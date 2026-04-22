// Bottom timeline scrubber. Backed by HistoryBuffer's per-second
// snapshots. Dragging the thumb calls worldMap.setScrubSnapshot(snap)
// to freeze the render on a past frame. Release or Live button → resume
// live rendering. Arrow keys step one second; Space toggles pause.

const SCRUBBER_VERSION = 1;

function injectStyles(doc) {
  if (doc.getElementById('timeline-scrubber-styles')) return;
  const style = doc.createElement('style');
  style.id = 'timeline-scrubber-styles';
  style.textContent = `
    #timeline-scrubber {
      position: fixed; left: 50%; bottom: 12px;
      transform: translateX(-50%);
      display: flex; align-items: center;
      gap: 10px;
      padding: 7px 12px 7px 12px;
      background: rgba(15, 23, 42, 0.92);
      border: 1px solid rgba(148, 163, 184, 0.35);
      border-radius: 10px;
      color: #e2e8f0;
      font: 11px/1 Menlo, Monaco, monospace;
      z-index: 10;
      box-shadow: 0 10px 28px rgba(0,0,0,0.42);
      min-width: 320px; max-width: 65vw;
      user-select: none;
    }
    #timeline-scrubber .ts-label {
      color: #94a3b8; font-size: 10px; letter-spacing: 0.04em;
      text-transform: uppercase; font-weight: 600;
    }
    #timeline-scrubber .ts-now {
      color: #fbbf24;
      font-variant-numeric: tabular-nums;
      min-width: 70px;
      text-align: center;
    }
    #timeline-scrubber .ts-live {
      font-size: 10px; padding: 3px 7px;
      border-radius: 4px;
      background: rgba(74, 222, 128, 0.18);
      color: #4ade80;
      font-weight: 600;
      letter-spacing: 0.06em;
    }
    #timeline-scrubber[data-live="0"] .ts-live {
      background: rgba(251, 191, 36, 0.18);
      color: #fbbf24;
    }
    #timeline-scrubber .ts-live.off {
      background: rgba(148,163,184,0.14);
      color: #94a3b8;
    }
    #timeline-scrubber .ts-track {
      position: relative;
      flex: 1;
      height: 26px;
      min-width: 180px;
    }
    #timeline-scrubber .ts-rail {
      position: absolute; left: 0; right: 0; top: 12px;
      height: 3px; background: rgba(148, 163, 184, 0.25);
      border-radius: 2px;
    }
    #timeline-scrubber .ts-fill {
      position: absolute; left: 0; top: 12px;
      height: 3px; background: rgba(56, 189, 248, 0.45);
      border-radius: 2px;
    }
    #timeline-scrubber .ts-ticks {
      position: absolute; left: 0; right: 0; top: 7px; height: 12px;
      pointer-events: none;
    }
    #timeline-scrubber .ts-tick {
      position: absolute; top: 0; width: 1px; height: 12px;
      background: rgba(251, 191, 36, 0.75);
    }
    #timeline-scrubber .ts-thumb {
      position: absolute; top: 5px;
      width: 14px; height: 18px;
      border-radius: 4px;
      background: #fbbf24;
      border: 1px solid #f59e0b;
      cursor: grab;
      transform: translateX(-50%);
      transition: transform 0.08s ease;
    }
    #timeline-scrubber .ts-thumb:active { cursor: grabbing; }
    #timeline-scrubber .ts-thumb:hover { transform: translateX(-50%) scale(1.15); }
    #timeline-scrubber button {
      font: inherit;
      cursor: pointer;
      color: #cbd5e1;
      background: rgba(30, 41, 59, 0.7);
      border: 1px solid rgba(148, 163, 184, 0.25);
      border-radius: 5px;
      padding: 4px 9px;
    }
    #timeline-scrubber button:hover {
      background: rgba(56, 189, 248, 0.18);
      color: #38bdf8;
    }
    #timeline-scrubber[data-empty="1"] { opacity: 0.6; pointer-events: none; }
  `;
  doc.head.appendChild(style);
}

function fmtClock(ts) {
  const d = new Date(ts);
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  const s = String(d.getSeconds()).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

export default class TimelineScrubber {
  constructor({ worldMap, history, document: doc = document, window: win = window } = {}) {
    this.worldMap = worldMap;
    this.history = history;
    this.document = doc;
    this.window = win;
    this.isLive = true;
    this.dragging = false;
    this.pausedIndex = null; // index into snapshots[] when paused via Space
    console.log(`[TimelineScrubber v${SCRUBBER_VERSION}] init`);

    injectStyles(doc);
    this._build();
    this._bind();
    this._render();
    this._onHistoryUpdate = () => this._render();
    win.addEventListener('history-updated', this._onHistoryUpdate);
  }

  _build() {
    const doc = this.document;
    this.root = doc.createElement('div');
    this.root.id = 'timeline-scrubber';
    this.root.dataset.live = '1';
    this.root.dataset.empty = '1';

    const label = doc.createElement('span');
    label.className = 'ts-label';
    label.textContent = '⟳';
    label.setAttribute('title', 'Timeline');
    this.root.appendChild(label);

    this.nowEl = doc.createElement('span');
    this.nowEl.className = 'ts-now';
    this.nowEl.textContent = '--:--:--';
    this.root.appendChild(this.nowEl);

    this.track = doc.createElement('div');
    this.track.className = 'ts-track';
    this.rail = doc.createElement('div');
    this.rail.className = 'ts-rail';
    this.fill = doc.createElement('div');
    this.fill.className = 'ts-fill';
    this.ticks = doc.createElement('div');
    this.ticks.className = 'ts-ticks';
    this.thumb = doc.createElement('div');
    this.thumb.className = 'ts-thumb';
    this.thumb.style.left = '100%';
    this.track.appendChild(this.rail);
    this.track.appendChild(this.fill);
    this.track.appendChild(this.ticks);
    this.track.appendChild(this.thumb);
    this.root.appendChild(this.track);

    this.liveBadge = doc.createElement('span');
    this.liveBadge.className = 'ts-live';
    this.liveBadge.textContent = '● LIVE';
    this.root.appendChild(this.liveBadge);

    this.liveBtn = doc.createElement('button');
    this.liveBtn.textContent = 'Live';
    this.liveBtn.title = 'Return to live (Space)';
    this.root.appendChild(this.liveBtn);

    doc.body.appendChild(this.root);
  }

  _bind() {
    // Thumb drag.
    this.thumb.addEventListener('mousedown', ev => this._beginDrag(ev));
    // Clicking the track also moves.
    this.track.addEventListener('mousedown', ev => {
      if (ev.target === this.thumb) return;
      this._beginDrag(ev);
    });
    this.liveBtn.addEventListener('click', () => this.goLive());

    // Keyboard: left/right scrub 1 step, Space toggle pause.
    this._onKey = ev => {
      const tag = ev.target?.tagName || '';
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(tag)) return;
      if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
      if (ev.key === 'ArrowLeft') { ev.preventDefault(); this._step(-1); }
      else if (ev.key === 'ArrowRight') { ev.preventDefault(); this._step(+1); }
      else if (ev.key === ' ') { ev.preventDefault(); this._togglePause(); }
    };
    this.window.addEventListener('keydown', this._onKey);

    this._onMouseMove = ev => this._onDrag(ev);
    this._onMouseUp = () => this._endDrag();
  }

  _render() {
    const snaps = this.history ? this.history.getSnapshots() : [];
    this.root.dataset.empty = snaps.length < 2 ? '1' : '0';
    const last = snaps.length ? snaps[snaps.length - 1].ts : Date.now();
    this.nowEl.textContent = fmtClock(last);
    // Draw ticks for every 10s marker.
    this.ticks.textContent = '';
    if (snaps.length > 1) {
      const start = snaps[0].ts;
      const span = last - start || 1;
      for (const s of snaps) {
        const sec = Math.floor((s.ts - start) / 1000);
        if (sec % 10 === 0) {
          const tick = this.document.createElement('div');
          tick.className = 'ts-tick';
          tick.style.left = `${((s.ts - start) / span) * 100}%`;
          this.ticks.appendChild(tick);
        }
      }
    }
    if (this.isLive) {
      this.thumb.style.left = '100%';
      this.fill.style.width = '100%';
    }
  }

  _beginDrag(ev) {
    if (this.root.dataset.empty === '1') return;
    this.dragging = true;
    this.window.addEventListener('mousemove', this._onMouseMove);
    this.window.addEventListener('mouseup', this._onMouseUp);
    this._onDrag(ev);
  }

  _onDrag(ev) {
    if (!this.dragging) return;
    const snaps = this.history.getSnapshots();
    if (!snaps.length) return;
    const rect = this.track.getBoundingClientRect();
    const px = ev.clientX - rect.left;
    const pct = Math.max(0, Math.min(1, px / rect.width));
    const idx = Math.round(pct * (snaps.length - 1));
    const snap = snaps[idx];
    this._applySnapshot(snap, pct);
    // Live-at-end: dragging to the rightmost step == live.
    if (idx === snaps.length - 1) this.goLive();
    else this._goHistory();
  }

  _endDrag() {
    this.dragging = false;
    this.window.removeEventListener('mousemove', this._onMouseMove);
    this.window.removeEventListener('mouseup', this._onMouseUp);
  }

  _step(delta) {
    const snaps = this.history.getSnapshots();
    if (snaps.length < 2) return;
    let idx;
    if (this.isLive) idx = snaps.length - 1 + delta;
    else {
      // find current snapshot
      idx = snaps.findIndex(s => s === this.currentSnap);
      if (idx < 0) idx = snaps.length - 1;
      idx = Math.max(0, Math.min(snaps.length - 1, idx + delta));
    }
    idx = Math.max(0, Math.min(snaps.length - 1, idx));
    const snap = snaps[idx];
    const pct = idx / (snaps.length - 1);
    this._applySnapshot(snap, pct);
    if (idx === snaps.length - 1) this.goLive();
    else this._goHistory();
  }

  _togglePause() {
    if (this.isLive) {
      const snaps = this.history.getSnapshots();
      if (snaps.length < 2) return;
      const snap = snaps[snaps.length - 1];
      this._applySnapshot(snap, 1);
      this._goHistory();
    } else {
      this.goLive();
    }
  }

  _applySnapshot(snap, pct) {
    this.currentSnap = snap;
    this.thumb.style.left = `${pct * 100}%`;
    this.fill.style.width = `${pct * 100}%`;
    this.nowEl.textContent = fmtClock(snap.ts);
    this.worldMap.setScrubSnapshot(snap);
  }

  _goHistory() {
    this.isLive = false;
    this.root.dataset.live = '0';
    this.liveBadge.textContent = '⏸ PAUSED';
    this.liveBadge.classList.remove('off');
  }

  goLive() {
    this.isLive = true;
    this.currentSnap = null;
    this.root.dataset.live = '1';
    this.liveBadge.textContent = '● LIVE';
    this.worldMap.setScrubSnapshot(null);
    this._render();
  }

  destroy() {
    this.window.removeEventListener('keydown', this._onKey);
    this.window.removeEventListener('mousemove', this._onMouseMove);
    this.window.removeEventListener('mouseup', this._onMouseUp);
    this.window.removeEventListener('history-updated', this._onHistoryUpdate);
    if (this.root.parentNode) this.root.parentNode.removeChild(this.root);
  }
}
