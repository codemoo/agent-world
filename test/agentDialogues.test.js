const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const moduleUrl = pathToFileURL(
  path.join(__dirname, '../frontend/agentDialogues.mjs')
).href;

async function load() { return import(moduleUrl); }

// Deterministic rng: always returns 0, picks the first line of every pool.
const zeroRng = () => 0;

test('both agents share repoRoot → SAME_REPO pool', async () => {
  const { buildConversation, SAME_REPO_OPENERS } = await load();
  const lines = buildConversation({
    a: { repoRoot: '/r/a', repoLabel: 'alpha', serverStatus: 'Working' },
    b: { repoRoot: '/r/a', repoLabel: 'alpha', serverStatus: 'Idle' }
  }, zeroRng);
  assert.equal(lines.length, 2);
  // First line should be the first SAME_REPO_OPENERS entry with {repo}
  // substituted to "alpha".
  const expected = SAME_REPO_OPENERS[0].replace('{repo}', 'alpha');
  assert.equal(lines[0], expected);
});

test('same repoLabel but different repoRoot → NOT same_repo (Codex v3 gap)', async () => {
  const { buildConversation, GREETINGS } = await load();
  const lines = buildConversation({
    a: { repoRoot: '/a/src', repoLabel: 'src', serverStatus: 'Idle' },
    b: { repoRoot: '/b/src', repoLabel: 'src', serverStatus: 'Idle' }
  }, zeroRng);
  // Neither is errored nor waiting → fall through to GREETINGS.
  assert.ok(GREETINGS.includes(lines[0]), 'first line should be a GREETING');
});

test('null repoLabel + same repoRoot → {repo} substitutes to "it"', async () => {
  const { buildConversation } = await load();
  const lines = buildConversation({
    a: { repoRoot: '/x', repoLabel: null, serverStatus: 'Working' },
    b: { repoRoot: '/x', repoLabel: null, serverStatus: 'Idle' }
  }, zeroRng);
  // First opener in SAME_REPO_OPENERS is "Working on {repo} too?".
  // With repoLabel null → "it".
  assert.equal(lines[0], 'Working on it too?');
});

test('one Errored → ERROR_COMMISERATE pool', async () => {
  const { buildConversation, ERROR_COMMISERATE_OPENERS } = await load();
  const lines = buildConversation({
    a: { serverStatus: 'Errored' },
    b: { serverStatus: 'Working' }
  }, zeroRng);
  assert.equal(lines[0], ERROR_COMMISERATE_OPENERS[0]);
});

test('both Errored → ERROR_COMMISERATE pool', async () => {
  const { buildConversation, ERROR_COMMISERATE_OPENERS } = await load();
  const lines = buildConversation({
    a: { serverStatus: 'Errored' },
    b: { serverStatus: 'Errored' }
  }, zeroRng);
  assert.equal(lines[0], ERROR_COMMISERATE_OPENERS[0]);
});

test('exactly one Waiting → WAITING_SUPPORT pool', async () => {
  const { buildConversation, WAITING_SUPPORT_OPENERS } = await load();
  const lines = buildConversation({
    a: { serverStatus: 'Waiting' },
    b: { serverStatus: 'Working' }
  }, zeroRng);
  assert.equal(lines[0], WAITING_SUPPORT_OPENERS[0]);
});

test('both Waiting → fall through (neither can help)', async () => {
  const { buildConversation, WAITING_SUPPORT_OPENERS } = await load();
  const lines = buildConversation({
    a: { serverStatus: 'Waiting' },
    b: { serverStatus: 'Waiting' }
  }, zeroRng);
  assert.ok(!WAITING_SUPPORT_OPENERS.includes(lines[0]),
    'should not use waiting_support when both are waiting');
});

test('error priority > waiting support: errored+waiting → ERROR pool', async () => {
  const { buildConversation, ERROR_COMMISERATE_OPENERS } = await load();
  const lines = buildConversation({
    a: { serverStatus: 'Errored' },
    b: { serverStatus: 'Waiting' }
  }, zeroRng);
  assert.equal(lines[0], ERROR_COMMISERATE_OPENERS[0]);
});

test('same-repo priority > error: same_repo + errored → SAME_REPO wins', async () => {
  const { buildConversation, SAME_REPO_OPENERS } = await load();
  const lines = buildConversation({
    a: { repoRoot: '/r', repoLabel: 'x', serverStatus: 'Errored' },
    b: { repoRoot: '/r', repoLabel: 'x', serverStatus: 'Working' }
  }, zeroRng);
  assert.equal(lines[0], SAME_REPO_OPENERS[0].replace('{repo}', 'x'));
});

test('null ctx → pure greeting fallback (existing behavior)', async () => {
  const { buildConversation, GREETINGS } = await load();
  const lines = buildConversation(null, zeroRng);
  assert.ok(GREETINGS.includes(lines[0]));
});

test('back-compat: buildConversation(rng) with function as first arg', async () => {
  const { buildConversation, GREETINGS } = await load();
  const lines = buildConversation(zeroRng);
  assert.ok(GREETINGS.includes(lines[0]),
    'function-as-first-arg must be treated as rng');
});

test('missing serverStatus on both sides → fallback', async () => {
  const { buildConversation, GREETINGS } = await load();
  const lines = buildConversation({ a: {}, b: {} }, zeroRng);
  assert.ok(GREETINGS.includes(lines[0]));
});

test('repoRoot null on one side kills same-repo route', async () => {
  const { buildConversation, GREETINGS } = await load();
  const lines = buildConversation({
    a: { repoRoot: '/x', repoLabel: 'x' },
    b: { repoRoot: null, repoLabel: 'x' }
  }, zeroRng);
  assert.ok(GREETINGS.includes(lines[0]));
});
