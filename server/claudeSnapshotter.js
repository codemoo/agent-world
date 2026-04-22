// 1 Hz snapshotter: enumerates live Claude CLI sessions on this Mac by
// reading ~/.claude/sessions/*.json, cross-checking against `ps`, reading
// hook event breadcrumbs from ~/.claude-control/events/*.json (claude-control)
// and ~/.claude/plugins/agent-world/events/*.json (our own, if installed).
//
// This is a stateless re-derivation — correctness comes from re-reading the
// truth sources every tick, not from perfect event delivery. No fs.watch.

const { EventEmitter } = require('node:events');
const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { classify, HOOK } = require('./sessionStatus');
const { resolveRepoRoot, buildingIdentity } = require('./repoRoot');
const { getTail } = require('./transcriptPreview');

const SESSIONS_DIR = path.join(os.homedir(), '.claude', 'sessions');
const CLAUDE_CONTROL_EVENTS = path.join(os.homedir(), '.claude-control', 'events');
const OUR_PLUGIN_EVENTS = path.join(os.homedir(), '.claude', 'plugins', 'agent-world', 'events');
const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

const DEFAULT_TICK_MS = 1000;
const PREVIEW_BYTES = 96 * 1024;

// Claude encodes cwd → project-dir name by replacing every `/` with `-`.
// For `/Users/a/b` → `-Users-a-b`. Paths with pre-existing dashes keep them.
// Root `/` collapses to empty after trimming, so we special-case it.
function encodeCwdForProjectDir(cwd) {
  if (!cwd || typeof cwd !== 'string') return null;
  if (cwd === '/') return '-';
  const trimmed = cwd.replace(/\/+$/, '');
  if (trimmed.length === 0) return null;
  return trimmed.replace(/\//g, '-');
}

// sessionId must be a safe filename (no path separators or funny characters).
const SAFE_SESSION_ID = /^[A-Za-z0-9._-]{4,96}$/;

function isUnderProjectsDir(absolute) {
  const root = PROJECTS_DIR.endsWith(path.sep) ? PROJECTS_DIR : PROJECTS_DIR + path.sep;
  return typeof absolute === 'string' && (absolute === PROJECTS_DIR || absolute.startsWith(root));
}

// Derive the canonical transcript path. Returns null if the file doesn't
// exist. Validates sessionId and enforces the path is under ~/.claude/projects
// (or a test-supplied `projectsDir`).
function deriveTranscriptPath(cwd, sessionId, { projectsDir = PROJECTS_DIR } = {}) {
  if (!cwd || !sessionId) return null;
  if (!SAFE_SESSION_ID.test(sessionId)) return null;
  const encoded = encodeCwdForProjectDir(cwd);
  if (!encoded) return null;
  const candidate = path.join(projectsDir, encoded, `${sessionId}.jsonl`);
  const root = projectsDir.endsWith(path.sep) ? projectsDir : projectsDir + path.sep;
  if (!(candidate === projectsDir || candidate.startsWith(root))) return null;
  try {
    const st = fsSync.statSync(candidate);
    if (st.isFile()) return candidate;
  } catch { /* not there */ }
  return null;
}

// Enforce that a hook-supplied transcript_path lives under ~/.claude/projects
// so a malformed hook can't make us read arbitrary files.
function sanitizeHookTranscriptPath(p) {
  if (typeof p !== 'string' || p.length === 0) return null;
  try {
    const resolved = path.resolve(p);
    if (!isUnderProjectsDir(resolved)) return null;
    return resolved;
  } catch { return null; }
}

function safeReadJson(file) {
  try {
    const buf = fsSync.readFileSync(file, 'utf8');
    return JSON.parse(buf);
  } catch {
    return null;
  }
}

async function listDir(dir) {
  try {
    return await fs.readdir(dir);
  } catch {
    return [];
  }
}

function runPs() {
  return new Promise(resolve => {
    execFile('ps', ['-eo', 'pid,pcpu,command'], { timeout: 1500, maxBuffer: 2 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve([]);
      const rows = stdout.toString().split('\n').slice(1);
      const out = [];
      for (const line of rows) {
        const trimmed = line.trimStart();
        if (!trimmed) continue;
        const m = trimmed.match(/^(\d+)\s+([\d.]+)\s+(.+)$/);
        if (!m) continue;
        const pid = Number(m[1]);
        const cpu = Number(m[2]);
        const cmd = m[3];
        if (!/\bclaude(\b|\s)/.test(cmd) && !/\/claude$/.test(cmd)) continue;
        // Skip Claude Desktop and Electron helpers.
        if (/Claude\.app/i.test(cmd)) continue;
        out.push({ pid, cpu, command: cmd });
      }
      return resolve(out);
    });
  });
}

// Per-tool input gist for the agent bubble / tooltip. Keeps the bubble
// informative without dumping the whole tool_use payload.
function extractToolInputPreview(toolName, input) {
  if (!input || typeof input !== 'object') return null;
  const take = (s) => (typeof s === 'string' ? s.split('\n')[0].slice(0, 120) : null);
  switch (toolName) {
    case 'Bash':
      return take(input.command);
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'NotebookEdit':
      return take(input.file_path || input.notebook_path);
    case 'Grep':
    case 'Glob':
      return take(input.pattern || input.query) || take(input.path);
    case 'WebFetch':
    case 'WebSearch':
      return take(input.url || input.query);
    case 'Task':
    case 'Agent':
      return take(input.description || input.subject);
    default: {
      for (const v of Object.values(input)) {
        if (typeof v === 'string' && v.length > 0) return take(v);
      }
      return null;
    }
  }
}

function pickLatestEvent(records) {
  let best = null;
  for (const r of records) {
    if (!r || typeof r !== 'object') continue;
    const ts = Number(r.ts || r.timestamp);
    if (!Number.isFinite(ts)) continue;
    if (!best || ts > best.ts) best = { type: r.event || r.type, ts: ts * (ts < 1e12 ? 1000 : 1), raw: r };
  }
  return best;
}

async function readEventsDir(dir) {
  const files = await listDir(dir);
  // Files may be JSON (one record) or JSONL (many). Read all, return per-file latest.
  const byPid = new Map();
  for (const name of files) {
    if (!name.endsWith('.json') && !name.endsWith('.jsonl')) continue;
    const base = name.replace(/\.(json|jsonl)$/, '');
    const pid = Number(base);
    if (!Number.isFinite(pid)) continue;
    const full = path.join(dir, name);
    let records = [];
    try {
      const buf = fsSync.readFileSync(full, 'utf8');
      if (name.endsWith('.jsonl')) {
        for (const ln of buf.split('\n')) {
          if (!ln.trim()) continue;
          try { records.push(JSON.parse(ln)); } catch { /* ignore */ }
        }
      } else {
        try {
          const parsed = JSON.parse(buf);
          records = Array.isArray(parsed) ? parsed : [parsed];
        } catch { /* ignore */ }
      }
    } catch { continue; }
    const latest = pickLatestEvent(records);
    if (latest) byPid.set(pid, latest);
  }
  return byPid;
}

async function takeSnapshot({
  sessionsDir = SESSIONS_DIR,
  ccEventsDir = CLAUDE_CONTROL_EVENTS,
  pluginEventsDir = OUR_PLUGIN_EVENTS,
  projectsDir = PROJECTS_DIR,
  psFn = runPs
} = {}) {
  const [psRows, sessionFiles, ccEvents, ourEvents] = await Promise.all([
    psFn(),
    listDir(sessionsDir),
    readEventsDir(ccEventsDir),
    readEventsDir(pluginEventsDir)
  ]);

  const alivePids = new Set(psRows.map(r => r.pid));
  const cpuByPid = new Map(psRows.map(r => [r.pid, r.cpu]));
  const commandByPid = new Map(psRows.map(r => [r.pid, r.command]));

  const sessions = [];
  for (const file of sessionFiles) {
    if (!file.endsWith('.json')) continue;
    const meta = safeReadJson(path.join(sessionsDir, file));
    if (!meta || !meta.pid) continue;
    const pid = meta.pid;
    const pidAlive = alivePids.has(pid);
    const hookCC = ccEvents.get(pid);
    const hookOurs = ourEvents.get(pid);
    const lastHookEvent = (() => {
      if (hookCC && hookOurs) return hookCC.ts > hookOurs.ts ? hookCC : hookOurs;
      return hookCC || hookOurs || null;
    })();

    let transcriptPath = sanitizeHookTranscriptPath(hookCC?.raw?.transcript_path)
      || sanitizeHookTranscriptPath(hookOurs?.raw?.transcript_path)
      || null;

    // Fallback: derive ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl
    // when no hook event supplied the path (e.g. claude-control not installed).
    if (!transcriptPath) {
      transcriptPath = deriveTranscriptPath(meta.cwd, meta.sessionId, { projectsDir });
    }

    let transcriptMtimeMs = null;
    let transcriptSize = null;
    if (transcriptPath) {
      try {
        const st = fsSync.statSync(transcriptPath);
        transcriptMtimeMs = st.mtimeMs;
        transcriptSize = st.size;
      } catch {
        // File vanished — drop the path so downstream code doesn't try to
        // open a non-existent file (and surfaces a clean absence instead).
        transcriptPath = null;
      }
    }

    const repoInfo = await resolveRepoRoot(meta.cwd);
    const buildingKey = buildingIdentity(repoInfo);

    const now = Date.now();
    const status = classify({
      now,
      pidAlive,
      pidSeenAliveAtMs: now, // ps run just now
      lastHookEvent,
      transcriptMtimeMs,
      cpuPercent: cpuByPid.get(pid) ?? 0
    });

    sessions.push({
      sessionId: meta.sessionId,
      pid,
      pidAlive,
      cwd: meta.cwd,
      repoRoot: repoInfo.repoRoot,
      buildingKey,
      isRepo: repoInfo.isRepo,
      name: meta.name || path.basename(meta.cwd || ''),
      startedAtMs: meta.startedAt || null,
      version: meta.version || null,
      kind: meta.kind || null,
      transcriptPath,
      transcriptMtimeMs,
      transcriptSize,
      cpuPercent: cpuByPid.get(pid) ?? 0,
      command: commandByPid.get(pid) || null,
      lastHookEvent,
      status
    });
  }

  return {
    takenAtMs: Date.now(),
    sessions,
    alivePids: [...alivePids]
  };
}

function createClaudeSnapshotter({ tickMs = DEFAULT_TICK_MS, now = () => Date.now() } = {}) {
  const emitter = new EventEmitter();
  let timer = null;
  let running = false;
  let lastSessions = new Map(); // sessionId → session snapshot
  // Per-session transcript preview cache. Keyed by sessionId. Only re-read
  // when transcript mtime advances, so cost is near-zero when nothing changed.
  const previewCache = new Map(); // sessionId → { mtimeMs, tool, model, gitBranch, lastAssistant, lastUser }

  async function enrichSession(session) {
    if (!session.transcriptPath) {
      // Nothing to enrich — make sure stale cache entries don't leak back.
      previewCache.delete(session.sessionId);
      return;
    }
    const cached = previewCache.get(session.sessionId);
    if (cached && cached.mtimeMs === session.transcriptMtimeMs && cached.size === session.transcriptSize) {
      session.tool = cached.tool;
      session.model = cached.model;
      session.gitBranch = cached.gitBranch;
      session.lastAssistantSnippet = cached.lastAssistant;
      session.lastUserSnippet = cached.lastUser;
      return;
    }
    try {
      const tail = await getTail(session.transcriptPath, { bytes: PREVIEW_BYTES });
      // Walk `lines` backwards to find the latest tool_use (preferring
      // content-block form inside assistant records, which is how Claude
      // actually writes them). Also capture the most recent assistant text
      // + user prompt snippets while we're at it.
      let toolName = null;
      let toolInputPreview = null;
      let lastAssistant = null;
      let lastUser = null;
      const records = tail.lines || [];
      for (let i = records.length - 1; i >= 0; i -= 1) {
        const rec = records[i];
        if (!rec) continue;
        if (rec.type === 'assistant' && !lastAssistant) {
          const blocks = rec?.message?.content;
          if (Array.isArray(blocks)) {
            const textBlock = [...blocks].reverse().find(b => b?.type === 'text' && b.text);
            if (textBlock) lastAssistant = textBlock.text.split('\n')[0].slice(0, 140);
            if (!toolName) {
              const tu = [...blocks].reverse().find(b => b?.type === 'tool_use');
              if (tu) {
                toolName = tu.name || null;
                toolInputPreview = extractToolInputPreview(tu.name, tu.input);
              }
            }
          } else if (typeof blocks === 'string') {
            lastAssistant = blocks.split('\n')[0].slice(0, 140);
          }
        } else if (rec.type === 'user' && !lastUser) {
          const content = rec?.message?.content;
          if (typeof content === 'string') {
            lastUser = content.split('\n')[0].slice(0, 140);
          } else if (Array.isArray(content)) {
            const textBlock = content.find(b => b?.type === 'text' && b.text);
            if (textBlock) lastUser = textBlock.text.split('\n')[0].slice(0, 140);
          }
        } else if (rec.type === 'tool_use' && !toolName) {
          // Top-level tool_use record (rare but support it).
          toolName = rec.name || null;
        }
        if (toolName && lastAssistant && lastUser) break;
      }
      const entry = {
        mtimeMs: session.transcriptMtimeMs,
        size: session.transcriptSize,
        tool: toolName ? { name: toolName, inputPreview: toolInputPreview } : null,
        model: tail.lastModel,
        gitBranch: tail.gitBranch,
        lastAssistant,
        lastUser
      };
      previewCache.set(session.sessionId, entry);
      session.tool = entry.tool;
      session.model = entry.model;
      session.gitBranch = entry.gitBranch;
      session.lastAssistantSnippet = entry.lastAssistant;
      session.lastUserSnippet = entry.lastUser;
    } catch (err) {
      // If the transcript disappeared or can't be parsed, drop any cached
      // fields so the world doesn't keep displaying stale info.
      previewCache.delete(session.sessionId);
      session.tool = null;
      session.model = null;
      session.gitBranch = null;
      session.lastAssistantSnippet = null;
      session.lastUserSnippet = null;
    }
  }

  async function tick() {
    if (running) return; // skip overlapping tick
    running = true;
    try {
      const snap = await takeSnapshot();
      // Enrich every session with its transcript preview before emitting.
      await Promise.all(snap.sessions.map(enrichSession));
      // GC previewCache entries for sessions that have disappeared.
      const liveIds = new Set(snap.sessions.map(s => s.sessionId));
      for (const id of [...previewCache.keys()]) {
        if (!liveIds.has(id)) previewCache.delete(id);
      }
      const nextMap = new Map(snap.sessions.map(s => [s.sessionId, s]));
      // Diff for emission.
      const added = [];
      const removed = [];
      const changed = [];
      for (const [id, next] of nextMap) {
        const prev = lastSessions.get(id);
        if (!prev) added.push(next);
        else if (prev.status !== next.status || prev.transcriptMtimeMs !== next.transcriptMtimeMs ||
                 prev.cwd !== next.cwd || prev.lastHookEvent?.type !== next.lastHookEvent?.type) {
          changed.push({ prev, next });
        }
      }
      for (const [id, prev] of lastSessions) {
        if (!nextMap.has(id)) removed.push(prev);
      }

      emitter.emit('snapshot', snap);
      if (added.length) emitter.emit('session-added', added);
      if (removed.length) emitter.emit('session-removed', removed);
      if (changed.length) emitter.emit('session-changed', changed);

      lastSessions = nextMap;
    } catch (err) {
      emitter.emit('error', err);
    } finally {
      running = false;
    }
  }

  emitter.start = function start() {
    if (timer) return;
    tick(); // fire immediately
    timer = setInterval(tick, tickMs);
    if (timer.unref) timer.unref();
  };
  emitter.stop = function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };
  // Define as a live getter (Object.assign would snapshot the value).
  Object.defineProperty(emitter, 'lastSessions', {
    get() { return lastSessions; },
    enumerable: true
  });
  return emitter;
}

module.exports = {
  createClaudeSnapshotter,
  takeSnapshot,
  deriveTranscriptPath,
  encodeCwdForProjectDir,
  SESSIONS_DIR,
  CLAUDE_CONTROL_EVENTS,
  OUR_PLUGIN_EVENTS,
  PROJECTS_DIR
};
