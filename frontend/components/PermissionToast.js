// Toast for pending permission requests.
//
// Two data sources:
//   1. Preferred: WS `permission-request` events carry a server-allocated
//      requestId. Clicking Allow/Deny POSTs to /api/permissions/:id/decide
//      and the hook script (running on the user's shell) receives the
//      decision and tells Claude what to do.
//   2. Fallback: when the snapshotter sees status === 'Waiting' on a
//      session that has NO matching permission request (user hasn't
//      installed the hook plugin), show a read-only toast with just a
//      "Focus Terminal" button. This covers legacy installs.
//
// Browser desktop notifications fire once per new request when the user
// has previously granted permission via Notification.requestPermission().

const VERSION = 1;

const STYLES = `
  #permission-toast-stack {
    position: fixed; top: 56px; left: 50%;
    transform: translateX(-50%);
    display: flex; flex-direction: column; gap: 8px;
    z-index: 22;
    pointer-events: none;
    max-width: min(560px, calc(100vw - 48px));
    width: 100%;
  }
  #permission-toast-stack .pt-toast {
    pointer-events: auto;
    background: rgba(15, 23, 42, 0.96);
    border: 1px solid rgba(251, 191, 36, 0.55);
    border-radius: 10px;
    box-shadow: 0 14px 32px rgba(0,0,0,0.48);
    padding: 10px 14px 12px;
    color: #e2e8f0;
    font: 12px/1.45 Menlo, Monaco, monospace;
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 10px;
    align-items: start;
    animation: pt-slide-in 0.22s ease;
  }
  @keyframes pt-slide-in {
    from { transform: translateY(-10px); opacity: 0; }
    to { transform: translateY(0); opacity: 1; }
  }
  #permission-toast-stack .pt-toast[data-resolving="1"] { opacity: 0.55; filter: grayscale(0.3); }
  #permission-toast-stack .pt-icon {
    font-size: 20px; line-height: 22px;
    color: #fbbf24;
    width: 22px;
  }
  #permission-toast-stack .pt-body { min-width: 0; }
  #permission-toast-stack .pt-title {
    color: #fbbf24;
    font-weight: 700;
    letter-spacing: 0.02em;
    font-size: 11px; text-transform: uppercase;
    margin-bottom: 2px;
  }
  #permission-toast-stack .pt-session {
    color: #f1f5f9;
    font-weight: 600;
    margin-right: 6px;
  }
  #permission-toast-stack .pt-tool {
    color: #fde68a;
  }
  #permission-toast-stack .pt-cmd {
    margin-top: 4px;
    background: rgba(0,0,0,0.4);
    border-radius: 5px;
    padding: 4px 7px;
    color: #cbd5e1;
    font-size: 11px;
    white-space: pre-wrap;
    word-break: break-all;
    max-height: 90px;
    overflow: auto;
  }
  #permission-toast-stack .pt-actions {
    margin-top: 8px;
    display: flex; gap: 8px; flex-wrap: wrap;
  }
  #permission-toast-stack .pt-actions button {
    font: inherit;
    padding: 5px 10px;
    border-radius: 5px;
    cursor: pointer;
    border: 1px solid;
  }
  #permission-toast-stack .pt-btn-allow {
    background: rgba(74, 222, 128, 0.16);
    color: #a7f3d0;
    border-color: #4ade80;
    font-weight: 600;
  }
  #permission-toast-stack .pt-btn-allow:hover { background: rgba(74,222,128,0.28); }
  #permission-toast-stack .pt-btn-deny {
    background: rgba(248, 113, 113, 0.12);
    color: #fecaca;
    border-color: #f87171;
  }
  #permission-toast-stack .pt-btn-deny:hover { background: rgba(248,113,113,0.25); }
  #permission-toast-stack .pt-btn-focus {
    background: rgba(56, 189, 248, 0.14);
    color: #bae6fd;
    border-color: #38bdf8;
  }
  #permission-toast-stack .pt-btn-focus:hover { background: rgba(56,189,248,0.24); }
  #permission-toast-stack .pt-timer {
    margin-left: auto;
    font-size: 10px;
    color: #64748b;
    font-variant-numeric: tabular-nums;
    align-self: center;
  }
  #permission-toast-stack .pt-hint {
    margin-top: 4px;
    color: #64748b;
    font-size: 10px;
  }
`;

function injectStyles(doc) {
  if (doc.getElementById('permission-toast-styles')) return;
  const style = doc.createElement('style');
  style.id = 'permission-toast-styles';
  style.textContent = STYLES;
  doc.head.appendChild(style);
}

function truncate(s, n = 160) {
  if (!s) return '';
  const str = typeof s === 'string' ? s : JSON.stringify(s);
  return str.length > n ? str.slice(0, n - 1) + '…' : str;
}

function describeTool(tool, input) {
  if (!tool) return 'unknown';
  if (input && typeof input === 'object') {
    if (typeof input.command === 'string') return `${tool}: ${truncate(input.command, 220)}`;
    if (typeof input.path === 'string') return `${tool}: ${input.path}`;
    if (typeof input.url === 'string') return `${tool}: ${input.url}`;
  }
  return tool;
}

export default class PermissionToast {
  constructor({ apiBaseUrl, authToken, fetchImpl, worldMap, document: doc = document, window: win = window } = {}) {
    this.apiBaseUrl = apiBaseUrl || '';
    this.authToken = authToken || '';
    const rawFetch = fetchImpl || (typeof window !== 'undefined' ? window.fetch : null);
    this.fetch = rawFetch ? rawFetch.bind(typeof window !== 'undefined' ? window : null) : null;
    this.worldMap = worldMap || null;
    this.document = doc;
    this.window = win;
    // requestId → { row, data }
    this.active = new Map();
    // sessionIds currently shown via the fallback (no hook) path.
    this.fallbackActive = new Map();
    this._lastSessionStatuses = new Map();
    console.log(`[PermissionToast v${VERSION}] init`);

    injectStyles(doc);
    this._build();
    this._bind();
    this._askNotificationPermission();
  }

  _build() {
    const doc = this.document;
    this.stack = doc.createElement('div');
    this.stack.id = 'permission-toast-stack';
    doc.body.appendChild(this.stack);
  }

  _bind() {
    // Hook up WS message channel — we piggyback on app-level `ws-message`
    // custom events dispatched by appBootstrap. Also subscribe to
    // `agent-selected` so we can position updates near the right agent
    // in the future.
    this._onWsMsg = ev => {
      const msg = ev && ev.detail;
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'permission-request') this._onRequest(msg.data);
      else if (msg.type === 'permission-resolved') this._onResolved(msg.data);
    };
    this.window.addEventListener('ws-message', this._onWsMsg);

    // Pull any already-pending requests on boot so a fresh reload
    // doesn't miss them.
    this._hydrate().catch(() => {});

    // Fallback: watch state broadcast for Waiting transitions.
    this._onState = ev => this._scanForFallback(ev?.detail || null);
    this.window.addEventListener('world-state', this._onState);

    // Re-render timers every second.
    this._tickHandle = this.window.setInterval(() => this._tick(), 1000);
  }

  async _hydrate() {
    if (!this.fetch) return;
    const headers = this.authToken ? { authorization: `Bearer ${this.authToken}` } : undefined;
    const res = await this.fetch(`${this.apiBaseUrl}/api/permissions/pending`, { headers });
    if (!res.ok) return;
    const payload = await res.json();
    if (!payload || !Array.isArray(payload.pending)) return;
    for (const entry of payload.pending) this._onRequest(entry);
  }

  _askNotificationPermission() {
    if (typeof Notification === 'undefined') return;
    if (Notification.permission === 'default') {
      // Don't auto-prompt on page load — wait for the first permission
      // request to appear so the user gets a concrete "why" context.
      this._wantsNotificationPrompt = true;
    }
  }

  _fireDesktopNotification(req) {
    if (typeof Notification === 'undefined') return;
    try {
      if (Notification.permission === 'default' && this._wantsNotificationPrompt) {
        Notification.requestPermission();
        this._wantsNotificationPrompt = false;
        return;
      }
      if (Notification.permission !== 'granted') return;
      const name = this._resolveName(req.sessionId) || req.sessionId.slice(0, 10);
      const body = describeTool(req.tool, req.toolInput);
      const n = new Notification(`🔒 ${name} is asking permission`, {
        body: truncate(body, 180),
        tag: `permission-${req.requestId}`,
        requireInteraction: true
      });
      n.onclick = () => {
        try { this.window.focus(); } catch (_) {}
        n.close();
      };
    } catch (_) { /* ignore */ }
  }

  _resolveName(sessionId) {
    if (!sessionId || !this.worldMap) return null;
    const a = this.worldMap?.state?.agents?.[sessionId];
    return a?.name || null;
  }

  _onRequest(req) {
    if (!req || !req.requestId) return;
    if (this.active.has(req.requestId)) return;
    const row = this._buildToast(req);
    this.stack.appendChild(row);
    this.active.set(req.requestId, { row, data: req });
    // Remove any fallback toast for the same session — the real
    // request supersedes it.
    this._removeFallback(req.sessionId);
    this._fireDesktopNotification(req);
  }

  _onResolved(res) {
    if (!res || !res.requestId) return;
    const entry = this.active.get(res.requestId);
    if (!entry) return;
    entry.row.dataset.resolving = '1';
    // Brief leave animation, then remove.
    this.window.setTimeout(() => {
      if (entry.row.parentNode) entry.row.parentNode.removeChild(entry.row);
      this.active.delete(res.requestId);
    }, 400);
  }

  _buildToast(req) {
    const doc = this.document;
    const row = doc.createElement('div');
    row.className = 'pt-toast';
    row.dataset.requestId = req.requestId;

    const icon = doc.createElement('div');
    icon.className = 'pt-icon';
    icon.textContent = '🔒';
    row.appendChild(icon);

    const body = doc.createElement('div');
    body.className = 'pt-body';

    const title = doc.createElement('div');
    title.className = 'pt-title';
    const titleText = doc.createElement('span');
    titleText.textContent = 'Permission requested';
    const timer = doc.createElement('span');
    timer.className = 'pt-timer';
    timer.dataset.since = String(req.receivedAt || Date.now());
    title.appendChild(titleText);
    title.appendChild(timer);
    body.appendChild(title);

    const head = doc.createElement('div');
    const name = this._resolveName(req.sessionId) || req.sessionId.slice(0, 10);
    const nameEl = doc.createElement('span');
    nameEl.className = 'pt-session';
    nameEl.textContent = name;
    const toolEl = doc.createElement('span');
    toolEl.className = 'pt-tool';
    toolEl.textContent = req.tool || 'unknown';
    head.appendChild(nameEl);
    head.appendChild(toolEl);
    body.appendChild(head);

    const cmd = doc.createElement('div');
    cmd.className = 'pt-cmd';
    const input = req.toolInput;
    if (input && typeof input === 'object') {
      if (typeof input.command === 'string') cmd.textContent = input.command;
      else if (typeof input.path === 'string') cmd.textContent = input.path;
      else if (typeof input.url === 'string') cmd.textContent = input.url;
      else cmd.textContent = truncate(JSON.stringify(input), 600);
    } else if (typeof input === 'string') {
      cmd.textContent = input;
    } else {
      cmd.textContent = '(no input preview)';
    }
    body.appendChild(cmd);

    const actions = doc.createElement('div');
    actions.className = 'pt-actions';
    const allow = doc.createElement('button');
    allow.className = 'pt-btn-allow';
    allow.textContent = '✓ Allow';
    allow.addEventListener('click', () => this._decide(req.requestId, 'allow'));
    const deny = doc.createElement('button');
    deny.className = 'pt-btn-deny';
    deny.textContent = '✕ Deny';
    deny.addEventListener('click', () => this._decide(req.requestId, 'deny'));
    const focus = doc.createElement('button');
    focus.className = 'pt-btn-focus';
    focus.textContent = '→ Focus terminal';
    focus.addEventListener('click', () => this._focus(req.sessionId));
    actions.appendChild(allow);
    actions.appendChild(deny);
    actions.appendChild(focus);
    body.appendChild(actions);

    const hint = doc.createElement('div');
    hint.className = 'pt-hint';
    hint.textContent = 'Decision is sent to the waiting claude hook. Timeout falls back to the CLI prompt.';
    body.appendChild(hint);

    row.appendChild(body);
    return row;
  }

  async _decide(requestId, decision) {
    const entry = this.active.get(requestId);
    if (entry) entry.row.dataset.resolving = '1';
    if (!this.fetch) return;
    try {
      const headers = {
        'content-type': 'application/json',
        ...(this.authToken ? { authorization: `Bearer ${this.authToken}` } : {})
      };
      await this.fetch(`${this.apiBaseUrl}/api/permissions/${encodeURIComponent(requestId)}/decide`, {
        method: 'POST', headers,
        body: JSON.stringify({ decision, reason: 'user clicked in agent-world' })
      });
    } catch (err) {
      console.warn('[permission] decide failed:', err.message);
      if (entry) entry.row.dataset.resolving = '0';
    }
  }

  async _focus(sessionId) {
    if (!this.fetch) return;
    try {
      const headers = {
        'content-type': 'application/json',
        ...(this.authToken ? { authorization: `Bearer ${this.authToken}` } : {})
      };
      await this.fetch(`${this.apiBaseUrl}/api/sessions/${encodeURIComponent(sessionId)}/focus`,
        { method: 'POST', headers, body: '{}' });
    } catch (_) { /* ignore */ }
  }

  // Fallback: if world state says Waiting but we never received a
  // permission-request for that sessionId (user didn't install our
  // PreToolUse hook), show a read-only toast with "Focus terminal".
  _scanForFallback(state) {
    if (!state || !state.agents) return;
    const hookActiveIds = new Set();
    for (const entry of this.active.values()) hookActiveIds.add(entry.data.sessionId);

    const nowWaiting = new Set();
    for (const [sid, agent] of Object.entries(state.agents)) {
      if (agent.status === 'Waiting') nowWaiting.add(sid);
    }

    // Add new fallbacks.
    for (const sid of nowWaiting) {
      if (hookActiveIds.has(sid)) continue;
      if (this.fallbackActive.has(sid)) continue;
      const agent = state.agents[sid];
      this._addFallback(sid, agent);
    }

    // Remove fallbacks whose session left Waiting.
    for (const sid of Array.from(this.fallbackActive.keys())) {
      if (!nowWaiting.has(sid)) this._removeFallback(sid);
    }
  }

  _addFallback(sessionId, agent) {
    const doc = this.document;
    const row = doc.createElement('div');
    row.className = 'pt-toast';
    row.dataset.fallback = '1';
    row.dataset.sessionId = sessionId;

    const icon = doc.createElement('div');
    icon.className = 'pt-icon';
    icon.textContent = '🔒';
    row.appendChild(icon);

    const body = doc.createElement('div');
    body.className = 'pt-body';
    const title = doc.createElement('div');
    title.className = 'pt-title';
    title.textContent = 'Waiting for permission';
    body.appendChild(title);

    const head = doc.createElement('div');
    const name = agent?.name || sessionId.slice(0, 10);
    const nameEl = doc.createElement('span');
    nameEl.className = 'pt-session';
    nameEl.textContent = name;
    head.appendChild(nameEl);
    if (agent?.tool?.name) {
      const toolEl = doc.createElement('span');
      toolEl.className = 'pt-tool';
      toolEl.textContent = agent.tool.name;
      head.appendChild(toolEl);
    }
    body.appendChild(head);

    const hint = doc.createElement('div');
    hint.className = 'pt-hint';
    hint.textContent = 'Install the PreToolUse hook to Allow/Deny from this page. Until then, respond in the host terminal.';
    body.appendChild(hint);

    const actions = doc.createElement('div');
    actions.className = 'pt-actions';
    const focus = doc.createElement('button');
    focus.className = 'pt-btn-focus';
    focus.textContent = '→ Focus terminal';
    focus.addEventListener('click', () => this._focus(sessionId));
    actions.appendChild(focus);
    body.appendChild(actions);

    row.appendChild(body);
    this.stack.appendChild(row);
    this.fallbackActive.set(sessionId, row);
  }

  _removeFallback(sessionId) {
    const row = this.fallbackActive.get(sessionId);
    if (!row) return;
    if (row.parentNode) row.parentNode.removeChild(row);
    this.fallbackActive.delete(sessionId);
  }

  _tick() {
    const now = Date.now();
    this.stack.querySelectorAll('.pt-timer').forEach(el => {
      const since = Number(el.dataset.since || 0);
      if (!since) return;
      const sec = Math.max(0, Math.round((now - since) / 1000));
      const m = Math.floor(sec / 60);
      const s = sec % 60;
      el.textContent = `${m}:${String(s).padStart(2, '0')}`;
    });
  }

  destroy() {
    this.window.removeEventListener('ws-message', this._onWsMsg);
    this.window.removeEventListener('world-state', this._onState);
    if (this._tickHandle) this.window.clearInterval(this._tickHandle);
    if (this.stack.parentNode) this.stack.parentNode.removeChild(this.stack);
  }
}
