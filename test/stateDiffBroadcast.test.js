const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createStateDiffBroadcast,
  mergePatch,
  producePatch
} = require('../server/stateDiffBroadcast');

test('producePatch → mergePatch round-trips', () => {
  const prev = { a: 1, b: { c: 2, d: 3 }, e: [1, 2] };
  const next = { a: 1, b: { c: 5, e: 9 }, e: [1, 2, 3], f: 'new' };
  const patch = producePatch(prev, next);
  const applied = mergePatch(JSON.parse(JSON.stringify(prev)), patch);
  assert.deepEqual(applied, next);
});

test('mergePatch with null deletes keys', () => {
  const target = { a: 1, b: 2 };
  const result = mergePatch(target, { b: null, c: 3 });
  assert.deepEqual(result, { a: 1, c: 3 });
});

test('debouncer coalesces rapid schedule() calls', async () => {
  const sent = [];
  const b = createStateDiffBroadcast({
    debounceMs: 30,
    sendFull: p => sent.push(['full', p]),
    sendPatch: p => sent.push(['patch', p])
  });
  b.schedule({ n: 1 });
  b.schedule({ n: 2 });
  b.schedule({ n: 3 });
  await new Promise(r => setTimeout(r, 60));
  assert.equal(sent.length, 1, 'expected one coalesced broadcast');
  assert.equal(sent[0][0], 'full', 'first broadcast is full snapshot');
});

test('subsequent broadcasts use patches', async () => {
  const sent = [];
  const b = createStateDiffBroadcast({
    debounceMs: 5,
    sendFull: p => sent.push(['full', JSON.parse(p)]),
    sendPatch: p => sent.push(['patch', JSON.parse(p)])
  });
  b.schedule({ a: 1, b: 2 });
  await new Promise(r => setTimeout(r, 20));
  b.schedule({ a: 1, b: 2, c: 3 });
  await new Promise(r => setTimeout(r, 20));
  assert.equal(sent.length, 2);
  assert.equal(sent[0][0], 'full');
  assert.equal(sent[1][0], 'patch');
  assert.deepEqual(sent[1][1].patch, { c: 3 });
});

test('emitFullNow sends full state for a new connection', () => {
  const out = [];
  const b = createStateDiffBroadcast({
    debounceMs: 50,
    sendFull: () => {},
    sendPatch: () => {}
  });
  b.emitFullNow({ hello: 'world' }, p => out.push(p));
  assert.match(out[0], /"type":"state"/);
});

test('identical consecutive states emit no patch', async () => {
  const sent = [];
  const b = createStateDiffBroadcast({
    debounceMs: 5,
    sendFull: p => sent.push(['full', p]),
    sendPatch: p => sent.push(['patch', p])
  });
  b.schedule({ a: 1 });
  await new Promise(r => setTimeout(r, 20));
  b.schedule({ a: 1 });
  await new Promise(r => setTimeout(r, 20));
  assert.equal(sent.length, 1);
});
