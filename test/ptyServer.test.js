// Exercise the PTY manager without actually forking a real PTY on every
// test run. We inject a stub node-pty via `require.cache` replacement so
// `attach()` behaviour is testable without the native helper binary.

const test = require('node:test');
const assert = require('node:assert/strict');

const ptyPath = require.resolve('node-pty');
let attachArgs = null;
let killedPids = [];
function stubPtyModule() {
  require.cache[ptyPath] = {
    id: ptyPath,
    filename: ptyPath,
    loaded: true,
    exports: {
      spawn(file, args, opts) {
        attachArgs = { file, args, opts };
        const listeners = { data: [], exit: [] };
        let nextPid = 40000 + Math.floor(Math.random() * 10000);
        return {
          pid: nextPid,
          onData(cb) { listeners.data.push(cb); },
          onExit(cb) { listeners.exit.push(cb); },
          write() {},
          resize() {},
          kill() { killedPids.push(nextPid); setTimeout(() => listeners.exit.forEach(cb => cb({ exitCode: 0, signal: 0 })), 0); },
          _emit(chunk) { listeners.data.forEach(cb => cb(chunk)); }
        };
      }
    }
  };
}

stubPtyModule();

const { createPtyManager } = require('../server/ptyServer');

function fakeWs() {
  const events = {};
  const ws = {
    readyState: 1, // OPEN
    OPEN: 1,
    messages: [],
    closes: [],
    on(type, cb) { (events[type] ||= []).push(cb); },
    send(data) { this.messages.push(data); },
    close(code, reason) { this.closes.push({ code, reason }); this.readyState = 3; (events.close || []).forEach(cb => cb(code, Buffer.from(reason || ''))); }
  };
  return { ws, events };
}

function stubSnapshotter(sessions = []) {
  const map = new Map(sessions.map(s => [s.sessionId, s]));
  return { lastSessions: map };
}

test('refuses attach when cwd does not match a known session', () => {
  killedPids = [];
  const snapshotter = stubSnapshotter([
    { sessionId: 'sess-A', cwd: '/Users/x/real', name: 'real', pid: 100 }
  ]);
  const mgr = createPtyManager({ claudeSnapshotter: () => snapshotter });
  const { ws } = fakeWs();
  const result = mgr.attach(ws, { sessionId: 'sess-A', cwd: '/Users/x/FORGED' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'cwd-mismatch');
  assert.equal(ws.closes[0].code, 4003);
});

test('refuses second attach on same sessionId with 4090', () => {
  killedPids = [];
  const snapshotter = stubSnapshotter([
    { sessionId: 'sess-B', cwd: '/Users/x/real', name: 'real', pid: 101 }
  ]);
  const mgr = createPtyManager({ claudeSnapshotter: () => snapshotter });
  const { ws: ws1 } = fakeWs();
  const r1 = mgr.attach(ws1, { sessionId: 'sess-B', mode: 'shell' });
  // Without AGENT_WORLD_PTY_ALLOW_SHELL, shell mode falls back to claude
  // binary lookup which may not exist — but the stub spawn always succeeds.
  // We only need the first attach to occupy the slot.
  if (!r1.ok) {
    // Force claude-bin to be present by setting the env var.
    process.env.AGENT_WORLD_PTY_ALLOW_SHELL = '1';
    const { ws: ws1b } = fakeWs();
    const r1b = mgr.attach(ws1b, { sessionId: 'sess-B', mode: 'shell' });
    assert.equal(r1b.ok, true);
  } else {
    assert.equal(r1.ok, true);
  }
  const { ws: ws2 } = fakeWs();
  const r2 = mgr.attach(ws2, { sessionId: 'sess-B', mode: 'shell' });
  assert.equal(r2.ok, false);
  assert.equal(r2.reason, 'already-attached');
  assert.equal(ws2.closes[0].code, 4090);
  delete process.env.AGENT_WORLD_PTY_ALLOW_SHELL;
});

test('successful attach emits a ready control message', () => {
  killedPids = [];
  process.env.AGENT_WORLD_PTY_ALLOW_SHELL = '1';
  const snapshotter = stubSnapshotter([
    { sessionId: 'sess-C', cwd: '/tmp', name: 'tmp', pid: 102 }
  ]);
  const mgr = createPtyManager({ claudeSnapshotter: () => snapshotter });
  const { ws } = fakeWs();
  const result = mgr.attach(ws, { sessionId: 'sess-C', mode: 'shell', cols: 90, rows: 25 });
  assert.equal(result.ok, true);
  const intro = JSON.parse(ws.messages[0]);
  assert.equal(intro.type, 'ready');
  assert.equal(intro.sessionId, 'sess-C');
  assert.equal(intro.cwd, '/tmp');
  assert.equal(intro.cols, 90);
  delete process.env.AGENT_WORLD_PTY_ALLOW_SHELL;
});
