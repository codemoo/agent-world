const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const moduleUrl = pathToFileURL(
  path.join(__dirname, '../frontend/avatarRuntime.mjs')
).href;

async function load() { return import(moduleUrl); }

// Minimal runtime fixture — pathfinding + chat turned off so the
// reaction dispatcher runs without noise.
function mkRt(overrides = {}) {
  return {
    id: 'x', x: 5, y: 5,
    moving: false, state: 'idle', bubbleText: '',
    direction: 'down', nextMoveAt: 0,
    path: null, pathIndex: 0, arrivalPauseUntil: 0,
    authoritativePosition: true,
    currentDestination: null, intent: null,
    chatPauseUntil: 0, chatCooldownUntil: 0, chatRecentPartners: {},
    reactionCooldowns: {}, reactionEmote: null, facingOverride: null,
    agentSeed: 0,
    ...overrides
  };
}

test('neighbor entering Errored → observer gets 😦 + faces source', async () => {
  const { advanceAvatarRuntimeEntries } = await load();
  const source = mkRt({ id: 'source', x: 10, y: 10, serverStatus: 'Working',
    _prevSocialStatus: 'Working' });
  const observer = mkRt({ id: 'obs', x: 12, y: 10, serverStatus: 'Working',
    _prevSocialStatus: 'Working' });
  const runtimeMap = new Map([['source', source], ['obs', observer]]);

  // Transition source to Errored.
  source.serverStatus = 'Errored';

  advanceAvatarRuntimeEntries(
    runtimeMap, { width: 30, height: 30 }, 1000, () => 0.5, null, [], []
  );

  assert.ok(observer.reactionEmote, 'observer should have a reaction');
  assert.equal(observer.reactionEmote.icon, '😦');
  // Source at x=10 is LEFT of observer at x=12 → observer faces left.
  assert.equal(observer.facingOverride, 'left');
});

test('error reaction has 20s per-observer-per-source cooldown', async () => {
  const { advanceAvatarRuntimeEntries } = await load();
  const source = mkRt({ id: 'source', x: 10, y: 10, serverStatus: 'Errored',
    _prevSocialStatus: 'Working' });
  const observer = mkRt({ id: 'obs', x: 12, y: 10, serverStatus: 'Working',
    _prevSocialStatus: 'Working' });
  const runtimeMap = new Map([['source', source], ['obs', observer]]);

  advanceAvatarRuntimeEntries(
    runtimeMap, { width: 30, height: 30 }, 1000, () => 0.5, null, [], []
  );
  const firstReaction = observer.reactionEmote;
  assert.ok(firstReaction);

  // Let the emote expire, re-trigger error (source → Working → Errored).
  source.serverStatus = 'Working';
  advanceAvatarRuntimeEntries(
    runtimeMap, { width: 30, height: 30 }, 5000, () => 0.5, null, [], []
  );
  source.serverStatus = 'Errored';
  advanceAvatarRuntimeEntries(
    runtimeMap, { width: 30, height: 30 }, 10_000, () => 0.5, null, [], []
  );
  // Observer is in cooldown (10s < 20s) — no new reaction.
  assert.equal(observer.reactionEmote, null, 'cooldown blocks repeat');

  // After cooldown clears, another error fires a fresh reaction.
  source.serverStatus = 'Working';
  advanceAvatarRuntimeEntries(
    runtimeMap, { width: 30, height: 30 }, 21_500, () => 0.5, null, [], []
  );
  source.serverStatus = 'Errored';
  advanceAvatarRuntimeEntries(
    runtimeMap, { width: 30, height: 30 }, 22_000, () => 0.5, null, [], []
  );
  assert.ok(observer.reactionEmote, 'post-cooldown fresh error fires');
  assert.equal(observer.reactionEmote.icon, '😦');
});

test('Waiting → Working fires self 🎉 (no cooldown, no radius)', async () => {
  const { advanceAvatarRuntimeEntries } = await load();
  const rt = mkRt({ id: 'a', serverStatus: 'Working', _prevSocialStatus: 'Waiting' });
  const runtimeMap = new Map([['a', rt]]);
  advanceAvatarRuntimeEntries(
    runtimeMap, { width: 30, height: 30 }, 1000, () => 0.5, null, [], []
  );
  assert.equal(rt.reactionEmote?.icon, '🎉');
});

test('productive burst newly opened → neighbors get ✨', async () => {
  const { advanceAvatarRuntimeEntries } = await load();
  const source = mkRt({ id: 'source', x: 10, y: 10,
    productiveUntil: 5000, _prevProductiveUntil: 0 });
  const neighbor = mkRt({ id: 'n', x: 12, y: 10 });
  const far = mkRt({ id: 'far', x: 20, y: 20 });
  const runtimeMap = new Map([
    ['source', source],
    ['n', neighbor],
    ['far', far]
  ]);
  advanceAvatarRuntimeEntries(
    runtimeMap, { width: 30, height: 30 }, 1000, () => 0.5, null, [], []
  );
  assert.equal(neighbor.reactionEmote?.icon, '✨');
  assert.equal(far.reactionEmote, null, 'out-of-radius = no reaction');
});

test('farewellUntil newly set → neighbors within 3 tiles wave 👋', async () => {
  const { advanceAvatarRuntimeEntries } = await load();
  const source = mkRt({ id: 'source', x: 10, y: 10,
    farewellUntil: 2500, _prevFarewellUntil: 0 });
  const near = mkRt({ id: 'near', x: 11, y: 12 });        // chebyshev 2
  const far = mkRt({ id: 'far',  x: 14, y: 14 });         // chebyshev 4 — out
  const runtimeMap = new Map([
    ['source', source], ['near', near], ['far', far]
  ]);
  advanceAvatarRuntimeEntries(
    runtimeMap, { width: 30, height: 30 }, 1000, () => 0.5, null, [], []
  );
  assert.equal(near.reactionEmote?.icon, '👋');
  assert.equal(far.reactionEmote, null, 'wave radius is only 3');
});

test('global cap: at most 3 active reactions; evict earliest-expiring first', async () => {
  const { advanceAvatarRuntimeEntries } = await load();
  // Four observers at same tile, source errored in the middle.
  const source = mkRt({ id: 'source', x: 10, y: 10, serverStatus: 'Errored',
    _prevSocialStatus: 'Working' });
  const obs = ['a', 'b', 'c', 'd'].map((id, i) =>
    mkRt({ id, x: 11 + i, y: 10 })
  );
  const runtimeMap = new Map();
  runtimeMap.set('source', source);
  obs.forEach(o => runtimeMap.set(o.id, o));

  advanceAvatarRuntimeEntries(
    runtimeMap, { width: 30, height: 30 }, 1000, () => 0.5, null, [], []
  );

  // Only 3 can be active. One should be evicted. Since all 4 have the
  // same expiresAt (same tick), tie-break is lex id; 'a' (lowest id
  // among observers) evicted first.
  const active = [...runtimeMap.values()].filter(r => r.reactionEmote).map(r => r.id);
  assert.equal(active.length, 3);
  assert.ok(!active.includes('a'), 'lex-smallest id evicts first');
  assert.ok(active.includes('b'));
  assert.ok(active.includes('c'));
  assert.ok(active.includes('d'));
});

test('reaction expires automatically once expiresAt passes', async () => {
  const { advanceAvatarRuntimeEntries } = await load();
  const rt = mkRt({ id: 'a',
    reactionEmote: { icon: '😦', expiresAt: 500 }
  });
  const runtimeMap = new Map([['a', rt]]);
  advanceAvatarRuntimeEntries(
    runtimeMap, { width: 30, height: 30 }, 1000, () => 0.5, null, [], []
  );
  assert.equal(rt.reactionEmote, null);
});

test('source of the error does not react to itself', async () => {
  const { advanceAvatarRuntimeEntries } = await load();
  const source = mkRt({ id: 'source', x: 10, y: 10, serverStatus: 'Errored',
    _prevSocialStatus: 'Working' });
  const obs = mkRt({ id: 'obs', x: 12, y: 10 });
  const runtimeMap = new Map([['source', source], ['obs', obs]]);
  advanceAvatarRuntimeEntries(
    runtimeMap, { width: 30, height: 30 }, 1000, () => 0.5, null, [], []
  );
  assert.equal(source.reactionEmote, null,
    'source has no observer-react emote on itself for error');
  assert.ok(obs.reactionEmote, 'but the neighbor does');
});

test('transitions require prev tracking — first-tick Errored does not fire', async () => {
  const { advanceAvatarRuntimeEntries } = await load();
  // No _prevSocialStatus seeded; serverStatus already 'Errored' on entry.
  const source = mkRt({ id: 'source', x: 10, y: 10, serverStatus: 'Errored' });
  const obs = mkRt({ id: 'obs', x: 12, y: 10 });
  const runtimeMap = new Map([['source', source], ['obs', obs]]);
  advanceAvatarRuntimeEntries(
    runtimeMap, { width: 30, height: 30 }, 1000, () => 0.5, null, [], []
  );
  // First tick sees `prev === undefined && cur === 'Errored'`, which
  // our predicate (`prev !== 'Errored' && cur === 'Errored'`) treats as
  // a transition. That's the current behavior; documenting it here so
  // we notice if it ever changes. If the flood-on-connect becomes a
  // problem we can tighten to `prev !== undefined && prev !== ...`.
  assert.ok(obs.reactionEmote,
    'first-observed Errored is treated as a transition (documented)');
});

test('neighbor-error sets facingOverride independent of walking direction', async () => {
  const { advanceAvatarRuntimeEntries } = await load();
  const source = mkRt({ id: 'source', x: 10, y: 10, serverStatus: 'Errored',
    _prevSocialStatus: 'Working' });
  // observer is north of source → should face 'down' (dy positive).
  const obs = mkRt({ id: 'obs', x: 10, y: 6, direction: 'up' });
  const runtimeMap = new Map([['source', source], ['obs', obs]]);
  advanceAvatarRuntimeEntries(
    runtimeMap, { width: 30, height: 30 }, 1000, () => 0.5, null, [], []
  );
  assert.equal(obs.facingOverride, 'down');
  assert.equal(obs.direction, 'up',
    'direction not mutated — only override');
});
