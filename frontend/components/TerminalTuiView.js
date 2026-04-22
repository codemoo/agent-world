// In-browser session viewer with two modes:
//   1. Transcript — cursor-paged JSON viewer of the .jsonl transcript (live,
//      read-only). Poll every 1.5s while visible.
//   2. Live — real xterm.js terminal attached via WebSocket to a server-side
//      PTY running `claude --resume <sessionId>` in the session's cwd.
//
// When the session's pid is still alive, Live mode prompts the user because
// `claude --resume` creates a PARALLEL writer on the same session file
// (the original terminal keeps running; both write interleaved messages).

const POLL_VISIBLE_MS = 1500;
const POLL_HIDDEN_MS = 6000;
const STICKY_PIXELS = 24;
const TOOL_RESULT_HEAD_LINES = 12;

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
    if (c == null || c === false) continue;
    el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return el;
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function renderAssistantMarkdown(text) {
  const escaped = escapeHtml(text);
  let out = escaped.replace(/```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g, (_, lang, body) => {
    const cls = lang ? ` class="tui-code-lang-${escapeHtml(lang)}"` : '';
    return `<pre class="tui-codeblock"><code${cls}>${body}</code></pre>`;
  });
  out = out.replace(/`([^`\n]+)`/g, '<code class="tui-inline-code">$1</code>');
  out = out.replace(/\*\*([^*\n][^*\n]*?)\*\*/g, '<strong>$1</strong>');
  return out;
}

const KIND_LABEL = {
  user: '▶ user', assistant_text: '◀ assistant', thinking: '💭 thinking',
  tool_use: '⚙ tool', tool_result: '↵ result', system: '# system', meta: '# meta'
};

function clampLines(text, max) {
  if (!text) return { head: '', rest: '', truncated: false };
  const lines = text.split('\n');
  if (lines.length <= max) return { head: text, rest: '', truncated: false };
  return {
    head: lines.slice(0, max).join('\n'),
    rest: lines.slice(max).join('\n'),
    truncated: true
  };
}

function fmtTs(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

// Load xterm CSS into the head once. Lazy so pages that never open Live
// don't pay the cost.
let xtermCssLoaded = false;
function ensureXtermCss() {
  if (xtermCssLoaded) return;
  xtermCssLoaded = true;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = '/vendor/xterm.css';
  document.head.appendChild(link);
}

export default class TerminalTuiView {
  constructor({ apiBaseUrl, authToken, fetchImpl }) {
    this.apiBaseUrl = apiBaseUrl || '';
    this.authToken = authToken || '';
    const rawFetch = fetchImpl || (typeof window !== 'undefined' ? window.fetch : null);
    this.fetch = rawFetch ? rawFetch.bind(typeof window !== 'undefined' ? window : null) : null;

    this.session = null;
    this.mode = 'transcript';
    // Transcript state
    this.cursor = null;
    this.seenEntryIds = new Set();
    this.pollTimer = null;
    this.pollMs = POLL_VISIBLE_MS;
    this.pinnedToBottom = true;
    this.pendingNewCount = 0;
    // Live state
    this.ptyWs = null;
    this.xterm = null;
    this.fitAddon = null;
    this._liveModulesLoaded = false;
    this._liveResizeObserver = null;

    this._buildUI();
    this._bindEvents();
  }

  _buildUI() {
    this.overlay = h('div', {
      id: 'tui-overlay',
      style: {
        position: 'fixed', inset: '0',
        background: 'rgba(7, 10, 20, 0.72)', backdropFilter: 'blur(3px)',
        zIndex: 20, display: 'none',
        alignItems: 'center', justifyContent: 'center',
        fontFamily: '"SFMono-Regular", Menlo, Monaco, "Cascadia Code", monospace',
        fontSize: '12.5px'
      }
    });

    this.container = h('div', {
      id: 'tui-container',
      style: {
        width: 'min(94vw, 1040px)', height: 'min(92vh, 820px)',
        display: 'flex', flexDirection: 'column',
        background: '#0b1220', border: '1px solid #38bdf8',
        borderRadius: '10px', boxShadow: '0 12px 40px rgba(0,0,0,0.6)',
        overflow: 'hidden', position: 'relative'
      }
    });

    // Header with title + tabs + status + close
    this.titleEl = h('strong', { style: { color: '#f1f5f9', fontSize: '13px' } }, 'session');
    this.subtitleEl = h('span', { style: { color: '#94a3b8', fontSize: '11px' } }, '');

    this.tabTranscriptBtn = h('button', {
      style: this._tabStyle(true),
      onclick: () => this.switchMode('transcript')
    }, '📜 Transcript');
    this.tabLiveBtn = h('button', {
      style: this._tabStyle(false),
      onclick: () => this.switchMode('live')
    }, '🎛 Live');

    this.statusChipEl = h('span', {
      style: {
        padding: '2px 8px', borderRadius: '999px', fontSize: '10px',
        background: 'rgba(56, 189, 248, 0.16)', color: '#7dd3fc',
        letterSpacing: '.5px', whiteSpace: 'nowrap'
      }
    }, '—');

    this.closeBtn = h('button', {
      style: {
        background: 'none', border: 'none', color: '#94a3b8',
        cursor: 'pointer', fontSize: '16px', padding: '0 0 0 6px'
      },
      onclick: () => this.close()
    }, '✕');

    this.header = h('div', {
      style: {
        display: 'flex', alignItems: 'center', gap: '10px',
        padding: '10px 14px',
        background: 'rgba(30, 41, 59, 0.8)',
        borderBottom: '1px solid #1e293b',
        color: '#e2e8f0', flex: '0 0 auto'
      }
    }, [
      this.titleEl,
      this.subtitleEl,
      h('span', { style: { flex: '1' } }),
      this.tabTranscriptBtn,
      this.tabLiveBtn,
      this.statusChipEl,
      this.closeBtn
    ]);

    // Transcript area (scrollable div).
    this.scroll = h('div', {
      style: {
        flex: '1 1 auto', overflowY: 'auto', overflowX: 'hidden',
        padding: '12px 14px', background: '#0b1220',
        color: '#cbd5e1', whiteSpace: 'pre-wrap', lineHeight: '1.5'
      }
    });

    // Live terminal container (xterm mounts here).
    this.terminalHost = h('div', {
      style: {
        flex: '1 1 auto', display: 'none',
        padding: '8px', background: '#0a0e1a',
        overflow: 'hidden'
      }
    });

    // Scroll-to-bottom chip for transcript mode.
    this.newChip = h('button', {
      style: {
        position: 'absolute', right: '28px', bottom: '60px',
        padding: '6px 12px', borderRadius: '999px',
        background: '#38bdf8', color: '#0b1220', border: 'none',
        fontSize: '11px', fontWeight: '600', cursor: 'pointer',
        boxShadow: '0 4px 14px rgba(56,189,248,0.3)', display: 'none', zIndex: 3
      },
      onclick: () => { this.pinnedToBottom = true; this._scrollToBottom(true); this._hideNewChip(); }
    }, '↓ new');

    this.footer = h('div', {
      style: {
        display: 'flex', gap: '10px', alignItems: 'center',
        padding: '8px 14px', background: 'rgba(30, 41, 59, 0.6)',
        borderTop: '1px solid #1e293b', color: '#94a3b8',
        fontSize: '11px', flex: '0 0 auto'
      }
    }, [
      this.footerLeftEl = h('span', {}, 'live polling 1.5s'),
      h('span', { style: { marginLeft: 'auto', fontSize: '10px' } }, 'ESC · T · L')
    ]);

    this.container.appendChild(this.header);
    this.container.appendChild(this.scroll);
    this.container.appendChild(this.terminalHost);
    this.container.appendChild(this.newChip);
    this.container.appendChild(this.footer);
    this.overlay.appendChild(this.container);
    document.body.appendChild(this.overlay);
  }

  _tabStyle(active) {
    return {
      padding: '4px 10px',
      borderRadius: '6px',
      border: `1px solid ${active ? '#38bdf8' : '#334155'}`,
      background: active ? 'rgba(56,189,248,0.18)' : 'rgba(30,41,59,0.6)',
      color: active ? '#bae6fd' : '#94a3b8',
      cursor: 'pointer', fontFamily: 'inherit', fontSize: '11px'
    };
  }

  _bindEvents() {
    this._onKey = (e) => {
      if (this.overlay.style.display === 'none') return;
      if (e.key === 'Escape') { this.close(); return; }
      const inField = /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(e.target?.tagName || '');
      // When xterm has focus it swallows keys itself; these shortcuts only
      // fire against the outer page.
      if (this.mode === 'live' && this.xterm?.textarea === document.activeElement) return;
      if (!inField && (e.key === 'l' || e.key === 'L')) {
        e.preventDefault();
        this.switchMode('live');
      } else if (!inField && (e.key === 't' || e.key === 'T') && e.target?.tagName !== 'BODY') {
        // Leave T as transcript-mode hotkey only when modal is focused.
        this.switchMode('transcript');
      }
    };
    window.addEventListener('keydown', this._onKey);

    this._onVisibility = () => {
      this.pollMs = document.hidden ? POLL_HIDDEN_MS : POLL_VISIBLE_MS;
    };
    document.addEventListener('visibilitychange', this._onVisibility);

    this._onScroll = () => {
      const el = this.scroll;
      const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - STICKY_PIXELS;
      this.pinnedToBottom = atBottom;
      if (atBottom) this._hideNewChip();
    };
    this.scroll.addEventListener('scroll', this._onScroll);

    this._onClickBackdrop = (e) => {
      if (e.target === this.overlay) this.close();
    };
    this.overlay.addEventListener('click', this._onClickBackdrop);

    this._onResize = () => { if (this.mode === 'live') this._fitXterm(); };
    window.addEventListener('resize', this._onResize);
  }

  open(session) {
    this.session = session;
    this.cursor = null;
    this.seenEntryIds.clear();
    this.scroll.innerHTML = '';
    this.pinnedToBottom = true;
    this.pendingNewCount = 0;
    this._hideNewChip();

    const folderName = session?.name || (session?.cwd || '').split('/').pop() || 'session';
    this.titleEl.textContent = folderName;
    const subtitleBits = [];
    if (session?.repoRoot) subtitleBits.push(session.repoRoot.split('/').slice(-2).join('/'));
    if (session?.gitBranch) subtitleBits.push(`(${session.gitBranch})`);
    this.subtitleEl.textContent = subtitleBits.join(' ');
    this.statusChipEl.textContent = session?.status || '—';

    this.overlay.style.display = 'flex';
    // Always start on Transcript. The user explicitly opts into Live via
    // the tab — Live spawns a parallel `claude --resume` writer which is
    // only appropriate when they understand the implications.
    this.mode = null;
    this.switchMode('transcript');
  }

  close() {
    this.overlay.style.display = 'none';
    this._stopTranscriptPoll();
    this._teardownLive();
    this.session = null;
    this.cursor = null;
    this.seenEntryIds.clear();
  }

  switchMode(mode) {
    if (mode === this.mode) return;
    if (mode === 'transcript') {
      this._teardownLive();
      this.mode = 'transcript';
      this.scroll.style.display = 'block';
      this.terminalHost.style.display = 'none';
      this.tabTranscriptBtn.style = this._styleToStr(this._tabStyle(true));
      this.tabLiveBtn.style = this._styleToStr(this._tabStyle(false));
      this.footerLeftEl.textContent = 'live polling 1.5s';
      this._scheduleNextPoll(0);
    } else if (mode === 'live') {
      // When the source pid is still alive, `claude --resume` creates a
      // PARALLEL writer on the same transcript. Warn the user once via
      // a non-blocking DOM modal (replaces window.confirm which froze
      // the WS event loop).
      if (this._sessionPidLikelyAlive() && !this._liveAcknowledged) {
        this._confirmLiveMode()
          .then(ok => {
            if (!ok) {
              // User declined — flip back to transcript silently.
              this.switchMode('transcript');
              return;
            }
            this._liveAcknowledged = true;
            this._enterLiveMode();
          })
          .catch(err => {
            console.error('[TerminalTuiView] live confirm failed:', err);
          });
        return;
      }
      this._enterLiveMode();
    }
  }

  _enterLiveMode() {
    this._stopTranscriptPoll();
    this.mode = 'live';
    this.scroll.style.display = 'none';
    this.terminalHost.style.display = 'flex';
    this.tabTranscriptBtn.style = this._styleToStr(this._tabStyle(false));
    this.tabLiveBtn.style = this._styleToStr(this._tabStyle(true));
    this.footerLeftEl.textContent = 'live PTY · claude --resume';
    this._launchLive().catch(err => {
      console.error('[TerminalTuiView] live launch failed:', err);
      this.statusChipEl.textContent = 'live failed';
    });
  }

  // Custom modal that explains the parallel-writer caveat in both
  // English + Korean. Returns a Promise<boolean>. Does NOT block the
  // thread — WS + rAF keep running while open.
  _confirmLiveMode() {
    return new Promise(resolve => {
      const backdrop = document.createElement('div');
      backdrop.style.cssText = `
        position: fixed; inset: 0; z-index: 30;
        background: rgba(2, 6, 23, 0.72);
        display: flex; align-items: center; justify-content: center;
        padding: 16px;
        backdrop-filter: blur(3px);
      `;
      const card = document.createElement('div');
      card.setAttribute('role', 'dialog');
      card.setAttribute('aria-modal', 'true');
      card.setAttribute('aria-labelledby', 'live-confirm-title');
      card.style.cssText = `
        max-width: 520px; width: 100%;
        background: #0f172a; color: #e2e8f0;
        border: 1px solid rgba(251, 191, 36, 0.5);
        border-radius: 10px;
        padding: 20px 22px;
        font: 13px/1.55 Menlo, Monaco, monospace;
        box-shadow: 0 20px 56px rgba(0,0,0,0.6);
      `;
      const pid = this.session?.pid || '?';
      card.innerHTML = `
        <h3 id="live-confirm-title" style="margin:0 0 8px; font-size:15px; color:#fbbf24;">⚠ Open Live Terminal?</h3>
        <p style="margin:10px 0; color:#cbd5e1;">
          <b>Claude is already running</b> for this session in another terminal (pid <code>${pid}</code>).
        </p>
        <p style="margin:10px 0; color:#cbd5e1;">
          Live mode will launch a <b>second</b> <code>claude --resume</code> inside the browser. Both processes write to the same transcript file in alternation; neither sees the other's streaming output.
        </p>
        <details style="margin:12px 0; color:#94a3b8;"><summary style="cursor:pointer; color:#60a5fa;">한국어 안내</summary>
          <p style="margin:8px 0;">이 세션은 이미 다른 터미널(pid <code>${pid}</code>)에서 Claude가 실행 중입니다. Live 모드는 브라우저 안에서 <code>claude --resume</code>을 추가로 실행합니다. 두 프로세스는 같은 transcript 파일에 번갈아 기록하며, 서로의 라이브 출력을 보지 못합니다.</p>
        </details>
        <div style="display:flex; gap:10px; justify-content:flex-end; margin-top:16px;">
          <button data-action="cancel" style="
            padding: 7px 14px; border-radius: 6px; cursor: pointer;
            background: #1e293b; color: #e2e8f0; border: 1px solid #334155;
            font: inherit;
          ">Cancel · 취소</button>
          <button data-action="ok" style="
            padding: 7px 14px; border-radius: 6px; cursor: pointer;
            background: #fbbf24; color: #1e293b; border: 1px solid #f59e0b; font-weight: 600;
            font: inherit;
          ">Open Live · 계속</button>
        </div>
      `;
      backdrop.appendChild(card);
      document.body.appendChild(backdrop);

      const prevFocus = document.activeElement;
      // Make surrounding UI inert while the modal is open — no focus
      // traps, no aria confusion. Supported in evergreen browsers.
      const siblings = [...document.body.children].filter(el => el !== backdrop);
      for (const el of siblings) el.inert = true;

      const cleanup = (answer) => {
        for (const el of siblings) el.inert = false;
        if (backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
        window.removeEventListener('keydown', onKey);
        if (prevFocus && typeof prevFocus.focus === 'function') {
          try { prevFocus.focus(); } catch (_) {}
        }
        resolve(answer);
      };
      const onKey = (ev) => {
        if (ev.key === 'Escape') { ev.preventDefault(); cleanup(false); }
        else if (ev.key === 'Enter') { ev.preventDefault(); cleanup(true); }
      };
      window.addEventListener('keydown', onKey);
      backdrop.addEventListener('click', (ev) => {
        if (ev.target === backdrop) cleanup(false);
      });
      card.querySelector('[data-action="cancel"]').addEventListener('click', () => cleanup(false));
      card.querySelector('[data-action="ok"]').addEventListener('click', () => cleanup(true));
      // Focus the primary action so Enter/Space confirms.
      const okBtn = card.querySelector('[data-action="ok"]');
      try { okBtn.focus(); } catch (_) {}
    });
  }

  _sessionPidLikelyAlive() {
    // A live agent in the snapshot implies the source pid is still running.
    return Boolean(this.session?.pid) && this.session?.status !== 'Finished';
  }

  _styleToStr(obj) {
    return Object.entries(obj)
      .map(([k, v]) => `${k.replace(/[A-Z]/g, m => '-' + m.toLowerCase())}:${v}`)
      .join(';');
  }

  // --- Transcript mode ---

  _stopTranscriptPoll() {
    if (this.pollTimer) { clearTimeout(this.pollTimer); this.pollTimer = null; }
  }

  _scheduleNextPoll(delayMs) {
    this._stopTranscriptPoll();
    this.pollTimer = window.setTimeout(() => this._poll(), delayMs);
  }

  async _poll() {
    if (this.mode !== 'transcript' || !this.session || !this.fetch) return;
    if (this.session.hasTranscript === false) {
      this.statusChipEl.textContent = 'no conversation yet';
      this._renderEmpty('아직 대화 내용이 없습니다. Live 탭으로 전환하면 이 세션에 직접 프롬프트를 입력할 수 있습니다.');
      return;
    }
    try {
      const url = new URL(
        `${this.apiBaseUrl}/api/sessions/${encodeURIComponent(this.session.sessionId)}/transcript`,
        window.location.origin
      );
      if (this.cursor) url.searchParams.set('cursor', this.cursor);
      const headers = this.authToken ? { authorization: `Bearer ${this.authToken}` } : undefined;
      const res = await this.fetch(url.toString(), { headers });
      if (res.status === 404) {
        this.statusChipEl.textContent = 'no conversation yet';
        if (this.seenEntryIds.size === 0) this._renderEmpty('아직 대화 내용이 없습니다. Live 탭으로 전환하면 이 세션에 직접 프롬프트를 입력할 수 있습니다.');
        this._scheduleNextPoll(this.pollMs);
        return;
      }
      if (res.status === 410) {
        this.statusChipEl.textContent = 'transcript rotated';
        this._renderEmpty('Transcript 파일이 사라졌거나 교체되었습니다.');
        this._scheduleNextPoll(this.pollMs);
        return;
      }
      if (!res.ok) {
        this.statusChipEl.textContent = `http ${res.status}`;
        this._scheduleNextPoll(this.pollMs);
        return;
      }
      const payload = await res.json();
      const data = payload?.data;
      if (!data) { this._scheduleNextPoll(this.pollMs); return; }
      this.cursor = data.cursor || this.cursor;
      this.statusChipEl.textContent = data.resync ? 'resynced' : (data.truncated ? 'history truncated' : 'live');
      this._appendEntries(data.entries || [], { isResync: Boolean(data.resync) });
    } catch (err) {
      console.warn('[TerminalTuiView] poll failed:', err.message);
      this.statusChipEl.textContent = 'offline';
    }
    if (this.mode === 'transcript') this._scheduleNextPoll(this.pollMs);
  }

  _renderEmpty(message) {
    this.scroll.innerHTML = '';
    const el = document.createElement('div');
    el.className = 'tui-empty';
    el.style.cssText = 'padding:32px;color:#64748b;text-align:center;font-size:13px;';
    el.textContent = message;
    this.scroll.appendChild(el);
  }

  _appendEntries(entries, { isResync }) {
    if (isResync) { this.seenEntryIds.clear(); this.scroll.innerHTML = ''; }
    const wasPinned = this.pinnedToBottom;
    const bottomOffset = this.scroll.scrollHeight - this.scroll.scrollTop;
    let appended = 0;
    for (const entry of entries) {
      if (this.seenEntryIds.has(entry.id)) continue;
      this.seenEntryIds.add(entry.id);
      this.scroll.appendChild(this._renderEntry(entry));
      appended++;
    }
    if (appended === 0) return;
    if (wasPinned) this._scrollToBottom(false);
    else {
      this.scroll.scrollTop = this.scroll.scrollHeight - bottomOffset;
      this.pendingNewCount += appended;
      this._showNewChip(this.pendingNewCount);
    }
  }

  _scrollToBottom(smooth) {
    this.scroll.scrollTo({ top: this.scroll.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  }
  _showNewChip(n) { this.newChip.textContent = `↓ ${n} new`; this.newChip.style.display = 'block'; }
  _hideNewChip() { this.newChip.style.display = 'none'; this.pendingNewCount = 0; }

  _renderEntry(entry) {
    const row = h('div', {
      class: `tui-entry tui-kind-${entry.kind}`,
      style: {
        padding: '6px 2px', margin: '0',
        borderLeft: '2px solid transparent', paddingLeft: '10px',
        ...this._styleForKind(entry.kind)
      }
    });
    const label = h('div', {
      style: {
        fontSize: '10px', letterSpacing: '.6px', color: '#475569',
        marginBottom: '2px', textTransform: 'uppercase'
      }
    }, [
      `${KIND_LABEL[entry.kind] || entry.kind}`,
      entry.tsMs ? h('span', { style: { marginLeft: '8px', opacity: '.6' } }, fmtTs(entry.tsMs)) : null,
      entry.tool ? h('span', { style: { marginLeft: '8px', color: '#fbbf24' } }, `· ${entry.tool}`) : null
    ].filter(Boolean));
    row.appendChild(label);

    switch (entry.kind) {
      case 'assistant_text': {
        const body = h('div', {});
        body.innerHTML = renderAssistantMarkdown(entry.text || '');
        row.appendChild(body); break;
      }
      case 'user': case 'thinking': case 'system': case 'meta': {
        row.appendChild(h('div', {}, entry.text || '')); break;
      }
      case 'tool_use': {
        const wrap = h('details', { style: { marginTop: '2px' } });
        wrap.appendChild(h('summary', { style: { cursor: 'pointer', color: '#fbbf24' } }, [entry.inputPreview || '(no input)']));
        wrap.appendChild(h('pre', {
          style: {
            marginTop: '4px', padding: '8px',
            background: 'rgba(251,191,36,0.06)',
            border: '1px solid rgba(251,191,36,0.3)',
            borderRadius: '4px', overflowX: 'auto',
            color: '#fde68a', whiteSpace: 'pre-wrap'
          }
        }, entry.fullInput || entry.inputPreview || ''));
        row.appendChild(wrap); break;
      }
      case 'tool_result': {
        const { head, rest, truncated } = clampLines(entry.text || '', TOOL_RESULT_HEAD_LINES);
        const status = entry.isError
          ? h('span', { style: { color: '#f87171' } }, '⚠ error')
          : h('span', { style: { color: '#4ade80' } }, '✓ ok');
        row.appendChild(status);
        row.appendChild(h('pre', {
          style: {
            margin: '4px 0 0 0', padding: '8px',
            background: 'rgba(148, 163, 184, 0.07)',
            border: '1px solid rgba(148,163,184,0.2)',
            borderRadius: '4px', color: '#e2e8f0',
            whiteSpace: 'pre-wrap', overflowX: 'auto'
          }
        }, head));
        if (truncated) {
          const expander = h('details', { style: { marginTop: '2px' } });
          expander.appendChild(h('summary', { style: { cursor: 'pointer', color: '#94a3b8', fontSize: '11px' } },
            `Show ${rest.split('\n').length} more lines`));
          expander.appendChild(h('pre', {
            style: {
              margin: '4px 0 0 0', padding: '8px',
              background: 'rgba(148, 163, 184, 0.07)',
              border: '1px solid rgba(148,163,184,0.2)',
              borderRadius: '4px', color: '#e2e8f0',
              whiteSpace: 'pre-wrap', overflowX: 'auto'
            }
          }, rest));
          row.appendChild(expander);
        }
        break;
      }
      default: row.appendChild(h('div', {}, entry.text || JSON.stringify(entry)));
    }

    if (entry.truncated) row.appendChild(h('div', {
      style: { color: '#475569', fontSize: '10px', marginTop: '2px' }
    }, '… (truncated)'));
    return row;
  }

  _styleForKind(kind) {
    switch (kind) {
      case 'user':           return { color: '#67e8f9', borderLeftColor: '#22d3ee' };
      case 'assistant_text': return { color: '#f1f5f9', borderLeftColor: '#94a3b8' };
      case 'thinking':       return { color: '#94a3b8', borderLeftColor: '#475569', fontStyle: 'italic' };
      case 'tool_use':       return { color: '#fde68a', borderLeftColor: '#fbbf24' };
      case 'tool_result':    return { color: '#cbd5e1', borderLeftColor: '#64748b' };
      case 'system': case 'meta': return { color: '#64748b', borderLeftColor: '#334155' };
      default: return {};
    }
  }

  // --- Live mode ---

  async _issueWsTicket() {
    const headers = {
      'content-type': 'application/json',
      ...(this.authToken ? { authorization: `Bearer ${this.authToken}` } : {})
    };
    const res = await this.fetch(`${this.apiBaseUrl}/auth/ws-ticket`, {
      method: 'POST', headers, body: '{}'
    });
    if (!res.ok) throw new Error(`WS ticket HTTP ${res.status}`);
    const payload = await res.json();
    const ticket = typeof payload?.ticket === 'string' ? payload.ticket.trim() : '';
    if (!ticket) throw new Error('WS ticket missing');
    return ticket;
  }

  async _loadXtermModules() {
    if (this._liveModulesLoaded) return;
    ensureXtermCss();
    const [{ Terminal }, { FitAddon }] = await Promise.all([
      import('/vendor/xterm.mjs'),
      import('/vendor/addon-fit.mjs')
    ]);
    this._Terminal = Terminal;
    this._FitAddon = FitAddon;
    this._liveModulesLoaded = true;
  }

  async _launchLive() {
    if (!this.session || !this.fetch) return;
    this.statusChipEl.textContent = 'connecting…';
    this.terminalHost.innerHTML = '';

    await this._loadXtermModules();

    const term = new this._Terminal({
      fontFamily: '"SFMono-Regular", Menlo, Monaco, "Cascadia Code", monospace',
      fontSize: 13,
      cursorBlink: true,
      scrollback: 5000,
      theme: {
        background: '#0a0e1a',
        foreground: '#e2e8f0',
        cursor: '#7dd3fc',
        selectionBackground: 'rgba(56,189,248,0.25)'
      }
    });
    const fit = new this._FitAddon();
    term.loadAddon(fit);
    term.open(this.terminalHost);
    fit.fit();
    term.focus();
    this.xterm = term;
    this.fitAddon = fit;

    // Watch container resize to re-fit xterm automatically.
    if (typeof ResizeObserver !== 'undefined') {
      this._liveResizeObserver = new ResizeObserver(() => this._fitXterm());
      this._liveResizeObserver.observe(this.terminalHost);
    }

    const ticket = await this._issueWsTicket();
    const wsProto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsBase = `${wsProto}//${window.location.host}`;
    const u = new URL('/ws/pty', wsBase);
    u.searchParams.set('ticket', ticket);
    u.searchParams.set('sessionId', this.session.sessionId);
    u.searchParams.set('cols', String(term.cols));
    u.searchParams.set('rows', String(term.rows));

    const ws = new WebSocket(u.toString());
    ws.binaryType = 'arraybuffer';
    this.ptyWs = ws;

    const decoder = new TextDecoder('utf-8');

    ws.addEventListener('open', () => {
      term.writeln('\x1b[90m[agent-world] attaching to `claude --resume ' + this.session.sessionId + '`…\x1b[0m');
    });
    ws.addEventListener('message', ev => {
      if (ev.data instanceof ArrayBuffer) {
        term.write(new Uint8Array(ev.data));
        return;
      }
      // Text frame — control messages.
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'ready') {
          this.statusChipEl.textContent = 'live PTY';
          term.writeln(`\x1b[90m[pid ${msg.pid}] ${msg.file} ${(msg.args||[]).join(' ')}\x1b[0m`);
          term.writeln(`\x1b[90m[cwd] ${msg.cwd}\x1b[0m\n`);
        } else if (msg.type === 'exit') {
          this.statusChipEl.textContent = `exit ${msg.exitCode}`;
          term.writeln(`\n\x1b[90m[exit ${msg.exitCode} signal ${msg.signal || 0}]\x1b[0m`);
        } else if (msg.type === 'error') {
          term.writeln(`\n\x1b[31m[error] ${msg.message}\x1b[0m`);
        }
      } catch {
        term.write(ev.data);
      }
    });
    ws.addEventListener('close', (ev) => {
      this.statusChipEl.textContent = ev.code === 4090 ? 'already attached' :
                                      ev.code === 1000 ? 'closed' : `closed ${ev.code}`;
      term.writeln(`\n\x1b[90m[ws closed ${ev.code} ${ev.reason || ''}]\x1b[0m`);
    });
    ws.addEventListener('error', () => {
      this.statusChipEl.textContent = 'ws error';
    });

    term.onData(data => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'input', data }));
      }
    });

    term.onResize(({ cols, rows }) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'resize', cols, rows }));
      }
    });
  }

  _fitXterm() {
    if (!this.fitAddon) return;
    try { this.fitAddon.fit(); } catch { /* host may be 0x0 transiently */ }
  }

  _teardownLive() {
    if (this._liveResizeObserver) {
      try { this._liveResizeObserver.disconnect(); } catch {}
      this._liveResizeObserver = null;
    }
    if (this.ptyWs) {
      try { this.ptyWs.close(1000, 'mode switch'); } catch {}
      this.ptyWs = null;
    }
    if (this.xterm) {
      try { this.xterm.dispose(); } catch {}
      this.xterm = null;
      this.fitAddon = null;
    }
  }

  destroy() {
    this.close();
    window.removeEventListener('keydown', this._onKey);
    window.removeEventListener('resize', this._onResize);
    document.removeEventListener('visibilitychange', this._onVisibility);
    if (this.overlay?.parentNode) this.overlay.parentNode.removeChild(this.overlay);
  }
}
