const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');

const {
  OFFLINE_MISSING_CACHE_CODE,
  INSTALL_FAILED_CODE,
  resolveBrowserCachePath,
  normalizeNetworkMode,
  ensurePlaywrightChromium
} = require('./helpers/ensurePlaywrightChromium.cjs');

test('캐시 경로 기본값은 홈 캐시 디렉터리를 사용한다', () => {
  const resolved = resolveBrowserCachePath({});
  assert.equal(resolved, path.join(os.homedir(), '.cache', 'agent-world-playwright'));
});

test('네트워크 모드 값이 비정상이면 auto로 폴백한다', () => {
  assert.equal(normalizeNetworkMode({ AGENT_WORLD_PLAYWRIGHT_NETWORK_MODE: 'OFFLINE' }), 'offline');
  assert.equal(normalizeNetworkMode({ AGENT_WORLD_PLAYWRIGHT_NETWORK_MODE: 'bogus' }), 'auto');
});

test('offline 모드에서 Chromium 캐시 누락 시 명시적 코드로 실패한다', () => {
  const logs = [];
  const warnings = [];
  const env = {
    AGENT_WORLD_PLAYWRIGHT_NETWORK_MODE: 'offline',
    PLAYWRIGHT_BROWSERS_PATH: '/tmp/agent-world-playwright-empty-cache'
  };

  const result = ensurePlaywrightChromium({
    env,
    hasChromiumExecutableFn: () => false,
    installChromiumFn: () => ({ status: 0 }),
    log: line => logs.push(line),
    warn: line => warnings.push(line)
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, OFFLINE_MISSING_CACHE_CODE);
  assert.equal(result.mode, 'offline');
  assert.equal(logs.length, 0);
  assert.ok(warnings.some(line => line.includes(OFFLINE_MISSING_CACHE_CODE)));
});

test('auto 모드에서 설치 성공 시 게이트를 통과한다', () => {
  const logs = [];
  const env = {
    AGENT_WORLD_PLAYWRIGHT_NETWORK_MODE: 'auto',
    PLAYWRIGHT_BROWSERS_PATH: '/tmp/agent-world-playwright-cache'
  };

  let hasChromium = false;
  const result = ensurePlaywrightChromium({
    env,
    hasChromiumExecutableFn: () => hasChromium,
    installChromiumFn: () => {
      hasChromium = true;
      return { status: 0 };
    },
    log: line => logs.push(line),
    warn: () => {}
  });

  assert.equal(result.ok, true);
  assert.equal(result.installed, true);
  assert.ok(logs.some(line => line.includes('Installing')));
});

test('online 모드에서 설치 실패 시 실패 코드로 반환한다', () => {
  const result = ensurePlaywrightChromium({
    env: {
      AGENT_WORLD_PLAYWRIGHT_NETWORK_MODE: 'online',
      PLAYWRIGHT_BROWSERS_PATH: '/tmp/agent-world-playwright-cache'
    },
    hasChromiumExecutableFn: () => false,
    installChromiumFn: () => ({ status: 2 }),
    log: () => {},
    warn: () => {}
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, INSTALL_FAILED_CODE);
});
