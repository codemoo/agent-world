const { spawnSync } = require('node:child_process');
const path = require('node:path');

const {
  ensurePlaywrightChromium,
  resolveNpxBinary
} = require('./ensurePlaywrightChromium.cjs');

function runPlaywrightBrowserSuite({
  env = process.env,
  spawnSyncFn = spawnSync
} = {}) {
  const preflight = ensurePlaywrightChromium({ env });
  if (!preflight.ok) {
    return 1;
  }

  const result = spawnSyncFn(
    resolveNpxBinary(),
    [
      'playwright',
      'test',
      path.join('test', 'frontendBoot.playwright.spec.js'),
      '--config=playwright.config.cjs',
      '--project=chromium'
    ],
    { env, stdio: 'inherit' }
  );

  return typeof result.status === 'number' ? result.status : 1;
}

if (require.main === module) {
  process.exit(runPlaywrightBrowserSuite());
}

module.exports = {
  runPlaywrightBrowserSuite
};
