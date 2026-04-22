const test = require('node:test');
const assert = require('node:assert/strict');

const { createPermissionStore } = require('../server/permissionStore');

test('createRequest emits permission-request event with the same requestId', () => {
  const store = createPermissionStore({ timeoutMs: 1000 });
  const events = [];
  store.events.on('permission-request', e => events.push(e));
  const { requestId } = store.createRequest({
    sessionId: 'sess-A', tool: 'Bash', toolInput: { command: 'ls' }
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].requestId, requestId);
  assert.equal(events[0].tool, 'Bash');
  assert.ok(events[0].expiresAt > Date.now());
});

test('decide resolves the pending promise with the chosen decision', async () => {
  const store = createPermissionStore({ timeoutMs: 1000 });
  const { requestId, promise } = store.createRequest({
    sessionId: 'sess-B', tool: 'Edit', toolInput: { path: '/f' }
  });
  const ok = store.decide(requestId, 'allow', 'user clicked');
  assert.equal(ok, true);
  const result = await promise;
  assert.equal(result.decision, 'allow');
  assert.equal(result.reason, 'user clicked');
});

test('timeout resolves to "ask" when the browser does not respond', async () => {
  const store = createPermissionStore({ timeoutMs: 40 });
  const resolves = [];
  store.events.on('permission-resolved', e => resolves.push(e));
  const { promise } = store.createRequest({
    sessionId: 'sess-C', tool: 'Bash', toolInput: null
  });
  const result = await promise;
  assert.equal(result.decision, 'ask');
  assert.equal(result.reason, 'timeout');
  assert.equal(resolves.length, 1);
  assert.equal(resolves[0].decision, 'ask');
});

test('decide on unknown requestId returns false', () => {
  const store = createPermissionStore({ timeoutMs: 500 });
  assert.equal(store.decide('bogus', 'allow'), false);
});

test('decide rejects invalid decision values', () => {
  const store = createPermissionStore({ timeoutMs: 500 });
  const { requestId } = store.createRequest({ sessionId: 'x', tool: 'Bash' });
  assert.equal(store.decide(requestId, 'maybe'), false);
});

test('MAX_PENDING cap returns ask decision immediately', () => {
  const store = createPermissionStore({ timeoutMs: 500 });
  for (let i = 0; i < 50; i++) {
    store.createRequest({ sessionId: `s${i}`, tool: 'Bash' });
  }
  const result = store.createRequest({ sessionId: 'overflow', tool: 'Bash' });
  // When full, the returned value is a plain Promise<result>, not
  // an { requestId, promise } pair. Detect via duck-typing.
  assert.ok(result && typeof result.then === 'function');
});

test('destroy cleans up all pending and resolves each to ask', async () => {
  const store = createPermissionStore({ timeoutMs: 5000 });
  const { promise: p1 } = store.createRequest({ sessionId: 'a', tool: 'Bash' });
  const { promise: p2 } = store.createRequest({ sessionId: 'b', tool: 'Edit' });
  store.destroy();
  const r1 = await p1;
  const r2 = await p2;
  assert.equal(r1.decision, 'ask');
  assert.equal(r2.decision, 'ask');
  assert.equal(r1.reason, 'shutdown');
});

test('snapshot lists all pending requests with their metadata', () => {
  const store = createPermissionStore({ timeoutMs: 1000 });
  store.createRequest({ sessionId: 'one', tool: 'Bash', toolInput: { command: 'foo' } });
  store.createRequest({ sessionId: 'two', tool: 'Edit', toolInput: { path: '/bar' } });
  const snap = store.snapshot();
  assert.equal(snap.length, 2);
  assert.equal(snap[0].tool, 'Bash');
  assert.equal(snap[1].sessionId, 'two');
});
