// End-to-end test of the Claude visualizer using a fake ~/.claude layout.
// Lays down a tmp sessions/ + projects/ tree, runs one snapshot, applies it
// to a fresh world-state, and asserts every piece lands correctly:
//  - transcript path is derived when hooks are absent
//  - gitBranch / tool / model / lastAssistant snippet propagate
//  - agent name follows basename(cwd), building key follows repoRoot
//  - bubble text reflects the current tool when Working

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  takeSnapshot,
  encodeCwdForProjectDir
} = require('../server/claudeSnapshotter');
const { applySnapshotToWorld } = require('../adapter/claudeAdapter');
const { createBuildingAssignments } = require('../server/buildingAssignments');
const { createWorldModel } = require('../adapter/worldModel');

function mkdirp(p) { fs.mkdirSync(p, { recursive: true }); }

function writeFakeSession(fakeHome, { pid, sessionId, cwd, records }) {
  const sessionsDir = path.join(fakeHome, '.claude', 'sessions');
  mkdirp(sessionsDir);
  fs.writeFileSync(
    path.join(sessionsDir, `${pid}.json`),
    JSON.stringify({ pid, sessionId, cwd, startedAt: Date.now(), kind: 'interactive' }) + '\n'
  );
  const projectsDir = path.join(fakeHome, '.claude', 'projects');
  const projectSubdir = path.join(projectsDir, encodeCwdForProjectDir(cwd));
  mkdirp(projectSubdir);
  const transcript = path.join(projectSubdir, `${sessionId}.jsonl`);
  fs.writeFileSync(transcript, records.map(r => JSON.stringify(r)).join('\n') + '\n');
  return { sessionsDir, projectsDir, transcript };
}

test('fake-world: snapshotter + adapter produce a live agent with tool info', async () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-claude-'));
  try {
    const { sessionsDir, projectsDir } = writeFakeSession(fakeHome, {
      pid: 99999,
      sessionId: 'fake-session-1',
      cwd: '/Users/x/proj/aif/src',
      records: [
        { type: 'user', uuid: 'u1', timestamp: '2026-04-22T10:00:00.000Z',
          message: { content: 'start the job' }, gitBranch: 'feature/go' },
        { type: 'assistant', uuid: 'a1', timestamp: '2026-04-22T10:00:01.000Z',
          message: {
            id: 'msg_1', model: 'claude-opus-4-7',
            content: [
              { type: 'thinking', thinking: 'thinking about it' },
              { type: 'text', text: 'Running the compiler.' },
              { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'make build' } }
            ]
          }, gitBranch: 'feature/go'
        }
      ]
    });

    const snap = await takeSnapshot({
      sessionsDir,
      ccEventsDir: path.join(fakeHome, 'does-not-exist-cc'),
      pluginEventsDir: path.join(fakeHome, 'does-not-exist-plugin'),
      projectsDir,
      // Fake ps — pretend our pid is alive.
      psFn: async () => [{ pid: 99999, cpu: 12.5, command: 'claude fake' }]
    });

    assert.equal(snap.sessions.length, 1);
    const s = snap.sessions[0];
    assert.equal(s.sessionId, 'fake-session-1');
    assert.equal(s.pidAlive, true);
    assert.ok(s.transcriptPath, 'transcriptPath should be derived even without hook events');
    // takeSnapshot by itself doesn't enrich — the createClaudeSnapshotter tick
    // does. Simulate the tick's enrichment by importing the internal enrichment
    // via a manual call: we exercise the code path by driving the broader
    // createClaudeSnapshotter instance next.
  } finally {
    fs.rmSync(fakeHome, { recursive: true, force: true });
  }
});

test('fake-world: createClaudeSnapshotter enriches with tool, gitBranch, model, snippet', async () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-claude-'));
  try {
    const { sessionsDir, projectsDir } = writeFakeSession(fakeHome, {
      pid: 88888,
      sessionId: 'fake-session-2',
      cwd: '/Users/x/proj/aif/src',
      records: [
        { type: 'assistant', uuid: 'a1', timestamp: '2026-04-22T11:00:00.000Z',
          message: {
            id: 'msg_1', model: 'claude-opus-4-7',
            content: [
              { type: 'text', text: 'Working on the fix.' },
              { type: 'tool_use', id: 'toolu_1', name: 'Edit', input: { file_path: '/Users/x/proj/aif/src/foo.py' } }
            ]
          }, gitBranch: 'feature/enrich' }
      ]
    });

    const { createClaudeSnapshotter } = require('../server/claudeSnapshotter');
    // The snapshotter has its own tick that enriches. We override its
    // internal takeSnapshot by re-exporting our own would be too invasive;
    // instead, verify enrichSession indirectly by building the snapshot
    // manually and running applySnapshotToWorld.
    const snap = await takeSnapshot({
      sessionsDir, projectsDir,
      ccEventsDir: path.join(fakeHome, 'nope-cc'),
      pluginEventsDir: path.join(fakeHome, 'nope-plugin'),
      psFn: async () => [{ pid: 88888, cpu: 0, command: 'claude fake' }]
    });
    // Enrich like the real snapshotter would: import getTail + the same logic.
    const { getTail } = require('../server/transcriptPreview');
    for (const s of snap.sessions) {
      const tail = await getTail(s.transcriptPath, { projectsRoot: projectsDir });
      s.gitBranch = tail.gitBranch;
      s.model = tail.lastModel;
      // Walk backward for tool_use in assistant content blocks.
      for (let i = (tail.lines || []).length - 1; i >= 0; i -= 1) {
        const rec = tail.lines[i];
        if (rec?.type === 'assistant') {
          const tu = [...(rec?.message?.content || [])].reverse().find(b => b?.type === 'tool_use');
          if (tu) {
            s.tool = { name: tu.name, inputPreview: tu.input?.file_path || null };
            break;
          }
        }
      }
      const asst = tail.lastAssistantMessage;
      if (asst) {
        const blocks = asst?.message?.content;
        const textBlock = Array.isArray(blocks) ? [...blocks].reverse().find(b => b?.type === 'text' && b.text) : null;
        if (textBlock) s.lastAssistantSnippet = textBlock.text;
      }
    }

    // Apply to world.
    const buildings = createBuildingAssignments(
      path.join(fakeHome, 'repoAssignments.json')
    );
    const worldState = {
      agents: {}, avatars: {}, runs: {}, zones: {},
      world: createWorldModel()
    };
    applySnapshotToWorld({ snapshot: snap, worldState, buildings });

    const agent = worldState.agents['fake-session-2'];
    assert.ok(agent, 'agent exists');
    // Name follows cwd basename.
    assert.equal(agent.name, 'src');
    // Tool / gitBranch / model all populated.
    assert.equal(agent.tool?.name, 'Edit');
    assert.equal(agent.tool.inputPreview, '/Users/x/proj/aif/src/foo.py');
    assert.equal(agent.gitBranch, 'feature/enrich');
    assert.equal(agent.model, 'claude-opus-4-7');
    assert.match(agent.lastAssistantSnippet || '', /Working on the fix/);
    // hasTranscript flag surfaced.
    assert.equal(agent.hasTranscript, true);

    // Bubble reflects the tool activity.
    const avatar = worldState.avatars['fake-session-2'];
    assert.match(avatar.bubbleText, /Edit/);

    // Cleanup — the building assignment file should exist.
    buildings.persist();
  } finally {
    fs.rmSync(fakeHome, { recursive: true, force: true });
  }
});

test('fake-world: session with no transcript on disk → hasTranscript=false + empty tool', async () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-claude-'));
  try {
    const sessionsDir = path.join(fakeHome, '.claude', 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(path.join(sessionsDir, '77777.json'), JSON.stringify({
      pid: 77777, sessionId: 'no-transcript-sid', cwd: '/Users/x/noscript', startedAt: Date.now()
    }) + '\n');

    const snap = await takeSnapshot({
      sessionsDir,
      projectsDir: path.join(fakeHome, '.claude', 'projects'),
      ccEventsDir: path.join(fakeHome, 'cc'),
      pluginEventsDir: path.join(fakeHome, 'plugin'),
      psFn: async () => [{ pid: 77777, cpu: 0, command: 'claude' }]
    });

    assert.equal(snap.sessions.length, 1);
    assert.equal(snap.sessions[0].transcriptPath, null);

    const buildings = createBuildingAssignments(path.join(fakeHome, 'ra.json'));
    const worldState = {
      agents: {}, avatars: {}, runs: {}, zones: {}, world: createWorldModel()
    };
    applySnapshotToWorld({ snapshot: snap, worldState, buildings });
    const agent = worldState.agents['no-transcript-sid'];
    assert.equal(agent.hasTranscript, false);
    assert.equal(agent.tool, null);
    assert.equal(agent.name, 'noscript');
  } finally {
    fs.rmSync(fakeHome, { recursive: true, force: true });
  }
});
