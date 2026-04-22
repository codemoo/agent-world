// Resolve a cwd to its git repo root (`git rev-parse --show-toplevel`).
// For worktrees we also surface the common dir so two worktrees of the same
// repo can share a building. Falls back to the cwd if outside any repo.

const { execFile } = require('node:child_process');
const path = require('node:path');

const TTL_MS = 30_000;
const cache = new Map(); // cwd → { resolvedAt, result }

function runGit(cwd, args) {
  return new Promise(resolve => {
    execFile('git', args, { cwd, timeout: 1500 }, (err, stdout) => {
      if (err) return resolve(null);
      const out = stdout.toString().trim();
      resolve(out.length > 0 ? out : null);
    });
  });
}

async function resolveRepoRoot(cwd) {
  if (!cwd || typeof cwd !== 'string') {
    return { repoRoot: null, commonDir: null, isRepo: false, cwd };
  }
  const cached = cache.get(cwd);
  if (cached && Date.now() - cached.resolvedAt < TTL_MS) {
    return cached.result;
  }

  const [top, common] = await Promise.all([
    runGit(cwd, ['rev-parse', '--show-toplevel']),
    runGit(cwd, ['rev-parse', '--git-common-dir'])
  ]);

  let result;
  if (!top) {
    result = { repoRoot: cwd, commonDir: null, isRepo: false, cwd };
  } else {
    // commonDir may be relative; resolve against the repo top for identity.
    const resolvedCommon = common
      ? path.isAbsolute(common) ? common : path.resolve(top, common)
      : null;
    result = { repoRoot: top, commonDir: resolvedCommon, isRepo: true, cwd };
  }

  cache.set(cwd, { resolvedAt: Date.now(), result });
  return result;
}

// Identity used for building assignment. Two worktrees of the same repo share
// an identity via commonDir; repos without a commonDir fall back to repoRoot.
function buildingIdentity(resolved) {
  if (!resolved) return null;
  return resolved.commonDir || resolved.repoRoot || resolved.cwd || null;
}

function clearCache() {
  cache.clear();
}

module.exports = { resolveRepoRoot, buildingIdentity, clearCache };
