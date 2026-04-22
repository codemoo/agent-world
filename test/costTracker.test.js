const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  createCostTracker,
  costOfUsage,
  rateFor,
  PRICING,
  applyRecord,
  emptyTotals
} = require('../server/costTracker');

function tmpFile(n) {
  return path.join(os.tmpdir(), `cost-${process.pid}-${n}-${Date.now()}.jsonl`);
}

function writeRecords(pathName, records) {
  const lines = records.map(r => JSON.stringify(r)).join('\n') + '\n';
  fs.writeFileSync(pathName, lines);
}

test('rateFor resolves known model ids + falls back to sonnet', () => {
  assert.equal(rateFor('claude-opus-4-7'), PRICING['claude-opus-4-7']);
  assert.equal(rateFor('claude-sonnet-4-6'), PRICING['claude-sonnet-4-6']);
  assert.equal(rateFor('claude-haiku-4-5'), PRICING['claude-haiku-4-5']);
  // Prefix match
  assert.equal(rateFor('claude-opus-4-99'), PRICING['claude-opus-4-7']);
  assert.equal(rateFor('claude-sonnet-new'), PRICING['claude-sonnet-4-6']);
  // Unknown → fallback
  assert.equal(rateFor('unknown'), PRICING['claude-sonnet-4-6']);
  assert.equal(rateFor(null), PRICING['claude-sonnet-4-6']);
});

test('costOfUsage computes the 4 token categories with correct rates', () => {
  // Sonnet rates: in 3, out 15, write 3.75, read 0.30 per Mtok.
  const usage = {
    input_tokens: 1_000_000,            // $3
    output_tokens: 1_000_000,           // $15
    cache_creation_input_tokens: 1_000_000, // $3.75
    cache_read_input_tokens: 1_000_000       // $0.30
  };
  const cost = costOfUsage(usage, 'claude-sonnet-4-6');
  assert.equal(Number(cost.toFixed(4)), 22.0500);
});

test('createCostTracker accumulates across multiple records', () => {
  const pathName = tmpFile('accum');
  try {
    writeRecords(pathName, [
      { type: 'user', message: { content: 'hi' } },
      { type: 'assistant', message: {
        model: 'claude-opus-4-7',
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_creation_input_tokens: 200,
          cache_read_input_tokens: 1000
        }
      }, timestamp: 'T1' },
      { type: 'assistant', message: {
        model: 'claude-opus-4-7',
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 500
        }
      }, timestamp: 'T2' }
    ]);
    const tracker = createCostTracker();
    const t = tracker.update('sess-1', pathName);
    assert.equal(t.messageCount, 2);
    assert.equal(t.input, 110);
    assert.equal(t.output, 55);
    assert.equal(t.cacheWrite, 200);
    assert.equal(t.cacheRead, 1500);
    assert.equal(t.model, 'claude-opus-4-7');
    assert.equal(t.firstTs, 'T1');
    assert.equal(t.lastTs, 'T2');
    assert.ok(t.cost > 0, 'cost should be positive');
  } finally {
    fs.rmSync(pathName, { force: true });
  }
});

test('createCostTracker resumes at the saved offset on subsequent updates', () => {
  const pathName = tmpFile('resume');
  try {
    writeRecords(pathName, [
      { type: 'assistant', message: {
        model: 'claude-sonnet-4-6',
        usage: { input_tokens: 10, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
      }}
    ]);
    const tracker = createCostTracker();
    const first = tracker.update('sess-2', pathName);
    assert.equal(first.messageCount, 1);
    // Append another record.
    fs.appendFileSync(pathName, JSON.stringify({
      type: 'assistant', message: {
        model: 'claude-sonnet-4-6',
        usage: { input_tokens: 7, output_tokens: 3, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
      }
    }) + '\n');
    const second = tracker.update('sess-2', pathName);
    assert.equal(second.messageCount, 2);
    assert.equal(second.input, 17);
    assert.equal(second.output, 3);
  } finally {
    fs.rmSync(pathName, { force: true });
  }
});

test('createCostTracker resets totals if file is truncated (rotation)', () => {
  const pathName = tmpFile('rotate');
  try {
    writeRecords(pathName, [
      { type: 'assistant', message: {
        model: 'claude-sonnet-4-6',
        usage: { input_tokens: 100, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
      }}
    ]);
    const tracker = createCostTracker();
    tracker.update('sess-3', pathName);
    assert.equal(tracker.get('sess-3').messageCount, 1);
    // Truncate & rewrite.
    fs.writeFileSync(pathName, JSON.stringify({
      type: 'assistant', message: {
        model: 'claude-sonnet-4-6',
        usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
      }
    }) + '\n');
    tracker.update('sess-3', pathName);
    assert.equal(tracker.get('sess-3').messageCount, 1, 'should re-start from 0 on truncate');
    assert.equal(tracker.get('sess-3').input, 1);
  } finally {
    fs.rmSync(pathName, { force: true });
  }
});

test('worldTotals sums across sessions', () => {
  const a = tmpFile('wa');
  const b = tmpFile('wb');
  try {
    writeRecords(a, [
      { type: 'assistant', message: {
        model: 'claude-sonnet-4-6',
        usage: { input_tokens: 100, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
      }}
    ]);
    writeRecords(b, [
      { type: 'assistant', message: {
        model: 'claude-sonnet-4-6',
        usage: { input_tokens: 200, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
      }}
    ]);
    const tracker = createCostTracker();
    tracker.update('A', a);
    tracker.update('B', b);
    const tot = tracker.worldTotals();
    assert.equal(tot.input, 300);
    assert.equal(tot.output, 10);
    assert.equal(tot.messageCount, 2);
  } finally {
    fs.rmSync(a, { force: true });
    fs.rmSync(b, { force: true });
  }
});

test('applyRecord ignores user records', () => {
  const t = emptyTotals();
  applyRecord(t, { type: 'user', message: { content: 'hi' } });
  assert.equal(t.messageCount, 0);
  assert.equal(t.cost, 0);
});
