// Bring the terminal tab running a given Claude session to the foreground.
//
// Strategy: inspect `ps` for the parent terminal process and dispatch to the
// right adapter:
//   - tmux:           `tmux list-panes` → find pane whose pane_pid ancestor
//                     contains our pid → tmux select-pane + select-window.
//   - iTerm2:         AppleScript, select window containing our pid's tty.
//   - Terminal.app:   AppleScript, select tab matching our tty.
//   - kitty/WezTerm:  not implemented in v1. Falls back to "unsupported".
//
// This runs outside the render path — safe to shell out to osascript/tmux.

const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

async function safeExec(cmd, args, { timeout = 1500 } = {}) {
  try {
    const { stdout } = await execFileAsync(cmd, args, { timeout });
    return stdout.toString();
  } catch {
    return null;
  }
}

// Walk ps to find the TTY + parent-chain for a pid.
async function ancestryForPid(pid) {
  const out = await safeExec('ps', ['-eo', 'pid,ppid,tty,command']);
  if (!out) return null;
  const rows = out.split('\n').slice(1).map(line => {
    const trimmed = line.trimStart();
    const m = trimmed.match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
    if (!m) return null;
    return { pid: Number(m[1]), ppid: Number(m[2]), tty: m[3], command: m[4] };
  }).filter(Boolean);

  const byPid = new Map(rows.map(r => [r.pid, r]));
  const chain = [];
  let cur = byPid.get(pid);
  while (cur) {
    chain.push(cur);
    if (cur.ppid <= 1) break;
    cur = byPid.get(cur.ppid);
  }
  return chain;
}

function detectTerminalKind(chain) {
  if (!chain) return 'unknown';
  const cmds = chain.map(r => r.command || '').join(' ');
  if (/tmux/.test(cmds) || process.env.TMUX) return 'tmux';
  if (/iTerm\.app|iTerm2/.test(cmds)) return 'iterm';
  if (/Terminal\.app/.test(cmds)) return 'terminal_app';
  if (/kitty/.test(cmds)) return 'kitty';
  if (/wezterm/.test(cmds)) return 'wezterm';
  return 'unknown';
}

async function focusViaTmux(pid) {
  const out = await safeExec('tmux', ['list-panes', '-a', '-F', '#{pane_id}|#{pane_pid}|#{session_name}|#{window_index}|#{window_name}']);
  if (!out) return { ok: false, reason: 'tmux-list-failed' };
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const [paneId, panePidStr, session, windowIdx] = line.split('|');
    const panePid = Number(panePidStr);
    if (!panePid) continue;
    // Check if our pid is in the pane's process tree. tmux panes spawn a shell
    // whose descendants include our Claude CLI.
    const descendants = await safeExec('pgrep', ['-P', String(panePid)]);
    if (descendants && descendants.split('\n').map(Number).includes(pid)) {
      await safeExec('tmux', ['select-window', '-t', `${session}:${windowIdx}`]);
      await safeExec('tmux', ['select-pane', '-t', paneId]);
      return { ok: true, adapter: 'tmux', paneId };
    }
  }
  // Fallback: match by direct match of pid == pane_pid (rare).
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const [paneId, panePidStr, session, windowIdx] = line.split('|');
    if (Number(panePidStr) === pid) {
      await safeExec('tmux', ['select-window', '-t', `${session}:${windowIdx}`]);
      await safeExec('tmux', ['select-pane', '-t', paneId]);
      return { ok: true, adapter: 'tmux', paneId };
    }
  }
  return { ok: false, reason: 'tmux-pane-not-found', adapter: 'tmux' };
}

async function focusViaAppleScript(script) {
  if (process.platform !== 'darwin') return { ok: false, reason: 'not-macos' };
  const res = await safeExec('osascript', ['-e', script]);
  if (res === null) return { ok: false, reason: 'osascript-failed' };
  return { ok: true, adapter: 'osascript' };
}

async function focusViaITerm(tty) {
  if (!tty || tty === '??') return { ok: false, reason: 'no-tty' };
  const script = `
    tell application "iTerm"
      activate
      repeat with w in windows
        repeat with t in tabs of w
          repeat with s in sessions of t
            if tty of s contains "${tty}" then
              select s
              select t
              select w
              return "ok"
            end if
          end repeat
        end repeat
      end repeat
    end tell
    return "not-found"
  `;
  return focusViaAppleScript(script);
}

async function focusViaTerminalApp(tty) {
  if (!tty || tty === '??') return { ok: false, reason: 'no-tty' };
  const script = `
    tell application "Terminal"
      activate
      repeat with w in windows
        repeat with t in tabs of w
          if tty of t contains "${tty}" then
            set selected of t to true
            set index of w to 1
            return "ok"
          end if
        end repeat
      end repeat
    end tell
    return "not-found"
  `;
  return focusViaAppleScript(script);
}

async function focusSessionTerminal(session) {
  const pid = session?.pid;
  if (!pid) return { ok: false, reason: 'no-pid' };
  const chain = await ancestryForPid(pid);
  const kind = detectTerminalKind(chain);
  const tty = chain?.[0]?.tty || null;

  switch (kind) {
    case 'tmux':          return { tty, kind, ...(await focusViaTmux(pid)) };
    case 'iterm':         return { tty, kind, ...(await focusViaITerm(tty)) };
    case 'terminal_app':  return { tty, kind, ...(await focusViaTerminalApp(tty)) };
    case 'kitty':
    case 'wezterm':
      return { ok: false, tty, kind, reason: 'adapter-not-implemented' };
    default:
      // Try tmux first, then iTerm, then Terminal.app.
      const tryTmux = await focusViaTmux(pid);
      if (tryTmux.ok) return { tty, kind: 'tmux', ...tryTmux };
      const tryIterm = await focusViaITerm(tty);
      if (tryIterm.ok) return { tty, kind: 'iterm', ...tryIterm };
      const tryTerm = await focusViaTerminalApp(tty);
      if (tryTerm.ok) return { tty, kind: 'terminal_app', ...tryTerm };
      return { ok: false, tty, kind, reason: 'no-matching-terminal' };
  }
}

module.exports = {
  focusSessionTerminal,
  detectTerminalKind,
  ancestryForPid,
  focusViaTmux,
  focusViaITerm,
  focusViaTerminalApp
};
