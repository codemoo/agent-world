const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { applySnapshotToWorld, intentFromStatus, INTENT, hatHueFromBranch } = require('../adapter/claudeAdapter');
const { STATUSES } = require('../server/sessionStatus');
const { createBuildingAssignments } = require('../server/buildingAssignments');
const { createWorldModel } = require('../adapter/worldModel');

function tmpFile(n) { return path.join(os.tmpdir(), `claudeAdapter-${process.pid}-${n}.json`); }

function baseWorldState() {
  return {
    agents: {},
    avatars: {},
    runs: {},
    zones: {},
    world: createWorldModel()
  };
}

function sess(overrides) {
  return {
    sessionId: 'sess-A',
    pid: 100,
    pidAlive: true,
    cwd: '/Users/x/repo',
    repoRoot: '/Users/x/repo',
    buildingKey: '/Users/x/repo/.git',
    isRepo: true,
    name: 'repo',
    transcriptPath: null,
    transcriptMtimeMs: null,
    cpuPercent: 0,
    lastHookEvent: null,
    status: STATUSES.Idle,
    ...overrides
  };
}

test('intentFromStatus maps every status to a kind', () => {
  assert.equal(intentFromStatus(STATUSES.Working).kind, INTENT.AtDesk);
  assert.equal(intentFromStatus(STATUSES.Waiting).kind, INTENT.ToInfoDesk);
  assert.equal(intentFromStatus(STATUSES.Errored).kind, INTENT.ToTavern);
  assert.equal(intentFromStatus(STATUSES.Idle).kind, INTENT.Wander);
  assert.equal(intentFromStatus(STATUSES.Finished).kind, INTENT.ToExitFade);
});

test('hatHueFromBranch deterministic, in [0,360)', () => {
  const h = hatHueFromBranch('main');
  assert.ok(Number.isInteger(h) && h >= 0 && h < 360);
  assert.equal(h, hatHueFromBranch('main'));
});

test('applying a snapshot creates agent + avatar; removes them when session drops', () => {
  const file = tmpFile('apply');
  try {
    const buildings = createBuildingAssignments(file);
    const worldState = baseWorldState();

    const { activeBuildingKeys } = applySnapshotToWorld({
      snapshot: { sessions: [sess({ status: STATUSES.Working })] },
      worldState,
      buildings
    });
    assert.deepEqual(activeBuildingKeys, ['/Users/x/repo/.git']);
    assert.ok(worldState.agents['sess-A']);
    assert.ok(worldState.avatars['sess-A']);
    assert.equal(worldState.avatars['sess-A'].intent.kind, INTENT.AtDesk);

    // Remove session
    applySnapshotToWorld({ snapshot: { sessions: [] }, worldState, buildings });
    assert.equal(worldState.agents['sess-A'], undefined);
    assert.equal(worldState.avatars['sess-A'], undefined);
  } finally {
    fs.rmSync(file, { force: true });
  }
});

test('agent name follows cwd basename (not repo basename)', () => {
  const file = tmpFile('name');
  try {
    const buildings = createBuildingAssignments(file);
    const worldState = baseWorldState();
    applySnapshotToWorld({
      snapshot: { sessions: [sess({
        sessionId: 'n1',
        cwd: '/Users/h/Dropbox/dev/uconsole',
        repoRoot: '/Users/h/Dropbox/dev',
        buildingKey: '/Users/h/Dropbox/dev/.git',
        status: STATUSES.Working
      })] },
      worldState, buildings
    });
    assert.equal(worldState.agents['n1'].name, 'uconsole');
  } finally {
    fs.rmSync(file, { force: true });
  }
});

test('snapshotter-enriched tool/gitBranch/model propagate to agent and bubble', () => {
  const file = tmpFile('enrich');
  try {
    const buildings = createBuildingAssignments(file);
    const worldState = baseWorldState();
    applySnapshotToWorld({
      snapshot: { sessions: [sess({
        status: STATUSES.Working,
        tool: { name: 'Edit', inputPreview: '/src/foo.py' },
        gitBranch: 'feature/x',
        model: 'claude-opus-4-7',
        lastAssistantSnippet: 'done'
      })] },
      worldState, buildings
    });
    const agent = worldState.agents['sess-A'];
    assert.equal(agent.tool.name, 'Edit');
    assert.equal(agent.tool.inputPreview, '/src/foo.py');
    assert.equal(agent.gitBranch, 'feature/x');
    assert.equal(agent.model, 'claude-opus-4-7');
    assert.match(worldState.avatars['sess-A'].bubbleText, /Edit/);
    assert.match(worldState.avatars['sess-A'].bubbleText, /foo\.py/);
  } finally {
    fs.rmSync(file, { force: true });
  }
});

test('Idle session with a known tool surfaces it in the bubble', () => {
  const file = tmpFile('idle-tool');
  try {
    const buildings = createBuildingAssignments(file);
    const worldState = baseWorldState();
    applySnapshotToWorld({
      snapshot: { sessions: [sess({
        status: STATUSES.Idle,
        tool: { name: 'Bash', inputPreview: null }
      })] },
      worldState, buildings
    });
    assert.match(worldState.avatars['sess-A'].bubbleText, /Bash/);
  } finally {
    fs.rmSync(file, { force: true });
  }
});

test('Waiting session gets to_info_desk intent and halo bubble', () => {
  const file = tmpFile('wait');
  try {
    const buildings = createBuildingAssignments(file);
    const worldState = baseWorldState();
    applySnapshotToWorld({
      snapshot: { sessions: [sess({ status: STATUSES.Waiting })] },
      worldState, buildings
    });
    assert.equal(worldState.avatars['sess-A'].intent.kind, INTENT.ToInfoDesk);
    assert.match(worldState.avatars['sess-A'].bubbleText, /waiting/);
  } finally {
    fs.rmSync(file, { force: true });
  }
});
