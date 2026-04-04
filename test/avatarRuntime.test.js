const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const moduleUrl = pathToFileURL(
  path.join(__dirname, '../frontend/avatarRuntime.mjs')
).href;

async function loadAvatarRuntime() {
  return import(moduleUrl);
}

test('moving=true에서도 서버 좌표를 즉시 반영해 드리프트를 수렴한다', async () => {
  const { syncAvatarRuntimeEntries } = await loadAvatarRuntime();

  const runtimeMap = new Map([
    [
      'agent-1',
      {
        x: 1,
        y: 1,
        moving: true,
        state: 'idle',
        bubbleText: '',
        direction: 'down',
        nextMoveAt: 500
      }
    ]
  ]);

  syncAvatarRuntimeEntries(
    runtimeMap,
    {
      'agent-1': {
        id: 'agent-1',
        x: 4,
        y: 1,
        moving: true,
        state: 'idle',
        bubbleText: '',
        authoritativePosition: true
      }
    },
    100,
    () => 0.1
  );

  const runtime = runtimeMap.get('agent-1');
  assert.equal(runtime.x, 4);
  assert.equal(runtime.y, 1);
  assert.equal(runtime.direction, 'right');
  assert.equal(runtime.authoritativePosition, true);
});

test('authoritativePosition=true 엔트리는 랜덤 이동 업데이트에서 제외한다', async () => {
  const { advanceAvatarRuntimeEntries } = await loadAvatarRuntime();

  const runtimeMap = new Map([
    [
      'auth',
      {
        x: 3,
        y: 3,
        moving: true,
        authoritativePosition: true,
        direction: 'down',
        nextMoveAt: 0
      }
    ],
    [
      'fallback',
      {
        x: 3,
        y: 3,
        moving: true,
        authoritativePosition: false,
        direction: 'down',
        nextMoveAt: 0
      }
    ]
  ]);

  advanceAvatarRuntimeEntries(runtimeMap, { width: 8, height: 8 }, 1000, () => 0.25);

  const authoritative = runtimeMap.get('auth');
  const fallback = runtimeMap.get('fallback');

  assert.deepEqual(
    { x: authoritative.x, y: authoritative.y },
    { x: 3, y: 3 }
  );
  assert.equal(fallback.x, 4);
  assert.equal(fallback.y, 3);
  assert.equal(fallback.direction, 'right');
});

test('sync는 사라진 avatar 엔트리를 정리한다', async () => {
  const { syncAvatarRuntimeEntries } = await loadAvatarRuntime();

  const runtimeMap = new Map([
    ['alive', { x: 0, y: 0, moving: false }],
    ['stale', { x: 1, y: 1, moving: false }]
  ]);

  syncAvatarRuntimeEntries(
    runtimeMap,
    {
      alive: {
        id: 'alive',
        x: 0,
        y: 0,
        moving: false,
        state: 'idle',
        bubbleText: '',
        authoritativePosition: true
      }
    },
    200,
    () => 0
  );

  assert.equal(runtimeMap.has('alive'), true);
  assert.equal(runtimeMap.has('stale'), false);
});
