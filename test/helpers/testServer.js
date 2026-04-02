const { startServer } = require('../../server/index');

async function startTestServer(options = {}) {
  const runtime = await startServer(0, options);
  const baseUrl = `http://127.0.0.1:${runtime.port}`;
  const wsUrl = `ws://127.0.0.1:${runtime.port}`;
  return {
    ...runtime,
    baseUrl,
    wsUrl
  };
}

function stopTestServer(runtime) {
  if (!runtime) {
    return Promise.resolve();
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

async function postJson(baseUrl, path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });

  const json = await response.json();
  return { response, json };
}

async function getJson(baseUrl, path) {
  const response = await fetch(`${baseUrl}${path}`);
  const json = await response.json();
  return { response, json };
}

function openWebSocket(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const timer = setTimeout(() => {
      reject(new Error('WebSocket open timeout'));
    }, 3000);

    socket.addEventListener('open', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.addEventListener('error', error => {
      clearTimeout(timer);
      reject(error);
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
  openWebSocket,
  postJson,
  startTestServer,
  stopTestServer,
  waitForWebSocketMessage
};
