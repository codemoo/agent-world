const test = require('node:test');
const assert = require('node:assert/strict');

const { classify, STATUSES, HOOK } = require('../server/sessionStatus');

const NOW = 1_780_000_000_000;

function base(overrides) {
  return {
    now: NOW,
    pidAlive: true,
    pidSeenAliveAtMs: NOW,
    lastHookEvent: null,
    transcriptMtimeMs: null,
    cpuPercent: 0,
    ...overrides
  };
}

test('SessionEnd hook → Finished', () => {
  const r = classify(base({ lastHookEvent: { type: HOOK.SessionEnd, ts: NOW - 100 } }));
  assert.equal(r, STATUSES.Finished);
});

test('pid dead >5s → Finished', () => {
  const r = classify(base({ pidAlive: false, pidSeenAliveAtMs: NOW - 6_000 }));
  assert.equal(r, STATUSES.Finished);
});

test('pid dead within grace → not Finished', () => {
  const r = classify(base({ pidAlive: false, pidSeenAliveAtMs: NOW - 2_000 }));
  assert.notEqual(r, STATUSES.Finished);
});

test('PermissionRequest <10min → Waiting', () => {
  const r = classify(base({ lastHookEvent: { type: HOOK.PermissionRequest, ts: NOW - 60_000 } }));
  assert.equal(r, STATUSES.Waiting);
});

test('PostToolUseFailure <30s → Errored', () => {
  const r = classify(base({ lastHookEvent: { type: HOOK.PostToolUseFailure, ts: NOW - 10_000 } }));
  assert.equal(r, STATUSES.Errored);
});

test('UserPromptSubmit <60s → Working', () => {
  const r = classify(base({ lastHookEvent: { type: HOOK.UserPromptSubmit, ts: NOW - 10_000 } }));
  assert.equal(r, STATUSES.Working);
});

test('SubagentStart <60s → Working', () => {
  const r = classify(base({ lastHookEvent: { type: HOOK.SubagentStart, ts: NOW - 10_000 } }));
  assert.equal(r, STATUSES.Working);
});

test('Stop hook + transcript quiet → Idle', () => {
  const r = classify(base({
    lastHookEvent: { type: HOOK.Stop, ts: NOW - 60_000 },
    transcriptMtimeMs: NOW - 30_000
  }));
  assert.equal(r, STATUSES.Idle);
});

test('transcript mtime <8s → Working (no hooks)', () => {
  const r = classify(base({ transcriptMtimeMs: NOW - 3_000 }));
  assert.equal(r, STATUSES.Working);
});

test('CPU >2% → Working (no recent hooks or mtime)', () => {
  const r = classify(base({ cpuPercent: 15.3 }));
  assert.equal(r, STATUSES.Working);
});

test('transcript mtime <120s → Idle', () => {
  const r = classify(base({ transcriptMtimeMs: NOW - 60_000 }));
  assert.equal(r, STATUSES.Idle);
});

test('silent session → IdleStale', () => {
  const r = classify(base({ transcriptMtimeMs: NOW - 600_000 }));
  assert.equal(r, STATUSES.IdleStale);
});
