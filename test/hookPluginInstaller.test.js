const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildInstall,
  install,
  status,
  HOOK_EVENTS,
  pluginJsonContent
} = require('../server/hookPluginInstaller');

test('buildInstall plan covers plugin.json + status hook + pre-tool hook', () => {
  const { plan } = buildInstall();
  const writes = plan.filter(s => s.op === 'write');
  assert.equal(writes.length, 3);
  const targets = writes.map(s => s.target);
  assert.ok(targets.some(t => t.endsWith('plugin.json')));
  assert.ok(targets.some(t => t.endsWith('status-hook.sh')));
  assert.ok(targets.some(t => t.endsWith('pre-tool-use-hook.sh')));
});

test('pluginJsonContent registers all expected hook events + PreToolUse', () => {
  const parsed = JSON.parse(pluginJsonContent());
  for (const ev of HOOK_EVENTS) {
    assert.ok(parsed.hooks[ev], `missing hook: ${ev}`);
  }
  assert.ok(parsed.hooks.PreToolUse, 'missing PreToolUse hook');
  assert.equal(parsed.hooks.PreToolUse.async, false, 'PreToolUse must block the CLI');
});

test('dry-run install does not touch the filesystem', () => {
  const before = status();
  const r = install({ dryRun: true });
  const after = status();
  assert.equal(r.dryRun, true);
  assert.equal(before.installed, after.installed);
});
