import { FURNITURE_ALIASES } from '../furnitureCatalog.mjs';

// World layout editor — DOM-based side panel + canvas overlay + drag.
//
// Loads `/api/world/layout`, lets the user add/move/delete stations and
// trees, and saves changes back via PUT. Working copy is kept in-memory;
// nothing persists until "Save". "Revert" refetches.
//
// Interaction model:
//   • Click on canvas (no tool):   select nearest item at tile
//   • Click with tool:             place a new item at tile
//   • Click + drag on selected:    snap-move to new tile
//   • Ctrl+Z / Ctrl+Shift+Z:       undo / redo (50-deep stack)
//   • Delete / Backspace:          remove selected
//   • Esc:                         clear tool / clear selection
//   • E:                           toggle edit mode

const EDITOR_VERSION = 2;
const HISTORY_LIMIT = 50;
const STATION_KINDS = ['work', 'rest'];
const TREE_TYPES = [
  'tree', 'tree.alt', 'tree.alt2', 'tree.alt3', 'tree.conifer',
  'tree.big', 'tree.big.alt'
];
const INDOOR_TYPES = [
  'bed.wide.pink', 'bed.wide.blue',
  'bookshelf', 'bookshelf.full', 'bookshelf.scroll',
  'cabinet.books', 'cabinet.drawer', 'cabinet.glass',
  'cabinet.metal', 'cabinet.metal.alt', 'cabinet.wood', 'cabinet.wood.alt',
  'chair', 'chair.alt',
  'counter',
  'display', 'display.alt',
  'dresser.alt', 'dresser.plain', 'dresser.beer',
  'nightstand', 'nightstand.alt',
  'plant.pink', 'plant.purple',
  'safe',
  'sofa', 'sofa.alt', 'sofa.alt2',
  'stove', 'stove.alt',
  'table', 'table.mid', 'table.tiny'
];
const OUTDOOR_TYPES = [
  'outdoor.fishing', 'outdoor.watching', 'outdoor.sitting',
  'outdoor.reading', 'outdoor.chatting', 'outdoor.flowers',
  'outdoor.mining', 'outdoor.foraging', 'outdoor.napping'
];
const BUILDING_TYPES = [
  'house', 'house2', 'house.green', 'house.green2', 'house.gray',
  'tower', 'shop', 'large'
];

function h(tag, attrs = {}, children = []) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') {
      el.addEventListener(k.slice(2).toLowerCase(), v);
    } else if (v === true) {
      el.setAttribute(k, '');
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

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

function uniqueId(prefix, taken) {
  let n = 1;
  while (taken.has(`${prefix}${n}`)) n++;
  return `${prefix}${n}`;
}

function deepClone(v) { return JSON.parse(JSON.stringify(v)); }

// Resolve sprite key for a given catalog type, matching WorldMap's logic.
function resolveSpriteKey(kind, type) {
  if (kind === 'tree') {
    // type is 'tree', 'tree.alt', 'tree.big' etc. Sprite key is 'prop.<type>'.
    return `prop.${type}`;
  }
  if (kind === 'indoor') {
    const raw = `furniture.${type}`;
    return FURNITURE_ALIASES[raw] || raw;
  }
  if (kind === 'building') {
    // Building types: 'house', 'house2', 'house.green', 'tower' → 'building.<type>'
    return `building.${type}`;
  }
  return null; // outdoor stations have no sprite
}

// Outdoor station type → emoji icon (since there's no sprite).
const OUTDOOR_ICONS = {
  'outdoor.fishing': '🎣', 'outdoor.watching': '👀', 'outdoor.sitting': '🪑',
  'outdoor.reading': '📖', 'outdoor.chatting': '💬', 'outdoor.flowers': '🌸',
  'outdoor.mining': '⛏', 'outdoor.foraging': '🍓', 'outdoor.napping': '😴'
};

export default class WorldEditor {
  constructor({ worldMap, apiBaseUrl, authToken, fetchImpl }) {
    this.worldMap = worldMap;
    this.apiBaseUrl = apiBaseUrl || '';
    this.authToken = authToken || '';
    // Browsers throw "Illegal invocation" when native `fetch` is called
    // with `this` set to anything other than Window. Bind to window here
    // (the caller may also pass an already-bound or mock fetch).
    const rawFetch = fetchImpl || (typeof window !== 'undefined' ? window.fetch : null);
    this.fetch = rawFetch ? rawFetch.bind(typeof window !== 'undefined' ? window : null) : null;

    this.layout = null;
    this.originalLayout = null;
    this.activeTab = 'trees';
    this.selection = null;          // { kind, id }
    this.pendingAdd = null;         // { kind, type, locationId? }
    this.isEditMode = false;
    this.statusText = '';
    this.loadError = null;

    // Undo/redo: snapshots of deep-cloned layout
    this.history = [];
    this.historyIndex = -1;

    // Drag state
    this.dragging = null;           // { kind, id, startTile, lastTile }

    console.log(`[WorldEditor v${EDITOR_VERSION}] init`, {
      apiBaseUrl: this.apiBaseUrl,
      hasAuthToken: Boolean(this.authToken)
    });

    this._buildUI();
    this._bindKeyboard();
    this._bindMouse();
    // Reposition floater when viewport changes.
    window.addEventListener('resize', () => this._updateFloater());
    window.addEventListener('scroll', () => this._updateFloater(), true);
  }

  _buildUI() {
    this.toggleButton = h('button', {
      id: 'world-editor-toggle',
      style: {
        position: 'fixed', top: '12px', right: '130px', zIndex: 10,
        padding: '6px 12px', borderRadius: '6px',
        background: 'rgba(15,23,42,0.85)', border: '1px solid #fbbf24',
        color: '#fde68a', fontSize: '12px', cursor: 'pointer',
        fontFamily: 'inherit'
      },
      onclick: () => this.toggle()
    }, '✏️ Edit (E)');
    document.body.appendChild(this.toggleButton);

    this.panel = h('div', {
      id: 'world-editor-panel',
      style: {
        position: 'fixed', top: '0', right: '0', bottom: '0',
        // Responsive width: 360px on desktop, full-width on narrow mobile.
        width: 'min(360px, 100vw)', maxWidth: '100vw',
        background: 'rgba(15,23,42,0.96)', color: '#e2e8f0',
        borderLeft: '2px solid #fbbf24', zIndex: 9,
        display: 'none', flexDirection: 'column',
        fontFamily: 'Menlo, Monaco, monospace', fontSize: '12px',
        overflow: 'hidden'
      }
    });
    document.body.appendChild(this.panel);

    // Floating mini-toolbar that tracks the selected object on canvas.
    // `pointer-events: none` on the container lets canvas drags pass through
    // when the cursor crosses the toolbar; buttons re-enable events locally.
    this.floater = h('div', {
      id: 'world-editor-floater',
      style: {
        position: 'fixed', zIndex: 11, display: 'none',
        background: 'rgba(15,23,42,0.96)', border: '1px solid #fbbf24',
        borderRadius: '6px', padding: '4px',
        boxShadow: '0 4px 12px rgba(0,0,0,0.4)', pointerEvents: 'none'
      }
    });
    document.body.appendChild(this.floater);
  }

  _bindKeyboard() {
    document.addEventListener('keydown', (e) => {
      const inField = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
      if (!inField && (e.key === 'e' || e.key === 'E')) {
        e.preventDefault();
        this.toggle();
        return;
      }
      if (!this.isEditMode) return;
      if (inField) return;

      // Undo/Redo
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        this._undo();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && ((e.shiftKey && e.key.toLowerCase() === 'z') || e.key.toLowerCase() === 'y')) {
        e.preventDefault();
        this._redo();
        return;
      }
      // Save
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        this._saveLayout();
        return;
      }
      // Delete
      if ((e.key === 'Delete' || e.key === 'Backspace') && this.selection) {
        e.preventDefault();
        this._deleteSelected();
        return;
      }
      // Escape
      if (e.key === 'Escape') {
        if (this.pendingAdd) {
          this.pendingAdd = null;
          this._setStatus('Cancelled placement');
        } else if (this.selection) {
          this.selection = null;
        }
        this._render();
        this._syncCanvas();
        return;
      }
      // Arrow keys: nudge selected
      if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.key) && this.selection) {
        e.preventDefault();
        const dx = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0;
        const dy = e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0;
        this._moveSelected(dx, dy);
      }
      // Flip shortcuts: F = horizontal, Shift+F = vertical
      if (e.key === 'f' || e.key === 'F') {
        if (this.selection) {
          e.preventDefault();
          this._flipSelected(e.shiftKey ? 'y' : 'x');
        }
      }
    });
  }

  _bindMouse() {
    const moveHandler = (e) => {
      if (!this.dragging || !this.worldMap) return;
      const tile = this._eventToTile(e);
      if (!tile) return;
      if (tile.x === this.dragging.lastTile.x && tile.y === this.dragging.lastTile.y) return;
      this.dragging.lastTile = tile;
      this.dragging.moved = true;
      this._applyDragPreview(tile);
      this._syncCanvas();
    };
    const upHandler = () => {
      if (!this.dragging) return;
      const moved = Boolean(this.dragging.moved);
      this.dragging = null;
      if (moved) {
        this._pushHistory();
        this._setStatus('Moved');
      }
      this._render();
    };

    // Mouse (desktop) and touch (mobile) both continue drag on document
    // so we don't lose events if the cursor/finger leaves the canvas.
    document.addEventListener('mousemove', moveHandler);
    document.addEventListener('mouseup', upHandler);
    document.addEventListener('touchmove', (e) => {
      if (!this.dragging) return;
      if (e.touches && e.touches.length === 1) {
        e.preventDefault(); // block page scroll while dragging
        const t = e.touches[0];
        moveHandler({ clientX: t.clientX, clientY: t.clientY });
      }
    }, { passive: false });
    document.addEventListener('touchend', upHandler);
    document.addEventListener('touchcancel', upHandler);
  }

  _eventToTile(event) {
    if (!this.worldMap || !this.worldMap.canvas) return null;
    const rect = this.worldMap.canvas.getBoundingClientRect();
    const cx = event.clientX - rect.left;
    const cy = event.clientY - rect.top;
    const ts = this.worldMap.tileSize;
    const tileX = Math.floor((cx - this.worldMap.offsetX) / ts);
    const tileY = Math.floor((cy - this.worldMap.offsetY) / ts);
    return { x: tileX, y: tileY };
  }

  // Called by WorldMap on canvas mousedown
  onCanvasMouseDown(tileX, tileY, worldState, event) {
    if (!this.isEditMode || !this.layout) return;
    if (this.pendingAdd) {
      this._placeAtTile(tileX, tileY, worldState);
      return;
    }
    const hit = this._findHit(tileX, tileY, worldState);
    if (hit) {
      this.selection = hit;
      // Remember pre-drag state. If the drag actually moves the item, we'll
      // push to history on first move (not here, to avoid noise when the
      // user just clicks to select).
      const drag = {
        kind: hit.kind, id: hit.id,
        startTile: { x: tileX, y: tileY },
        lastTile: { x: tileX, y: tileY },
        historyPushed: false
      };
      // For buildings, remember the offset from the top-left so the
      // drag feels anchored to the grab point instead of snapping
      // corner-first.
      if (hit.kind === 'building') {
        const b = (this.layout.buildings || []).find(x => x.id === hit.id);
        if (b) {
          drag.grabOffsetX = tileX - b.x;
          drag.grabOffsetY = tileY - b.y;
        }
      }
      this.dragging = drag;
      this._render();
      this._syncCanvas();
      if (event) event.preventDefault();
    } else {
      this.selection = null;
      this._render();
      this._syncCanvas();
    }
  }

  _applyDragPreview(tile) {
    const obj = this._getSelectedObject();
    if (!obj) return;
    const { kind } = this.selection;
    const world = this.worldMap.state?.world;
    const W = world?.width || 30, H = world?.height || 30;
    const tx = clamp(tile.x, 0, W - 1);
    const ty = clamp(tile.y, 0, H - 1);
    if (kind === 'tree' || kind === 'outdoor') {
      obj.x = tx;
      obj.y = ty;
    } else if (kind === 'indoor') {
      const loc = (world?.locations || []).find(l => l.id === obj.locationId);
      if (!loc) return;
      // Clamp to interior (dx 0..w-1, dy 0..h-1; door tile Math.floor(w/2),h-1 excluded)
      const dx = clamp(tx - loc.x, 0, loc.w - 1);
      const dy = clamp(ty - loc.y, 0, loc.h - 1);
      obj.dx = dx;
      obj.dy = dy;
    } else if (kind === 'building') {
      // Keep the building inside world bounds (account for its footprint).
      const gox = (this.dragging && this.dragging.grabOffsetX) || 0;
      const goy = (this.dragging && this.dragging.grabOffsetY) || 0;
      obj.x = clamp(tx - gox, 0, Math.max(0, W - obj.w));
      obj.y = clamp(ty - goy, 0, Math.max(0, H - obj.h));
    }
  }

  async toggle() {
    const wasOff = !this.isEditMode;
    this.isEditMode = !this.isEditMode;
    // When panel is open, hide the floating toggle button so it doesn't
    // cover other UI. The panel header has its own close button.
    this.toggleButton.style.display = this.isEditMode ? 'none' : 'block';
    this.panel.style.display = this.isEditMode ? 'flex' : 'none';
    if (!this.isEditMode) this.floater.style.display = 'none';
    if (this.worldMap?.setEditorMode) {
      this.worldMap.setEditorMode(this.isEditMode, this);
    }
    if (wasOff && !this.layout) {
      this._render();  // show "Loading..." immediately
      await this._fetchLayout();
    }
    this._render();
    this._syncCanvas();
  }

  async _fetchLayout() {
    const url = `${this.apiBaseUrl}/api/world/layout`;
    console.log('[WorldEditor] fetching layout from', url);
    try {
      const headers = this.authToken ? { authorization: `Bearer ${this.authToken}` } : {};
      const res = await this.fetch(url, { headers });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status}: ${text.slice(0, 160)}`);
      }
      const body = await res.json();
      this.layout = deepClone(body.data);
      // If the saved layout predates the buildings field, derive it from
      // the current world state so the Buildings tab isn't empty.
      if (!Array.isArray(this.layout.buildings)) {
        const locs = this.worldMap?.state?.world?.locations || [];
        this.layout.buildings = locs.map(l => ({
          id: l.id, name: l.name, type: l.type,
          x: l.x, y: l.y, w: l.w, h: l.h
        }));
      }
      this.originalLayout = deepClone(this.layout);
      this.loadError = null;
      this._resetHistory();
      console.log('[WorldEditor] layout loaded', {
        buildings: this.layout.buildings.length,
        trees: this.layout.trees.length,
        indoor: this.layout.indoorStations.length,
        outdoor: this.layout.outdoorStations.length
      });
      this._setStatus('Loaded');
    } catch (err) {
      console.error('[WorldEditor] fetch failed', url, err);
      this.loadError = err.message || String(err);
      this._setStatus(`Load failed: ${this.loadError}`);
    }
  }

  async _saveLayout() {
    if (!this.layout) return;
    try {
      const headers = {
        'content-type': 'application/json',
        ...(this.authToken ? { authorization: `Bearer ${this.authToken}` } : {})
      };
      const res = await this.fetch(`${this.apiBaseUrl}/api/world/layout`, {
        method: 'PUT', headers, body: JSON.stringify(this.layout)
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.details?.[0]?.message || `HTTP ${res.status}`);
      this.originalLayout = deepClone(body.data);
      this.layout = deepClone(body.data);
      this._setStatus('✓ Saved');
      this._render();
      this._syncCanvas();
    } catch (err) {
      console.error('[WorldEditor] save failed', err);
      this._setStatus(`Save failed: ${err.message}`);
    }
  }

  _revert() {
    if (!this.originalLayout) return;
    this.layout = deepClone(this.originalLayout);
    this.selection = null;
    this._resetHistory();
    this._setStatus('Reverted');
    this._render();
    this._syncCanvas();
  }

  _resetHistory() {
    this.history = [deepClone(this.layout)];
    this.historyIndex = 0;
  }

  // Call AFTER a mutation: snapshots the new current state so that
  // history[historyIndex] always equals the live layout. Undo navigates
  // backwards in history; redo moves forward.
  //
  // Invariant after push: historyIndex === history.length - 1.
  // When the cap is hit we shift() the oldest entry AND decrement index
  // so the pointer still points at the current state.
  _pushHistory() {
    if (!this.layout) return;
    // Drop any redo entries ahead
    this.history = this.history.slice(0, this.historyIndex + 1);
    this.history.push(deepClone(this.layout));
    this.historyIndex = this.history.length - 1;
    while (this.history.length > HISTORY_LIMIT) {
      this.history.shift();
      this.historyIndex--;
    }
  }

  _undo() {
    if (this.historyIndex <= 0) { this._setStatus('Nothing to undo'); return; }
    this.historyIndex--;
    this.layout = deepClone(this.history[this.historyIndex]);
    this.selection = null;
    this._setStatus('↶ Undo');
    this._render();
    this._syncCanvas();
  }

  _redo() {
    if (this.historyIndex >= this.history.length - 1) { this._setStatus('Nothing to redo'); return; }
    this.historyIndex++;
    this.layout = deepClone(this.history[this.historyIndex]);
    this.selection = null;
    this._setStatus('↷ Redo');
    this._render();
    this._syncCanvas();
  }

  _setStatus(text) {
    this.statusText = text;
    if (this.statusEl) this.statusEl.textContent = text;
  }

  _isDirty() {
    return JSON.stringify(this.layout) !== JSON.stringify(this.originalLayout);
  }

  _takenIds(kind) {
    if (!this.layout) return new Set();
    const list = kind === 'indoor' ? this.layout.indoorStations :
      kind === 'outdoor' ? this.layout.outdoorStations :
      kind === 'building' ? (this.layout.buildings || []) : [];
    return new Set(list.map(s => s.id));
  }

  _deleteSelected() {
    if (!this.selection || !this.layout) return;
    const { kind, id } = this.selection;
    if (kind === 'tree') {
      this.layout.trees.splice(Number(id), 1);
    } else if (kind === 'indoor') {
      this.layout.indoorStations = this.layout.indoorStations.filter(s => s.id !== id);
    } else if (kind === 'outdoor') {
      this.layout.outdoorStations = this.layout.outdoorStations.filter(s => s.id !== id);
    } else if (kind === 'building') {
      this.layout.buildings = (this.layout.buildings || []).filter(b => b.id !== id);
      // Also drop any indoor stations that pointed at this building.
      this.layout.indoorStations = this.layout.indoorStations.filter(s => s.locationId !== id);
    }
    this.selection = null;
    this._pushHistory();
    this._setStatus('Deleted');
    this._render();
    this._syncCanvas();
  }

  _flipSelected(axis) {
    const obj = this._getSelectedObject();
    if (!obj) return;
    // Buildings don't support flipping.
    if (this.selection?.kind === 'building') return;
    if (axis === 'x') obj.flipX = !obj.flipX;
    else obj.flipY = !obj.flipY;
    // Strip false flip flags to keep layout compact.
    if (!obj.flipX) delete obj.flipX;
    if (!obj.flipY) delete obj.flipY;
    this._pushHistory();
    this._setStatus(`Flipped ${axis === 'x' ? 'H ↔' : 'V ↕'}`);
    this._render();
    this._syncCanvas();
  }

  _moveSelected(dx, dy) {
    const obj = this._getSelectedObject();
    if (!obj) return;
    const { kind } = this.selection;
    const world = this.worldMap.state?.world;
    const W = world?.width || 30, H = world?.height || 30;
    if (kind === 'tree' || kind === 'outdoor') {
      obj.x = clamp(obj.x + dx, 0, W - 1);
      obj.y = clamp(obj.y + dy, 0, H - 1);
    } else if (kind === 'building') {
      obj.x = clamp(obj.x + dx, 0, Math.max(0, W - obj.w));
      obj.y = clamp(obj.y + dy, 0, Math.max(0, H - obj.h));
    } else if (kind === 'indoor') {
      const loc = (world?.locations || []).find(l => l.id === obj.locationId);
      if (!loc) return;
      obj.dx = clamp(obj.dx + dx, 0, loc.w - 1);
      obj.dy = clamp(obj.dy + dy, 0, loc.h - 1);
    }
    this._pushHistory();
    this._render();
    this._syncCanvas();
  }

  _findHit(tx, ty, worldState) {
    if (!this.layout) return null;
    for (let i = 0; i < this.layout.trees.length; i++) {
      const t = this.layout.trees[i];
      if (t.x === tx && t.y === ty) return { kind: 'tree', id: String(i) };
    }
    for (const s of this.layout.outdoorStations) {
      if (s.x === tx && s.y === ty) return { kind: 'outdoor', id: s.id };
    }
    const locs = worldState?.world?.locations || [];
    for (const s of this.layout.indoorStations) {
      const loc = locs.find(l => l.id === s.locationId);
      if (!loc) continue;
      if (loc.x + s.dx === tx && loc.y + s.dy === ty) return { kind: 'indoor', id: s.id };
    }
    // Buildings: the only kind whose hit area spans multiple tiles. Checked
    // last so trees/stations sitting on top of a building still win.
    const buildings = this.layout.buildings || [];
    for (const b of buildings) {
      if (tx >= b.x && tx < b.x + b.w && ty >= b.y && ty < b.y + b.h) {
        return { kind: 'building', id: b.id };
      }
    }
    return null;
  }

  _placeAtTile(tx, ty, worldState) {
    const W = worldState?.world?.width || 30;
    const H = worldState?.world?.height || 30;
    if (tx < 0 || ty < 0 || tx >= W || ty >= H) {
      this._setStatus('Out of world bounds');
      this._render();
      return;
    }
    const { kind, type, locationId } = this.pendingAdd;
    if (kind === 'tree') {
      this.layout.trees.push({ x: tx, y: ty, type });
      this.selection = { kind: 'tree', id: String(this.layout.trees.length - 1) };
    } else if (kind === 'outdoor') {
      const id = uniqueId('outdoor_', this._takenIds('outdoor'));
      this.layout.outdoorStations.push({
        id, kind: 'rest', type, x: tx, y: ty, label: type.replace(/^outdoor\./, ''), activity: ''
      });
      this.selection = { kind: 'outdoor', id };
    } else if (kind === 'indoor') {
      const locs = worldState?.world?.locations || [];
      let loc;
      if (locationId) {
        loc = locs.find(l => l.id === locationId);
        if (!loc) { this._setStatus('Building not found'); this._render(); return; }
      } else {
        loc = locs.find(l => tx >= l.x && tx < l.x + l.w && ty >= l.y && ty < l.y + l.h);
        if (!loc) {
          this._setStatus('Indoor stations must go inside a building');
          this._render();
          return;
        }
      }
      const dx = clamp(tx - loc.x, 0, loc.w - 1);
      const dy = clamp(ty - loc.y, 0, loc.h - 1);
      const id = uniqueId(`${loc.id}_`, this._takenIds('indoor'));
      this.layout.indoorStations.push({
        id, locationId: loc.id, kind: 'rest', type, dx, dy, label: type
      });
      this.selection = { kind: 'indoor', id };
    } else if (kind === 'building') {
      // Default new-building footprint: 5×4, clamped to world bounds
      // and anchored at the clicked tile.
      const w = 5, hh = 4;
      const bx = clamp(tx, 0, Math.max(0, W - w));
      const by = clamp(ty, 0, Math.max(0, H - hh));
      if (!this.layout.buildings) this.layout.buildings = [];
      const id = uniqueId('bldg_', this._takenIds('building'));
      this.layout.buildings.push({
        id, name: type.replace(/\./g, ' '), type,
        x: bx, y: by, w, h: hh
      });
      this.selection = { kind: 'building', id };
    }
    this.pendingAdd = null;
    this._pushHistory();
    this._setStatus('Added');
    this._render();
    this._syncCanvas();
  }

  _syncCanvas() {
    if (this.worldMap?.setEditorState) {
      this.worldMap.setEditorState({
        layout: this.layout,
        selection: this.selection,
        pendingAdd: this.pendingAdd,
        dragging: this.dragging
      });
    }
    this._updateFloater();
  }

  // Position the floating mini-toolbar next to the selected object.
  // Hidden when no selection or when selection is off-screen. Prefers the
  // RIGHT side of the tile, flips to LEFT if close to panel / viewport edge.
  _updateFloater() {
    if (!this.floater) return;
    if (!this.isEditMode || !this.selection || !this.worldMap?.canvas) {
      this.floater.style.display = 'none';
      return;
    }
    const obj = this._getSelectedObject();
    if (!obj) { this.floater.style.display = 'none'; return; }
    // Derive world-tile coords for the selected item
    let tx, ty;
    if (this.selection.kind === 'indoor') {
      const loc = (this.worldMap.state?.world?.locations || []).find(l => l.id === obj.locationId);
      if (!loc) { this.floater.style.display = 'none'; return; }
      tx = loc.x + obj.dx; ty = loc.y + obj.dy;
    } else {
      tx = obj.x; ty = obj.y;
    }
    const rect = this.worldMap.canvas.getBoundingClientRect();
    const ts = this.worldMap.tileSize;
    const objX = rect.left + this.worldMap.offsetX + tx * ts;
    const objY = rect.top + this.worldMap.offsetY + ty * ts;
    // Render contents (flip state may have changed)
    this._renderFloater();
    // Position: prefer right of tile. Flip to left if the panel (variable
    // width on mobile) would overlap.
    const floaterWidth = this.floater.offsetWidth || 120;
    const floaterHeight = this.floater.offsetHeight || 30;
    const panelW = this.panel.offsetWidth || 360;
    const panelEdge = window.innerWidth - panelW - 8;
    let left = objX + ts + 6;
    if (left + floaterWidth > panelEdge) left = objX - floaterWidth - 6;
    if (left < 8) left = 8;
    let top = objY - 4;
    if (top < 8) top = objY + ts + 6;
    // Keep floater on-screen vertically too.
    if (top + floaterHeight > window.innerHeight - 8) top = window.innerHeight - floaterHeight - 8;
    this.floater.style.left = `${left}px`;
    this.floater.style.top = `${top}px`;
    this.floater.style.display = 'flex';
  }

  _renderFloater() {
    while (this.floater.firstChild) this.floater.removeChild(this.floater.firstChild);
    const obj = this._getSelectedObject();
    if (!obj) return;
    this.floater.style.gap = '4px';
    this.floater.style.display = 'flex';
    const btnStyle = (color, extra = {}) => ({
      padding: '3px 8px', fontSize: '13px', border: `1px solid ${color}`,
      background: 'rgba(15,23,42,0.9)', color, borderRadius: '4px',
      cursor: 'pointer', fontFamily: 'inherit', pointerEvents: 'auto', ...extra
    });
    this.floater.appendChild(h('button', {
      style: btnStyle(obj.flipX ? '#f97316' : '#94a3b8'),
      onclick: () => this._flipSelected('x'), title: 'Flip horizontal (F)'
    }, '↔'));
    this.floater.appendChild(h('button', {
      style: btnStyle(obj.flipY ? '#f97316' : '#94a3b8'),
      onclick: () => this._flipSelected('y'), title: 'Flip vertical (Shift+F)'
    }, '↕'));
    this.floater.appendChild(h('button', {
      style: btnStyle('#ef4444'),
      onclick: () => this._deleteSelected(), title: 'Delete (Del)'
    }, '🗑'));
    this.floater.appendChild(h('button', {
      style: btnStyle('#94a3b8'),
      onclick: () => { this.selection = null; this._render(); this._syncCanvas(); },
      title: 'Deselect (Esc)'
    }, '✕'));
  }

  _getSelectedObject() {
    if (!this.selection || !this.layout) return null;
    const { kind, id } = this.selection;
    if (kind === 'tree') return this.layout.trees[Number(id)] || null;
    if (kind === 'indoor') return this.layout.indoorStations.find(s => s.id === id) || null;
    if (kind === 'outdoor') return this.layout.outdoorStations.find(s => s.id === id) || null;
    if (kind === 'building') return (this.layout.buildings || []).find(b => b.id === id) || null;
    return null;
  }

  // ====== Rendering ======

  _render() {
    if (!this.isEditMode) return;
    while (this.panel.firstChild) this.panel.removeChild(this.panel.firstChild);

    if (!this.layout) {
      if (this.loadError) {
        this.panel.appendChild(h('div', {
          style: { padding: '20px', color: '#fca5a5', lineHeight: '1.6' }
        }, [
          h('strong', {}, 'Load failed'),
          h('br'),
          h('pre', { style: { whiteSpace: 'pre-wrap', marginTop: '8px', fontSize: '11px' } }, this.loadError),
          h('br'),
          h('button', {
            style: this._btn('#fbbf24'),
            onclick: async () => {
              this.loadError = null; this._render();
              await this._fetchLayout(); this._render(); this._syncCanvas();
            }
          }, 'Retry')
        ]));
      } else {
        this.panel.appendChild(h('div', { style: { padding: '20px' } }, 'Loading...'));
      }
      return;
    }

    this.panel.appendChild(this._renderHeader());
    this.panel.appendChild(this._renderTabs());
    this.panel.appendChild(this._renderAddToolbar());

    // Inspector on TOP of the list (pinned, always visible when something is selected).
    if (this.selection) this.panel.appendChild(this._renderInspector());

    const body = h('div', { style: { flex: '1', overflow: 'auto', display: 'flex', flexDirection: 'column' } });
    body.appendChild(this._renderList());
    this.panel.appendChild(body);

    this.statusEl = h('div', {
      style: {
        padding: '6px 12px', borderTop: '1px solid #334155',
        fontSize: '10px', color: '#94a3b8', minHeight: '22px',
        display: 'flex', justifyContent: 'space-between'
      }
    }, [
      h('span', {}, this.statusText || 'Click: select · Drag: move · Del: delete · Ctrl+Z: undo'),
      h('span', { style: { color: '#64748b' } }, `v${EDITOR_VERSION}`)
    ]);
    this.panel.appendChild(this.statusEl);
  }

  _renderHeader() {
    const undoDisabled = this.historyIndex <= 0;
    const redoDisabled = this.historyIndex >= this.history.length - 1;
    return h('div', {
      style: {
        padding: '10px 12px', borderBottom: '1px solid #334155',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '6px'
      }
    }, [
      h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px' } }, [
        h('button', {
          style: this._btn('#f97316', { padding: '3px 8px' }),
          onclick: () => this.toggle(), title: 'Close editor (E)'
        }, '✕'),
        h('strong', { style: { fontSize: '13px' } }, 'World Editor')
      ]),
      h('div', { style: { display: 'flex', gap: '4px' } }, [
        h('button', {
          style: this._btn('#94a3b8', { opacity: undoDisabled ? '0.4' : '1' }),
          onclick: () => this._undo(), disabled: undoDisabled, title: 'Ctrl+Z'
        }, '↶'),
        h('button', {
          style: this._btn('#94a3b8', { opacity: redoDisabled ? '0.4' : '1' }),
          onclick: () => this._redo(), disabled: redoDisabled, title: 'Ctrl+Shift+Z'
        }, '↷'),
        h('button', {
          style: this._btn('#6b7280'),
          onclick: () => this._revert(), title: 'Revert all changes'
        }, 'Revert'),
        h('button', {
          style: this._btn('#22c55e'),
          onclick: () => this._saveLayout(), title: 'Ctrl+S'
        }, this._isDirty() ? 'Save *' : 'Save')
      ])
    ]);
  }

  _renderTabs() {
    const tabs = h('div', { style: { display: 'flex', borderBottom: '1px solid #334155' } });
    const specs = [
      ['buildings', 'Bldgs', (this.layout.buildings || []).length],
      ['trees', 'Trees', this.layout.trees.length],
      ['indoor', 'Indoor', this.layout.indoorStations.length],
      ['outdoor', 'Outdoor', this.layout.outdoorStations.length]
    ];
    for (const [tab, label, count] of specs) {
      tabs.appendChild(h('button', {
        style: {
          flex: '1', padding: '8px', border: 'none',
          background: this.activeTab === tab ? '#334155' : 'transparent',
          color: this.activeTab === tab ? '#fde68a' : '#94a3b8',
          cursor: 'pointer', fontFamily: 'inherit', fontSize: '11px',
          borderBottom: this.activeTab === tab ? '2px solid #fbbf24' : '2px solid transparent'
        },
        onclick: () => { this.activeTab = tab; this.selection = null; this._render(); this._syncCanvas(); }
      }, `${label} (${count})`));
    }
    return tabs;
  }

  _renderAddToolbar() {
    const container = h('div', {
      style: { borderBottom: '1px solid #334155', background: '#0f172a' }
    });

    // Header row with optional location picker for indoor
    const headerRow = h('div', {
      style: { padding: '6px 10px', display: 'flex', gap: '6px',
        alignItems: 'center', fontSize: '10px', color: '#94a3b8' }
    });
    headerRow.appendChild(h('span', { style: { flex: '1' } }, '+ New item (click a thumbnail, then click the map)'));

    let locSelect = null;
    if (this.activeTab === 'indoor') {
      const locs = this.worldMap?.state?.world?.locations || [];
      locSelect = h('select', { style: this._input({ fontSize: '10px' }) },
        [h('option', { value: '' }, 'Auto-detect building'),
         ...locs.map(l => h('option', { value: l.id }, l.id))]);
      headerRow.appendChild(locSelect);
    }
    container.appendChild(headerRow);

    // Thumbnail grid
    const types = this.activeTab === 'trees' ? TREE_TYPES :
      this.activeTab === 'indoor' ? INDOOR_TYPES :
      this.activeTab === 'buildings' ? BUILDING_TYPES :
      OUTDOOR_TYPES;
    const kind = this.activeTab === 'trees' ? 'tree' :
      this.activeTab === 'buildings' ? 'building' :
      this.activeTab;
    const grid = h('div', {
      style: {
        display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)',
        gap: '4px', padding: '6px 10px 8px', maxHeight: '180px', overflow: 'auto'
      }
    });

    for (const type of types) {
      const isPending = this.pendingAdd && this.pendingAdd.type === type;
      const cell = h('button', {
        style: {
          padding: '2px', border: `1px solid ${isPending ? '#fbbf24' : '#334155'}`,
          background: isPending ? '#3f2f1a' : '#1e293b',
          borderRadius: '4px', cursor: 'pointer', display: 'flex',
          flexDirection: 'column', alignItems: 'center', gap: '1px',
          fontFamily: 'inherit'
        },
        title: type,
        onclick: () => {
          this.pendingAdd = { kind, type };
          if (kind === 'indoor' && locSelect?.value) this.pendingAdd.locationId = locSelect.value;
          this._setStatus(`${type} — click the map to place (Esc to cancel)`);
          this._render();
          this._syncCanvas();
        }
      });
      cell.appendChild(this._makeThumbnail(kind, type, 36));
      cell.appendChild(h('span', {
        style: {
          fontSize: '8px', color: '#94a3b8', maxWidth: '100%',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
        }
      }, type.replace(/^outdoor\./, '')));
      grid.appendChild(cell);
    }
    container.appendChild(grid);
    return container;
  }

  // Render a preview thumbnail for the given catalog type.
  // Returns a canvas (sprite) or a span (emoji fallback for outdoor).
  _makeThumbnail(kind, type, size = 36) {
    if (kind === 'outdoor') {
      return h('span', {
        style: {
          width: `${size}px`, height: `${size}px`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: `${Math.floor(size * 0.6)}px`
        }
      }, OUTDOOR_ICONS[type] || '◉');
    }
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    canvas.style.display = 'block';
    canvas.style.imageRendering = 'pixelated';
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, size, size);
    const spriteKey = resolveSpriteKey(kind, type);
    const sprite = this.worldMap?.spriteStore?.getSprite(spriteKey);
    if (!sprite || !sprite.image) {
      ctx.fillStyle = '#475569';
      ctx.font = '9px monospace';
      ctx.textAlign = 'center';
      ctx.fillText('?', size / 2, size / 2 + 3);
      return canvas;
    }
    // Fit sprite into the square, preserving aspect ratio.
    const aspect = sprite.sw / sprite.sh;
    let dw = size - 4, dh = size - 4;
    if (aspect > 1) dh = dw / aspect;
    else dw = dh * aspect;
    const dx = (size - dw) / 2;
    const dy = (size - dh) / 2;
    ctx.drawImage(sprite.image, sprite.sx, sprite.sy, sprite.sw, sprite.sh, dx, dy, dw, dh);
    return canvas;
  }

  _renderList() {
    const container = h('div', { style: { padding: '4px 0' } });
    let items;
    if (this.activeTab === 'trees') {
      items = this.layout.trees.map((t, i) => ({
        kind: 'tree', id: String(i), label: `${t.type} @ (${t.x},${t.y})`
      }));
    } else if (this.activeTab === 'indoor') {
      items = this.layout.indoorStations.map(s => ({
        kind: 'indoor', id: s.id,
        label: `[${s.locationId}] ${s.type} (${s.dx},${s.dy}) · ${s.kind}`
      }));
    } else if (this.activeTab === 'buildings') {
      items = (this.layout.buildings || []).map(b => ({
        kind: 'building', id: b.id,
        label: `${b.name} · ${b.type} @ (${b.x},${b.y}) ${b.w}×${b.h}`
      }));
    } else {
      items = this.layout.outdoorStations.map(s => ({
        kind: 'outdoor', id: s.id,
        label: `${s.type} @ (${s.x},${s.y}) · ${s.kind}`
      }));
    }

    if (items.length === 0) {
      container.appendChild(h('div', { style: { padding: '16px', color: '#64748b', textAlign: 'center' } }, 'Empty'));
      return container;
    }
    for (const item of items) {
      const isSel = this.selection && this.selection.kind === item.kind && this.selection.id === item.id;
      container.appendChild(h('div', {
        style: {
          padding: '5px 12px', cursor: 'pointer', fontSize: '11px',
          background: isSel ? '#334155' : 'transparent',
          color: isSel ? '#fde68a' : '#cbd5e1',
          borderLeft: isSel ? '3px solid #fbbf24' : '3px solid transparent',
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'
        },
        onclick: () => {
          this.selection = { kind: item.kind, id: item.id };
          this._render(); this._syncCanvas();
        }
      }, item.label));
    }
    return container;
  }

  _renderInspector() {
    const obj = this._getSelectedObject();
    if (!obj) return h('div');
    const { kind } = this.selection;
    const inspector = h('div', {
      style: {
        padding: '10px 12px', borderTop: '1px solid #334155',
        borderBottom: '2px solid #fbbf24', background: '#0f172a'
      }
    });

    // Preview + quick actions row
    const previewThumb = this._makeThumbnail(kind, obj.type, 40);
    // Apply CSS flip to the thumbnail to reflect current state.
    if (previewThumb.tagName === 'CANVAS') {
      const sx = obj.flipX ? -1 : 1, sy = obj.flipY ? -1 : 1;
      previewThumb.style.transform = `scale(${sx},${sy})`;
    }
    const quickRow = h('div', {
      style: { display: 'flex', gap: '6px', marginBottom: '8px', alignItems: 'center' }
    }, [
      previewThumb,
      h('span', { style: { fontSize: '11px', color: '#fbbf24', fontWeight: 'bold', flex: '1' } }, `${kind}: ${obj.type}`),
      h('button', {
        style: this._btn(obj.flipX ? '#f97316' : '#94a3b8', { padding: '2px 8px' }),
        onclick: () => this._flipSelected('x'), title: 'F — flip horizontal'
      }, '↔'),
      h('button', {
        style: this._btn(obj.flipY ? '#f97316' : '#94a3b8', { padding: '2px 8px' }),
        onclick: () => this._flipSelected('y'), title: 'Shift+F — flip vertical'
      }, '↕'),
      h('button', {
        style: this._btn('#ef4444', { padding: '2px 8px' }),
        onclick: () => this._deleteSelected(), title: 'Del — delete'
      }, '🗑')
    ]);
    inspector.appendChild(quickRow);

    const addField = (label, input) => {
      const row = h('div', { style: { marginBottom: '6px', display: 'flex', alignItems: 'center' } });
      row.appendChild(h('label', { style: { width: '70px', color: '#94a3b8', fontSize: '11px' } }, label));
      row.appendChild(input);
      inspector.appendChild(row);
    };

    const s = this._input({ flex: '1' });
    const mutate = (fn) => {
      fn();
      this._pushHistory();
      this._render();
      this._syncCanvas();
    };

    if (kind === 'tree') {
      addField('type', h('select', { style: s, onchange: (e) => mutate(() => obj.type = e.target.value) },
        TREE_TYPES.map(t => h('option', { value: t, selected: t === obj.type || undefined }, t))));
      addField('x', h('input', { type: 'number', value: obj.x, style: s,
        onchange: (e) => mutate(() => obj.x = Number(e.target.value) | 0) }));
      addField('y', h('input', { type: 'number', value: obj.y, style: s,
        onchange: (e) => mutate(() => obj.y = Number(e.target.value) | 0) }));
    } else if (kind === 'building') {
      addField('id', h('input', { type: 'text', value: obj.id, readonly: 'true',
        style: { ...s, opacity: '0.6' } }));
      addField('name', h('input', { type: 'text', value: obj.name, style: s,
        onchange: (e) => mutate(() => obj.name = e.target.value) }));
      addField('type', h('select', { style: s, onchange: (e) => mutate(() => obj.type = e.target.value) },
        BUILDING_TYPES.map(t => h('option', { value: t, selected: t === obj.type || undefined }, t))));
      addField('x', h('input', { type: 'number', value: obj.x, style: s,
        onchange: (e) => mutate(() => obj.x = Number(e.target.value) | 0) }));
      addField('y', h('input', { type: 'number', value: obj.y, style: s,
        onchange: (e) => mutate(() => obj.y = Number(e.target.value) | 0) }));
      addField('w', h('input', { type: 'number', value: obj.w, min: '1', style: s,
        onchange: (e) => mutate(() => obj.w = Math.max(1, Number(e.target.value) | 0)) }));
      addField('h', h('input', { type: 'number', value: obj.h, min: '1', style: s,
        onchange: (e) => mutate(() => obj.h = Math.max(1, Number(e.target.value) | 0)) }));
    } else {
      // Station (indoor/outdoor)
      const idInput = h('input', { type: 'text', value: obj.id, style: s });
      idInput.addEventListener('blur', (e) => {
        const newId = e.target.value.trim();
        if (!newId || newId === obj.id) return;
        const taken = this._takenIds(kind);
        taken.delete(obj.id);
        if (taken.has(newId)) {
          this._setStatus(`❌ duplicate id: ${newId}`);
          idInput.value = obj.id;
          return;
        }
        mutate(() => { obj.id = newId; this.selection.id = newId; });
      });
      addField('id', idInput);

      addField('kind', h('select', { style: s, onchange: (e) => mutate(() => obj.kind = e.target.value) },
        STATION_KINDS.map(k => h('option', { value: k, selected: k === obj.kind || undefined }, k))));
      const types = kind === 'indoor' ? INDOOR_TYPES : OUTDOOR_TYPES;
      addField('type', h('select', { style: s, onchange: (e) => mutate(() => obj.type = e.target.value) },
        types.map(t => h('option', { value: t, selected: t === obj.type || undefined }, t))));

      if (kind === 'indoor') {
        const locs = this.worldMap?.state?.world?.locations || [];
        addField('location', h('select', { style: s,
          onchange: (e) => mutate(() => { obj.locationId = e.target.value; obj.dx = 0; obj.dy = 0; }) },
          locs.map(l => h('option', { value: l.id, selected: l.id === obj.locationId || undefined }, l.id))));
        addField('dx', h('input', { type: 'number', value: obj.dx, style: s,
          onchange: (e) => mutate(() => obj.dx = Number(e.target.value) | 0) }));
        addField('dy', h('input', { type: 'number', value: obj.dy, style: s,
          onchange: (e) => mutate(() => obj.dy = Number(e.target.value) | 0) }));
      } else {
        addField('x', h('input', { type: 'number', value: obj.x, style: s,
          onchange: (e) => mutate(() => obj.x = Number(e.target.value) | 0) }));
        addField('y', h('input', { type: 'number', value: obj.y, style: s,
          onchange: (e) => mutate(() => obj.y = Number(e.target.value) | 0) }));
      }
      addField('label', h('input', { type: 'text', value: obj.label || '', style: s,
        onchange: (e) => mutate(() => obj.label = e.target.value) }));
      if (kind === 'outdoor') {
        addField('activity', h('input', { type: 'text', value: obj.activity || '', style: s,
          onchange: (e) => mutate(() => obj.activity = e.target.value) }));
      }
    }

    return inspector;
  }

  _btn(color, extra = {}) {
    return {
      padding: '4px 10px', fontSize: '11px', border: `1px solid ${color}`,
      background: 'transparent', color, borderRadius: '4px',
      cursor: 'pointer', fontFamily: 'inherit', ...extra
    };
  }

  _input(extra = {}) {
    return {
      padding: '3px 6px', fontSize: '11px', background: '#1e293b', color: '#e2e8f0',
      border: '1px solid #475569', fontFamily: 'inherit', ...extra
    };
  }
}
