const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const OFFLINE_MISSING_CACHE_CODE = 'PLAYWRIGHT_CACHE_MISSING_OFFLINE';
const INSTALL_FAILED_CODE = 'PLAYWRIGHT_CHROMIUM_INSTALL_FAILED';
const INSTALL_INVALID_CODE = 'PLAYWRIGHT_CHROMIUM_INSTALL_INVALID';
const SUPPORTED_NETWORK_MODES = new Set(['auto', 'online', 'offline']);

function resolveNpxBinary() {
  return process.platform === 'win32' ? 'npx.cmd' : 'npx';
}

function resolveBrowserCachePath(env = process.env) {
  if (typeof env.PLAYWRIGHT_BROWSERS_PATH === 'string' && env.PLAYWRIGHT_BROWSERS_PATH.trim()) {
    return env.PLAYWRIGHT_BROWSERS_PATH.trim();
  }
  return path.join(os.homedir(), '.cache', 'agent-world-playwright');
}

function normalizeNetworkMode(env = process.env) {
  const raw = String(env.AGENT_WORLD_PLAYWRIGHT_NETWORK_MODE || 'auto').trim().toLowerCase();
  return SUPPORTED_NETWORK_MODES.has(raw) ? raw : 'auto';
}

function hasChromiumExecutable() {
  const resolveChromium = () => {
    try {
      return require('playwright').chromium;
    } catch {
      try {
        return require('@playwright/test').chromium;
      } catch {
        return null;
      }
    }
  };

  try {
    const chromium = resolveChromium();
    if (!chromium) {
      return false;
    }
    const executablePath = chromium.executablePath();
    return Boolean(executablePath) && fs.existsSync(executablePath);
  } catch {
    return false;
  }
}

function installChromium({
  env = process.env,
  spawnSyncFn = spawnSync,
  npxBinary = resolveNpxBinary(),
  stdio = 'inherit'
} = {}) {
  return spawnSyncFn(npxBinary, ['playwright', 'install', 'chromium'], {
    stdio,
    env
  });
}

function ensurePlaywrightChromium({
  env = process.env,
  hasChromiumExecutableFn = hasChromiumExecutable,
  installChromiumFn = installChromium,
  log = console.log,
  warn = console.error
} = {}) {
  const cachePath = resolveBrowserCachePath(env);
  env.PLAYWRIGHT_BROWSERS_PATH = cachePath;
  fs.mkdirSync(cachePath, { recursive: true });

  const mode = normalizeNetworkMode(env);
  const chromiumReady = hasChromiumExecutableFn();
  if (chromiumReady) {
    log(`[playwright-preflight] Chromium ready (cache=${cachePath}, mode=${mode}).`);
    return { ok: true, installed: false, cachePath, mode };
  }

  if (mode === 'offline') {
    warn(
      `[playwright-preflight][${OFFLINE_MISSING_CACHE_CODE}] Chromium executable not found in cache=${cachePath}.`
    );
    warn(
      '[playwright-preflight] Offline mode blocks downloads. Seed cache first:'
    );
    warn(
      `PLAYWRIGHT_BROWSERS_PATH=${cachePath} npx playwright install chromium`
    );
    return {
      ok: false,
      installed: false,
      cachePath,
      mode,
      code: OFFLINE_MISSING_CACHE_CODE
    };
  }

  log(
    `[playwright-preflight] Chromium not found (cache=${cachePath}, mode=${mode}). Installing...`
  );
  const installResult = installChromiumFn({ env });
  if (!installResult || typeof installResult.status !== 'number') {
    warn(
      `[playwright-preflight][${INSTALL_INVALID_CODE}] Playwright install returned an invalid result.`
    );
    return {
      ok: false,
      installed: false,
      cachePath,
      mode,
      code: INSTALL_INVALID_CODE
    };
  }

  if (installResult.status !== 0) {
    warn(
      `[playwright-preflight][${INSTALL_FAILED_CODE}] Playwright install failed with exit code ${installResult.status}.`
    );
    return {
      ok: false,
      installed: false,
      cachePath,
      mode,
      code: INSTALL_FAILED_CODE
    };
  }

  if (!hasChromiumExecutableFn()) {
    warn(
      `[playwright-preflight][${INSTALL_INVALID_CODE}] Chromium still missing after install.`
    );
    return {
      ok: false,
      installed: false,
      cachePath,
      mode,
      code: INSTALL_INVALID_CODE
    };
  }

  log(`[playwright-preflight] Chromium install completed (cache=${cachePath}).`);
  return { ok: true, installed: true, cachePath, mode };
}

if (require.main === module) {
  const result = ensurePlaywrightChromium();
  if (!result.ok) {
    process.exit(1);
  }
}

module.exports = {
  OFFLINE_MISSING_CACHE_CODE,
  INSTALL_FAILED_CODE,
  INSTALL_INVALID_CODE,
  resolveNpxBinary,
  resolveBrowserCachePath,
  normalizeNetworkMode,
  hasChromiumExecutable,
  installChromium,
  ensurePlaywrightChromium
};
