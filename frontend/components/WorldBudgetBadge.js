// Small bottom-corner badge showing the running $ total across all
// live sessions in the village. Polls `/api/cost` every 5 s while
// visible. Click expands into a per-session breakdown tooltip.

const BUDGET_VERSION = 1;

function fmtUSD(n) {
  if (!Number.isFinite(n)) return '$0.00';
  if (n >= 100) return '$' + n.toFixed(0);
  if (n >= 1)   return '$' + n.toFixed(2);
  return '$' + n.toFixed(3);
}

function fmtTokens(n) {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000)     return (n / 1_000).toFixed(1) + 'k';
  return String(n);
}

const STYLES = `
  #world-budget {
    position: fixed;
    top: 48px; left: 12px;
    background: rgba(15, 23, 42, 0.9);
    border: 1px solid rgba(251, 191, 36, 0.35);
    border-radius: 8px;
    color: #fde68a;
    font: 600 12px/1.2 Menlo, Monaco, monospace;
    padding: 6px 10px;
    box-shadow: 0 6px 18px rgba(0,0,0,0.35);
    z-index: 10;
    cursor: pointer;
    user-select: none;
    display: flex; align-items: center; gap: 7px;
    transition: transform 0.1s ease, background 0.12s ease;
  }
  #world-budget:hover { background: rgba(30, 41, 59, 0.95); transform: translateY(-1px); }
  #world-budget[data-empty="1"] { display: none; }
  #world-budget .wb-icon { color: #fbbf24; }
  #world-budget .wb-sub {
    font-weight: 400; color: #94a3b8; font-size: 10px;
  }
  #world-budget-popover {
    position: fixed;
    top: 84px; left: 12px;
    min-width: 280px; max-width: 380px;
    background: rgba(15, 23, 42, 0.95);
    border: 1px solid rgba(148, 163, 184, 0.3);
    border-radius: 9px;
    color: #e2e8f0;
    font: 11px/1.4 Menlo, Monaco, monospace;
    padding: 10px 12px;
    box-shadow: 0 10px 24px rgba(0,0,0,0.45);
    z-index: 11;
    display: none;
  }
  #world-budget-popover[data-visible="1"] { display: block; }
  #world-budget-popover h4 {
    margin: 0 0 8px;
    font-size: 11px;
    color: #fbbf24;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    border-bottom: 1px solid rgba(251, 191, 36, 0.2);
    padding-bottom: 4px;
  }
  #world-budget-popover .wb-row {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 8px;
    padding: 2px 0;
    align-items: baseline;
  }
  #world-budget-popover .wb-row .wb-name {
    color: #cbd5e1;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  #world-budget-popover .wb-row .wb-cost {
    color: #fde68a;
    font-variant-numeric: tabular-nums;
  }
  #world-budget-popover .wb-model {
    color: #64748b;
    font-size: 9px;
    margin-left: 6px;
  }
  #world-budget-popover .wb-total {
    margin-top: 8px;
    padding-top: 8px;
    border-top: 1px solid rgba(148, 163, 184, 0.2);
    display: grid;
    grid-template-columns: 1fr auto;
    font-weight: 600;
    color: #fbbf24;
  }
  #world-budget-popover .wb-hint {
    color: #475569;
    font-size: 10px;
    text-align: right;
    margin-top: 4px;
  }
`;

function injectStyles(doc) {
  if (doc.getElementById('world-budget-styles')) return;
  const style = doc.createElement('style');
  style.id = 'world-budget-styles';
  style.textContent = STYLES;
  doc.head.appendChild(style);
}

export default class WorldBudgetBadge {
  constructor({ apiBaseUrl, authToken, fetchImpl, worldMap, document: doc = document, window: win = window } = {}) {
    this.apiBaseUrl = apiBaseUrl || '';
    this.authToken = authToken || '';
    const rawFetch = fetchImpl || (typeof window !== 'undefined' ? window.fetch : null);
    this.fetch = rawFetch ? rawFetch.bind(typeof window !== 'undefined' ? window : null) : null;
    this.worldMap = worldMap || null;
    this.document = doc;
    this.window = win;
    this.pollHandle = null;
    this.popoverOpen = false;
    console.log(`[WorldBudgetBadge v${BUDGET_VERSION}] init`);

    injectStyles(doc);
    this._build();
    this._bind();
    this.refresh();
    this.pollHandle = win.setInterval(() => this.refresh(), 5000);
  }

  _build() {
    const doc = this.document;
    this.root = doc.createElement('div');
    this.root.id = 'world-budget';
    this.root.dataset.empty = '1';
    this.root.setAttribute('role', 'button');
    this.root.setAttribute('tabindex', '0');
    this.root.setAttribute('title', 'Village spend so far · click for breakdown');
    const icon = doc.createElement('span'); icon.className = 'wb-icon'; icon.textContent = '💰';
    this.amountEl = doc.createElement('span'); this.amountEl.textContent = '$0';
    this.subEl = doc.createElement('span'); this.subEl.className = 'wb-sub'; this.subEl.textContent = '0 msg';
    this.root.appendChild(icon);
    this.root.appendChild(this.amountEl);
    this.root.appendChild(this.subEl);
    doc.body.appendChild(this.root);

    this.popover = doc.createElement('aside');
    this.popover.id = 'world-budget-popover';
    doc.body.appendChild(this.popover);
  }

  _bind() {
    const onClick = () => {
      this.popoverOpen = !this.popoverOpen;
      this.popover.dataset.visible = this.popoverOpen ? '1' : '0';
      if (this.popoverOpen) this.refresh();
    };
    this.root.addEventListener('click', onClick);
    this.root.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); onClick(); }
    });
    // Click outside popover → close.
    this._onDocClick = (ev) => {
      if (!this.popoverOpen) return;
      if (this.popover.contains(ev.target) || this.root.contains(ev.target)) return;
      this.popoverOpen = false;
      this.popover.dataset.visible = '0';
    };
    this.document.addEventListener('click', this._onDocClick);
    this._onEditor = (ev) => {
      const active = Boolean(ev && ev.detail && ev.detail.active);
      if (this.root) this.root.style.display = active ? 'none' : '';
      if (active) { this.popoverOpen = false; this.popover.dataset.visible = '0'; }
    };
    this.window.addEventListener('editor-mode', this._onEditor);
  }

  async refresh() {
    if (!this.fetch) return;
    try {
      const headers = this.authToken ? { authorization: `Bearer ${this.authToken}` } : undefined;
      const res = await this.fetch(`${this.apiBaseUrl}/api/cost`, { headers });
      if (!res.ok) return;
      const payload = await res.json();
      this._apply(payload);
    } catch (_) { /* ignore */ }
  }

  _apply(payload) {
    const totals = payload && payload.worldTotals;
    const bySession = payload && payload.bySession;
    if (!totals || !totals.messageCount) {
      this.root.dataset.empty = '1';
      return;
    }
    this.root.dataset.empty = '0';
    this.amountEl.textContent = fmtUSD(totals.cost || 0);
    this.subEl.textContent = `${totals.messageCount} msg · ${fmtTokens((totals.input || 0) + (totals.output || 0))}`;

    if (this.popoverOpen) this._renderPopover(totals, bySession);
  }

  _renderPopover(totals, bySession) {
    const doc = this.document;
    this.popover.textContent = '';
    const h = doc.createElement('h4');
    h.textContent = 'Per-session spend';
    this.popover.appendChild(h);

    // Pair session-id → display name from WorldMap's live state when
    // possible, otherwise show the first slice of the id.
    const agents = this.worldMap?.state?.agents || {};
    const entries = Object.entries(bySession || {});
    entries.sort((a, b) => (b[1].cost || 0) - (a[1].cost || 0));
    for (const [id, t] of entries.slice(0, 12)) {
      if (!t.messageCount) continue;
      const name = agents[id]?.name || id.slice(0, 10);
      const row = doc.createElement('div');
      row.className = 'wb-row';
      const nameEl = doc.createElement('span');
      nameEl.className = 'wb-name';
      nameEl.textContent = name;
      if (t.model) {
        const model = doc.createElement('span');
        model.className = 'wb-model';
        model.textContent = `(${String(t.model).replace(/^claude-/, '').split('-').slice(0, 2).join(' ')})`;
        nameEl.appendChild(model);
      }
      const costEl = doc.createElement('span');
      costEl.className = 'wb-cost';
      costEl.textContent = fmtUSD(t.cost || 0);
      row.appendChild(nameEl);
      row.appendChild(costEl);
      this.popover.appendChild(row);
    }

    const tot = doc.createElement('div');
    tot.className = 'wb-total';
    const label = doc.createElement('span'); label.textContent = 'Total';
    const val = doc.createElement('span'); val.textContent = fmtUSD(totals.cost || 0);
    tot.appendChild(label); tot.appendChild(val);
    this.popover.appendChild(tot);

    const hint = doc.createElement('div');
    hint.className = 'wb-hint';
    hint.textContent = 'estimate — rates may drift';
    this.popover.appendChild(hint);
  }

  destroy() {
    if (this.pollHandle) this.window.clearInterval(this.pollHandle);
    this.document.removeEventListener('click', this._onDocClick);
    this.window.removeEventListener('editor-mode', this._onEditor);
    if (this.root.parentNode) this.root.parentNode.removeChild(this.root);
    if (this.popover.parentNode) this.popover.parentNode.removeChild(this.popover);
  }
}
