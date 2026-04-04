const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const mainUrl = pathToFileURL(
  path.join(__dirname, '../frontend/appBootstrap.mjs')
).href;

async function loadFrontendMain() {
  return import(`${mainUrl}?cacheBust=${Date.now()}`);
}

function createFakeWindow(location) {
  const listeners = new Map();
  const timers = new Map();
  let timerSeq = 0;

  return {
    location,
    setTimeout(callback) {
      timerSeq += 1;
      timers.set(timerSeq, callback);
      return timerSeq;
    },
    clearTimeout(timerId) {
      timers.delete(timerId);
    },
    addEventListener(name, listener) {
      listeners.set(name, listener);
    },
    getListener(name) {
      return listeners.get(name);
    },
    timerCount() {
      return timers.size;
    },
    flushTimers() {
      const queued = Array.from(timers.entries());
      timers.clear();
      queued.forEach(([, callback]) => callback());
    }
  };
}

class FakeWebSocket {
  static OPEN = 1;
  static instances = [];

  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.listeners = new Map();
    FakeWebSocket.instances.push(this);
  }

  addEventListener(name, listener) {
    if (!this.listeners.has(name)) {
      this.listeners.set(name, []);
    }

    this.listeners.get(name).push(listener);
  }

  emit(name, payload = {}) {
    const handlers = this.listeners.get(name) || [];
    handlers.forEach(handler => handler(payload));
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.emit('open');
  }

  close() {
    this.readyState = 3;
    this.emit('close');
  }
}

class FakeWorldMap {
  static instances = [];

  constructor(root, options) {
    this.root = root;
    this.options = options;
    this.started = false;
    this.destroyed = false;
    this.states = [];
    FakeWorldMap.instances.push(this);
  }

  start() {
    this.started = true;
  }

  setWorldState(state) {
    this.states.push(state);
  }

  destroy() {
    this.destroyed = true;
  }
}

test('프론트 smoke: main 부트 경로가 DOM/WS/재연결 흐름을 처리한다', async () => {
  FakeWebSocket.instances = [];
  FakeWorldMap.instances = [];

  const rootElement = {};
  const statusBadge = { textContent: '', dataset: {} };
  const documentLike = {
    getElementById(id) {
      if (id === 'root') {
        return rootElement;
      }

      if (id === 'connection-status') {
        return statusBadge;
      }

      return null;
    }
  };

  const windowLike = createFakeWindow({
    protocol: 'https:',
    hostname: 'world.local',
    search: '?apiPort=3200&wsPort=3201'
  });

  let fetchCallCount = 0;
  let wsTicketIssueCount = 0;
  const fetchImpl = async (url, options) => {
    fetchCallCount += 1;
    if (url === 'https://world.local:3200/state') {
      assert.deepEqual(options, {
        headers: { authorization: 'Bearer smoke-token' }
      });
      return {
        ok: true,
        async json() {
          return {
            data: {
              avatars: {
                bootstrap: {
                  id: 'bootstrap',
                  x: 1,
                  y: 2,
                  moving: false,
                  state: 'idle',
                  bubbleText: ''
                }
              }
            }
          };
        }
      };
    }

    if (url === 'https://world.local:3200/auth/ws-ticket') {
      wsTicketIssueCount += 1;
      assert.deepEqual(options, {
        method: 'POST',
        headers: {
          authorization: 'Bearer smoke-token',
          'content-type': 'application/json'
        },
        body: '{}'
      });
      return {
        ok: true,
        async json() {
          return {
            status: 'ok',
            ticket: `ticket-${wsTicketIssueCount}`,
            ttlMs: 15000,
            expiresAt: '2026-04-03T10:00:00.000Z'
          };
        }
      };
    }

    throw new Error(`Unexpected fetch URL: ${url}`);
  };

  const { bootstrapFrontendApp } = await loadFrontendMain();
  const app = bootstrapFrontendApp({
    windowLike,
    documentLike,
    fetchImpl,
    WebSocketImpl: FakeWebSocket,
    WorldMapClass: FakeWorldMap,
    connectionConfigOptions: {
      environment: 'production',
      authToken: 'smoke-token'
    }
  });

  const worldMap = FakeWorldMap.instances[0];
  assert.equal(FakeWorldMap.instances.length, 1);
  assert.equal(worldMap.started, true);
  assert.equal(worldMap.options.assetRoot, '/assets/pixymoon/Cute RPG World');

  await Promise.resolve();
  await Promise.resolve();
  assert.equal(fetchCallCount, 2);
  assert.equal(wsTicketIssueCount, 1);
  assert.equal(worldMap.states.length, 1);

  for (let attempt = 0; attempt < 5 && FakeWebSocket.instances.length === 0; attempt += 1) {
    await Promise.resolve();
  }
  assert.equal(FakeWebSocket.instances.length, 1);
  const socket = FakeWebSocket.instances[0];
  assert.equal(socket.url, 'wss://world.local:3201/?ticket=ticket-1');

  socket.open();
  assert.equal(statusBadge.textContent, 'Live');
  assert.equal(statusBadge.dataset.state, 'live');

  socket.emit('message', {
    data: JSON.stringify({
      type: 'state',
      data: {
        avatars: {
          runtime: {
            id: 'runtime',
            x: 3,
            y: 4,
            moving: true,
            state: 'working',
            bubbleText: 'hi'
          }
        }
      }
    })
  });
  assert.equal(worldMap.states.length, 2);

  socket.readyState = 3;
  socket.emit('close');
  assert.equal(statusBadge.textContent, 'Reconnecting...');
  assert.equal(statusBadge.dataset.state, 'reconnecting');
  assert.equal(windowLike.timerCount(), 1);

  windowLike.flushTimers();
  for (let attempt = 0; attempt < 8 && FakeWebSocket.instances.length < 2; attempt += 1) {
    await Promise.resolve();
  }
  assert.equal(FakeWebSocket.instances.length, 2);
  assert.equal(wsTicketIssueCount, 2);

  const beforeUnloadHandler = windowLike.getListener('beforeunload');
  assert.equal(typeof beforeUnloadHandler, 'function');
  beforeUnloadHandler();
  assert.equal(worldMap.destroyed, true);

  app.destroy();
});
