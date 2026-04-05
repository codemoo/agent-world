const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('../server/index');

test('startServer: PORT 환경변수가 없으면 3102 포트를 기본값으로 사용한다', async () => {
  // 기존 PORT 환경변수 백업
  const oldPort = process.env.PORT;
  delete process.env.PORT;

  try {
    const runtime = await startServer(undefined, { security: { enabled: false } });
    assert.equal(runtime.port, 3102);
    await new Promise(resolve => runtime.server.close(resolve));
  } finally {
    // 환경변수 복구
    if (oldPort) process.env.PORT = oldPort;
  }
});
