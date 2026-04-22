const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createBuildingAssignments, PROMOTE_THRESHOLD } = require('../server/buildingAssignments');

function tmpFile(name) {
  return path.join(os.tmpdir(), `building-${process.pid}-${name}-${Date.now()}.json`);
}

test('assigns distinct desks to two sessions in same repo', () => {
  const file = tmpFile('desks');
  try {
    const b = createBuildingAssignments(file);
    const key = '/repos/foo/.git';
    // Promote directly: ensure building slot is pre-claimed
    b._state.buildings.push({
      buildingKey: key, locationId: 'home_nw', label: 'foo',
      totalSeconds: 99999, lastSeenMs: Date.now(), desks: []
    });
    const s1 = b.assignSession({ buildingKey: key, label: 'foo', sessionId: 'S1' });
    const s2 = b.assignSession({ buildingKey: key, label: 'foo', sessionId: 'S2' });
    assert.equal(s1.kind, 'building');
    assert.equal(s2.kind, 'building');
    assert.notDeepEqual({ x: s1.x, y: s1.y }, { x: s2.x, y: s2.y });
  } finally {
    fs.rmSync(file, { force: true });
  }
});

test('unknown repo starts as tent', () => {
  const file = tmpFile('tent');
  try {
    const b = createBuildingAssignments(file);
    const r = b.assignSession({ buildingKey: '/repos/new/.git', label: 'new', sessionId: 'S1' });
    assert.equal(r.kind, 'tent');
    assert.equal(b._state.tents.length, 1);
  } finally {
    fs.rmSync(file, { force: true });
  }
});

test('tent promotes to building when score > threshold and slot free', () => {
  const file = tmpFile('promote');
  try {
    const b = createBuildingAssignments(file);
    b.assignSession({ buildingKey: '/r/a/.git', label: 'a', sessionId: 'S1' });
    // Manually boost the score.
    b._state.tents[0].totalSeconds = PROMOTE_THRESHOLD + 10;
    b.tick({ activeBuildingKeys: ['/r/a/.git'], tickMs: 0 });
    assert.equal(b._state.tents.length, 0);
    assert.equal(b._state.buildings.length, 1);
  } finally {
    fs.rmSync(file, { force: true });
  }
});

test('releaseSession clears desk slot', () => {
  const file = tmpFile('release');
  try {
    const b = createBuildingAssignments(file);
    const key = '/r/x/.git';
    b._state.buildings.push({
      buildingKey: key, locationId: 'cafe', label: 'x',
      totalSeconds: 0, lastSeenMs: Date.now(), desks: []
    });
    b.assignSession({ buildingKey: key, sessionId: 'S1' });
    b.releaseSession({ buildingKey: key, sessionId: 'S1' });
    assert.equal(b._state.buildings[0].desks.length, 0);
  } finally {
    fs.rmSync(file, { force: true });
  }
});

test('persists and reloads', () => {
  const file = tmpFile('persist');
  try {
    const b1 = createBuildingAssignments(file);
    b1.assignSession({ buildingKey: '/r/p/.git', sessionId: 'S1', label: 'p' });
    b1.persist();
    const b2 = createBuildingAssignments(file);
    assert.equal(b2._state.tents.length, 1);
    assert.equal(b2._state.tents[0].buildingKey, '/r/p/.git');
  } finally {
    fs.rmSync(file, { force: true });
  }
});
