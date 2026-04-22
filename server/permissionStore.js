// Pending permission requests from PreToolUse hooks, awaiting browser
// resolution. Each entry holds the hook's reply Promise; the hook
// script blocks on this server's response until the browser either
// Allow/Deny-s, or TIMEOUT_MS elapses and we fall back to `ask` (let
// the CLI show its normal prompt).
//
// Design notes:
//   • The hook script is a trusted local process — it can only run if
//     the user installed our plugin via `npm run install-hooks`. So we
//     don't authenticate the hook's POST; we DO bind requestId back to
//     an allocated entry so the browser can route its decision.
//   • The browser DOES authenticate (bearer token + ws ticket), same
//     as the rest of the app.
//   • Events fire on `events` so the WS broadcast layer can push them
//     to connected clients.

const { EventEmitter } = require('node:events');
const crypto = require('node:crypto');

const DEFAULT_TIMEOUT_MS = 90_000;
const MAX_PENDING = 50;

function makeRequestId() {
  return `pr_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
}

function createPermissionStore(options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
  const events = new EventEmitter();
  // requestId → entry
  const pending = new Map();

  function snapshot() {
    const out = [];
    for (const [id, e] of pending) {
      out.push({
        requestId: id,
        sessionId: e.sessionId,
        tool: e.tool,
        toolInput: e.toolInput,
        receivedAt: e.receivedAt,
        expiresAt: e.expiresAt
      });
    }
    return out;
  }

  // Called by the hook POST handler. Returns a Promise that resolves
  // to `{ decision }` where decision ∈ 'allow'|'deny'|'ask'. `ask`
  // means the hook should exit without overriding, letting Claude
  // show its normal CLI prompt.
  function createRequest({ sessionId, tool, toolInput, cwd }) {
    if (pending.size >= MAX_PENDING) {
      return Promise.resolve({ decision: 'ask', reason: 'too many pending' });
    }
    const requestId = makeRequestId();
    const receivedAt = Date.now();
    const expiresAt = receivedAt + timeoutMs;

    let resolveFn;
    const promise = new Promise(resolve => { resolveFn = resolve; });

    const timer = setTimeout(() => {
      if (pending.has(requestId)) {
        pending.delete(requestId);
        events.emit('permission-resolved', {
          requestId, sessionId, decision: 'ask', reason: 'timeout'
        });
        resolveFn({ decision: 'ask', reason: 'timeout' });
      }
    }, timeoutMs);

    pending.set(requestId, {
      sessionId: String(sessionId || 'unknown'),
      tool: String(tool || 'unknown'),
      toolInput: toolInput || null,
      cwd: cwd || null,
      receivedAt,
      expiresAt,
      timer,
      resolve: (decision, reason = null) => {
        if (!pending.has(requestId)) return false;
        clearTimeout(timer);
        pending.delete(requestId);
        events.emit('permission-resolved', { requestId, sessionId, decision, reason });
        resolveFn({ decision, reason });
        return true;
      }
    });

    events.emit('permission-request', {
      requestId,
      sessionId: String(sessionId || 'unknown'),
      tool: String(tool || 'unknown'),
      toolInput: toolInput || null,
      cwd: cwd || null,
      receivedAt,
      expiresAt
    });

    return { requestId, promise };
  }

  // Browser → server. Returns true if the request existed and was
  // resolved; false if already resolved, timed out, or unknown.
  function decide(requestId, decision, reason = null) {
    if (!['allow', 'deny', 'ask'].includes(decision)) return false;
    const entry = pending.get(requestId);
    if (!entry) return false;
    return entry.resolve(decision, reason);
  }

  // Cancel everything (e.g. on server shutdown). Resolves each pending
  // as "ask" so hooks can exit cleanly.
  function destroy() {
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer);
      entry.resolve('ask', 'shutdown');
      pending.delete(id);
    }
  }

  return { createRequest, decide, snapshot, events, destroy, _pending: pending };
}

module.exports = {
  createPermissionStore,
  makeRequestId,
  DEFAULT_TIMEOUT_MS
};
