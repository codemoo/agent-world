import { createConnectionConfig } from './connectionConfig.mjs';

export function createFrontendApp({
  windowLike,
  documentLike,
  locationLike,
  fetchImpl,
  WebSocketImpl,
  WorldMapClass,
  connectionConfigOptions = {},
  connectionConfigFactory = createConnectionConfig
} = {}) {
  const resolvedWindow =
    windowLike || (typeof window !== 'undefined' ? window : null);
  const resolvedDocument =
    documentLike || (typeof document !== 'undefined' ? document : null);
  const resolvedLocation = locationLike || resolvedWindow?.location;
  const resolvedFetch =
    fetchImpl || (typeof fetch === 'function' ? fetch : null);
  const ResolvedWebSocket =
    WebSocketImpl || (typeof WebSocket !== 'undefined' ? WebSocket : null);

  if (!resolvedWindow || !resolvedDocument || !resolvedLocation) {
    throw new Error('Browser globals are required to bootstrap frontend app.');
  }

  if (!resolvedFetch || !ResolvedWebSocket) {
    throw new Error('fetch/WebSocket runtime is required to bootstrap frontend app.');
  }
  if (!WorldMapClass) {
    throw new Error('WorldMap runtime class is required to bootstrap frontend app.');
  }

  const { authToken, assetRoot, apiBaseUrl, wsBaseUrl, wsUrl } =
    connectionConfigFactory(resolvedLocation, connectionConfigOptions);
  const resolvedWsBaseUrl = wsBaseUrl || wsUrl;

  const root = resolvedDocument.getElementById('root');
  const statusBadge = resolvedDocument.getElementById('connection-status');
  if (!root) {
    throw new Error('#root element is required.');
  }

  const worldMap = new WorldMapClass(root, { assetRoot });
  if (typeof worldMap.start === 'function') {
    worldMap.start();
  }

  let socket = null;
  let reconnectTimer = null;
  let isDestroyed = false;
  let isConnecting = false;
  const wsConnectingState =
    typeof ResolvedWebSocket.CONNECTING === 'number'
      ? ResolvedWebSocket.CONNECTING
      : 0;

  function setConnectionStatus(label, modifier = '') {
    if (!statusBadge) {
      return;
    }

    statusBadge.textContent = label;
    statusBadge.dataset.state = modifier;
  }

  function applyMessage(rawMessage) {
    if (!rawMessage || rawMessage.type !== 'state') {
      return;
    }

    worldMap.setWorldState(rawMessage.data || null);
  }

  async function fetchInitialState() {
    try {
      const headers = authToken
        ? { authorization: `Bearer ${authToken}` }
        : undefined;
      const response = await resolvedFetch(`${apiBaseUrl}/state`, { headers });
      if (!response.ok) {
        throw new Error(`Failed to fetch /state (${response.status})`);
      }

      const payload = await response.json();
      if (payload?.data) {
        worldMap.setWorldState(payload.data);
      }
    } catch (error) {
      console.error(error);
    }
  }

  async function issueWsTicket() {
    const headers = authToken
      ? {
          authorization: `Bearer ${authToken}`,
          'content-type': 'application/json'
        }
      : { 'content-type': 'application/json' };
    const response = await resolvedFetch(`${apiBaseUrl}/auth/ws-ticket`, {
      method: 'POST',
      headers,
      body: '{}'
    });
    if (!response.ok) {
      throw new Error(`Failed to issue WS ticket (${response.status})`);
    }

    const payload = await response.json();
    const ticket =
      typeof payload?.ticket === 'string' ? payload.ticket.trim() : '';
    if (!ticket) {
      throw new Error('WS ticket payload is missing ticket value.');
    }

    const wsUrlObject = new URL(resolvedWsBaseUrl);
    wsUrlObject.searchParams.set('ticket', ticket);
    return wsUrlObject.toString();
  }

  function scheduleReconnect() {
    if (isDestroyed || reconnectTimer) {
      return;
    }

    reconnectTimer = resolvedWindow.setTimeout(() => {
      reconnectTimer = null;
      connectWebSocket();
    }, 1500);
  }

  function connectWebSocket() {
    if (
      isDestroyed ||
      isConnecting ||
      (socket &&
        (socket.readyState === ResolvedWebSocket.OPEN ||
          socket.readyState === wsConnectingState))
    ) {
      return;
    }

    isConnecting = true;
    setConnectionStatus('Connecting...', 'connecting');
    issueWsTicket()
      .then(wsUrl => {
        isConnecting = false;
        if (isDestroyed) {
          return;
        }

        socket = new ResolvedWebSocket(wsUrl);

        socket.addEventListener('open', () => {
          setConnectionStatus('Live', 'live');
        });

        socket.addEventListener('message', event => {
          try {
            const message = JSON.parse(event.data);
            applyMessage(message);
          } catch (error) {
            console.error('Failed to parse WS message', error);
          }
        });

        socket.addEventListener('close', () => {
          if (isDestroyed) {
            return;
          }

          setConnectionStatus('Reconnecting...', 'reconnecting');
          scheduleReconnect();
        });

        socket.addEventListener('error', () => {
          setConnectionStatus('Connection Error', 'error');
        });
      })
      .catch(error => {
        isConnecting = false;
        console.error('Failed to initialize WS connection', error);
        if (isDestroyed) {
          return;
        }
        setConnectionStatus('Connection Error', 'error');
        scheduleReconnect();
      });
  }

  function destroy() {
    if (isDestroyed) {
      return;
    }

    isDestroyed = true;

    if (reconnectTimer) {
      resolvedWindow.clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }

    if (socket && typeof socket.close === 'function') {
      socket.close();
    }

    if (typeof worldMap.destroy === 'function') {
      worldMap.destroy();
    }
  }

  return {
    fetchInitialState,
    connectWebSocket,
    destroy,
    getWorldState() {
      return worldMap.state || null;
    }
  };
}

export function bootstrapFrontendApp(options = {}) {
  const resolvedWindow =
    options.windowLike || (typeof window !== 'undefined' ? window : null);
  const app = createFrontendApp(options);
  if (resolvedWindow && typeof resolvedWindow === 'object') {
    resolvedWindow.__agentWorldApp = app;
  }

  if (resolvedWindow && typeof resolvedWindow.addEventListener === 'function') {
    resolvedWindow.addEventListener('beforeunload', () => {
      app.destroy();
    });
  }

  app.fetchInitialState();
  app.connectWebSocket();
  return app;
}
