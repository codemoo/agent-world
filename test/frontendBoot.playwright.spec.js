const path = require('node:path');
const express = require('express');
const { test, expect } = require('@playwright/test');

const {
  postJson,
  startTestServer,
  stopTestServer
} = require('./helpers/testServer');

function startFrontendStaticServer() {
  const app = express();
  const repoRoot = path.resolve(__dirname, '..');

  app.use('/assets', express.static(path.join(repoRoot, 'assets')));
  app.use(express.static(path.join(repoRoot, 'frontend')));

  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        origin: `http://127.0.0.1:${address.port}`,
        async stop() {
          await new Promise((closeResolve, closeReject) => {
            server.close(error => {
              if (error) {
                closeReject(error);
                return;
              }
              closeResolve();
            });
          });
        }
      });
    });

    server.on('error', reject);
  });
}

test.describe.configure({ mode: 'serial' });

test('Playwright 부트 스모크: 상태 전이/WS 렌더/재연결을 검증한다', async ({
  page
}) => {
  test.setTimeout(45000);
  let apiRuntime = null;
  let staticRuntime = null;

  try {
    staticRuntime = await startFrontendStaticServer();
    apiRuntime = await startTestServer({
      security: {
        corsAllowedOrigins: [staticRuntime.origin]
      }
    });

    await page.addInitScript(authToken => {
      window.__AGENT_WORLD_RUNTIME__ = {
        environment: 'production',
        authToken
      };

      const NativeWebSocket = window.WebSocket;
      const wsState = {
        urls: [],
        reconnectAttempts: 0,
        messageCount: 0,
        last: null
      };

      class TrackingWebSocket extends NativeWebSocket {
        constructor(url, protocols) {
          super(url, protocols);
          wsState.urls.push(String(url));
          wsState.reconnectAttempts += 1;
          wsState.last = this;
          this.addEventListener('message', () => {
            wsState.messageCount += 1;
          });
        }
      }

      window.__qaWsState = wsState;
      window.WebSocket = TrackingWebSocket;
    }, apiRuntime.authToken);

    const wsPortOffset = Number(
      process.env.AGENT_WORLD_BOOT_TEST_WS_PORT_OFFSET || 0
    );
    const wsPort = apiRuntime.port + wsPortOffset;
    const pageUrl = `${staticRuntime.origin}/index.html?apiPort=${apiRuntime.port}&wsPort=${wsPort}`;

    await page.goto(pageUrl, { waitUntil: 'domcontentloaded' });

    const statusBadge = page.locator('#connection-status');
    await expect(statusBadge).toHaveText('Live', { timeout: 7000 });
    await expect(statusBadge).toHaveAttribute('data-state', 'live');

    const root = page.locator('#root');
    await expect(root.locator('canvas')).toHaveCount(1);
    const baselineMessageCount = await page.evaluate(
      () => window.__qaWsState?.messageCount || 0
    );

    const appendEventResult = await postJson(apiRuntime.baseUrl, '/events', {
      event_type: 'task_created',
      agent_id: 'playwright-agent',
      task_id: 'playwright-task-1',
      payload: { label: 'playwright-guard' }
    });
    expect(appendEventResult.response.status).toBe(200);

    await expect
      .poll(
        async () => page.evaluate(() => window.__qaWsState?.messageCount || 0),
        { timeout: 7000 }
      )
      .toBeGreaterThan(baselineMessageCount);

    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const state = window.__agentWorldApp?.getWorldState?.();
            const tasks = state?.agents?.['playwright-agent']?.tasks;
            return Array.isArray(tasks)
              ? tasks.some(task => task?.id === 'playwright-task-1')
              : false;
          }),
        { timeout: 7000 }
      )
      .toBe(true);

    await page.evaluate(() => {
      const socket = window.__qaWsState?.last;
      if (!socket) {
        throw new Error('WebSocket instance was not created.');
      }

      socket.dispatchEvent(new Event('error'));
    });
    await expect(statusBadge).toHaveText('Connection Error', { timeout: 2000 });
    await expect(statusBadge).toHaveAttribute('data-state', 'error');

    await page.evaluate(() => {
      const socket = window.__qaWsState?.last;
      if (!socket) {
        throw new Error('WebSocket instance was not created.');
      }

      socket.close();
    });

    await expect(statusBadge).toHaveText('Reconnecting...', { timeout: 2500 });
    await expect(statusBadge).toHaveAttribute('data-state', 'reconnecting');
    await expect(statusBadge).toHaveText('Live', { timeout: 7000 });

    const reconnectAttempts = await page.evaluate(
      () => window.__qaWsState?.reconnectAttempts || 0
    );
    expect(reconnectAttempts).toBeGreaterThanOrEqual(2);

    const observedWsUrls = await page.evaluate(() => window.__qaWsState?.urls || []);
    expect(observedWsUrls.length).toBeGreaterThan(0);
    for (const wsUrl of observedWsUrls) {
      const parsed = new URL(wsUrl);
      expect(parsed.searchParams.get('ticket')).toBeTruthy();
      expect(parsed.searchParams.get('token')).toBeNull();
    }
  } finally {
    if (apiRuntime?.wss?.clients) {
      for (const client of apiRuntime.wss.clients) {
        client.terminate();
      }
    }
    if (staticRuntime) {
      await staticRuntime.stop();
    }
    if (apiRuntime) {
      await stopTestServer(apiRuntime);
    }
  }
});
