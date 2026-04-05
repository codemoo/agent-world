const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const moduleUrl = pathToFileURL(
  path.join(__dirname, '../frontend/connectionConfig.mjs')
).href;

async function loadConnectionConfig() {
  return import(moduleUrl);
}

test('apiPort/wsPort는 숫자 범위만 허용하고 host injection 입력은 기본값으로 차단한다', async () => {
  const { CONNECTION_DEFAULTS, createConnectionConfig } =
    await loadConnectionConfig();

  const config = createConnectionConfig({
    protocol: 'http:',
    hostname: 'victim.local',
    search: '?apiPort=443@evil.com&wsPort=8443@evil.com&authToken=secret'
  });

  assert.equal(config.apiPort, CONNECTION_DEFAULTS.port);
  assert.equal(config.wsPort, CONNECTION_DEFAULTS.port);
  assert.equal(new URL(config.apiBaseUrl).hostname, 'victim.local');
  assert.equal(new URL(config.wsBaseUrl).hostname, 'victim.local');
  assert.equal(config.environment, 'production');
  assert.equal(config.allowDevQueryToken, false);
  assert.equal(config.authToken, '');
  assert.equal(new URL(config.wsBaseUrl).searchParams.get('ticket'), null);
});

test('development + 명시 플래그에서만 authToken/token 쿼리를 허용한다', async () => {
  const { createConnectionConfig } = await loadConnectionConfig();

  const config = createConnectionConfig(
    {
      protocol: 'https:',
      hostname: 'dev.local',
      port: '',
      search: '?authToken=dev-secret'
    },
    { environment: 'development', allowDevQueryToken: true }
  );

  assert.equal(config.environment, 'development');
  assert.equal(config.allowDevQueryToken, true);
  assert.equal(config.authToken, 'dev-secret');
  // Standard https port (443) should NOT be baked into the URL — the
  // browser uses the origin's port automatically. This lets external
  // tunnels / reverse proxies work without hardcoding :3102.
  assert.equal(config.wsBaseUrl, 'wss://dev.local/');
  assert.equal(config.wsPort, 443);
});

test('location.port이 있으면 같은 포트로 연결한다 (localhost dev)', async () => {
  const { createConnectionConfig } = await loadConnectionConfig();
  const config = createConnectionConfig({
    protocol: 'http:',
    hostname: 'localhost',
    port: '3102',
    search: ''
  });
  assert.equal(config.apiBaseUrl, 'http://localhost:3102');
  assert.equal(config.wsBaseUrl, 'ws://localhost:3102/');
  assert.equal(config.apiPort, 3102);
});

test('외부 터널 (port 미지정)은 origin을 그대로 사용한다', async () => {
  const { createConnectionConfig } = await loadConnectionConfig();
  const config = createConnectionConfig({
    protocol: 'https:',
    hostname: 'tunnel.example.com',
    port: '',
    search: ''
  });
  assert.equal(config.apiBaseUrl, 'https://tunnel.example.com');
  assert.equal(config.wsBaseUrl, 'wss://tunnel.example.com/');
});

test('유효한 포트 입력은 반영되고 wsPort 미지정 시 apiPort를 상속한다', async () => {
  const { createConnectionConfig } = await loadConnectionConfig();

  const config = createConnectionConfig({
    protocol: 'https:',
    hostname: 'agent.local',
    search: '?apiPort=3101&assetRoot=%2Fassets%2Fcustom'
  });

  assert.equal(config.apiPort, 3101);
  assert.equal(config.wsPort, 3101);
  assert.equal(config.assetRoot, '/assets/custom');
  assert.equal(config.apiBaseUrl, 'https://agent.local:3101');
  assert.equal(config.wsBaseUrl, 'wss://agent.local:3101/');
});
