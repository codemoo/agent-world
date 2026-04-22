const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildInstall,
  install,
  status,
  HOOK_EVENTS,
  pluginJsonContent
} = require('../server/hookPluginInstaller');

test('buildInstall plan covers plugin.json + hook script', () => {
  const { plan } = buildInstall();
  const writes = plan.filter(s => s.op === 'write');
  assert.equal(writes.length, 2);
  const targets = writes.map(s => s.target);
  assert.ok(targets.some(t => t.endsWith('plugin.json')));
  assert.ok(targets.some(t => t.endsWith('status-hook.sh')));
});

test('pluginJsonContent registers all expected hook events', () => {
  const parsed = JSON.parse(pluginJsonContent());
  for (const ev of HOOK_EVENTS) {
    assert.ok(parsed.hooks[ev], `missing hook: ${ev}`);
  }
});

test('dry-run install does not touch the filesystem', () => {
  const before = status();
  const r = install({ dryRun: true });
  const after = status();
  assert.equal(r.dryRun, true);
  assert.equal(before.installed, after.installed);
});
