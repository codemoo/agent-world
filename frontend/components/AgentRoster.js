// DOM roster of live Claude sessions. Replaces the canvas-drawn roster
// so rows can be clicked, hovered, scrolled, and labelled with proper
// CSS spinners. Reads from worldMap.avatarRuntime on a short tick so it
// stays in step with bubble/tool updates without wiring a push channel.

const ROSTER_VERSION = 1;

const STATUS_META = {
  Working:   { dot: '#4ade80', label: 'Working' },
  Waiting:   { dot: '#fbbf24', label: 'Waiting' },
  Errored:   { dot: '#f87171', label: 'Errored' },
  Idle:      { dot: '#94a3b8', label: 'Idle' },
  IdleStale: { dot: '#64748b', label: 'Stale' },
  Finished:  { dot: '#7280a0', label: 'Done' }
};

const TICK_MS = 400;

function injectStyles(doc) {
  if (doc.getElementById('agent-roster-styles')) return;
  const style = doc.createElement('style');
  style.id = 'agent-roster-styles';
  style.textContent = `
    #agent-roster {
      position: fixed;
      top: 56px;
      right: 12px;
      width: 240px;
      max-height: calc(100vh - 160px);
      background: rgba(15, 23, 42, 0.92);
      border: 1px solid rgba(148, 163, 184, 0.35);
      border-radius: 10px;
      box-shadow: 0 10px 28px rgba(0,0,0,0.42);
      color: #e2e8f0;
      font: 11px/1.4 Menlo, Monaco, monospace;
      z-index: 11;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      transition: opacity 0.15s ease, transform 0.15s ease;
    }
    #agent-roster[data-empty="1"] { opacity: 0; pointer-events: none; transform: translateY(-4px); }
    #agent-roster .roster-header {
      display: flex; align-items: center; justify-content: space-between;
      padding: 9px 12px;
      background: rgba(30, 41, 59, 0.6);
      border-bottom: 1px solid rgba(148, 163, 184, 0.2);
      font-weight: 600;
      color: #fbbf24;
      font-size: 11px;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      user-select: none;
    }
    #agent-roster .roster-count {
      font-variant-numeric: tabular-nums;
      color: #cbd5e1;
      text-transform: none;
      font-weight: 500;
      font-size: 10px;
    }
    #agent-roster .roster-list {
      list-style: none; margin: 0; padding: 4px 0;
      overflow-y: auto;
      scrollbar-width: thin;
    }
    #agent-roster .roster-list::-webkit-scrollbar { width: 6px; }
    #agent-roster .roster-list::-webkit-scrollbar-thumb { background: rgba(148,163,184,0.25); border-radius: 4px; }
    #agent-roster .roster-row {
      display: grid;
      grid-template-columns: 14px 1fr auto;
      gap: 8px;
      align-items: center;
      padding: 6px 12px;
      cursor: pointer;
      border-left: 3px solid transparent;
      transition: background 0.1s ease, border-left-color 0.1s ease;
    }
    #agent-roster .roster-row:hover {
      background: rgba(56, 189, 248, 0.10);
      border-left-color: rgba(56, 189, 248, 0.55);
    }
    #agent-roster .roster-row[data-selected="1"] {
      background: rgba(56, 189, 248, 0.18);
      border-left-color: #38bdf8;
    }
    #agent-roster .roster-row[data-status="Working"] .roster-status-dot { animation: roster-pulse 1.4s ease-in-out infinite; }
    #agent-roster .roster-row[data-status="Finished"],
    #agent-roster .roster-row[data-status="IdleStale"] {
      opacity: 0.55;
    }
    #agent-roster .roster-status-dot {
      width: 8px; height: 8px; border-radius: 50%;
      box-shadow: 0 0 0 2px rgba(15, 23, 42, 0.4);
    }
    #agent-roster .roster-main {
      display: flex; flex-direction: column; gap: 1px;
      min-width: 0;
    }
    #agent-roster .roster-name {
      font-weight: 600; color: #f1f5f9;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    #agent-roster .roster-activity {
      color: rgba(148, 163, 184, 0.85);
      font-size: 10px;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    #agent-roster .roster-row[data-status="Working"] .roster-activity {
      color: rgba(251, 191, 36, 0.9);
    }
    #agent-roster .roster-badge {
      font-size: 9px;
      color: rgba(226, 232, 240, 0.55);
      font-variant-numeric: tabular-nums;
      text-align: right;
      white-space: nowrap;
    }
    #agent-roster .roster-spinner {
      display: inline-block;
      width: 10px; height: 10px;
      margin-left: 2px;
      border: 1.5px solid rgba(251, 191, 36, 0.3);
      border-top-color: #fbbf24;
      border-radius: 50%;
      animation: roster-spin 0.8s linear infinite;
      vertical-align: middle;
    }
    @keyframes roster-spin { to { transform: rotate(360deg); } }
    @keyframes roster-pulse {
      0%, 100% { transform: scale(1); box-shadow: 0 0 0 2px rgba(15, 23, 42, 0.4); }
      50%      { transform: scale(1.25); box-shadow: 0 0 0 4px rgba(74, 222, 128, 0.18); }
    }
    #agent-roster .roster-empty {
      padding: 18px 14px;
      color: rgba(148, 163, 184, 0.7);
      text-align: center;
      font-size: 11px;
    }
  `;
  doc.head.appendChild(style);
}

// Stable sort key: Working first, then Waiting, then Idle bucket, then
// Finished/Stale; alphabetical within buckets. Using a fixed key
// prevents row jitter during reconnect storms.
const STATUS_ORDER = { Working: 0, Waiting: 1, Errored: 2, Idle: 3, IdleStale: 4, Finished: 5 };
function sortAgents(a, b) {
  const sa = STATUS_ORDER[a.status] ?? 9;
  const sb = STATUS_ORDER[b.status] ?? 9;
  if (sa !== sb) return sa - sb;
  const na = (a.name || '').toLowerCase();
  const nb = (b.name || '').toLowerCase();
  return na.localeCompare(nb);
}

export default class AgentRoster {
  constructor({ worldMap, document: doc = document, window: win = window } = {}) {
    this.worldMap = worldMap;
    this.document = doc;
    this.window = win;
    this.tickHandle = null;
    this.selectedId = null;
    this.lastSignature = '';
    console.log(`[AgentRoster v${ROSTER_VERSION}] init`);

    injectStyles(doc);
    this._build();
    this._bind();
    this._tick(); // first paint
    this.tickHandle = win.setInterval(() => this._tick(), TICK_MS);
  }

  _build() {
    const doc = this.document;
    this.root = doc.createElement('aside');
    this.root.id = 'agent-roster';
    this.root.dataset.empty = '1';
    this.root.setAttribute('aria-label', 'Agent roster');

    const header = doc.createElement('div');
    header.className = 'roster-header';
    const title = doc.createElement('span');
    title.textContent = 'Agents';
    this.countEl = doc.createElement('span');
    this.countEl.className = 'roster-count';
    this.countEl.textContent = '0';
    header.appendChild(title);
    header.appendChild(this.countEl);
    this.root.appendChild(header);

    this.list = doc.createElement('ul');
    this.list.className = 'roster-list';
    this.root.appendChild(this.list);

    doc.body.appendChild(this.root);
  }

  _bind() {
    // Click delegation — single handler for the whole list.
    this.list.addEventListener('click', ev => {
      const row = ev.target && ev.target.closest
        ? ev.target.closest('.roster-row')
        : null;
      if (!row || !row.dataset.sessionId) return;
      this._dispatchSelect(row.dataset.sessionId);
    });

    // Track selection from WorldMap's selection event so the active row
    // highlights even when the user selects via sprite click or hotkey.
    this._onSelected = ev => {
      const detail = ev && ev.detail;
      this.selectedId = detail && detail.sessionId ? detail.sessionId : null;
      this._applySelection();
    };
    this.window.addEventListener('agent-selected', this._onSelected);
  }

  _dispatchSelect(sessionId) {
    const runtime = this.worldMap && this.worldMap.avatarRuntime;
    const avatar = runtime ? runtime.get(sessionId) : null;
    const detail = { sessionId, avatar };
    const ev = new CustomEvent('agent-selected', { bubbles: true, detail });
    this.window.dispatchEvent(ev);
  }

  _applySelection() {
    const rows = this.list.querySelectorAll('.roster-row');
    rows.forEach(row => {
      row.dataset.selected = row.dataset.sessionId === this.selectedId ? '1' : '0';
    });
  }

  // Collect current agent state from worldMap's state + avatarRuntime so
  // we don't miss runtime-only fields like toolIcon or productiveUntil.
  _collect() {
    const state = this.worldMap && this.worldMap.state;
    const agentsMap = (state && state.agents) || {};
    const runtime = this.worldMap && this.worldMap.avatarRuntime;
    const out = [];
    for (const id of Object.keys(agentsMap)) {
      const a = agentsMap[id];
      if (!a || !a.sessionId) continue;
      const rt = runtime ? runtime.get(id) : null;
      out.push({
        id,
        sessionId: a.sessionId || id,
        name: a.name || (rt && rt.displayName) || 'session',
        status: a.status || (rt && rt.serverStatus) || 'Idle',
        repoLabel: a.repoLabel || null,
        toolIcon: (rt && rt.toolIcon) || a.tool?.icon || null,
        toolName: a.tool?.name || null,
        activity: (rt && rt.bubbleText) || a.lastAssistantSnippet || ''
      });
    }
    out.sort(sortAgents);
    return out;
  }

  _tick() {
    const agents = this._collect();
    // Signature dodges DOM churn when nothing meaningful changed.
    const sig = agents
      .map(a => `${a.id}|${a.status}|${a.toolName || ''}|${a.activity.slice(0, 40)}`)
      .join('\n');
    const countSig = `${agents.length}:${this.selectedId || ''}:${sig}`;
    if (countSig === this.lastSignature) return;
    this.lastSignature = countSig;

    this.root.dataset.empty = agents.length === 0 ? '1' : '0';
    this.countEl.textContent = String(agents.length);

    const doc = this.document;
    // Map existing rows by sessionId so we can reuse rather than re-create.
    const existing = new Map();
    this.list.querySelectorAll('.roster-row').forEach(row => {
      existing.set(row.dataset.sessionId, row);
    });

    // Build in order, move into correct position.
    let prevRow = null;
    for (const a of agents) {
      let row = existing.get(a.id);
      if (!row) {
        row = doc.createElement('li');
        row.className = 'roster-row';
        row.dataset.sessionId = a.id;
        row.setAttribute('role', 'button');
        row.setAttribute('tabindex', '0');

        const dot = doc.createElement('span');
        dot.className = 'roster-status-dot';
        row.appendChild(dot);

        const main = doc.createElement('div');
        main.className = 'roster-main';
        const name = doc.createElement('div');
        name.className = 'roster-name';
        const act = doc.createElement('div');
        act.className = 'roster-activity';
        main.appendChild(name);
        main.appendChild(act);
        row.appendChild(main);

        const badge = doc.createElement('div');
        badge.className = 'roster-badge';
        row.appendChild(badge);

        // Keyboard support: Enter/Space selects.
        row.addEventListener('keydown', ev => {
          if (ev.key === 'Enter' || ev.key === ' ') {
            ev.preventDefault();
            this._dispatchSelect(row.dataset.sessionId);
          }
        });
      }

      row.dataset.status = a.status || 'Idle';
      row.dataset.selected = a.id === this.selectedId ? '1' : '0';

      const dot = row.querySelector('.roster-status-dot');
      const meta = STATUS_META[a.status] || STATUS_META.Idle;
      dot.style.background = meta.dot;

      const name = row.querySelector('.roster-name');
      name.textContent = a.name;
      // Append a repo label only when it differs from the display name.
      if (a.repoLabel && a.repoLabel !== a.name) {
        const small = doc.createElement('span');
        small.style.color = 'rgba(148,163,184,0.55)';
        small.style.marginLeft = '6px';
        small.style.fontWeight = '400';
        small.textContent = `· ${a.repoLabel}`;
        // Strip any previously-appended small tag before adding.
        name.textContent = a.name;
        name.appendChild(small);
      }

      const act = row.querySelector('.roster-activity');
      act.textContent = '';
      if (a.toolIcon || a.toolName) {
        const tool = doc.createElement('span');
        tool.textContent = `${a.toolIcon || '⚙'} ${a.toolName || ''}`.trim();
        tool.style.marginRight = '6px';
        act.appendChild(tool);
      }
      if (a.activity) {
        const label = doc.createElement('span');
        // Strip leading emoji the server already puts in bubble text when
        // we already drew a tool icon.
        label.textContent = a.toolIcon
          ? a.activity.replace(/^[^\s]+\s+[^\s]+\s+/, '')
          : a.activity;
        act.appendChild(label);
      }
      if (!a.toolName && !a.activity && meta.label) {
        act.textContent = meta.label.toLowerCase();
      }

      const badge = row.querySelector('.roster-badge');
      badge.textContent = '';
      if (a.status === 'Working') {
        const spin = doc.createElement('span');
        spin.className = 'roster-spinner';
        spin.setAttribute('aria-label', 'working');
        badge.appendChild(spin);
      } else {
        badge.textContent = meta.label;
      }

      // Reorder in place.
      if (prevRow) {
        if (prevRow.nextSibling !== row) this.list.insertBefore(row, prevRow.nextSibling);
      } else if (this.list.firstChild !== row) {
        this.list.insertBefore(row, this.list.firstChild);
      }
      prevRow = row;

      existing.delete(a.id);
    }

    // Remove rows for sessions that are gone.
    for (const stale of existing.values()) stale.remove();
  }

  destroy() {
    if (this.tickHandle) this.window.clearInterval(this.tickHandle);
    this.window.removeEventListener('agent-selected', this._onSelected);
    if (this.root && this.root.parentNode) this.root.parentNode.removeChild(this.root);
  }
}
