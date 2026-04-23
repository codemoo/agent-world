// Phase D — activity loop tests.

const test = require('node:test');
const assert = require('node:assert/strict');

let _mod = null;
async function load() {
  if (!_mod) _mod = await import('../frontend/activityLoop.mjs');
  return _mod;
}

test('catalog lists exactly the Codex-approved kinds', async () => {
  const { ACTIVITY_LOOP_KINDS } = await load();
  assert.deepEqual([...ACTIVITY_LOOP_KINDS].sort(),
    ['archive', 'foraging', 'mining']);
});

test('unknown kind returns null emoteOverride', async () => {
  const { computeActivityLoop } = await load();
  assert.deepEqual(computeActivityLoop('fishing_spot', 0, 0), { emoteOverride: null });
  assert.deepEqual(computeActivityLoop('desk', 0, 1000), { emoteOverride: null });
  assert.deepEqual(computeActivityLoop('', 0, 1000), { emoteOverride: null });
  assert.deepEqual(computeActivityLoop(undefined, 0, 1000), { emoteOverride: null });
});

test('mining has a beat window inside each 1400ms period', async () => {
  const { computeActivityLoop } = await load();
  // Scan a full period with seed=0. Expect beat between ~1000–1200ms.
  const seed = 0;
  let offWindowFound = 0, onWindowFound = 0;
  for (let t = 0; t < 1400; t += 50) {
    const r = computeActivityLoop('mining', seed, t);
    if (r.emoteOverride === '💥') onWindowFound++;
    else if (r.emoteOverride === null) offWindowFound++;
  }
  assert.ok(onWindowFound > 0, 'expected at least one beat tick in period');
  assert.ok(offWindowFound > onWindowFound, 'beat should be MINORITY of period');
});

test('foraging beat emote is 🧺', async () => {
  const { computeActivityLoop } = await load();
  // Period 1800, beat 1200–1450. t=1300 (seed 0) should be on.
  const r = computeActivityLoop('foraging', 0, 1300);
  assert.equal(r.emoteOverride, '🧺');
});

test('archive beat emote is 📄', async () => {
  const { computeActivityLoop } = await load();
  // Period 2600, beat 2000–2220. t=2100 should be on.
  const r = computeActivityLoop('archive', 0, 2100);
  assert.equal(r.emoteOverride, '📄');
});

test('different agentSeeds dephase the beat window', async () => {
  const { computeActivityLoop } = await load();
  // At t=1100, seed=0 is in the mining beat. With a large seed offset,
  // another agent should be OUTSIDE the beat at the same instant.
  const seed0 = computeActivityLoop('mining', 0, 1100);
  assert.equal(seed0.emoteOverride, '💥');

  // seed=400 shifts phase by 400ms → t effectively 500 (pre-beat) or 1500
  // (post-beat). Either way, not '💥'.
  const seed400 = computeActivityLoop('mining', 400, 1100);
  assert.equal(seed400.emoteOverride, null);
});

test('mining loop wraps around the period', async () => {
  const { computeActivityLoop } = await load();
  // t=1400 → wraps to t=0 → pre-beat → null.
  assert.equal(computeActivityLoop('mining', 0, 1400).emoteOverride, null);
  // t=2500 → 2500 % 1400 = 1100 → in beat → '💥'.
  assert.equal(computeActivityLoop('mining', 0, 2500).emoteOverride, '💥');
});
