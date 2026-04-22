const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createClaudeSnapshotter,
  encodeCwdForProjectDir,
  deriveTranscriptPath,
  PROJECTS_DIR
} = require('../server/claudeSnapshotter');
const fs = require('node:fs');
const path = require('node:path');

test('encodeCwdForProjectDir replaces / with - and trims trailing slash', () => {
  assert.equal(encodeCwdForProjectDir('/Users/a/b'), '-Users-a-b');
  assert.equal(encodeCwdForProjectDir('/Users/a/b/'), '-Users-a-b');
  assert.equal(encodeCwdForProjectDir(null), null);
});

test('deriveTranscriptPath returns null when file does not exist', () => {
  const result = deriveTranscriptPath('/not/a/real/path', 'sess-bogus');
  assert.equal(result, null);
});

test('deriveTranscriptPath resolves an existing file under ~/.claude/projects', () => {
  const uniq = `awprobe-${process.pid}-${Date.now()}`;
  const matchingCwd = `/tmp/${uniq}`;
  const sessionId = `sess-${uniq}`;
  const encodedDir = path.join(PROJECTS_DIR, encodeCwdForProjectDir(matchingCwd));
  const matchingFile = path.join(encodedDir, `${sessionId}.jsonl`);
  try {
    fs.mkdirSync(encodedDir, { recursive: true });
    fs.writeFileSync(matchingFile, '{}\n');
    const derived = deriveTranscriptPath(matchingCwd, sessionId);
    assert.equal(derived, matchingFile);

    // Missing session id returns null.
    const miss = deriveTranscriptPath(matchingCwd, 'no-such-session');
    assert.equal(miss, null);
  } finally {
    fs.rmSync(encodedDir, { recursive: true, force: true });
  }
});

// Smoke test: snapshotter boots, reads the real host state, shuts down cleanly.
// We don't assert specific sessions because they depend on the machine.
test('snapshotter start/stop + emits at least one snapshot', async () => {
  const snap = createClaudeSnapshotter({ tickMs: 250 });
  const received = [];
  snap.on('snapshot', s => received.push(s));
  snap.start();
  await new Promise(r => setTimeout(r, 600));
  snap.stop();
  assert.ok(received.length >= 1, 'expected at least one snapshot event');
  const first = received[0];
  assert.ok(Array.isArray(first.sessions));
  assert.ok(Array.isArray(first.alivePids));
  assert.ok(typeof first.takenAtMs === 'number');
});
