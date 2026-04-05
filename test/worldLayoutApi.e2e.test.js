const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  getJson,
  putJson,
  startTestServer,
  stopTestServer
} = require('./helpers/testServer');

let runtime;
let layoutPath;

test.before(async () => {
  layoutPath = path.join(os.tmpdir(), `world-layout-e2e-${process.pid}-${Date.now()}.json`);
  if (fs.existsSync(layoutPath)) fs.unlinkSync(layoutPath);
  runtime = await startTestServer({ worldLayoutPath: layoutPath });
});

test.after(async () => {
  await stopTestServer(runtime);
  if (fs.existsSync(layoutPath)) fs.unlinkSync(layoutPath);
});

test('GET /api/world/layout: seed된 layout JSON을 반환한다', async () => {
  const { response, json } = await getJson(runtime.baseUrl, '/api/world/layout');
  assert.equal(response.status, 200);
  assert.equal(json.status, 'ok');
  assert.equal(json.data.version, 1);
  assert.ok(json.data.indoorStations.length > 0);
  assert.ok(json.data.outdoorStations.length > 0);
  assert.ok(json.data.trees.length > 0);
});

test('PUT /api/world/layout: 수정된 layout을 저장하고 응답한다', async () => {
  const { json: get1 } = await getJson(runtime.baseUrl, '/api/world/layout');
  const modified = {
    ...get1.data,
    trees: [...get1.data.trees, { x: 12, y: 12, type: 'tree.big' }]
  };
  const { response, json } = await putJson(runtime.baseUrl, '/api/world/layout', modified);
  assert.equal(response.status, 200);
  assert.equal(json.data.trees.length, get1.data.trees.length + 1);

  // GET again returns the persisted layout
  const { json: get2 } = await getJson(runtime.baseUrl, '/api/world/layout');
  assert.equal(get2.data.trees.length, get1.data.trees.length + 1);

  // File on disk reflects change
  const diskContent = JSON.parse(fs.readFileSync(layoutPath, 'utf8'));
  assert.equal(diskContent.trees.length, get1.data.trees.length + 1);
});

test('PUT /api/world/layout: 검증 실패 시 400을 반환한다', async () => {
  const bad = { version: 1, indoorStations: 'not an array', outdoorStations: [], trees: [] };
  const { response, json } = await putJson(runtime.baseUrl, '/api/world/layout', bad);
  assert.equal(response.status, 400);
  assert.equal(json.error, 'Invalid world layout.');
  assert.equal(Array.isArray(json.details), true);
  assert.equal(json.details[0].code, 'WORLD_LAYOUT_INVALID');
});

test('PUT /api/world/layout: worldState.world가 새 layout으로 업데이트된다', async () => {
  const { json: layoutJson } = await getJson(runtime.baseUrl, '/api/world/layout');
  // Remove all indoor stations for home_nw
  const filtered = layoutJson.data.indoorStations.filter(s => s.locationId !== 'home_nw');
  const modified = { ...layoutJson.data, indoorStations: filtered };
  await putJson(runtime.baseUrl, '/api/world/layout', modified);

  // Check /state reflects the new layout
  const { json: stateJson } = await getJson(runtime.baseUrl, '/state');
  const nwLocation = stateJson.data.world.locations.find(l => l.id === 'home_nw');
  assert.equal(nwLocation.stations.length, 0);
});

test('PUT /api/world/layout: flip 필드가 worldState를 통해 전파된다', async () => {
  const { json: layoutJson } = await getJson(runtime.baseUrl, '/api/world/layout');
  const newTree = { x: 5, y: 5, type: 'tree', flipX: true };
  const modified = { ...layoutJson.data, trees: [...layoutJson.data.trees, newTree] };
  const { response } = await putJson(runtime.baseUrl, '/api/world/layout', modified);
  assert.equal(response.status, 200);

  const { json: stateJson } = await getJson(runtime.baseUrl, '/state');
  const added = stateJson.data.world.trees.find(t => t.x === 5 && t.y === 5);
  assert.equal(Boolean(added), true);
  assert.equal(added.flipX, true);
  assert.equal(added.flipY, undefined);
});
