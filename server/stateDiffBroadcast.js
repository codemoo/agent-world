// Debounced broadcaster. Any call to `schedule()` within the debounce
// window coalesces into a single outbound message. Optionally produces a
// RFC 7396 JSON Merge Patch vs. the last-emitted snapshot so active clients
// can reconstruct state by applying patches.

const DEFAULT_DEBOUNCE_MS = 50;

function isObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

// RFC 7396 JSON Merge Patch: recursive merge. null values on the patch
// delete the key in the target.
function mergePatch(target, patch) {
  if (!isObject(patch)) return patch;
  if (!isObject(target)) target = {};
  for (const key of Object.keys(patch)) {
    const p = patch[key];
    if (p === null) delete target[key];
    else if (isObject(p)) target[key] = mergePatch(target[key], p);
    else target[key] = p;
  }
  return target;
}

// Produce a merge patch that, applied to `prev`, yields `next`.
// Limitation: arrays are not diffed; if arrays differ we include the whole
// replacement. That's fine for our state shape (most arrays are small).
function producePatch(prev, next) {
  if (!isObject(prev) || !isObject(next)) {
    if (prev === next) return {};
    return next;
  }
  const patch = {};
  const keys = new Set([...Object.keys(prev), ...Object.keys(next)]);
  for (const k of keys) {
    const a = prev[k];
    const b = next[k];
    if (a === b) continue;
    if (b === undefined) { patch[k] = null; continue; }
    if (a === undefined) { patch[k] = b; continue; }
    if (isObject(a) && isObject(b)) {
      const sub = producePatch(a, b);
      if (Object.keys(sub).length > 0) patch[k] = sub;
    } else if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length !== b.length || a.some((v, i) => v !== b[i])) patch[k] = b;
    } else {
      patch[k] = b;
    }
  }
  return patch;
}

// Shallow clone first two levels — enough to diff typical world state
// without paying a structured-clone cost each tick. For deeply-mutated
// sub-objects (avatars[id]), we clone deeply so producePatch sees stable
// comparison targets.
function snapshotForDiff(state) {
  return JSON.parse(JSON.stringify(state));
}

function createStateDiffBroadcast({
  debounceMs = DEFAULT_DEBOUNCE_MS,
  sendFull,           // (payloadStr) => broadcast to all
  sendPatch,          // (payloadStr) => broadcast to all
  emitFull = false    // force full-state on every flush (diff disabled)
} = {}) {
  let lastSnapshot = null;
  let timer = null;
  let pendingState = null;

  function flush() {
    timer = null;
    const state = pendingState;
    pendingState = null;
    if (!state) return;

    if (emitFull || !lastSnapshot) {
      const payload = JSON.stringify({ type: 'state', data: state });
      sendFull?.(payload);
      lastSnapshot = snapshotForDiff(state);
      return;
    }

    const nextSnap = snapshotForDiff(state);
    const patch = producePatch(lastSnapshot, nextSnap);
    if (Object.keys(patch).length === 0) return;
    const payload = JSON.stringify({ type: 'patch', patch });
    sendPatch?.(payload);
    lastSnapshot = nextSnap;
  }

  return {
    schedule(state) {
      pendingState = state;
      if (timer) return;
      timer = setTimeout(flush, debounceMs);
      if (timer.unref) timer.unref();
    },
    // Emit a full snapshot immediately (used on a new WS connection).
    emitFullNow(state, sendToClient) {
      const snap = snapshotForDiff(state);
      const payload = JSON.stringify({ type: 'state', data: state });
      sendToClient(payload);
      lastSnapshot = snap;
    },
    flush,
    _debugLastSnapshot() { return lastSnapshot; }
  };
}

module.exports = {
  createStateDiffBroadcast,
  mergePatch,
  producePatch,
  DEFAULT_DEBOUNCE_MS
};
