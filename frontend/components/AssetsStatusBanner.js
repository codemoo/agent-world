// "Minimal mode" banner + gating for asset-dependent UI.
//
// Listens for the `assets-status` CustomEvent dispatched by WorldMap
// once sprite loading finishes:
//   { loaded: false, loadedCount: 0 }  → show banner, hide editor/assets
//   { loaded: true,  loadedCount: N }  → hide banner, show everything
//
// "Asset editor" and "Assets →" link are hidden outright in minimal
// mode because both are useless without the PixyMoon pack installed.

const VERSION = 1;

const STYLES = `
  #assets-minimal-banner {
    position: fixed;
    bottom: 72px;
    right: 12px;
    max-width: 300px;
    padding: 10px 12px 11px;
    background: rgba(15, 23, 42, 0.94);
    color: #e2e8f0;
    border: 1px solid rgba(251, 191, 36, 0.45);
    border-radius: 9px;
    font: 11px/1.45 Menlo, Monaco, monospace;
    box-shadow: 0 10px 24px rgba(0,0,0,0.4);
    z-index: 9;
    display: none;
  }
  #assets-minimal-banner[data-visible="1"] { display: block; }
  #assets-minimal-banner .banner-title {
    color: #fbbf24;
    font-weight: 700;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    font-size: 10px;
    margin-bottom: 4px;
  }
  #assets-minimal-banner .banner-body {
    color: #cbd5e1;
  }
  #assets-minimal-banner .banner-body b { color: #f1f5f9; }
  #assets-minimal-banner a {
    color: #7dd3fc;
    text-decoration: none;
  }
  #assets-minimal-banner a:hover { text-decoration: underline; }
  #assets-minimal-banner .banner-close {
    float: right;
    background: none; border: none;
    color: #64748b;
    font: inherit; cursor: pointer;
    padding: 0 2px;
    margin-left: 8px;
  }
  #assets-minimal-banner .banner-close:hover { color: #e2e8f0; }
`;

function injectStyles(doc) {
  if (doc.getElementById('assets-banner-styles')) return;
  const style = doc.createElement('style');
  style.id = 'assets-banner-styles';
  style.textContent = STYLES;
  doc.head.appendChild(style);
}

const DISMISS_KEY = 'agent-world.minimal-banner-dismissed';

export default class AssetsStatusBanner {
  constructor({ document: doc = document, window: win = window } = {}) {
    this.document = doc;
    this.window = win;
    this.dismissed = false;
    try { this.dismissed = win.localStorage.getItem(DISMISS_KEY) === '1'; } catch (_) {}
    this._gatedEls = [];
    console.log(`[AssetsStatusBanner v${VERSION}] init`);

    injectStyles(doc);
    this._build();
    this._bind();
  }

  _build() {
    const doc = this.document;
    this.banner = doc.createElement('aside');
    this.banner.id = 'assets-minimal-banner';
    this.banner.setAttribute('role', 'status');

    const close = doc.createElement('button');
    close.className = 'banner-close';
    close.setAttribute('aria-label', 'Dismiss');
    close.textContent = '✕';
    close.addEventListener('click', () => this._dismiss());
    this.banner.appendChild(close);

    const title = doc.createElement('div');
    title.className = 'banner-title';
    title.textContent = '◇ Minimal mode';
    this.banner.appendChild(title);

    const body = doc.createElement('div');
    body.className = 'banner-body';
    body.innerHTML =
      'Running without sprite assets. ' +
      'For the full look, drop <b>PixyMoon Cute RPG World</b> at <code>assets/pixymoon/</code> ' +
      '(<a href="https://pixymoon.itch.io/cute-rpg-world" target="_blank" rel="noopener">buy pack</a>) and reload.';
    this.banner.appendChild(body);

    doc.body.appendChild(this.banner);
  }

  _bind() {
    this._onAssets = (ev) => this._apply(ev.detail || {});
    this.window.addEventListener('assets-status', this._onAssets);
  }

  // Register DOM elements that should be hidden in minimal mode. Pass a
  // truthy value for `hard` to remove them entirely instead of just
  // hiding (useful for the "Assets →" anchor that wouldn't do anything
  // when the pack is missing).
  registerGated(el, { hard = false } = {}) {
    if (!el) return;
    this._gatedEls.push({ el, hard, originalDisplay: el.style.display });
  }

  _apply({ loaded, loadedCount = 0 }) {
    const minimal = !loaded || loadedCount === 0;
    // Gate asset-dependent UI.
    for (const entry of this._gatedEls) {
      if (!entry.el) continue;
      if (minimal) {
        if (entry.hard) entry.el.style.display = 'none';
        else entry.el.style.display = 'none';
      } else {
        entry.el.style.display = entry.originalDisplay || '';
      }
    }
    // Banner: visible in minimal mode, hidden when assets load (unless
    // the user clicked ✕).
    if (minimal && !this.dismissed) {
      this.banner.dataset.visible = '1';
    } else {
      this.banner.dataset.visible = '0';
    }
  }

  _dismiss() {
    this.dismissed = true;
    try { this.window.localStorage.setItem(DISMISS_KEY, '1'); } catch (_) {}
    this.banner.dataset.visible = '0';
  }

  destroy() {
    this.window.removeEventListener('assets-status', this._onAssets);
    if (this.banner.parentNode) this.banner.parentNode.removeChild(this.banner);
  }
}
