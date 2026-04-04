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

test('프론트 런타임 통합: sync -> advance -> sync 순서에서 서버 좌표를 최종 진실원으로 유지한다', async () => {
  const { advanceAvatarRuntimeEntries, syncAvatarRuntimeEntries } =
    await loadAvatarRuntime();

  const runtimeMap = new Map();

  syncAvatarRuntimeEntries(
    runtimeMap,
    {
      'agent-sync': {
        id: 'agent-sync',
        x: 2,
        y: 2,
        moving: true,
        state: 'idle',
        bubbleText: '',
        authoritativePosition: true
      }
    },
    0,
    () => 0
  );

  advanceAvatarRuntimeEntries(runtimeMap, { width: 25, height: 25 }, 1000, () => 0.25);

  const afterAdvance = runtimeMap.get('agent-sync');
  assert.deepEqual({ x: afterAdvance.x, y: afterAdvance.y }, { x: 2, y: 2 });

  syncAvatarRuntimeEntries(
    runtimeMap,
    {
      'agent-sync': {
        id: 'agent-sync',
        x: 5,
        y: 4,
        moving: true,
        state: 'idle',
        bubbleText: '',
        authoritativePosition: true
      }
    },
    1200,
    () => 0
  );

  const afterResync = runtimeMap.get('agent-sync');
  assert.deepEqual({ x: afterResync.x, y: afterResync.y }, { x: 5, y: 4 });
  assert.equal(afterResync.direction, 'right');
});
