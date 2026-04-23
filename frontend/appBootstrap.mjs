import { createConnectionConfig } from './connectionConfig.mjs';

export function createFrontendApp({
  windowLike,
  documentLike,
  locationLike,
  fetchImpl,
  WebSocketImpl,
  WorldMapClass,
  WorldEditorClass = null,
  SessionDetailPanelClass = null,
  TerminalTuiViewClass = null,
  AgentRosterClass = null,
  HelpOverlayClass = null,
  HistoryBufferClass = null,
  EventLogClass = null,
  TimelineScrubberClass = null,
  AssetsStatusBannerClass = null,
  WorldBudgetBadgeClass = null,
  PermissionToastClass = null,
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

  // World editor — optional. Mounts its own DOM panel + toggle button.
  // Only instantiate in browser context (needs document.body).
  let worldEditor = null;
  if (WorldEditorClass && resolvedDocument.body) {
    worldEditor = new WorldEditorClass({
      worldMap,
      apiBaseUrl,
      authToken,
      fetchImpl: resolvedFetch
    });
  }

  // Terminal-style conversation viewer — full-screen overlay that polls the
  // transcript and renders it as a scrollable TUI. Opened from the session
  // detail panel or via the T keyboard shortcut while a sprite is selected.
  let tuiView = null;
  if (TerminalTuiViewClass && resolvedDocument.body) {
    tuiView = new TerminalTuiViewClass({
      apiBaseUrl,
      authToken,
      fetchImpl: resolvedFetch
    });
  }

  // Session detail panel — DOM sidebar showing the clicked agent's live
  // Claude session state (git branch, PR, last message, tools, focus button).
  let sessionDetailPanel = null;
  if (SessionDetailPanelClass && resolvedDocument.body) {
    sessionDetailPanel = new SessionDetailPanelClass({
      worldMap,
      apiBaseUrl,
      authToken,
      fetchImpl: resolvedFetch,
      tuiView
    });
  }

  // Agent roster — DOM list of live sessions. Clickable rows dispatch
  // 'agent-selected' to drive the same flow as clicking a sprite.
  let agentRoster = null;
  if (AgentRosterClass && resolvedDocument.body) {
    agentRoster = new AgentRosterClass({
      worldMap,
      document: resolvedDocument,
      window: resolvedWindow
    });
  }

  // Help overlay — "?" button + shortcut legend.
  let helpOverlay = null;
  if (HelpOverlayClass && resolvedDocument.body) {
    helpOverlay = new HelpOverlayClass({
      document: resolvedDocument,
      window: resolvedWindow
    });
  }

  // History buffer — 1Hz snapshots (~60s) + derived event stream.
  // Feeds both the EventLog panel and the TimelineScrubber.
  let historyBuffer = null;
  if (HistoryBufferClass && resolvedDocument.body) {
    historyBuffer = new HistoryBufferClass({
      worldMap,
      window: resolvedWindow
    });
  }

  let eventLog = null;
  if (EventLogClass && historyBuffer && resolvedDocument.body) {
    eventLog = new EventLogClass({
      history: historyBuffer,
      document: resolvedDocument,
      window: resolvedWindow
    });
  }

  let timelineScrubber = null;
  if (TimelineScrubberClass && historyBuffer && resolvedDocument.body) {
    timelineScrubber = new TimelineScrubberClass({
      worldMap,
      history: historyBuffer,
      document: resolvedDocument,
      window: resolvedWindow
    });
  }

  // Permission toast — listens for ws-message 'permission-request'
  // events from the server's PreToolUse hook roundtrip. Falls back to
  // a read-only "focus terminal" toast when the hook isn't installed
  // but the session status is still Waiting.
  let permissionToast = null;
  if (PermissionToastClass && resolvedDocument.body) {
    permissionToast = new PermissionToastClass({
      apiBaseUrl,
      authToken,
      fetchImpl: resolvedFetch,
      worldMap,
      document: resolvedDocument,
      window: resolvedWindow
    });
  }

  // World-wide cost badge — polls /api/cost every 5 s, shows running $
  // in the top-left. Click expands into per-session breakdown.
  let worldBudget = null;
  if (WorldBudgetBadgeClass && resolvedDocument.body) {
    worldBudget = new WorldBudgetBadgeClass({
      apiBaseUrl,
      authToken,
      fetchImpl: resolvedFetch,
      worldMap,
      document: resolvedDocument,
      window: resolvedWindow
    });
  }

  // Minimal-mode banner + gating. Hides the Assets link, World Editor
  // toggle, and (once we know) the editor-related help section when
  // sprite assets aren't installed.
  let assetsBanner = null;
  if (AssetsStatusBannerClass && resolvedDocument.body) {
    assetsBanner = new AssetsStatusBannerClass({
      document: resolvedDocument,
      window: resolvedWindow
    });
    // Best-effort: hide the top-right "Assets →" link and the World
    // Editor toggle. Both are dead weight without a sprite pack.
    const assetsLink = resolvedDocument.getElementById('assets-link');
    if (assetsLink) assetsBanner.registerGated(assetsLink, { hard: true });
    const editorToggle = resolvedDocument.getElementById('world-editor-toggle');
    if (editorToggle) assetsBanner.registerGated(editorToggle, { hard: true });
    // Some components create their toggle asynchronously — poll once a
    // beat for a second, then give up.
    let attempts = 0;
    const rescan = resolvedWindow.setInterval(() => {
      attempts += 1;
      const toggle = resolvedDocument.getElementById('world-editor-toggle');
      if (toggle && !assetsBanner._gatedEls.some(e => e.el === toggle)) {
        assetsBanner.registerGated(toggle, { hard: true });
        // Re-apply current state.
        assetsBanner._apply({
          loaded: worldMap?.assetSummary?.loadedCount > 0,
          loadedCount: worldMap?.assetSummary?.loadedCount || 0
        });
      }
      if (attempts > 5) resolvedWindow.clearInterval(rescan);
    }, 200);
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
    if (!rawMessage) return;
    // Fan out every message on a window event so opt-in subscribers
    // (e.g. PermissionToast) don't need a dedicated WS connection.
    try {
      resolvedWindow.dispatchEvent(new CustomEvent('ws-message', { detail: rawMessage }));
    } catch (_) { /* ignore */ }

    if (rawMessage.type === 'state') {
      worldMap.setWorldState(rawMessage.data || null);
      if (sessionDetailPanel?.handleStateUpdate) {
        sessionDetailPanel.handleStateUpdate(rawMessage.data);
      }
      try {
        resolvedWindow.dispatchEvent(new CustomEvent('world-state', { detail: rawMessage.data || null }));
      } catch (_) { /* ignore */ }
    } else if (rawMessage.type === 'patch' && rawMessage.patch) {
      worldMap.applyStatePatch?.(rawMessage.patch);
      if (sessionDetailPanel?.handleStateUpdate) {
        sessionDetailPanel.handleStateUpdate(worldMap.state || null);
      }
      try {
        resolvedWindow.dispatchEvent(new CustomEvent('world-state', { detail: worldMap.state || null }));
      } catch (_) { /* ignore */ }
    }
  }

  // Keyboard 1–9: focus the Nth live session in the session detail panel.
  // 0 closes the panel. Ignored when typing in a text field.
  function handleSessionHotkey(ev) {
    const tag = ev.target?.tagName || '';
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(tag)) return;
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    if (!/^[0-9]$/.test(ev.key)) return;
    if (!sessionDetailPanel) return;
    const agents = Object.values(worldMap?.state?.agents || {});
    agents.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    const idx = ev.key === '0' ? -1 : Number(ev.key) - 1;
    if (idx === -1) {
      sessionDetailPanel._close?.();
    } else if (agents[idx]) {
      sessionDetailPanel.focusSession(agents[idx].sessionId || agents[idx].id);
    }
  }
  if (typeof resolvedWindow.addEventListener === 'function') {
    resolvedWindow.addEventListener('keydown', handleSessionHotkey);
  }

  // N — toggle persistent sprite name labels. Names always remain visible
  // for hovered/selected sprites regardless of this flag.
  function handleNameTagToggle(ev) {
    const tag = ev.target?.tagName || '';
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(tag)) return;
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    if (ev.key !== 'n' && ev.key !== 'N') return;
    if (worldMap) {
      worldMap.showNameTags = !worldMap.showNameTags;
      worldMap.render?.(performance.now());
    }
  }
  if (typeof resolvedWindow.addEventListener === 'function') {
    resolvedWindow.addEventListener('keydown', handleNameTagToggle);
  }

  // M — toggle forced minimal-mode preview. Flips drawSprite +
  // character-variant rendering to always-miss, so the procedural
  // fallbacks come through. State persists across reloads.
  function handleMinimalToggle(ev) {
    const tag = ev.target?.tagName || '';
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(tag)) return;
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    if (ev.key !== 'm' && ev.key !== 'M') return;
    if (worldMap && typeof worldMap.toggleMinimalMode === 'function') {
      worldMap.toggleMinimalMode();
    }
  }
  if (typeof resolvedWindow.addEventListener === 'function') {
    resolvedWindow.addEventListener('keydown', handleMinimalToggle);

    // D — cycle drama level (calm / normal / lively). Same guard
    // rules (not-in-text-field, no modifiers).
    resolvedWindow.addEventListener('keydown', (ev) => {
      const tag = ev.target?.tagName || '';
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(tag)) return;
      if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
      if (ev.key !== 'd' && ev.key !== 'D') return;
      if (worldMap && typeof worldMap._cycleDrama === 'function') {
        worldMap._cycleDrama();
      }
    });
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
        if (sessionDetailPanel?.handleStateUpdate) {
          sessionDetailPanel.handleStateUpdate(payload.data);
        }
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

    if (sessionDetailPanel && typeof sessionDetailPanel.destroy === 'function') {
      sessionDetailPanel.destroy();
    }

    if (tuiView && typeof tuiView.destroy === 'function') {
      tuiView.destroy();
    }

    if (agentRoster && typeof agentRoster.destroy === 'function') {
      agentRoster.destroy();
    }

    if (helpOverlay && typeof helpOverlay.destroy === 'function') {
      helpOverlay.destroy();
    }

    if (eventLog && typeof eventLog.destroy === 'function') eventLog.destroy();
    if (timelineScrubber && typeof timelineScrubber.destroy === 'function') timelineScrubber.destroy();
    if (historyBuffer && typeof historyBuffer.destroy === 'function') historyBuffer.destroy();
    if (assetsBanner && typeof assetsBanner.destroy === 'function') assetsBanner.destroy();
    if (worldBudget && typeof worldBudget.destroy === 'function') worldBudget.destroy();
    if (permissionToast && typeof permissionToast.destroy === 'function') permissionToast.destroy();
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
