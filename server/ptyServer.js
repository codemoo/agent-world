// Live interactive TUI server. Each WebSocket connection gets its own PTY
// running `claude --resume <sessionId>` in the session's cwd. Output bytes
// stream as binary WS frames; inbound text frames are either JSON control
// messages ({type:"input",data}, {type:"resize",cols,rows}, {type:"ping"})
// or raw keystrokes.
//
// Design (Codex-reviewed):
//   - We ONLY ever spawn the `claude` binary, never a raw shell. Keeps the
//     product boundary tight and prevents "browser shell" abuse.
//   - When the source pid is still alive, `claude --resume` does NOT attach
//     — it creates a second writer on the same session id. The upstream
//     caller must warn the user about this (see the frontend Live dialog).
//   - One PTY per sessionId at a time (refuse second with code 4090).
//   - cwd MUST match the snapshotter's record for that sessionId.
//   - Idle timeout (default 30 min) kills the PTY.
//   - Input byte rate capped to prevent flood attacks.

const { spawn } = require('node-pty');
const path = require('node:path');
const fs = require('node:fs');
const { execSync } = require('node:child_process');

const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_COLS = 100;
const DEFAULT_ROWS = 30;
const MAX_INPUT_BYTES_PER_SEC = 256 * 1024;

// Resolve a claude binary the server can safely spawn. Cache after the
// first successful lookup to avoid hammering the shell on each attach.
let cachedClaudeBin = null;
function findClaudeBinary() {
  if (cachedClaudeBin) return cachedClaudeBin;
  if (process.env.AGENT_WORLD_CLAUDE_BIN) {
    cachedClaudeBin = process.env.AGENT_WORLD_CLAUDE_BIN;
    return cachedClaudeBin;
  }
  // Try common locations without spawning a login shell.
  const candidates = [
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    process.env.HOME ? path.join(process.env.HOME, '.local', 'bin', 'claude') : null,
    process.env.HOME ? path.join(process.env.HOME, '.claude', 'local', 'claude') : null
  ].filter(Boolean);
  for (const p of candidates) {
    try {
      if (fs.statSync(p).isFile()) { cachedClaudeBin = p; return p; }
    } catch { /* not there */ }
  }
  // Fall back to the user's login shell which will know about PATH.
  try {
    const hint = execSync('zsh -lc "command -v claude"', { timeout: 2000 }).toString().trim();
    if (hint && fs.existsSync(hint)) {
      cachedClaudeBin = hint;
      return hint;
    }
  } catch { /* ignore */ }
  return null;
}

function createPtyManager(options = {}) {
  const idleTimeoutMs = options.idleTimeoutMs || DEFAULT_IDLE_TIMEOUT_MS;
  // Resolve the snapshotter lazily so creation can precede its
  // instantiation in server/index.js.
  function currentSnapshotter() {
    const s = options.claudeSnapshotter;
    return typeof s === 'function' ? s() : s;
  }

  // sessionId → { ptyProc, ws, lastActivity, idleTimer, intro }
  const active = new Map();

  function activeCount() { return active.size; }

  function cwdIsKnown(cwd) {
    const snapshotter = currentSnapshotter();
    if (!snapshotter) return false;
    const snap = snapshotter.lastSessions;
    if (!snap) return false;
    for (const s of snap.values()) {
      if (s.cwd === cwd) return true;
    }
    return false;
  }

  function sessionByIdCwd(sessionId) {
    const snapshotter = currentSnapshotter();
    const snap = snapshotter?.lastSessions;
    const s = snap?.get(sessionId);
    return s ? { cwd: s.cwd, name: s.name, pid: s.pid } : null;
  }

  // Bind a new WS → PTY pair. `mode` is 'claude' (default — `claude --resume`)
  // or 'shell' (zsh — only if AGENT_WORLD_PTY_ALLOW_SHELL=1, for dev/test).
  function attach(ws, { sessionId, cwd, cols = DEFAULT_COLS, rows = DEFAULT_ROWS, mode = 'claude' }) {
    if (active.has(sessionId)) {
      try { ws.close(4090, 'pty already attached for this session'); } catch {}
      return { ok: false, reason: 'already-attached' };
    }

    const info = sessionByIdCwd(sessionId);
    const resolvedCwd = info?.cwd || null;
    if (!resolvedCwd || (cwd && cwd !== resolvedCwd)) {
      try { ws.close(4003, 'cwd does not match a known session'); } catch {}
      return { ok: false, reason: 'cwd-mismatch' };
    }

    // Pick the binary + args based on mode.
    let file, args;
    if (mode === 'shell' && process.env.AGENT_WORLD_PTY_ALLOW_SHELL === '1') {
      file = process.env.SHELL || '/bin/zsh';
      args = ['-i'];
    } else {
      const claudeBin = findClaudeBinary();
      if (!claudeBin) {
        try { ws.send(JSON.stringify({ type: 'error', message: 'claude binary not found on server PATH. Set AGENT_WORLD_CLAUDE_BIN or install Claude Code CLI.' })); } catch {}
        try { ws.close(1011, 'claude not found'); } catch {}
        return { ok: false, reason: 'claude-not-found' };
      }
      file = claudeBin;
      args = ['--resume', sessionId];
    }

    const env = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' };
    let proc;
    try {
      proc = spawn(file, args, {
        name: 'xterm-256color',
        cwd: resolvedCwd,
        cols, rows,
        env
      });
    } catch (err) {
      try { ws.send(JSON.stringify({ type: 'error', message: `spawn failed: ${err.message}` })); } catch {}
      try { ws.close(1011, 'spawn failed'); } catch {}
      return { ok: false, reason: 'spawn-failed', error: err };
    }

    const state = {
      proc,
      ws,
      lastActivity: Date.now(),
      idleTimer: null,
      inputWindowStart: Date.now(),
      inputWindowBytes: 0,
      sessionId,
      cwd: resolvedCwd,
      pid: proc.pid,
      name: info?.name || path.basename(resolvedCwd || '')
    };
    active.set(sessionId, state);

    function bump() { state.lastActivity = Date.now(); }

    function scheduleIdle() {
      if (state.idleTimer) clearTimeout(state.idleTimer);
      state.idleTimer = setTimeout(() => {
        if (Date.now() - state.lastActivity >= idleTimeoutMs) {
          try { proc.kill(); } catch {}
          try { ws.close(1000, 'idle'); } catch {}
        } else {
          scheduleIdle();
        }
      }, idleTimeoutMs + 1000);
      if (state.idleTimer.unref) state.idleTimer.unref();
    }
    scheduleIdle();

    const intro = JSON.stringify({
      type: 'ready',
      sessionId,
      pid: proc.pid,
      cwd: resolvedCwd,
      name: state.name,
      mode,
      file,
      args,
      cols, rows
    });
    try { ws.send(intro); } catch {}

    // pty → ws (binary frames).
    proc.onData(chunk => {
      bump();
      if (ws.readyState !== ws.OPEN) return;
      try { ws.send(chunk); } catch (err) {
        // backpressure/close — kill the pty
        try { proc.kill(); } catch {}
      }
    });

    proc.onExit(({ exitCode, signal }) => {
      try {
        ws.send(JSON.stringify({ type: 'exit', exitCode, signal }));
      } catch {}
      try { ws.close(1000, `pty exited ${exitCode}`); } catch {}
      cleanup();
    });

    // ws → pty.
    ws.on('message', (raw, isBinary) => {
      bump();
      // Rate limit inbound bytes.
      const now = Date.now();
      if (now - state.inputWindowStart > 1000) {
        state.inputWindowStart = now;
        state.inputWindowBytes = 0;
      }
      const len = raw?.length || raw?.byteLength || 0;
      state.inputWindowBytes += len;
      if (state.inputWindowBytes > MAX_INPUT_BYTES_PER_SEC) {
        try { ws.close(1009, 'rate limit'); } catch {}
        try { proc.kill(); } catch {}
        return;
      }

      if (isBinary) {
        // Raw bytes → pty.
        try { proc.write(raw); } catch {}
        return;
      }
      // Text. Try JSON first.
      const text = raw.toString('utf8');
      if (text.length === 0) return;
      if (text[0] === '{') {
        try {
          const msg = JSON.parse(text);
          if (msg?.type === 'input' && typeof msg.data === 'string') {
            try { proc.write(msg.data); } catch {}
            return;
          }
          if (msg?.type === 'resize') {
            const c = Math.max(20, Math.min(300, Number(msg.cols) || DEFAULT_COLS));
            const r = Math.max(5, Math.min(120, Number(msg.rows) || DEFAULT_ROWS));
            try { proc.resize(c, r); } catch {}
            return;
          }
          if (msg?.type === 'ping') {
            try { ws.send(JSON.stringify({ type: 'pong' })); } catch {}
            return;
          }
        } catch { /* fall through to raw write */ }
      }
      // Fallback: treat as raw keystroke.
      try { proc.write(text); } catch {}
    });

    ws.on('close', () => { cleanup(); });
    ws.on('error', () => { cleanup(); });

    function cleanup() {
      if (!active.has(sessionId)) return;
      active.delete(sessionId);
      if (state.idleTimer) { clearTimeout(state.idleTimer); state.idleTimer = null; }
      try { proc.kill(); } catch {}
    }

    return { ok: true };
  }

  function stopAll() {
    for (const [id, state] of [...active]) {
      try { state.proc.kill(); } catch {}
      try { state.ws.close(1000, 'shutdown'); } catch {}
      active.delete(id);
    }
  }

  return {
    attach,
    cwdIsKnown,
    activeCount,
    stopAll,
    _active: active
  };
}

module.exports = {
  createPtyManager,
  findClaudeBinary,
  DEFAULT_IDLE_TIMEOUT_MS
};
