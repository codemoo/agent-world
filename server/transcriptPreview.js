// On-demand JSONL reader for the session transcript. Opens O_RDONLY, reads
// a bounded window, parses complete lines only. Never holds a permanent fd.
//
// Two shapes:
//   • getTail()  — last-of-kind summary for the session detail sidebar
//                  (lastUser, lastAssistant, lastToolUse, lastModel, gitBranch)
//   • getSlice() — forward slice of normalized render-ready entries for the
//                  in-browser TUI viewer. Uses a byte cursor for efficient
//                  incremental polling.
//
// Cursor model (Codex-approved): base64url JSON with {offset, inode, mtimeMs}.
// If the file rotated (inode/size mismatch or file shrank) we ignore the
// cursor and resync from the tail window.

const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PROJECTS_ROOT = path.join(os.homedir(), '.claude', 'projects');
const DEFAULT_TAIL_BYTES = 64 * 1024;
const DEFAULT_SLICE_BYTES = 256 * 1024; // tail window for a fresh (no-cursor) slice
const INCREMENT_CAP_BYTES = 4 * 1024 * 1024; // max bytes per follow-up poll
const MAX_TEXT_LEN = 8 * 1024;               // cap per-entry text
const MAX_TOOL_STDOUT_HEAD = 4 * 1024;       // per-entry stdout preview

function isPathUnderRoot(absolute, root) {
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  return absolute === root || absolute.startsWith(rootWithSep);
}

async function resolveSafePath(transcriptPath, projectsRoot = PROJECTS_ROOT) {
  if (!transcriptPath || typeof transcriptPath !== 'string') {
    throw new Error('transcriptPath required');
  }
  const real = await fs.realpath(transcriptPath);
  // Also canonicalize the root so that macOS /var → /private/var doesn't
  // produce a false mismatch.
  let realRoot;
  try { realRoot = await fs.realpath(projectsRoot); }
  catch { realRoot = projectsRoot; }
  if (!isPathUnderRoot(real, realRoot)) {
    throw new Error(`refusing to read outside ${realRoot}: ${real}`);
  }
  return real;
}

// Read [start, end) from path. Returns a Buffer. End defaults to the current
// file size. Caller should pass start < end; undefined start means 0.
function readRange(real, start, end) {
  const length = Math.max(0, end - start);
  if (length === 0) return Buffer.alloc(0);
  const buf = Buffer.alloc(length);
  const fd = fsSync.openSync(real, 'r');
  try {
    fsSync.readSync(fd, buf, 0, length, start);
  } finally {
    fsSync.closeSync(fd);
  }
  return buf;
}

// Parse a tail buffer into records. If `trimPartialLead`, drops the first
// partial line (we started mid-file). Always returns the byte offset of the
// *last complete newline* so the caller can advance its cursor safely.
function parseBuffer(buffer, baseOffset, { trimPartialLead }) {
  const text = buffer.toString('utf8');
  const lineStart = trimPartialLead ? text.indexOf('\n') + 1 : 0;
  const lastNewline = text.lastIndexOf('\n');
  const endByte = lastNewline >= 0 ? baseOffset + Buffer.byteLength(text.slice(0, lastNewline + 1), 'utf8') : baseOffset + lineStart;
  const body = lastNewline >= 0 ? text.slice(lineStart, lastNewline + 1) : '';
  const rawLines = body.split('\n').filter(l => l.length > 0);
  const records = [];
  for (const raw of rawLines) {
    try { records.push(JSON.parse(raw)); } catch { /* skip malformed */ }
  }
  return { records, endByte };
}

async function getTail(transcriptPath, { bytes = DEFAULT_TAIL_BYTES, projectsRoot = PROJECTS_ROOT } = {}) {
  const real = await resolveSafePath(transcriptPath, projectsRoot);
  const stat = await fs.stat(real);
  if (stat.size === 0) {
    return {
      path: real, mtimeMs: stat.mtimeMs, lines: [],
      lastUserMessage: null, lastAssistantMessage: null,
      lastToolUse: null, lastToolResult: null,
      lastModel: null, gitBranch: null
    };
  }
  const start = Math.max(0, stat.size - bytes);
  const buffer = readRange(real, start, stat.size);
  const { records } = parseBuffer(buffer, start, { trimPartialLead: start > 0 });

  let lastUserMessage = null, lastAssistantMessage = null;
  let lastToolUse = null, lastToolResult = null;
  let lastModel = null, gitBranch = null;
  for (const rec of records) {
    if (!rec || typeof rec !== 'object') continue;
    if (typeof rec.gitBranch === 'string') gitBranch = rec.gitBranch;
    switch (rec.type) {
      case 'user': lastUserMessage = rec; break;
      case 'assistant': {
        lastAssistantMessage = rec;
        const m = rec.message?.model;
        if (typeof m === 'string') lastModel = m;
        break;
      }
      case 'tool_use': lastToolUse = rec; break;
      case 'tool_result': lastToolResult = rec; break;
    }
  }
  return {
    path: real, mtimeMs: stat.mtimeMs, lines: records,
    lastUserMessage, lastAssistantMessage,
    lastToolUse, lastToolResult, lastModel, gitBranch
  };
}

// ANSI CSI + OSC + other escape sequences, plus control chars (excluding \n\t).
const ANSI_CSI = /\x1b\[[0-9;?]*[ -\/]*[@-~]/g;
const ANSI_OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const ANSI_OTHER = /\x1b[()#][0-9A-Za-z]/g;
const CONTROL = /[\x00-\x08\x0b-\x0c\x0e-\x1f\x7f]/g;

function sanitize(text) {
  if (typeof text !== 'string') return '';
  return text
    .replace(ANSI_OSC, '')
    .replace(ANSI_CSI, '')
    .replace(ANSI_OTHER, '')
    .replace(CONTROL, '');
}

function truncateText(text, max = MAX_TEXT_LEN) {
  const clean = sanitize(text || '');
  if (clean.length <= max) return { text: clean, truncated: false };
  return { text: clean.slice(0, max), truncated: true };
}

function extractToolResultContent(block) {
  if (!block) return '';
  if (typeof block.content === 'string') return block.content;
  if (Array.isArray(block.content)) {
    return block.content.map(c => {
      if (!c) return '';
      if (typeof c === 'string') return c;
      if (c.type === 'text' && typeof c.text === 'string') return c.text;
      return '';
    }).join('\n');
  }
  return '';
}

// Normalize one JSONL record into 0+ render-ready "entries".
// Each entry carries:
//   { id, turnId, parentId, kind, tone?, tsMs, text?, tool?, input?,
//     toolUseId?, isError?, truncated?, meta? }
// Where `kind` ∈ {user, assistant_text, thinking, tool_use, tool_result,
// system, meta}.
function normalizeRecord(rec, seqStart, turnMap) {
  const entries = [];
  if (!rec || typeof rec !== 'object') return entries;

  const tsMs = rec.timestamp ? Date.parse(rec.timestamp) : null;
  const uuid = rec.uuid || null;
  const parentUuid = rec.parentUuid || null;
  let seq = seqStart;

  const pushEntry = (e) => {
    entries.push({ seq: seq++, ...e });
  };

  switch (rec.type) {
    case 'user': {
      const content = rec.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (!block || typeof block !== 'object') continue;
          if (block.type === 'tool_result') {
            const raw = extractToolResultContent(block);
            const { text, truncated } = truncateText(raw, MAX_TOOL_STDOUT_HEAD);
            const turnId = turnMap.get(block.tool_use_id) || parentUuid || uuid || null;
            pushEntry({
              id: `${uuid || 'u'}:tr:${block.tool_use_id || 'x'}`,
              turnId,
              parentId: block.tool_use_id || parentUuid,
              kind: 'tool_result',
              tsMs,
              toolUseId: block.tool_use_id || null,
              isError: Boolean(block.is_error),
              text,
              truncated
            });
          } else if (block.type === 'text') {
            const { text, truncated } = truncateText(block.text || '');
            pushEntry({
              id: `${uuid || 'u'}:t`,
              turnId: uuid || null,
              parentId: parentUuid,
              kind: 'user',
              tsMs, text, truncated
            });
          }
        }
      } else if (typeof content === 'string') {
        const { text, truncated } = truncateText(content);
        pushEntry({
          id: uuid || `u:${tsMs}`,
          turnId: uuid || null,
          parentId: parentUuid,
          kind: 'user',
          tsMs, text, truncated
        });
      }
      return entries;
    }
    case 'assistant': {
      const msg = rec.message || {};
      const content = msg.content;
      const model = msg.model || null;
      const turnId = msg.id || uuid || null;
      if (!Array.isArray(content)) return entries;
      let blockIdx = 0;
      for (const block of content) {
        if (!block || typeof block !== 'object') continue;
        const idPrefix = `${turnId || 'a'}:${blockIdx++}`;
        if (block.type === 'text') {
          const { text, truncated } = truncateText(block.text || '');
          pushEntry({
            id: `${idPrefix}:text`, turnId, parentId: uuid,
            kind: 'assistant_text', tsMs, model, text, truncated
          });
        } else if (block.type === 'thinking') {
          const raw = block.thinking || block.text || '';
          const { text, truncated } = truncateText(raw);
          pushEntry({
            id: `${idPrefix}:think`, turnId, parentId: uuid,
            kind: 'thinking', tsMs, model, text, truncated
          });
        } else if (block.type === 'tool_use') {
          const inputStr = JSON.stringify(block.input ?? {}, null, 2);
          const { text: inputPreview, truncated: inputTruncated } =
            truncateText(inputStr, 240);
          const fullInputStr = sanitize(inputStr).slice(0, MAX_TEXT_LEN);
          const toolUseId = block.id || null;
          if (toolUseId) turnMap.set(toolUseId, turnId);
          pushEntry({
            id: toolUseId || `${idPrefix}:tu`,
            turnId, parentId: uuid,
            kind: 'tool_use', tsMs, model,
            tool: block.name || 'unknown',
            toolUseId,
            inputPreview,
            inputTruncated,
            fullInput: fullInputStr
          });
        }
      }
      return entries;
    }
    case 'thinking': {
      const { text, truncated } = truncateText(rec.content || rec.thinking || '');
      pushEntry({
        id: uuid || `th:${tsMs}`,
        turnId: parentUuid || uuid || null,
        parentId: parentUuid,
        kind: 'thinking', tsMs, text, truncated
      });
      return entries;
    }
    case 'tool_use': {
      const top = rec.message?.content?.find?.(c => c?.type === 'tool_use');
      const tool = rec.name || top?.name || 'unknown';
      const inputObj = rec.input ?? top?.input ?? {};
      const inputStr = JSON.stringify(inputObj, null, 2);
      const { text: inputPreview, truncated: inputTruncated } =
        truncateText(inputStr, 240);
      pushEntry({
        id: uuid || `tu:${tsMs}`,
        turnId: parentUuid || uuid || null,
        parentId: parentUuid,
        kind: 'tool_use', tsMs, tool,
        toolUseId: rec.tool_use_id || null,
        inputPreview, inputTruncated,
        fullInput: sanitize(inputStr).slice(0, MAX_TEXT_LEN)
      });
      return entries;
    }
    case 'tool_result': {
      const raw = typeof rec.content === 'string'
        ? rec.content
        : (rec.text || extractToolResultContent(rec));
      const { text, truncated } = truncateText(raw, MAX_TOOL_STDOUT_HEAD);
      const turnId = turnMap.get(rec.tool_use_id) || parentUuid || null;
      pushEntry({
        id: uuid || `tr:${tsMs}`,
        turnId, parentId: parentUuid,
        kind: 'tool_result', tsMs,
        toolUseId: rec.tool_use_id || null,
        isError: Boolean(rec.is_error),
        text, truncated
      });
      return entries;
    }
    case 'system':
    case 'permission-mode': {
      const { text, truncated } = truncateText(rec.content || '');
      pushEntry({
        id: uuid || `sys:${tsMs}`,
        turnId: null, parentId: parentUuid,
        kind: rec.type === 'system' ? 'system' : 'meta',
        subtype: rec.subtype || rec.type,
        tsMs, text, truncated
      });
      return entries;
    }
    default:
      // file-history-snapshot, attachment, tool_reference, async_hook_response,
      // skill_listing, plan_mode, etc. — collapse to a dim meta row by default.
      if (typeof rec.content === 'string' && rec.content.length > 0) {
        const { text, truncated } = truncateText(rec.content);
        pushEntry({
          id: uuid || `meta:${tsMs}`,
          turnId: null, parentId: parentUuid,
          kind: 'meta', subtype: rec.type, tsMs, text, truncated
        });
      }
      return entries;
  }
}

// Encode a byte cursor. Stable enough for our needs; survives one process
// restart because it's just a recap of on-disk facts.
function encodeCursor({ offset, inode, mtimeMs }) {
  const payload = JSON.stringify({ o: offset, i: inode, m: mtimeMs });
  return Buffer.from(payload, 'utf8').toString('base64url');
}
function decodeCursor(cursor) {
  if (!cursor || typeof cursor !== 'string') return null;
  try {
    const payload = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (typeof payload?.o === 'number' && typeof payload?.i === 'number') return payload;
    return null;
  } catch { return null; }
}

// Normalize a sequence of raw records into entries. Maintains a turnMap
// across the call so tool_result records link to the correct assistant turn
// even when the tool_use and tool_result fall on different poll windows.
function normalizeRecords(records, { baseSeq = 0, turnMap = new Map() } = {}) {
  const entries = [];
  let seq = baseSeq;
  for (const rec of records) {
    const batch = normalizeRecord(rec, seq, turnMap);
    for (const e of batch) entries.push(e);
    seq += batch.length;
  }
  return { entries, turnMap, nextSeq: seq };
}

async function getSlice(transcriptPath, {
  cursor: cursorStr = null,
  limit = 200,
  tailBytes = DEFAULT_SLICE_BYTES,
  projectsRoot = PROJECTS_ROOT
} = {}) {
  const real = await resolveSafePath(transcriptPath, projectsRoot);
  const stat = await fs.stat(real);
  const inode = stat.ino;
  const size = stat.size;

  if (size === 0) {
    return {
      path: real, mtimeMs: stat.mtimeMs, size: 0,
      entries: [], truncated: false,
      gitBranch: null, model: null,
      cursor: encodeCursor({ offset: 0, inode, mtimeMs: stat.mtimeMs }),
      resync: false
    };
  }

  const parsed = decodeCursor(cursorStr);
  let startOffset;
  let resync = false;
  let trimPartialLead = false;

  if (parsed && parsed.i === inode && parsed.o <= size) {
    // Incremental read from the cursor.
    const cap = Math.min(INCREMENT_CAP_BYTES, size - parsed.o);
    startOffset = size - cap;
    if (startOffset < parsed.o) startOffset = parsed.o;
    trimPartialLead = startOffset > 0 && startOffset !== parsed.o;
  } else {
    // No cursor, or cursor stale / inode changed / file shrank — resync from tail.
    resync = Boolean(parsed);
    startOffset = Math.max(0, size - tailBytes);
    trimPartialLead = startOffset > 0;
  }

  const buffer = readRange(real, startOffset, size);
  const { records, endByte } = parseBuffer(buffer, startOffset, { trimPartialLead });

  // Walk records once for provenance + normalize.
  let gitBranch = null;
  let model = null;
  for (const rec of records) {
    if (rec?.gitBranch) gitBranch = rec.gitBranch;
    if (rec?.message?.model) model = rec.message.model;
  }

  const { entries } = normalizeRecords(records, { baseSeq: 0, turnMap: new Map() });

  // Trim to the trailing `limit` when reading a fresh tail (no cursor).
  const trimmed = parsed ? entries : entries.slice(Math.max(0, entries.length - limit));
  const truncated = !parsed && entries.length > limit;

  return {
    path: real,
    mtimeMs: stat.mtimeMs,
    size,
    entries: trimmed,
    truncated,
    gitBranch,
    model,
    cursor: encodeCursor({ offset: endByte, inode, mtimeMs: stat.mtimeMs }),
    resync
  };
}

module.exports = {
  getTail,
  getSlice,
  normalizeRecord,
  normalizeRecords,
  sanitize,
  encodeCursor,
  decodeCursor,
  PROJECTS_ROOT
};
