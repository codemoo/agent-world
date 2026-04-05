const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  LAYOUT_VERSION,
  loadLayout,
  saveLayout,
  loadOrSeed,
  buildSeedLayout,
  validateLayout
} = require('../server/worldLayout');
const {
  createVillageGrid,
  LOCATION_DEFS,
  OUTDOOR_STATIONS,
  WORLD_WIDTH,
  WORLD_HEIGHT
} = require('../adapter/paperclipAdapter');
const { generateTrees } = require('../adapter/treeGenerator');

function tmpPath(label) {
  return path.join(os.tmpdir(), `world-layout-${label}-${process.pid}-${Date.now()}.json`);
}

function buildValidLayout() {
  const tiles = createVillageGrid(WORLD_WIDTH, WORLD_HEIGHT);
  const locations = LOCATION_DEFS.map(l => ({ x: l.x, y: l.y, w: l.w, h: l.h }));
  const trees = generateTrees(WORLD_WIDTH, WORLD_HEIGHT, locations, tiles);
  return buildSeedLayout({
    locationDefs: LOCATION_DEFS,
    outdoorStations: OUTDOOR_STATIONS,
    trees
  });
}

test('buildSeedLayout: code defaults을 version=1 layout으로 변환한다', () => {
  const layout = buildValidLayout();
  assert.equal(layout.version, LAYOUT_VERSION);
  assert.equal(Array.isArray(layout.indoorStations), true);
  assert.equal(Array.isArray(layout.outdoorStations), true);
  assert.equal(Array.isArray(layout.trees), true);
  assert.ok(layout.indoorStations.length > 0, 'has indoor stations');
  assert.ok(layout.outdoorStations.length > 0, 'has outdoor stations');
  assert.ok(layout.trees.length > 0, 'has trees');

  // Indoor stations carry locationId
  assert.equal(typeof layout.indoorStations[0].locationId, 'string');
  assert.ok(['work', 'rest'].includes(layout.indoorStations[0].kind));
});

test('saveLayout → loadLayout: 라운드트립이 데이터를 보존한다', () => {
  const p = tmpPath('roundtrip');
  const layout = buildValidLayout();
  const saved = saveLayout(layout, p);
  const loaded = loadLayout(p);
  assert.deepEqual(loaded, saved);
  assert.equal(loaded.indoorStations.length, layout.indoorStations.length);
  fs.unlinkSync(p);
});

test('loadOrSeed: 파일이 없으면 seed builder를 호출하고 저장한다', () => {
  const p = tmpPath('seed');
  assert.equal(fs.existsSync(p), false);
  let seedCalls = 0;
  const result = loadOrSeed(() => {
    seedCalls++;
    return buildValidLayout();
  }, p);
  assert.equal(seedCalls, 1);
  assert.equal(fs.existsSync(p), true);
  assert.equal(result.version, LAYOUT_VERSION);

  // Second call reads file, does NOT invoke seeder
  const result2 = loadOrSeed(() => {
    seedCalls++;
    return buildValidLayout();
  }, p);
  assert.equal(seedCalls, 1);
  assert.equal(result2.indoorStations.length, result.indoorStations.length);
  fs.unlinkSync(p);
});

test('validateLayout: 필수 필드 누락 시 예외를 던진다', () => {
  assert.throws(() => validateLayout(null), /must be a JSON object/);
  assert.throws(() => validateLayout({}), /unsupported layout version/);
  assert.throws(
    () => validateLayout({ version: 1, indoorStations: 'x', outdoorStations: [], trees: [] }),
    /indoorStations must be an array/
  );
  assert.throws(
    () => validateLayout({
      version: 1,
      indoorStations: [{ id: 'a', locationId: 'loc', kind: 'badkind', type: 'chair', dx: 0, dy: 0 }],
      outdoorStations: [],
      trees: []
    }),
    /kind must be 'work' or 'rest'/
  );
  assert.throws(
    () => validateLayout({
      version: 1,
      indoorStations: [],
      outdoorStations: [],
      trees: [{ x: -1, y: 0, type: 'tree' }]
    }),
    /trees\[0\].x must be non-negative int/
  );
});

test('saveLayout: atomic 쓰기 후 버전이 덮어쓰인다', () => {
  const p = tmpPath('atomic');
  const layout = buildValidLayout();
  saveLayout(layout, p);
  // Drop some trees + stations, save again
  const modified = {
    ...layout,
    trees: layout.trees.slice(0, 3),
    indoorStations: layout.indoorStations.slice(0, 5)
  };
  saveLayout(modified, p);
  const reloaded = loadLayout(p);
  assert.equal(reloaded.trees.length, 3);
  assert.equal(reloaded.indoorStations.length, 5);
  fs.unlinkSync(p);
});

test('loadLayout: 파일이 없으면 null을 반환한다', () => {
  const p = tmpPath('missing');
  assert.equal(loadLayout(p), null);
});

test('flipX/flipY는 옵셔널 bool로 raw layout을 통과한다', () => {
  const layout = {
    version: 1,
    indoorStations: [
      { id: 'a', locationId: 'loc', kind: 'work', type: 'chair', dx: 0, dy: 0, flipX: true }
    ],
    outdoorStations: [
      { id: 'b', kind: 'rest', type: 'outdoor.fishing', x: 0, y: 0, flipY: true }
    ],
    trees: [
      { x: 1, y: 1, type: 'tree', flipX: true, flipY: true }
    ]
  };
  assert.doesNotThrow(() => validateLayout(layout));
});

test('flipX가 bool이 아니면 검증이 실패한다', () => {
  assert.throws(() => validateLayout({
    version: 1,
    indoorStations: [],
    outdoorStations: [],
    trees: [{ x: 0, y: 0, type: 'tree', flipX: 'yes' }]
  }), /flipX must be a boolean/);
});

test('saveLayout → loadLayout: flip 필드가 보존된다', () => {
  const p = tmpPath('flip-roundtrip');
  const layout = {
    version: 1,
    indoorStations: [
      { id: 'a', locationId: 'loc', kind: 'work', type: 'chair', dx: 1, dy: 2, label: 'x', flipX: true }
    ],
    outdoorStations: [],
    trees: [{ x: 3, y: 4, type: 'tree.big', flipY: true }]
  };
  saveLayout(layout, p);
  const loaded = loadLayout(p);
  assert.equal(loaded.indoorStations[0].flipX, true);
  assert.equal(loaded.indoorStations[0].flipY, undefined);
  assert.equal(loaded.trees[0].flipY, true);
  assert.equal(loaded.trees[0].flipX, undefined);
  fs.unlinkSync(p);
});
