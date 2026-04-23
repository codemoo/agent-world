const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const moduleUrl = pathToFileURL(
  path.join(__dirname, '../frontend/avatarRuntime.mjs')
).href;

async function load() { return import(moduleUrl); }

// Seeded RNG: deterministic 0.1 so every rng() > 0.20 test (group
// start chance) fires on the first eligible tick.
const alwaysLow = () => 0.1;

function mkRt(overrides = {}) {
  return {
    id: 'x', x: 14, y: 14,
    moving: false, state: 'idle', bubbleText: '',
    direction: 'down', nextMoveAt: 0, path: null, pathIndex: 0,
    arrivalPauseUntil: 999_999_999,     // stay seated throughout the test
    authoritativePosition: true,
    currentDestination: { stationId: 'cf_table', locationId: 'cafe', x: 14, y: 14 },
    intent: null,
    chatPauseUntil: 0, chatCooldownUntil: 0,
    chatRecentPartners: {}, chatRecentGroups: {},
    reactionCooldowns: {}, reactionEmote: null,
    interactionKind: 'tavern_seat',
    serverStatus: 'Idle',
    agentSeed: 0,
    ...overrides
  };
}

test('3 agents at cafe → group forms', async () => {
  const { advanceAvatarRuntimeEntries } = await load();
  const stations = [
    { id: 'cf_table', kind: 'rest', type: 'chair', locationId: 'cafe' }
  ];
  const a = mkRt({ id: 'a', x: 14, y: 14 });
  const b = mkRt({ id: 'b', x: 15, y: 14 });
  const c = mkRt({ id: 'c', x: 14, y: 15 });
  const runtimeMap = new Map([['a', a], ['b', b], ['c', c]]);

  advanceAvatarRuntimeEntries(
    runtimeMap, { width: 30, height: 30 }, 1000, alwaysLow,
    null, [], stations
  );

  assert.ok(a.groupId, 'a joined a group');
  assert.equal(b.groupId, a.groupId);
  assert.equal(c.groupId, a.groupId);
  assert.ok(a.chatPauseUntil > 1000);
  assert.equal(a.chatPauseUntil, b.chatPauseUntil);
});

test('group with 2 members does NOT form', async () => {
  const { advanceAvatarRuntimeEntries } = await load();
  const stations = [
    { id: 'cf_table', kind: 'rest', type: 'chair', locationId: 'cafe' }
  ];
  const a = mkRt({ id: 'a', x: 14, y: 14 });
  const b = mkRt({ id: 'b', x: 15, y: 14 });
  const runtimeMap = new Map([['a', a], ['b', b]]);
  advanceAvatarRuntimeEntries(
    runtimeMap, { width: 30, height: 30 }, 1000, alwaysLow,
    null, [], stations
  );
  assert.equal(a.groupId, undefined);
  assert.equal(b.groupId, undefined);
});

test('3 agents at desk (non-social) → NO group forms', async () => {
  const { advanceAvatarRuntimeEntries } = await load();
  const stations = [
    { id: 'ne_chair1', kind: 'work', type: 'chair', locationId: 'home_ne' }
  ];
  const mk = id => mkRt({
    id,
    currentDestination: { stationId: 'ne_chair1', locationId: 'home_ne', x: 14, y: 14 },
    interactionKind: 'desk'
  });
  const a = mk('a'), b = mk('b'), c = mk('c');
  const runtimeMap = new Map([['a', a], ['b', b], ['c', c]]);
  advanceAvatarRuntimeEntries(
    runtimeMap, { width: 30, height: 30 }, 1000, alwaysLow,
    null, [], stations
  );
  assert.equal(a.groupId, undefined);
  assert.equal(b.groupId, undefined);
  assert.equal(c.groupId, undefined);
});

test('group disband → pair cooldown applied to all members', async () => {
  const { advanceAvatarRuntimeEntries } = await load();
  const stations = [
    { id: 'cf_table', kind: 'rest', type: 'chair', locationId: 'cafe' }
  ];
  const a = mkRt({ id: 'a', x: 14, y: 14 });
  const b = mkRt({ id: 'b', x: 15, y: 14 });
  const c = mkRt({ id: 'c', x: 14, y: 15 });
  const runtimeMap = new Map([['a', a], ['b', b], ['c', c]]);

  advanceAvatarRuntimeEntries(
    runtimeMap, { width: 30, height: 30 }, 1000, alwaysLow,
    null, [], stations
  );
  const endAt = a.chatPauseUntil;
  assert.ok(endAt > 1000);

  // Tick forward past the group window → disband.
  advanceAvatarRuntimeEntries(
    runtimeMap, { width: 30, height: 30 }, endAt + 100, alwaysLow,
    null, [], stations
  );
  assert.equal(a.groupId, null);
  // a remembers b + c with pair cooldown ≈ 45s ahead.
  assert.ok(a.chatRecentPartners['b'] > endAt + 100);
  assert.ok(a.chatRecentPartners['c'] > endAt + 100);
  assert.ok(b.chatRecentPartners['a'] > endAt + 100);
  assert.ok(c.chatRecentPartners['a'] > endAt + 100);
});

test('group reform suppressor: no re-form for 60s at same location', async () => {
  const { advanceAvatarRuntimeEntries } = await load();
  const stations = [
    { id: 'cf_table', kind: 'rest', type: 'chair', locationId: 'cafe' }
  ];
  const a = mkRt({ id: 'a', x: 14, y: 14 });
  const b = mkRt({ id: 'b', x: 15, y: 14 });
  const c = mkRt({ id: 'c', x: 14, y: 15 });
  const runtimeMap = new Map([['a', a], ['b', b], ['c', c]]);
  advanceAvatarRuntimeEntries(
    runtimeMap, { width: 30, height: 30 }, 1000, alwaysLow,
    null, [], stations
  );
  const firstEnd = a.chatPauseUntil;

  // Disband (now past group window).
  advanceAvatarRuntimeEntries(
    runtimeMap, { width: 30, height: 30 }, firstEnd + 100, alwaysLow,
    null, [], stations
  );
  // chatRecentGroups['cafe'] = (firstEnd+100) + 60_000 ≈ 151_100.
  assert.ok(a.chatRecentGroups['cafe'] > firstEnd + 100);

  // Clear ALL chat state between ticks so we isolate the group
  // reform suppressor — otherwise the 1:1 pair loop fires at tick 2
  // (after disband) and leaves a fresh chatCooldownUntil on tick 3
  // that masks what we're trying to measure.
  const freshChat = r => {
    r.chatPauseUntil = 0;
    r.chatCooldownUntil = 0;
    r.chatQueue = null;
    r.chatPartnerId = null;
    r.chat = null;
    r.chatRecentPartners = {};
  };

  // Try to re-form 10s later — suppressed by chatRecentGroups['cafe'].
  [a, b, c].forEach(freshChat);
  advanceAvatarRuntimeEntries(
    runtimeMap, { width: 30, height: 30 }, firstEnd + 10_000, alwaysLow,
    null, [], stations
  );
  assert.equal(a.groupId || null, null, 'reform suppressed within 60s');

  // Try 70s later — past the reform cooldown → allowed.
  [a, b, c].forEach(freshChat);
  advanceAvatarRuntimeEntries(
    runtimeMap, { width: 30, height: 30 }, firstEnd + 70_000, alwaysLow,
    null, [], stations
  );
  assert.ok(a.groupId, 'reform allowed after 60s reform cooldown');
});

test('group members skip the 1:1 pair pass (chatPauseUntil keeps them out)', async () => {
  const { advanceAvatarRuntimeEntries } = await load();
  const stations = [
    { id: 'cf_table', kind: 'rest', type: 'chair', locationId: 'cafe' }
  ];
  const a = mkRt({ id: 'a', x: 14, y: 14 });
  const b = mkRt({ id: 'b', x: 15, y: 14 });
  const c = mkRt({ id: 'c', x: 14, y: 15 });
  const runtimeMap = new Map([['a', a], ['b', b], ['c', c]]);
  advanceAvatarRuntimeEntries(
    runtimeMap, { width: 30, height: 30 }, 1000, alwaysLow,
    null, [], stations
  );
  // All three in a group. Pair loop should not set chatPartnerId.
  assert.equal(a.chatPartnerId, null);
  assert.equal(b.chatPartnerId, null);
  assert.equal(c.chatPartnerId, null);
});

test('huddle: members get renderOffset toward centroid (visual lean-in)', async () => {
  const { advanceAvatarRuntimeEntries } = await load();
  const stations = [
    { id: 'cf_table', kind: 'rest', type: 'chair', locationId: 'cafe' }
  ];
  const a = mkRt({ id: 'a', x: 10, y: 10 });
  const b = mkRt({ id: 'b', x: 14, y: 10 });
  const c = mkRt({ id: 'c', x: 12, y: 13 });
  const runtimeMap = new Map([['a', a], ['b', b], ['c', c]]);
  advanceAvatarRuntimeEntries(
    runtimeMap, { width: 30, height: 30 }, 1000, alwaysLow,
    null, [], stations
  );
  assert.ok(a.groupId, 'group formed');
  // Centroid ≈ (12, 11). 'a' at (10,10) leans toward right+down.
  assert.ok(a.renderOffsetX > 0, 'a leans east toward centroid');
  assert.ok(a.renderOffsetY > 0, 'a leans south toward centroid');
  // Magnitude bounded — ~0.30 tiles.
  const mag = Math.hypot(a.renderOffsetX, a.renderOffsetY);
  assert.ok(mag > 0.25 && mag < 0.35, `magnitude ${mag} within ~0.30`);
});

test('huddle offset cleared on disband', async () => {
  const { advanceAvatarRuntimeEntries } = await load();
  const stations = [
    { id: 'cf_table', kind: 'rest', type: 'chair', locationId: 'cafe' }
  ];
  const a = mkRt({ id: 'a', x: 10, y: 10 });
  const b = mkRt({ id: 'b', x: 14, y: 10 });
  const c = mkRt({ id: 'c', x: 12, y: 13 });
  const runtimeMap = new Map([['a', a], ['b', b], ['c', c]]);
  advanceAvatarRuntimeEntries(
    runtimeMap, { width: 30, height: 30 }, 1000, alwaysLow,
    null, [], stations
  );
  const endAt = a.chatPauseUntil;
  advanceAvatarRuntimeEntries(
    runtimeMap, { width: 30, height: 30 }, endAt + 100, alwaysLow,
    null, [], stations
  );
  assert.equal(a.renderOffsetX, 0);
  assert.equal(a.renderOffsetY, 0);
});

test('outdoor plaza bucket: plaza-type agents use outdoor:plaza key', async () => {
  const { advanceAvatarRuntimeEntries } = await load();
  // The real worldModel has only one 'outdoor.chatting' station so
  // three real agents cannot hold plaza simultaneously. Stub three
  // plaza-type stations for this test to confirm that the outdoor
  // bucket code path works when future worldModel edits add more.
  const stations = [
    { id: 'p1', kind: 'rest', type: 'outdoor.chatting' },
    { id: 'p2', kind: 'rest', type: 'outdoor.chatting' },
    { id: 'p3', kind: 'rest', type: 'outdoor.chatting' }
  ];
  const mk = (id, stationId, x, y) => mkRt({
    id, x, y,
    currentDestination: { stationId, locationId: null, x, y }
  });
  const a = mk('a', 'p1', 13, 13);
  const b = mk('b', 'p2', 14, 14);
  const c = mk('c', 'p3', 15, 13);
  const runtimeMap = new Map([['a', a], ['b', b], ['c', c]]);
  advanceAvatarRuntimeEntries(
    runtimeMap, { width: 30, height: 30 }, 1000, alwaysLow,
    null, [], stations
  );
  assert.ok(a.groupId, 'plaza-type agents form a group');
  assert.equal(a._groupLocationId, 'outdoor:plaza');
});

test('proximity gate: members beyond centroid-5 chebyshev do NOT group', async () => {
  const { advanceAvatarRuntimeEntries } = await load();
  const stations = [
    { id: 'cf_1', kind: 'rest', type: 'chair', locationId: 'cafe' }
  ];
  // Three cafe members, but one is far away — simulated by stretching
  // coordinates so the centroid-radius check fails.
  const a = mkRt({ id: 'a', x: 0, y: 0 });
  const b = mkRt({ id: 'b', x: 5, y: 0 });
  const c = mkRt({ id: 'c', x: 29, y: 29 });
  const runtimeMap = new Map([['a', a], ['b', b], ['c', c]]);
  advanceAvatarRuntimeEntries(
    runtimeMap, { width: 30, height: 30 }, 1000, alwaysLow,
    null, [], stations
  );
  assert.equal(a.groupId, undefined,
    'members too far apart do not form a group');
});

test('GROUP_START_CHANCE gate: rng above threshold suppresses formation', async () => {
  const { advanceAvatarRuntimeEntries } = await load();
  const stations = [
    { id: 'cf_table', kind: 'rest', type: 'chair', locationId: 'cafe' }
  ];
  const a = mkRt({ id: 'a' });
  const b = mkRt({ id: 'b' });
  const c = mkRt({ id: 'c' });
  const runtimeMap = new Map([['a', a], ['b', b], ['c', c]]);
  advanceAvatarRuntimeEntries(
    runtimeMap, { width: 30, height: 30 }, 1000, () => 0.99,
    null, [], stations
  );
  assert.equal(a.groupId, undefined,
    'rng 0.99 > GROUP_START_CHANCE (0.20) — no formation');
});
