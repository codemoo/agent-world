// DOM sidebar that shows the clicked agent's live Claude session state.
// Subscribes to the `agent-selected` event dispatched by WorldMap on click.
// Pulls `/api/sessions/:sessionId` for extra detail (git branch, last msg,
// current tool, PR etc.) when the panel opens.

const PANEL_VERSION = 2;
// Sparkline (Item F) — rolling window of cumulative tokens,
// rendered as tokens-per-second bar chart over the last minute.
const SPARKLINE_WINDOW_MS = 60_000;
const SPARKLINE_MAX_SAMPLES = 60;

function h(tag, attrs = {}, children = []) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') {
      el.addEventListener(k.slice(2).toLowerCase(), v);
    } else {
      el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  for (const c of [].concat(children)) {
    if (c == null) continue;
    el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return el;
}

const STATUS_COLORS = {
  Working:   '#4ade80',
  Waiting:   '#fbbf24',
  Errored:   '#f87171',
  Idle:      '#94a3b8',
  IdleStale: '#64748b',
  Finished:  '#7280a0'
};

export default class SessionDetailPanel {
  constructor({ worldMap, apiBaseUrl, authToken, fetchImpl, tuiView = null }) {
    this.worldMap = worldMap;
    this.apiBaseUrl = apiBaseUrl || '';
    this.authToken = authToken || '';
    const rawFetch = fetchImpl || (typeof window !== 'undefined' ? window.fetch : null);
    this.fetch = rawFetch ? rawFetch.bind(typeof window !== 'undefined' ? window : null) : null;

    this.tuiView = tuiView;
    this.currentSessionId = null;
    this.latestState = null;
    this.detailsBySession = new Map();
    // Item F — per-session token velocity samples. Map<sessionId, Array<{t,in,out,msg}>>.
    // Appended on handleStateUpdate when cumulative totals change. Trimmed to
    // last SPARKLINE_WINDOW_MS.
    this.tokenSamples = new Map();

    console.log(`[SessionDetailPanel v${PANEL_VERSION}] init`);

    this._buildUI();
    this._bindEvents();
  }

  _buildUI() {
    // Sit to the LEFT of the agent roster (240px wide at right:12) so
    // both panels are visible together. 16 px gap keeps them from
    // visually touching. On narrow viewports the panel width caps at
    // calc(100vw - 300px) so it never bleeds into the roster.
    this.panel = h('aside', {
      id: 'session-detail-panel',
      style: {
        position: 'fixed', top: '56px', right: '268px',
        width: 'min(340px, calc(100vw - 300px))',
        maxHeight: 'calc(100vh - 100px)',
        overflow: 'auto',
        padding: '12px 14px',
        background: 'rgba(15,23,42,0.94)',
        color: '#e2e8f0',
        border: '1px solid #38bdf8',
        borderRadius: '10px',
        boxShadow: '0 10px 28px rgba(0,0,0,0.45)',
        zIndex: 12,
        fontFamily: 'Menlo, Monaco, monospace', fontSize: '12px',
        display: 'none',
        lineHeight: '1.5'
      }
    });
    document.body.appendChild(this.panel);

    this.closeBtn = h('button', {
      style: {
        position: 'absolute', top: '8px', right: '10px',
        background: 'none', border: 'none', color: '#94a3b8',
        cursor: 'pointer', fontSize: '14px', padding: '0'
      },
      onclick: () => this._close()
    }, '✕');

    this.body = h('div', { id: 'session-detail-body' });
  }

  _bindEvents() {
    // Listen on window — the WorldMap canvas lives inside #root, the event
    // bubbles to window since we use `bubbles: true`.
    this._onSelect = (e) => this._onAgentSelected(e);
    window.addEventListener('agent-selected', this._onSelect);

    this._onKey = (e) => {
      if (!this.currentSessionId) return;
      const tag = e.target?.tagName || '';
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(tag)) return;
      if (e.key === 'Escape') this._close();
      else if ((e.key === 't' || e.key === 'T') && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        this._openTui();
      }
    };
    window.addEventListener('keydown', this._onKey);
  }

  _openTui() {
    if (!this.tuiView || !this.currentSessionId) return;
    const agent = this.latestState?.agents?.[this.currentSessionId];
    const detail = this.detailsBySession.get(this.currentSessionId);
    const session = {
      sessionId: this.currentSessionId,
      name: agent?.name || (detail?.cwd || '').split('/').pop() || 'session',
      cwd: detail?.cwd || agent?.cwd,
      repoRoot: agent?.repoRoot || detail?.repoRoot || null,
      gitBranch: agent?.gitBranch || detail?.gitBranch || null,
      status: agent?.status || detail?.status || '—',
      pid: agent?.pid || detail?.pid || null,
      hasTranscript: agent?.hasTranscript !== false
    };
    this.tuiView.open(session);
  }

  _onAgentSelected(event) {
    const sessionId = event?.detail?.sessionId;
    if (!sessionId) {
      this._close();
      return;
    }
    this.currentSessionId = sessionId;
    this._open();
    this._render();
    this._fetchDetails(sessionId).catch(err => {
      console.warn('[SessionDetailPanel] fetch failed:', err.message);
    });
  }

  _open() {
    this.panel.style.display = 'block';
  }

  _close() {
    this.panel.style.display = 'none';
    this.currentSessionId = null;
    if (this.worldMap) this.worldMap.selectedAgent = null;
  }

  async _fetchDetails(sessionId) {
    if (!this.fetch) return;
    const headers = this.authToken
      ? { authorization: `Bearer ${this.authToken}` }
      : undefined;
    const url = `${this.apiBaseUrl}/api/sessions/${encodeURIComponent(sessionId)}`;
    const response = await this.fetch(url, { headers });
    if (!response.ok) {
      console.warn('[SessionDetailPanel] detail fetch returned', response.status);
      return;
    }
    const payload = await response.json();
    if (payload?.data) {
      this.detailsBySession.set(sessionId, payload.data);
      if (sessionId === this.currentSessionId) this._render();
    }
  }

  // Called by appBootstrap on every state/patch update.
  handleStateUpdate(state) {
    this.latestState = state;
    this._sampleTokens(state);
    if (this.currentSessionId) this._render();
  }

  // Append cumulative-token samples (Item F). One sample per sessionId per
  // state update IFF input+output grew since the last sample. Cheap O(N)
  // over active sessions.
  _sampleTokens(state) {
    const agents = state?.agents;
    if (!agents) return;
    const now = Date.now();
    for (const id of Object.keys(agents)) {
      const cost = agents[id]?.cost;
      if (!cost || !cost.messageCount) continue;
      const cumulative = (cost.input || 0) + (cost.output || 0);
      let samples = this.tokenSamples.get(id);
      if (!samples) { samples = []; this.tokenSamples.set(id, samples); }
      const last = samples[samples.length - 1];
      if (last && last.cum === cumulative) continue; // no change, skip
      samples.push({ t: now, cum: cumulative, msg: cost.messageCount });
      // Trim by window + cap.
      const cutoff = now - SPARKLINE_WINDOW_MS;
      while (samples.length > 1 && samples[0].t < cutoff) samples.shift();
      if (samples.length > SPARKLINE_MAX_SAMPLES) samples.splice(0, samples.length - SPARKLINE_MAX_SAMPLES);
    }
  }

  // Build an SVG sparkline showing tokens/sec delta between consecutive
  // samples, over SPARKLINE_WINDOW_MS. Returns null when we don't have
  // enough samples to draw.
  _buildSparkline(sessionId) {
    const samples = this.tokenSamples.get(sessionId);
    if (!samples || samples.length < 2) return null;

    // Convert to per-segment velocity points (tokens/sec).
    const velocities = [];
    for (let i = 1; i < samples.length; i++) {
      const dt = Math.max(50, samples[i].t - samples[i - 1].t);  // ms
      const dtok = Math.max(0, samples[i].cum - samples[i - 1].cum);
      velocities.push({ t: samples[i].t, v: dtok / (dt / 1000) });
    }
    if (velocities.length === 0) return null;

    const now = Date.now();
    const vmax = Math.max(1, ...velocities.map(p => p.v));

    const W = 300, H = 36;
    const toX = (t) => ((t - (now - SPARKLINE_WINDOW_MS)) / SPARKLINE_WINDOW_MS) * W;
    const toY = (v) => H - 2 - Math.min(H - 4, (v / vmax) * (H - 4));

    const svgNs = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNs, 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('width', String(W));
    svg.setAttribute('height', String(H));
    svg.style.display = 'block';

    // Baseline.
    const axis = document.createElementNS(svgNs, 'line');
    axis.setAttribute('x1', '0'); axis.setAttribute('y1', String(H - 1));
    axis.setAttribute('x2', String(W)); axis.setAttribute('y2', String(H - 1));
    axis.setAttribute('stroke', 'rgba(148,163,184,0.25)');
    axis.setAttribute('stroke-width', '1');
    svg.appendChild(axis);

    // Polyline.
    const pts = velocities
      .map(p => `${toX(p.t).toFixed(1)},${toY(p.v).toFixed(1)}`)
      .join(' ');
    const line = document.createElementNS(svgNs, 'polyline');
    line.setAttribute('points', pts);
    line.setAttribute('fill', 'none');
    line.setAttribute('stroke', '#38bdf8');
    line.setAttribute('stroke-width', '1.6');
    line.setAttribute('stroke-linejoin', 'round');
    line.setAttribute('stroke-linecap', 'round');
    svg.appendChild(line);

    // Fill under curve for mass.
    const areaPts = `${toX(velocities[0].t).toFixed(1)},${H - 1} ` + pts + ` ${toX(velocities[velocities.length - 1].t).toFixed(1)},${H - 1}`;
    const area = document.createElementNS(svgNs, 'polyline');
    area.setAttribute('points', areaPts);
    area.setAttribute('fill', 'rgba(56, 189, 248, 0.18)');
    area.setAttribute('stroke', 'none');
    svg.insertBefore(area, line);

    return { svg, vmax };
  }

  // Called by appBootstrap (external) to pre-select a session via keyboard.
  focusSession(sessionId) {
    if (!sessionId) return;
    this.currentSessionId = sessionId;
    this._open();
    this._render();
    this._fetchDetails(sessionId).catch(() => {});
  }

  async focusTerminal(sessionId) {
    if (!this.fetch) return;
    const headers = {
      'content-type': 'application/json',
      ...(this.authToken ? { authorization: `Bearer ${this.authToken}` } : {})
    };
    const url = `${this.apiBaseUrl}/api/sessions/${encodeURIComponent(sessionId)}/focus`;
    try {
      const response = await this.fetch(url, { method: 'POST', headers, body: '{}' });
      if (!response.ok) console.warn('[SessionDetailPanel] focus failed', response.status);
    } catch (err) {
      console.warn('[SessionDetailPanel] focus error:', err.message);
    }
  }

  _render() {
    const sid = this.currentSessionId;
    if (!sid) {
      this.body.textContent = '';
      return;
    }
    const agent = this.latestState?.agents?.[sid] || null;
    const detail = this.detailsBySession.get(sid) || null;

    this.body.innerHTML = '';
    this.body.appendChild(this.closeBtn);

    if (!agent) {
      this.body.appendChild(h('div', { style: { opacity: '0.6' } }, [
        `Session ${sid.slice(0, 8)}… is no longer active.`
      ]));
      this.panel.innerHTML = '';
      this.panel.appendChild(this.closeBtn);
      this.panel.appendChild(this.body);
      return;
    }

    const statusColor = STATUS_COLORS[agent.status] || '#94a3b8';
    const header = h('div', {
      style: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }
    }, [
      h('span', { style: {
        display: 'inline-block', width: '10px', height: '10px',
        borderRadius: '50%', background: statusColor,
        boxShadow: `0 0 8px ${statusColor}`
      } }),
      h('strong', { style: { fontSize: '14px', color: '#f1f5f9' } }, agent.name || 'session'),
      h('span', { style: { color: '#94a3b8', fontSize: '11px' } }, agent.status || '—')
    ]);
    this.body.appendChild(header);

    const repoLabel = agent.repoLabel || (agent.repoRoot ? agent.repoRoot.split('/').pop() : null);
    const cwdShort = agent.cwd ? agent.cwd.split('/').slice(-3).join('/') : '';
    const repoRow = h('div', { style: { marginBottom: '4px' } }, [
      h('span', { style: { color: '#94a3b8' } }, 'repo: '),
      h('span', {}, repoLabel || '—')
    ]);
    if (cwdShort && cwdShort !== repoLabel) {
      repoRow.appendChild(h('span', {
        style: { color: '#64748b', marginLeft: '6px', fontSize: '11px' }
      }, `· ${cwdShort}`));
    }
    this.body.appendChild(repoRow);

    const branchRow = h('div', { style: { marginBottom: '4px' } }, [
      h('span', { style: { color: '#94a3b8' } }, 'branch: '),
      h('span', {}, agent.gitBranch || '—')
    ]);
    this.body.appendChild(branchRow);

    if (agent.model) {
      this.body.appendChild(h('div', { style: { marginBottom: '4px' } }, [
        h('span', { style: { color: '#94a3b8' } }, 'model: '),
        h('span', {}, agent.model)
      ]));
    }

    if (agent.tool?.name) {
      this.body.appendChild(h('div', { style: { marginBottom: '4px' } }, [
        h('span', { style: { color: '#94a3b8' } }, 'tool: '),
        h('span', {}, `${agent.tool.icon || '⚙'} ${agent.tool.name}`)
      ]));
    }

    // Cost summary — populated by the snapshotter as the transcript
    // grows. `detail.cost` and `agent.cost` should match; prefer the
    // fresher per-detail payload when it's present.
    const cost = detail?.cost || agent.cost;
    if (cost && cost.messageCount > 0) {
      const usd = Number(cost.usd || 0);
      const kfmt = (n) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
      this.body.appendChild(h('div', {
        style: {
          marginTop: '8px',
          padding: '7px 9px',
          borderRadius: '6px',
          background: 'rgba(251, 191, 36, 0.08)',
          border: '1px solid rgba(251, 191, 36, 0.25)',
          fontSize: '11px',
          lineHeight: '1.5'
        }
      }, [
        h('div', { style: { display: 'flex', justifyContent: 'space-between', marginBottom: '2px' } }, [
          h('span', { style: { color: '#fbbf24', fontWeight: '600' } }, '💰 session cost'),
          h('span', { style: { color: '#fde68a', fontVariantNumeric: 'tabular-nums' } }, `$${usd.toFixed(4)}`)
        ]),
        h('div', { style: { color: '#94a3b8', fontSize: '10px' } },
          `in ${kfmt(cost.input)} · out ${kfmt(cost.output)} · cache W ${kfmt(cost.cacheWrite)} R ${kfmt(cost.cacheRead)} · ${cost.messageCount} msg`)
      ]));

      // Item F — token-flow sparkline: tokens/sec delta over last 60s.
      const sparkMeta = this._buildSparkline(this.currentSessionId);
      if (sparkMeta) {
        const peak = sparkMeta.vmax >= 1_000
          ? (sparkMeta.vmax / 1_000).toFixed(1) + 'k/s'
          : sparkMeta.vmax.toFixed(0) + '/s';
        const card = h('div', {
          style: {
            marginTop: '6px',
            padding: '6px 8px 4px',
            borderRadius: '6px',
            background: 'rgba(56, 189, 248, 0.06)',
            border: '1px solid rgba(56, 189, 248, 0.22)',
            fontSize: '10px'
          }
        }, [
          h('div', { style: { display: 'flex', justifyContent: 'space-between', marginBottom: '2px' } }, [
            h('span', { style: { color: '#38bdf8', fontWeight: '600' } }, '⇅ flow / 60s'),
            h('span', { style: { color: '#bae6fd', fontVariantNumeric: 'tabular-nums' } }, `peak ${peak}`)
          ])
        ]);
        card.appendChild(sparkMeta.svg);
        this.body.appendChild(card);
      }
    }

    if (detail?.lastAssistantMessage?.message?.content) {
      const content = detail.lastAssistantMessage.message.content;
      const text = Array.isArray(content)
        ? content.filter(c => c?.type === 'text').map(c => c.text || '').join('\n').slice(0, 400)
        : (typeof content === 'string' ? content.slice(0, 400) : '');
      if (text) {
        this.body.appendChild(h('div', {
          style: {
            marginTop: '10px', padding: '8px', borderRadius: '6px',
            background: 'rgba(30, 41, 59, 0.8)', color: '#cbd5e1',
            whiteSpace: 'pre-wrap', fontSize: '11px', lineHeight: '1.5'
          }
        }, text));
      }
    }

    if (detail?.pid) {
      this.body.appendChild(h('div', {
        style: { marginTop: '8px', color: '#64748b', fontSize: '11px' }
      }, `pid ${detail.pid}  •  ${detail.cwd || agent.cwd || ''}`));
    }

    const hasTranscript = agent.hasTranscript !== false;
    const actions = h('div', { style: { display: 'flex', gap: '6px', marginTop: '10px', flexWrap: 'wrap' } }, [
      h('button', {
        style: {
          padding: '6px 10px',
          border: `1px solid ${hasTranscript ? '#38bdf8' : '#334155'}`,
          borderRadius: '6px',
          background: hasTranscript ? 'rgba(56,189,248,0.2)' : 'rgba(30,41,59,0.6)',
          color: hasTranscript ? '#bae6fd' : '#64748b',
          cursor: hasTranscript ? 'pointer' : 'not-allowed',
          fontFamily: 'inherit', fontSize: '11px', fontWeight: '600'
        },
        onclick: () => { if (hasTranscript) this._openTui(); },
        title: hasTranscript ? 'T' : 'no transcript yet'
      }, hasTranscript ? '💬 View conversation' : '💬 No conversation yet'),
      h('button', {
        style: {
          padding: '6px 10px', border: '1px solid #38bdf8', borderRadius: '6px',
          background: 'rgba(56,189,248,0.12)', color: '#bae6fd', cursor: 'pointer',
          fontFamily: 'inherit', fontSize: '11px'
        },
        onclick: () => this.focusTerminal(sid)
      }, 'Focus terminal'),
      h('button', {
        style: {
          padding: '6px 10px', border: '1px solid #334155', borderRadius: '6px',
          background: 'rgba(15,23,42,0.6)', color: '#94a3b8', cursor: 'pointer',
          fontFamily: 'inherit', fontSize: '11px'
        },
        onclick: () => this._close()
      }, 'Close')
    ]);
    this.body.appendChild(actions);

    // Footer hint — shortcut tail. Cheap, removes the "how do I close?" gap.
    this.body.appendChild(h('div', {
      style: {
        marginTop: '10px',
        paddingTop: '8px',
        borderTop: '1px solid rgba(148,163,184,0.18)',
        color: '#475569',
        fontSize: '10px',
        textAlign: 'right',
        letterSpacing: '0.04em'
      }
    }, 'Esc · close · T transcript · L live'));

    this.panel.innerHTML = '';
    this.panel.appendChild(this.closeBtn);
    this.panel.appendChild(this.body);
  }

  destroy() {
    window.removeEventListener('agent-selected', this._onSelect);
    window.removeEventListener('keydown', this._onKey);
    if (this.panel?.parentNode) this.panel.parentNode.removeChild(this.panel);
  }
}
