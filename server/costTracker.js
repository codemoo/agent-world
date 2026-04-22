// Cumulative token + $ accounting per Claude session.
//
// How it works:
//   1. Lazy init: when asked for a session's totals the first time, we
//      scan the full transcript JSONL from byte 0 to the current end
//      and remember where we left off.
//   2. On every subsequent update (call after snapshotter detects an
//      mtime change), we seek to the remembered offset and parse only
//      the new records — O(new bytes), not O(file size).
//   3. Accumulate per-record: `type === 'assistant'` messages carry
//      `message.usage`; multiply by per-model rates from PRICING.
//
// State lives in memory only. A restart rebuilds by re-scanning on
// demand — cheap because the snapshotter only asks when a session is
// alive and it only happens once per session per process.

const fs = require('node:fs');

// USD per million tokens. Rates match Anthropic's published pricing
// for the claude-4.x family (approximate; override via env if needed).
// Cache write = `cache_creation_input_tokens` (includes both 5 m and
// 1 h ephemeral writes — we don't distinguish tiers here for UX
// simplicity; error is ~2× on the cache_write column only).
const PRICING = Object.freeze({
  'claude-opus-4-7':   { input: 15.00, output: 75.00, cache_write: 18.75, cache_read: 1.50 },
  'claude-opus-4-6':   { input: 15.00, output: 75.00, cache_write: 18.75, cache_read: 1.50 },
  'claude-opus-4-5':   { input: 15.00, output: 75.00, cache_write: 18.75, cache_read: 1.50 },
  'claude-opus-4':     { input: 15.00, output: 75.00, cache_write: 18.75, cache_read: 1.50 },
  'claude-sonnet-4-6': { input:  3.00, output: 15.00, cache_write:  3.75, cache_read: 0.30 },
  'claude-sonnet-4-5': { input:  3.00, output: 15.00, cache_write:  3.75, cache_read: 0.30 },
  'claude-sonnet-4':   { input:  3.00, output: 15.00, cache_write:  3.75, cache_read: 0.30 },
  'claude-haiku-4-5':  { input:  0.80, output:  4.00, cache_write:  1.00, cache_read: 0.08 },
  'claude-haiku-4':    { input:  0.80, output:  4.00, cache_write:  1.00, cache_read: 0.08 }
});

const FALLBACK_RATE = PRICING['claude-sonnet-4-6'];

function rateFor(model) {
  if (!model || typeof model !== 'string') return FALLBACK_RATE;
  const exact = PRICING[model];
  if (exact) return exact;
  const m = model.toLowerCase();
  if (m.includes('opus')) return PRICING['claude-opus-4-7'];
  if (m.includes('sonnet')) return PRICING['claude-sonnet-4-6'];
  if (m.includes('haiku')) return PRICING['claude-haiku-4-5'];
  return FALLBACK_RATE;
}

function costOfUsage(usage, model) {
  if (!usage) return 0;
  const r = rateFor(model);
  const input = (usage.input_tokens || 0) / 1_000_000 * r.input;
  const output = (usage.output_tokens || 0) / 1_000_000 * r.output;
  const write = (usage.cache_creation_input_tokens || 0) / 1_000_000 * r.cache_write;
  const read = (usage.cache_read_input_tokens || 0) / 1_000_000 * r.cache_read;
  return input + output + write + read;
}

function emptyTotals() {
  return {
    input: 0, output: 0, cacheWrite: 0, cacheRead: 0,
    cost: 0, messageCount: 0,
    firstTs: null, lastTs: null, model: null
  };
}

function applyRecord(totals, rec) {
  if (!rec || rec.type !== 'assistant') return;
  const usage = rec.message && rec.message.usage;
  if (!usage) return;
  const model = rec.message && rec.message.model;
  totals.input += usage.input_tokens || 0;
  totals.output += usage.output_tokens || 0;
  totals.cacheWrite += usage.cache_creation_input_tokens || 0;
  totals.cacheRead += usage.cache_read_input_tokens || 0;
  totals.cost += costOfUsage(usage, model);
  totals.messageCount += 1;
  if (model) totals.model = model;
  const ts = rec.timestamp || (rec.message && rec.message.timestamp) || rec.createdAt;
  if (ts) {
    if (!totals.firstTs) totals.firstTs = ts;
    totals.lastTs = ts;
  }
}

// Files larger than this on first encounter skip the historical scan
// and start counting from "now". Prevents a cold-start stall on a busy
// machine with multi-MB transcripts. Users accept some lost history in
// exchange for non-blocking boot; worldTotals continues accumulating.
const INITIAL_SCAN_BYTES_CAP = 1_500_000;

function createCostTracker(options = {}) {
  const capBytes = typeof options.initialScanCapBytes === 'number'
    ? options.initialScanCapBytes
    : INITIAL_SCAN_BYTES_CAP;
  // sessionId → { totals, offset, inode, mtimeMs }
  const state = new Map();

  function reset(sessionId) {
    state.delete(sessionId);
  }

  // Resume reading from where we left off; if the file was rotated
  // (inode changed) or truncated (size shrunk), start fresh.
  function update(sessionId, transcriptPath) {
    if (!sessionId || !transcriptPath) return null;
    let st;
    try { st = fs.statSync(transcriptPath); } catch { return null; }
    let entry = state.get(sessionId);
    if (entry) {
      const rotated = entry.inode !== st.ino;
      const truncated = st.size < entry.offset;
      if (rotated || truncated) entry = null;
    }
    if (!entry) {
      // Cold start: if the transcript is already large, skip historical
      // bytes to avoid blocking the tick loop on a multi-MB read. We
      // lose accumulated history for that session but the tracker
      // continues incrementally from here.
      const startOffset = st.size > capBytes ? st.size : 0;
      entry = {
        totals: emptyTotals(),
        offset: startOffset,
        inode: st.ino,
        mtimeMs: st.mtimeMs
      };
      state.set(sessionId, entry);
      if (startOffset === st.size) return entry.totals;
    }
    if (st.mtimeMs === entry.mtimeMs && entry.offset === st.size) {
      return entry.totals;
    }
    if (st.size <= entry.offset) {
      entry.mtimeMs = st.mtimeMs;
      return entry.totals;
    }

    // Read the new slice. Anchor to newline so we don't split a record.
    const len = st.size - entry.offset;
    const buf = Buffer.alloc(len);
    let fd;
    try {
      fd = fs.openSync(transcriptPath, 'r');
      fs.readSync(fd, buf, 0, len, entry.offset);
    } finally {
      if (fd !== undefined) try { fs.closeSync(fd); } catch (_) {}
    }

    const text = buf.toString('utf8');
    const lastNewline = text.lastIndexOf('\n');
    const complete = lastNewline >= 0 ? text.slice(0, lastNewline + 1) : '';
    const consumed = Buffer.byteLength(complete, 'utf8');
    const lines = complete.split('\n');
    for (const line of lines) {
      if (!line) continue;
      let rec;
      try { rec = JSON.parse(line); } catch { continue; }
      applyRecord(entry.totals, rec);
    }
    entry.offset += consumed;
    entry.mtimeMs = st.mtimeMs;
    return entry.totals;
  }

  function get(sessionId) {
    const entry = state.get(sessionId);
    return entry ? entry.totals : null;
  }

  function snapshot() {
    const out = {};
    for (const [id, entry] of state) out[id] = { ...entry.totals };
    return out;
  }

  // World-wide aggregate for the village-level badge.
  function worldTotals() {
    const t = emptyTotals();
    for (const [, entry] of state) {
      t.input += entry.totals.input;
      t.output += entry.totals.output;
      t.cacheWrite += entry.totals.cacheWrite;
      t.cacheRead += entry.totals.cacheRead;
      t.cost += entry.totals.cost;
      t.messageCount += entry.totals.messageCount;
    }
    return t;
  }

  return { update, get, snapshot, worldTotals, reset, _state: state };
}

module.exports = {
  createCostTracker,
  costOfUsage,
  rateFor,
  PRICING,
  applyRecord,
  emptyTotals
};
