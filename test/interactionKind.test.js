const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const moduleUrl = pathToFileURL(
  path.join(__dirname, '../frontend/interactionKind.mjs')
).href;

async function load() {
  return import(moduleUrl);
}

function mkRuntime(overrides = {}) {
  return {
    intent: null,
    currentDestination: {
      x: 10, y: 10,
      stationId: 'ne_chair1',
      locationId: 'home_ne'
    },
    ...overrides
  };
}

// ============================================================
// Intent-driven overrides
// ============================================================

test('intent.kind=to_info_desk → queue_slot', async () => {
  const { interactionKindFor } = await load();
  const rt = mkRuntime({ intent: { kind: 'to_info_desk' } });
  assert.equal(interactionKindFor(rt, {}), 'queue_slot');
});

test('intent.kind=to_exit_fade → exit', async () => {
  const { interactionKindFor } = await load();
  const rt = mkRuntime({ intent: { kind: 'to_exit_fade' } });
  assert.equal(interactionKindFor(rt, {}), 'exit');
});

test('intent.kind=to_tavern → tavern', async () => {
  const { interactionKindFor } = await load();
  const rt = mkRuntime({ intent: { kind: 'to_tavern' } });
  assert.equal(interactionKindFor(rt, {}), 'tavern');
});

test('intent.kind=frozen → frozen', async () => {
  const { interactionKindFor } = await load();
  const rt = mkRuntime({ intent: { kind: 'frozen' } });
  assert.equal(interactionKindFor(rt, {}), 'frozen');
});

// ============================================================
// Cafe short-circuit: any station inside cafe → tavern_seat
// ============================================================

test('cafe locationId short-circuits before type inspection', async () => {
  const { interactionKindFor } = await load();
  const lookup = {
    'cf_desk': { id: 'cf_desk', kind: 'work', type: 'chair' } // ambiguous chair
  };
  const rt = mkRuntime({
    currentDestination: { stationId: 'cf_desk', locationId: 'cafe' }
  });
  assert.equal(interactionKindFor(rt, lookup), 'tavern_seat');
});

// ============================================================
// Outdoor types — all 9 variants
// ============================================================

test('every OUTDOOR_STATIONS type maps to its expected kind', async () => {
  const { interactionKindFor } = await load();
  const cases = [
    ['outdoor.chatting',  'plaza'],
    ['outdoor.reading',   'park_bench'],
    ['outdoor.sitting',   'park_bench'],
    ['outdoor.watching',  'park_bench'],
    ['outdoor.flowers',   'garden'],
    ['outdoor.napping',   'nap_spot'],
    ['outdoor.fishing',   'fishing_spot'],
    ['outdoor.mining',    'work_outdoor'],
    ['outdoor.foraging',  'work_outdoor']
  ];
  for (const [type, expected] of cases) {
    const lookup = { 's': { id: 's', kind: 'rest', type } };
    const rt = mkRuntime({
      currentDestination: { stationId: 's', locationId: null }
    });
    assert.equal(interactionKindFor(rt, lookup), expected,
      `${type} should be ${expected}`);
  }
});

// ============================================================
// Indoor specific types — fully enumerated (v4 regression coverage)
// ============================================================

test('indoor-specific station types map as specified', async () => {
  const { interactionKindFor } = await load();
  const cases = [
    ['bed.wide.pink',     'bed'],
    ['bed.wide.blue',     'bed'],
    ['display',           'monitor_wall'],
    ['display.alt',       'monitor_wall'],
    ['bookshelf',         'archive'],
    ['bookshelf.full',    'archive'],
    ['bookshelf.scroll',  'archive'],
    ['safe',              'archive'],
    ['stove',             'cooking'],
    ['stove.alt',         'cooking'],
    ['sofa',              'lounge'],
    ['sofa.alt',          'lounge'],
    ['sofa.alt2',         'lounge'],
    ['plant.pink',        'break_area'],
    ['plant.purple',      'break_area']
  ];
  for (const [type, expected] of cases) {
    const lookup = { 's': { id: 's', kind: 'work', type } };
    const rt = mkRuntime({
      currentDestination: { stationId: 's', locationId: 'home_ne' }
    });
    assert.equal(interactionKindFor(rt, lookup), expected,
      `${type} should be ${expected}`);
  }
});

// ============================================================
// Ambiguous types — kind-aware resolution (Codex v3 regression)
// ============================================================

test('chair with kind=work → desk (home_ne monitor room)', async () => {
  const { interactionKindFor } = await load();
  const lookup = { 's': { kind: 'work', type: 'chair' } };
  const rt = mkRuntime({
    currentDestination: { stationId: 's', locationId: 'home_ne' }
  });
  assert.equal(interactionKindFor(rt, lookup), 'desk');
});

test('chair with kind=rest → break_area (e.g. home_nw lounge chair)', async () => {
  const { interactionKindFor } = await load();
  const lookup = { 's': { kind: 'rest', type: 'chair.alt' } };
  const rt = mkRuntime({
    currentDestination: { stationId: 's', locationId: 'home_nw' }
  });
  assert.equal(interactionKindFor(rt, lookup), 'break_area');
});

test('dresser.beer with kind=work → desk (NOT tavern_seat — it is monitor 1 in QA Lab)', async () => {
  const { interactionKindFor } = await load();
  const lookup = { 's': { kind: 'work', type: 'dresser.beer' } };
  const rt = mkRuntime({
    currentDestination: { stationId: 's', locationId: 'home_ne' }
  });
  assert.equal(interactionKindFor(rt, lookup), 'desk');
});

test('every ambiguous type in worldModel lands on desk or break_area by kind', async () => {
  const { interactionKindFor } = await load();
  const ambiguous = [
    'chair', 'chair.alt', 'counter',
    'dresser', 'dresser.alt', 'dresser.beer',
    'cabinet.books', 'cabinet.drawer', 'cabinet.glass',
    'cabinet.metal', 'cabinet.metal.alt', 'cabinet.wood', 'cabinet.wood.alt',
    'nightstand', 'nightstand.alt',
    'table', 'table.mid', 'table.tiny'
  ];
  for (const type of ambiguous) {
    const workLookup = { 's': { kind: 'work', type } };
    const restLookup = { 's': { kind: 'rest', type } };
    const rt = mkRuntime({
      currentDestination: { stationId: 's', locationId: 'home_ne' }
    });
    assert.equal(interactionKindFor(rt, workLookup), 'desk',
      `${type}/work should be desk`);
    assert.equal(interactionKindFor(rt, restLookup), 'break_area',
      `${type}/rest should be break_area`);
  }
});

// ============================================================
// Fallbacks
// ============================================================

test('no currentDestination → wander', async () => {
  const { interactionKindFor } = await load();
  assert.equal(interactionKindFor({ intent: null, currentDestination: null }, {}), 'wander');
  assert.equal(interactionKindFor({}, {}), 'wander');
});

test('intent=wander with station resolves by station, not wander', async () => {
  const { interactionKindFor } = await load();
  const lookup = { 's': { kind: 'work', type: 'display' } };
  const rt = mkRuntime({
    intent: { kind: 'wander' },
    currentDestination: { stationId: 's', locationId: 'home_ne' }
  });
  assert.equal(interactionKindFor(rt, lookup), 'monitor_wall');
});

test('missing station in lookup → wander', async () => {
  const { interactionKindFor } = await load();
  const rt = mkRuntime({
    currentDestination: { stationId: 'does-not-exist', locationId: 'home_ne' }
  });
  assert.equal(interactionKindFor(rt, {}), 'wander');
});

test('unknown station.type with no kind → wander', async () => {
  const { interactionKindFor } = await load();
  const lookup = { 's': { type: 'some.future.type' } }; // no kind
  const rt = mkRuntime({
    currentDestination: { stationId: 's', locationId: 'home_ne' }
  });
  assert.equal(interactionKindFor(rt, lookup), 'wander');
});
