const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { resolveRepoRoot, buildingIdentity, clearCache } = require('../server/repoRoot');

function mktmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'repo-root-test-'));
}

test('resolves repo root for a git dir', async () => {
  clearCache();
  const dir = mktmp();
  try {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    const inner = path.join(dir, 'nested');
    fs.mkdirSync(inner);
    const r = await resolveRepoRoot(inner);
    assert.equal(r.isRepo, true);
    assert.equal(fs.realpathSync(r.repoRoot), fs.realpathSync(dir));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('falls back to cwd when not in a git repo', async () => {
  clearCache();
  const dir = mktmp();
  try {
    const r = await resolveRepoRoot(dir);
    assert.equal(r.isRepo, false);
    assert.equal(r.repoRoot, dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('buildingIdentity prefers commonDir then repoRoot then cwd', () => {
  assert.equal(
    buildingIdentity({ repoRoot: '/a', commonDir: '/a/.git', cwd: '/a/sub' }),
    '/a/.git'
  );
  assert.equal(
    buildingIdentity({ repoRoot: '/a', commonDir: null, cwd: '/a/sub' }),
    '/a'
  );
  assert.equal(
    buildingIdentity({ repoRoot: null, commonDir: null, cwd: '/a/sub' }),
    '/a/sub'
  );
  assert.equal(buildingIdentity(null), null);
});

test('returns null-ish for missing cwd', async () => {
  const r = await resolveRepoRoot('');
  assert.equal(r.isRepo, false);
});
