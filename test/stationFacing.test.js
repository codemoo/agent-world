// Phase B — computeStationFacing truth table.

const test = require('node:test');
const assert = require('node:assert/strict');

let _mod = null;
async function load() {
  if (!_mod) _mod = await import('../frontend/stationFacing.mjs');
  return _mod;
}

test('explicit station.facing wins over type rules', async () => {
  const { computeStationFacing } = await load();
  assert.equal(computeStationFacing({ facing: 'down', type: 'outdoor.mining' }), 'down');
  assert.equal(computeStationFacing({ facing: 'left', type: 'sofa' }), 'left');
});

test('outdoor work props face up', async () => {
  const { computeStationFacing } = await load();
  assert.equal(computeStationFacing({ type: 'outdoor.fishing', kind: 'rest' }), 'up');
  assert.equal(computeStationFacing({ type: 'outdoor.mining', kind: 'work' }), 'up');
  assert.equal(computeStationFacing({ type: 'outdoor.foraging', kind: 'work' }), 'up');
  assert.equal(computeStationFacing({ type: 'outdoor.napping', kind: 'rest' }), 'up');
});

test('outdoor social stations keep arrival direction (null)', async () => {
  const { computeStationFacing } = await load();
  assert.equal(computeStationFacing({ type: 'outdoor.chatting' }), null);
  assert.equal(computeStationFacing({ type: 'outdoor.reading' }), null);
  assert.equal(computeStationFacing({ type: 'outdoor.sitting' }), null);
  assert.equal(computeStationFacing({ type: 'outdoor.watching' }), null);
  assert.equal(computeStationFacing({ type: 'outdoor.flowers' }), null);
});

test('indoor work props face up', async () => {
  const { computeStationFacing } = await load();
  assert.equal(computeStationFacing({ type: 'table.mid', kind: 'work' }), 'up');
  assert.equal(computeStationFacing({ type: 'bookshelf.full', kind: 'work' }), 'up');
  assert.equal(computeStationFacing({ type: 'display', kind: 'work' }), 'up');
  assert.equal(computeStationFacing({ type: 'cabinet.metal', kind: 'work' }), 'up');
  assert.equal(computeStationFacing({ type: 'safe', kind: 'work' }), 'up');
  assert.equal(computeStationFacing({ type: 'stove', kind: 'work' }), 'up');
  assert.equal(computeStationFacing({ type: 'counter', kind: 'work' }), 'up');
  assert.equal(computeStationFacing({ type: 'dresser', kind: 'rest' }), 'up');
});

test('chairs face up (paired with work prop to the north)', async () => {
  const { computeStationFacing } = await load();
  assert.equal(computeStationFacing({ type: 'chair', kind: 'work' }), 'up');
  assert.equal(computeStationFacing({ type: 'chair.alt', kind: 'rest' }), 'up');
});

test('beds face up (sleep frame reads vertically)', async () => {
  const { computeStationFacing } = await load();
  assert.equal(computeStationFacing({ type: 'bed.wide.pink', kind: 'rest' }), 'up');
  assert.equal(computeStationFacing({ type: 'bed.wide.blue', kind: 'rest' }), 'up');
});

test('sofas/plants/nightstands keep arrival direction', async () => {
  const { computeStationFacing } = await load();
  assert.equal(computeStationFacing({ type: 'sofa', kind: 'rest' }), null);
  assert.equal(computeStationFacing({ type: 'sofa.alt', kind: 'rest' }), null);
  assert.equal(computeStationFacing({ type: 'plant.pink', kind: 'rest' }), null);
  assert.equal(computeStationFacing({ type: 'nightstand', kind: 'rest' }), null);
});

test('unknown type defers to station.kind', async () => {
  const { computeStationFacing } = await load();
  assert.equal(computeStationFacing({ type: 'weird.unknown', kind: 'work' }), 'up');
  assert.equal(computeStationFacing({ type: 'weird.unknown', kind: 'rest' }), null);
});

test('null/undefined station returns null', async () => {
  const { computeStationFacing } = await load();
  assert.equal(computeStationFacing(null), null);
  assert.equal(computeStationFacing(undefined), null);
  assert.equal(computeStationFacing({}), null);
});
