const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const moduleUrl = pathToFileURL(
  path.join(__dirname, '../frontend/poseResolver.mjs')
).href;

async function load() { return import(moduleUrl); }

test('desk + Working → typing, no emote', async () => {
  const { resolvePose, POSES } = await load();
  const out = resolvePose({ interactionKind: 'desk', serverStatus: 'Working' }, 0);
  assert.equal(out.pose, POSES.TYPING);
  assert.equal(out.emote, null);
});

test('desk + Idle → leaning, no emote', async () => {
  const { resolvePose, POSES } = await load();
  const out = resolvePose({ interactionKind: 'desk', serverStatus: 'Idle' }, 0);
  assert.equal(out.pose, POSES.LEANING);
});

test('tavern → drinking + 🍺 regardless of status', async () => {
  const { resolvePose, POSES } = await load();
  for (const status of ['Working', 'Idle', 'Errored', 'Waiting', 'Finished']) {
    const out = resolvePose({ interactionKind: 'tavern', serverStatus: status }, 0);
    assert.equal(out.pose, POSES.DRINKING, `status=${status}`);
    assert.equal(out.emote, '🍺', `status=${status}`);
  }
});

test('tavern_seat (cafe locationId) → drinking + 🍺', async () => {
  const { resolvePose, POSES } = await load();
  const out = resolvePose({ interactionKind: 'tavern_seat', serverStatus: 'Idle' }, 0);
  assert.equal(out.pose, POSES.DRINKING);
  assert.equal(out.emote, '🍺');
});

test('monitor_wall → watching + 📺', async () => {
  const { resolvePose, POSES } = await load();
  const out = resolvePose({ interactionKind: 'monitor_wall' }, 0);
  assert.equal(out.pose, POSES.WATCHING);
  assert.equal(out.emote, '📺');
});

test('bed + nap_spot → sleeping + 💤', async () => {
  const { resolvePose, POSES } = await load();
  for (const kind of ['bed', 'nap_spot']) {
    const out = resolvePose({ interactionKind: kind }, 0);
    assert.equal(out.pose, POSES.SLEEPING, `kind=${kind}`);
    assert.equal(out.emote, '💤', `kind=${kind}`);
  }
});

test('queue_slot + Waiting → impatient', async () => {
  const { resolvePose, POSES } = await load();
  const out = resolvePose(
    { interactionKind: 'queue_slot', serverStatus: 'Waiting' }, 0);
  assert.equal(out.pose, POSES.IMPATIENT);
});

test('queue_slot without Waiting → idle (the queue might be cleared)', async () => {
  const { resolvePose, POSES } = await load();
  const out = resolvePose(
    { interactionKind: 'queue_slot', serverStatus: 'Working' }, 0);
  assert.equal(out.pose, POSES.IDLE);
});

test('exit → idle unless farewellUntil is open', async () => {
  const { resolvePose, POSES } = await load();
  const out = resolvePose({ interactionKind: 'exit' }, 0);
  assert.equal(out.pose, POSES.IDLE);
});

test('farewellUntil open → waving_goodbye + 👋 (trumps interactionKind)', async () => {
  const { resolvePose, POSES } = await load();
  const out = resolvePose(
    { interactionKind: 'desk', farewellUntil: 1000, serverStatus: 'Working' },
    500
  );
  assert.equal(out.pose, POSES.WAVING_GOODBYE);
  assert.equal(out.emote, '👋');
});

test('stretchUntil open → stretching (trumps station pose)', async () => {
  const { resolvePose, POSES } = await load();
  const out = resolvePose(
    { interactionKind: 'break_area', stretchUntil: 1000 }, 500);
  assert.equal(out.pose, POSES.STRETCHING);
});

test('erroredPoseUntil open → leaning + 😔 (shown for 2s after error)', async () => {
  const { resolvePose, POSES } = await load();
  const out = resolvePose(
    { interactionKind: 'desk', erroredPoseUntil: 1000, serverStatus: 'Errored' },
    500
  );
  assert.equal(out.pose, POSES.LEANING);
  assert.equal(out.emote, '😔');
});

test('farewell trumps errored overlay', async () => {
  const { resolvePose, POSES } = await load();
  const out = resolvePose({
    interactionKind: 'exit',
    farewellUntil: 1000,
    erroredPoseUntil: 1000
  }, 500);
  assert.equal(out.pose, POSES.WAVING_GOODBYE);
});

test('wander / missing interactionKind → idle', async () => {
  const { resolvePose, POSES } = await load();
  for (const kind of ['wander', undefined, null, 'frozen']) {
    const out = resolvePose({ interactionKind: kind }, 0);
    assert.equal(out.pose, POSES.IDLE, `kind=${kind}`);
  }
});

test('work_outdoor → typing (mining/foraging body)', async () => {
  const { resolvePose, POSES } = await load();
  const out = resolvePose(
    { interactionKind: 'work_outdoor', serverStatus: 'Working' }, 0);
  assert.equal(out.pose, POSES.TYPING);
});

test('lounge, park_bench, plaza, garden, break_area → leaning, no emote', async () => {
  const { resolvePose, POSES } = await load();
  for (const kind of ['lounge', 'park_bench', 'plaza', 'garden', 'break_area']) {
    const out = resolvePose({ interactionKind: kind }, 0);
    assert.equal(out.pose, POSES.LEANING, `kind=${kind}`);
    assert.equal(out.emote, null, `kind=${kind}`);
  }
});
