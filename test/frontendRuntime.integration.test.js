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

test('프론트 런타임 통합: moving=true인 에이전트는 클라이언트 이동 후에도 서버 좌표로 덮어씌워지지 않는다', async () => {
  const { advanceAvatarRuntimeEntries, syncAvatarRuntimeEntries } =
    await loadAvatarRuntime();

  const runtimeMap = new Map();

  // First sync: agent created at (2,2), moving=true → client movement allowed
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

  // Agent starts at (2,2) from first sync
  const afterSync = runtimeMap.get('agent-sync');
  assert.deepEqual({ x: afterSync.x, y: afterSync.y }, { x: 2, y: 2 });
  // authoritativePosition should be false since moving=true
  assert.equal(afterSync.authoritativePosition, false);

  // Advance: agent moves freely (rng=0.25 → MOVES[2] = [0,1] → down)
  advanceAvatarRuntimeEntries(runtimeMap, { width: 25, height: 25 }, 1000, () => 0.25);

  const afterAdvance = runtimeMap.get('agent-sync');
  // Agent should have moved (not frozen at 2,2)
  assert.notDeepEqual({ x: afterAdvance.x, y: afterAdvance.y }, { x: 2, y: 2 });

  // Second sync: server says (5,4) but agent is already moving client-side
  // so position should NOT be overridden
  const posBeforeResync = { x: afterAdvance.x, y: afterAdvance.y };
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
  // Position stays at client-side value, not overridden by server
  assert.deepEqual({ x: afterResync.x, y: afterResync.y }, posBeforeResync);
});

test('프론트 런타임 통합: working 에이전트는 서버 좌표를 최종 진실원으로 유지한다', async () => {
  const { advanceAvatarRuntimeEntries, syncAvatarRuntimeEntries } =
    await loadAvatarRuntime();

  const runtimeMap = new Map();

  // Sync: working agent at (3,3) — position should be locked
  syncAvatarRuntimeEntries(
    runtimeMap,
    {
      'agent-work': {
        id: 'agent-work',
        x: 3,
        y: 3,
        moving: false,
        state: 'working',
        bubbleText: 'fixing bug',
        authoritativePosition: true
      }
    },
    0,
    () => 0
  );

  const afterSync = runtimeMap.get('agent-work');
  assert.equal(afterSync.authoritativePosition, true);

  // Advance should NOT move a working agent
  advanceAvatarRuntimeEntries(runtimeMap, { width: 25, height: 25 }, 1000, () => 0.25);

  const afterAdvance = runtimeMap.get('agent-work');
  assert.deepEqual({ x: afterAdvance.x, y: afterAdvance.y }, { x: 3, y: 3 });

  // Server updates position → should be applied since working
  syncAvatarRuntimeEntries(
    runtimeMap,
    {
      'agent-work': {
        id: 'agent-work',
        x: 6,
        y: 5,
        moving: false,
        state: 'working',
        bubbleText: 'reviewing PR',
        authoritativePosition: true
      }
    },
    1200,
    () => 0
  );

  const afterResync = runtimeMap.get('agent-work');
  assert.deepEqual({ x: afterResync.x, y: afterResync.y }, { x: 6, y: 5 });
});
