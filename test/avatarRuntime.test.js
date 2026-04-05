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

test('moving=true 에이전트는 클라이언트 이동을 허용하고 서버 좌표를 덮어쓰지 않는다', async () => {
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

  // Server says x=4, but agent is already moving client-side (prevMoving=true)
  // so position should NOT be snapped to server value
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
  // Position stays at client value — server doesn't override moving agents
  assert.equal(runtime.x, 1);
  assert.equal(runtime.y, 1);
  // authoritativePosition becomes false when moving=true
  assert.equal(runtime.authoritativePosition, false);
});

test('moving=false→true 전환 시 서버 좌표를 한 번 수용한다', async () => {
  const { syncAvatarRuntimeEntries } = await loadAvatarRuntime();

  const runtimeMap = new Map([
    [
      'agent-1',
      {
        x: 1,
        y: 1,
        moving: false,  // was not moving (working)
        state: 'working',
        bubbleText: 'fixing bug',
        direction: 'down',
        nextMoveAt: 500
      }
    ]
  ]);

  // Server transitions to idle with new position — should snap once
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
  // Position snaps because prevMoving was false (transition)
  assert.equal(runtime.x, 4);
  assert.equal(runtime.y, 1);
  assert.equal(runtime.authoritativePosition, false);
});

test('authoritativePosition=true 엔트리는 로컬 이동을 건너뛰고, false 엔트리만 이동한다', async () => {
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

  // rng=0.0 → MOVES[0] = [1,0] (right)
  advanceAvatarRuntimeEntries(runtimeMap, { width: 8, height: 8 }, 1000, () => 0.0);

  const authoritative = runtimeMap.get('auth');
  const fallback = runtimeMap.get('fallback');

  // Authoritative agents skip local movement — position comes from server
  assert.equal(authoritative.x, 3);
  assert.equal(authoritative.y, 3);
  assert.equal(authoritative.direction, 'down');
  // Non-authoritative agents move locally
  assert.equal(fallback.x, 4);
  assert.equal(fallback.y, 3);
  assert.equal(fallback.direction, 'right');
});

test('blockedTiles에 포함된 타일로는 이동하지 않는다', async () => {
  const { advanceAvatarRuntimeEntries } = await loadAvatarRuntime();

  const runtimeMap = new Map([
    [
      'agent',
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

  // rng=0.0 → MOVES[0] = [1,0] (right) → target (4,3)
  const blocked = new Set(['4,3']);
  advanceAvatarRuntimeEntries(runtimeMap, { width: 8, height: 8 }, 1000, () => 0.0, blocked);

  const agent = runtimeMap.get('agent');
  // Target was (4,3) but it's blocked, so position stays
  assert.equal(agent.x, 3);
  assert.equal(agent.y, 3);
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

test('idle 에이전트는 야외 rest 스테이션을 목적지로 선택한다', async () => {
  const { advanceAvatarRuntimeEntries } = await loadAvatarRuntime();

  // Runtime starts with no destination — should pick from station list.
  const runtimeMap = new Map([[
    'idle-1', {
      id: 'idle-1', x: 5, y: 5,
      moving: true, state: 'idle', bubbleText: '',
      direction: 'down', nextMoveAt: 0, path: null, pathIndex: 0,
      arrivalPauseUntil: 0, authoritativePosition: false,
      currentDestination: null, agentSeed: 1
    }
  ]]);

  const stations = [
    { id: 'pond_fish', kind: 'rest', type: 'outdoor.fishing',
      label: 'fishing spot', activity: 'fishing by the pond',
      locationId: null, locationName: 'outdoors', x: 22, y: 13 },
    { id: 'nap_grass', kind: 'rest', type: 'outdoor.napping',
      label: 'shady tree', activity: 'napping under a tree',
      locationId: null, locationName: 'outdoors', x: 8, y: 7 }
  ];

  advanceAvatarRuntimeEntries(
    runtimeMap, { width: 30, height: 30 }, 1000, () => 0.5,
    null, [], stations
  );

  const runtime = runtimeMap.get('idle-1');
  assert.ok(runtime.currentDestination, 'should have picked a destination');
  assert.ok(
    ['pond_fish', 'nap_grass'].includes(runtime.currentDestination.stationId),
    'destination should be an outdoor rest station'
  );
  // Bubble text should reflect the outdoor activity or station label.
  assert.ok(
    runtime.bubbleText && runtime.bubbleText.length > 0,
    `bubbleText "${runtime.bubbleText}" should be set`
  );
  assert.ok(
    /fishing|napping|shady|pond/.test(runtime.bubbleText),
    `bubbleText "${runtime.bubbleText}" should mention outdoor station`
  );
});

test('스테이션이 1개뿐일 때도 에이전트는 그 스테이션을 다시 선택할 수 있다', async () => {
  const { advanceAvatarRuntimeEntries } = await loadAvatarRuntime();
  // Single station, agent already claimed it, pause over → must re-pick
  const runtimeMap = new Map([[
    'only', {
      id: 'only', x: 10, y: 10,
      moving: true, state: 'idle', bubbleText: '',
      direction: 'down', nextMoveAt: 0, path: null, pathIndex: 0,
      arrivalPauseUntil: 1, // past-due → triggers re-pick
      authoritativePosition: false, agentSeed: 1,
      currentDestination: { stationId: 's1', locationId: null, locationName: 'outdoors',
        stationLabel: 'only', stationKind: 'rest', stationActivity: 'resting', x: 10, y: 10 }
    }
  ]]);
  const stations = [
    { id: 's1', kind: 'rest', type: 'outdoor.sitting', label: 'only',
      activity: 'resting', locationId: null, locationName: 'outdoors', x: 10, y: 10 }
  ];
  advanceAvatarRuntimeEntries(
    runtimeMap, { width: 30, height: 30 }, 2000, () => 0.5,
    null, [], stations
  );
  const runtime = runtimeMap.get('only');
  assert.ok(runtime.currentDestination, 'should have a destination (even if same as before)');
  assert.equal(runtime.currentDestination.stationId, 's1');
});

test('두 에이전트는 같은 스테이션을 claim하지 않는다', async () => {
  const { advanceAvatarRuntimeEntries } = await loadAvatarRuntime();

  const mkRuntime = (id, seed) => ({
    id, x: 0, y: 0, moving: true, state: 'rest' === 'rest' ? 'idle' : 'idle',
    bubbleText: '', direction: 'down', nextMoveAt: 0, path: null, pathIndex: 0,
    arrivalPauseUntil: 0, authoritativePosition: false,
    currentDestination: null, agentSeed: seed
  });
  const runtimeMap = new Map([
    ['a', mkRuntime('a', 1)],
    ['b', mkRuntime('b', 2)]
  ]);

  const stations = [
    { id: 's1', kind: 'rest', type: 'outdoor.flowers', label: 'nw',
      activity: 'enjoying flowers', locationId: null, locationName: 'outdoors', x: 10, y: 10 },
    { id: 's2', kind: 'rest', type: 'outdoor.flowers', label: 'ne',
      activity: 'enjoying flowers', locationId: null, locationName: 'outdoors', x: 20, y: 10 }
  ];

  advanceAvatarRuntimeEntries(
    runtimeMap, { width: 30, height: 30 }, 1000, () => 0.5,
    null, [], stations
  );

  const a = runtimeMap.get('a');
  const b = runtimeMap.get('b');
  assert.ok(a.currentDestination && b.currentDestination, 'both should pick destinations');
  assert.notEqual(a.currentDestination.stationId, b.currentDestination.stationId,
    'two agents should not share the same station claim');
});
