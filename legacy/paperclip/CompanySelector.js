// Company selector — small top-bar widget that lets the user pick which
// Paperclip company the world syncs with. Shows the current company name
// and a dropdown to switch. Hidden when Paperclip sync is disabled.

function h(tag, attrs = {}, children = []) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') {
      el.addEventListener(k.slice(2).toLowerCase(), v);
    } else {
      el.setAttribute(k, String(v));
    }
  }
  for (const c of [].concat(children)) {
    if (c == null) continue;
    el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return el;
}

const BADGE_STYLE = {
  position: 'absolute', top: '12px', left: '12px', zIndex: 2,
  padding: '0', borderRadius: '6px',
  background: 'rgba(15,23,42,0.8)', border: '1px solid #7dd3fc',
  fontFamily: 'Menlo, Monaco, Consolas, monospace', fontSize: '12px',
  color: '#bae6fd', display: 'none', alignItems: 'center'
};

const SELECT_STYLE = {
  background: 'transparent', color: '#bae6fd', border: 'none',
  fontFamily: 'inherit', fontSize: '12px', cursor: 'pointer',
  outline: 'none', padding: '6px 10px', appearance: 'none',
  WebkitAppearance: 'none', MozAppearance: 'none',
  paddingRight: '24px'
};

export default class CompanySelector {
  constructor({ apiBaseUrl, authToken, fetchImpl, onSwitch }) {
    this.apiBaseUrl = apiBaseUrl || '';
    this.authToken = authToken || '';
    const rawFetch = fetchImpl || (typeof window !== 'undefined' ? window.fetch : null);
    this.fetch = rawFetch ? rawFetch.bind(typeof window !== 'undefined' ? window : null) : null;
    this.onSwitch = onSwitch || (() => {});

    this.companies = [];
    this.currentCompanyId = null;
    this.enabled = false;
    this.loading = false;
    this.error = null;
    this.switching = false;
    this._fetchAbort = null;

    this._buildUI();
  }

  _buildUI() {
    this.container = h('div', { id: 'company-selector', style: BADGE_STYLE });

    this.select = h('select', {
      'aria-label': 'Select Paperclip company',
      style: SELECT_STYLE,
      onchange: () => this._handleChange()
    });

    // Dropdown arrow indicator (purely decorative)
    this.arrow = h('span', {
      'aria-hidden': 'true',
      style: {
        position: 'absolute', right: '8px', top: '50%',
        transform: 'translateY(-50%)', pointerEvents: 'none',
        fontSize: '8px', color: '#7dd3fc'
      }
    }, '\u25BC');

    this.container.appendChild(this.select);
    this.container.appendChild(this.arrow);

    document.body.appendChild(this.container);
  }

  // Called on every world state update from WebSocket / initial fetch.
  updateFromState(meta) {
    const pc = meta?.paperclip;
    if (!pc) return;

    const wasEnabled = this.enabled;
    this.enabled = Boolean(pc.enabled);

    if (!this.enabled) {
      this.container.style.display = 'none';
      return;
    }

    this.container.style.display = 'flex';

    // Don't overwrite currentCompanyId while a switch is in flight —
    // the server broadcast may arrive before our PUT response.
    if (!this.switching) {
      this.currentCompanyId = pc.companyId || null;
    }

    // Fetch companies list on first enable
    if (!wasEnabled && this.companies.length === 0) {
      this._fetchCompanies();
    }

    // Update selection to match server state (skip during switch)
    if (!this.switching && this.select.value !== (this.currentCompanyId || '')) {
      this.select.value = this.currentCompanyId || '';
    }
  }

  async _fetchCompanies() {
    if (this.loading) return;

    // Cancel any in-flight fetch
    if (this._fetchAbort) {
      this._fetchAbort.abort();
      this._fetchAbort = null;
    }

    this.loading = true;
    this.error = null;
    this.select.disabled = true;

    const abort = typeof AbortController !== 'undefined' ? new AbortController() : null;
    this._fetchAbort = abort;

    try {
      const headers = this.authToken
        ? { authorization: `Bearer ${this.authToken}` }
        : {};
      const fetchOpts = { headers };
      if (abort) fetchOpts.signal = abort.signal;

      const res = await this.fetch(
        `${this.apiBaseUrl}/sync/paperclip/companies`,
        fetchOpts
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const data = await res.json();
      this.companies = data.companies || [];
      this.currentCompanyId = data.currentCompanyId || null;
      this.error = null;
      this._renderOptions();
    } catch (err) {
      if (err.name === 'AbortError') return;
      this.error = err.message;
      console.warn('[CompanySelector] failed to fetch companies:', err.message);
      this._renderOptions();
    } finally {
      this.loading = false;
      this.select.disabled = false;
      this._fetchAbort = null;
    }
  }

  _renderOptions() {
    this.select.innerHTML = '';

    if (this.error) {
      this.select.appendChild(
        h('option', { value: '', disabled: true }, `Load failed — click to retry`)
      );
      // One-shot click to retry
      const retryHandler = () => {
        this.select.removeEventListener('mousedown', retryHandler);
        this._fetchCompanies();
      };
      this.select.addEventListener('mousedown', retryHandler);
      return;
    }

    this.select.appendChild(
      h('option', { value: '' }, 'Inbox mode (all)')
    );

    if (this.companies.length === 0) {
      this.select.appendChild(
        h('option', { value: '', disabled: true }, 'No companies found')
      );
    }

    for (const c of this.companies) {
      const label = c.agentCount != null
        ? `${c.name} (${c.agentCount})`
        : c.name;
      this.select.appendChild(
        h('option', {
          value: c.id,
          selected: c.id === this.currentCompanyId || undefined
        }, label)
      );
    }
  }

  async _handleChange() {
    if (this.switching) return;

    const prevCompanyId = this.currentCompanyId;
    const companyId = this.select.value || null;
    const company = this.companies.find(c => c.id === companyId);
    const companyName = company?.name || null;

    this.switching = true;
    this.currentCompanyId = companyId;
    this.select.disabled = true;
    this.container.style.opacity = '0.6';

    try {
      const headers = {
        'content-type': 'application/json',
        ...(this.authToken ? { authorization: `Bearer ${this.authToken}` } : {})
      };
      const res = await this.fetch(
        `${this.apiBaseUrl}/sync/paperclip/company`,
        {
          method: 'PUT',
          headers,
          body: JSON.stringify({ companyId, companyName })
        }
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const result = await res.json();
      this.currentCompanyId = result.companyId || null;
      console.log(
        `[CompanySelector] switched to ${result.companyName || 'inbox'} (${result.mode})`
      );
      this.onSwitch(result);
    } catch (err) {
      console.error('[CompanySelector] switch failed:', err.message);
      // Revert to previous state
      this.currentCompanyId = prevCompanyId;
      this.select.value = prevCompanyId || '';
    } finally {
      this.switching = false;
      this.select.disabled = false;
      this.container.style.opacity = '1';
    }
  }

  // Allow external refresh (e.g. after reconnect).
  refresh() {
    if (this.enabled) {
      this._fetchCompanies();
    }
  }

  destroy() {
    if (this._fetchAbort) {
      this._fetchAbort.abort();
      this._fetchAbort = null;
    }
    if (this.container.parentNode) {
      this.container.parentNode.removeChild(this.container);
    }
  }
}
