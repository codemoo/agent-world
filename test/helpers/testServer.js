const { startServer } = require('../../server/index');
const WebSocket = require('ws');

const DEFAULT_TEST_API_TOKEN = 'test-token';
const runtimeAuthRegistry = new Map();

function resolveHttpBaseFromWsUrl(wsUrl) {
  const parsed = new URL(wsUrl);
  parsed.protocol = parsed.protocol === 'wss:' ? 'https:' : 'http:';
  return `${parsed.protocol}//${parsed.host}`;
}

function resolveAuthConfig(baseUrl) {
  return runtimeAuthRegistry.get(baseUrl) || { authEnabled: false, apiToken: null };
}

function buildHeaders(baseUrl, baseHeaders = {}, options = {}) {
  const headers = { ...baseHeaders, ...(options.headers || {}) };
  const authConfig = resolveAuthConfig(baseUrl);

  if (options.auth === false) {
    delete headers.authorization;
    delete headers.Authorization;
    return headers;
  }

  const token =
    typeof options.auth === 'string' ? options.auth : authConfig.apiToken;
  if (authConfig.authEnabled && token) {
    headers.authorization = `Bearer ${token}`;
  }
  return headers;
}

async function startTestServer(options = {}) {
  const security = {
    enabled: true,
    apiToken: DEFAULT_TEST_API_TOKEN,
    ...(options.security || {})
  };
  const runtime = await startServer(0, { ...options, security });
  const baseUrl = `http://127.0.0.1:${runtime.port}`;
  const wsUrl = `ws://127.0.0.1:${runtime.port}`;
  runtimeAuthRegistry.set(baseUrl, {
    authEnabled: security.enabled !== false,
    apiToken: security.apiToken || null
  });
  return {
    ...runtime,
    baseUrl,
    wsUrl,
    authToken: security.apiToken || null
  };
}

function stopTestServer(runtime) {
  if (!runtime) {
    return Promise.resolve();
  }
  runtimeAuthRegistry.delete(runtime.baseUrl);
  if (typeof runtime.stopBackgroundWorkers === 'function') {
    runtime.stopBackgroundWorkers();
  }

  return new Promise((resolve, reject) => {
    runtime.wss.close(error => {
      if (error) {
        reject(error);
        return;
      }

      runtime.server.close(serverError => {
        if (serverError) {
          reject(serverError);
          return;
        }
        resolve();
      });
    });
  });
}

async function postJson(baseUrl, path, body, options = {}) {
  const headers = buildHeaders(
    baseUrl,
    { 'content-type': 'application/json' },
    options
  );
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  });

  const json = await response.json();
  return { response, json };
}

async function getJson(baseUrl, path, options = {}) {
  const headers = buildHeaders(baseUrl, {}, options);
  const response = await fetch(`${baseUrl}${path}`, { headers });
  const json = await response.json();
  return { response, json };
}

async function issueWsTicket(baseUrl, options = {}) {
  const headers = buildHeaders(
    baseUrl,
    { 'content-type': 'application/json' },
    options
  );
  const response = await fetch(`${baseUrl}/auth/ws-ticket`, {
    method: 'POST',
    headers,
    body: '{}'
  });
  const json = await response.json();
  return { response, json };
}

function openWebSocket(url, options = {}) {
  return new Promise(async (resolve, reject) => {
    const wsUrl = new URL(url);
    try {
      if (typeof options.ticket === 'string' && options.ticket.trim().length > 0) {
        wsUrl.searchParams.set('ticket', options.ticket.trim());
      } else if (options.auth !== false) {
        const baseUrl = resolveHttpBaseFromWsUrl(url);
        const ticketResult = await issueWsTicket(baseUrl, options);
        if (!ticketResult.response.ok) {
          throw new Error(`WS ticket issue failed (${ticketResult.response.status})`);
        }

        const ticket =
          typeof ticketResult.json?.ticket === 'string'
            ? ticketResult.json.ticket.trim()
            : '';
        if (!ticket) {
          throw new Error('WS ticket response did not include ticket.');
        }
        wsUrl.searchParams.set('ticket', ticket);
      }
    } catch (error) {
      reject(error);
      return;
    }

    const socket = new WebSocket(wsUrl.toString(), {
      headers: options.headers || {}
    });
    const timer = setTimeout(() => {
      reject(new Error('WebSocket open timeout'));
    }, 3000);

    socket.addEventListener('open', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.addEventListener('error', error => {
      clearTimeout(timer);
      const message =
        error?.message ||
        error?.error?.message ||
        String(error && error.type ? error.type : error);
      reject(new Error(message));
    });
  });
}

function normalizeMessageData(data) {
  if (typeof data === 'string') {
    return Promise.resolve(data);
  }

  if (data instanceof ArrayBuffer) {
    return Promise.resolve(Buffer.from(data).toString('utf8'));
  }

  if (ArrayBuffer.isView(data)) {
    return Promise.resolve(Buffer.from(data.buffer).toString('utf8'));
  }

  if (data && typeof data.text === 'function') {
    return data.text();
  }

  return Promise.resolve(Buffer.from(data).toString('utf8'));
}

function waitForWebSocketMessage(
  socket,
  timeoutMs = 3000,
  predicate = () => true
) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.removeEventListener('message', onMessage);
      reject(new Error('WebSocket message timeout'));
    }, timeoutMs);

    const onMessage = async event => {
      try {
        const raw = await normalizeMessageData(event.data);
        const parsed = JSON.parse(raw);
        if (!predicate(parsed)) {
          return;
        }

        clearTimeout(timer);
        socket.removeEventListener('message', onMessage);
        resolve(parsed);
      } catch (error) {
        clearTimeout(timer);
        socket.removeEventListener('message', onMessage);
        reject(error);
      }
    };

    socket.addEventListener('message', onMessage);
  });
}

module.exports = {
  getJson,
  issueWsTicket,
  openWebSocket,
  postJson,
  startTestServer,
  stopTestServer,
  waitForWebSocketMessage
};
