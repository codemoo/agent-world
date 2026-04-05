// Asset management page runtime.

const runtime =
  (typeof window !== 'undefined' && window.__AGENT_WORLD_RUNTIME__) || {};
const authToken = runtime.authToken || '';
const apiBaseUrl = window.location.origin;

const state = {
  sheets: [],
  filteredSheets: [],
  selectedSheetId: null,
  sheet: null,
  selectedPropId: null,
  selectedGroupId: null,
  zoom: 1,
  draftRect: null,
  isDragging: false,
  dragStart: null
};

const el = {
  filter: document.getElementById('sheetFilter'),
  sheetList: document.getElementById('sheetListItems'),
  emptyDetails: document.getElementById('emptyDetails'),
  sheetDetails: document.getElementById('sheetDetails'),
  sheetName: document.getElementById('sheetName'),
  sheetDims: document.getElementById('sheetDims'),
  sheetDescription: document.getElementById('sheetDescription'),
  sheetCategory: document.getElementById('sheetCategory'),
  sheetNotes: document.getElementById('sheetNotes'),
  gridCols: document.getElementById('gridCols'),
  gridRows: document.getElementById('gridRows'),
  gridCellW: document.getElementById('gridCellW'),
  gridCellH: document.getElementById('gridCellH'),
  saveSheet: document.getElementById('saveSheet'),
  autoSlice: document.getElementById('autoSlice'),
  propCount: document.getElementById('propCount'),
  propsList: document.getElementById('propsList'),
  groupCount: document.getElementById('groupCount'),
  groupsList: document.getElementById('groupsList'),
  noPropSelected: document.getElementById('noPropSelected'),
  propFields: document.getElementById('propFields'),
  propName: document.getElementById('propName'),
  propDescription: document.getElementById('propDescription'),
  propX: document.getElementById('propX'),
  propY: document.getElementById('propY'),
  propW: document.getElementById('propW'),
  propH: document.getElementById('propH'),
  savePropBtn: document.getElementById('savePropBtn'),
  deletePropBtn: document.getElementById('deletePropBtn'),
  sheetImage: document.getElementById('sheetImage'),
  overlay: document.getElementById('overlay'),
  canvasStage: document.getElementById('canvasStage'),
  canvasInfo: document.getElementById('canvasInfo'),
  zoomLabel: document.getElementById('zoomLabel'),
  zoomIn: document.getElementById('zoomIn'),
  zoomOut: document.getElementById('zoomOut'),
  toast: document.getElementById('toast')
};

function authHeaders(extra = {}) {
  const headers = { ...extra };
  if (authToken) headers.authorization = `Bearer ${authToken}`;
  return headers;
}

async function api(method, path, body) {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    method,
    headers: authHeaders(body ? { 'content-type': 'application/json' } : {}),
    body: body ? JSON.stringify(body) : undefined
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${response.status} ${text}`);
  }
  return response.json();
}

function toast(message, isError = false) {
  el.toast.textContent = message;
  el.toast.classList.toggle('error', isError);
  el.toast.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.toast.classList.remove('show'), 2500);
}

// --- Sheet list ---
async function loadSheets() {
  try {
    const data = await api('GET', '/api/assets/sheets');
    state.sheets = data.sheets || [];
    applyFilter();
  } catch (error) {
    toast(`Failed to load sheet list: ${error.message}`, true);
  }
}

function applyFilter() {
  const q = el.filter.value.trim().toLowerCase();
  state.filteredSheets = q
    ? state.sheets.filter(s => s.relativePath.toLowerCase().includes(q))
    : state.sheets;
  renderSheetList();
}

function renderSheetList() {
  const frag = document.createDocumentFragment();
  for (const sheet of state.filteredSheets) {
    const li = document.createElement('li');
    if (sheet.id === state.selectedSheetId) li.classList.add('selected');
    const name = sheet.relativePath.split(/[\\/]/).pop();
    const folder = sheet.relativePath
      .split(/[\\/]/)
      .slice(0, -1)
      .join(' / ');
    li.innerHTML = `
      <div class="name">${escapeHtml(name)}</div>
      <div class="meta">
        <span class="cat ${sheet.category}">${sheet.category}</span>
        ${sheet.width}×${sheet.height} · ${sheet.propCount} props
      </div>
      <div class="meta">${escapeHtml(folder)}</div>`;
    li.addEventListener('click', () => selectSheet(sheet.id));
    frag.appendChild(li);
  }
  el.sheetList.replaceChildren(frag);
}

// --- Sheet detail ---
async function selectSheet(sheetId) {
  state.selectedSheetId = sheetId;
  state.selectedPropId = null;
  renderSheetList();
  try {
    const data = await api('GET', `/api/assets/sheets/${sheetId}`);
    state.sheet = data.sheet;
    renderSheetDetails();
  } catch (error) {
    toast(`Failed to load sheet: ${error.message}`, true);
  }
}

function renderSheetDetails() {
  if (!state.sheet) {
    el.emptyDetails.hidden = false;
    el.sheetDetails.hidden = true;
    return;
  }
  const s = state.sheet;
  el.emptyDetails.hidden = true;
  el.sheetDetails.hidden = false;
  el.sheetName.textContent = s.relativePath.split(/[\\/]/).pop();
  el.sheetDims.textContent = `${s.width}×${s.height}px · ${s.relativePath}`;
  el.sheetDescription.value = s.description || '';
  el.sheetCategory.value = s.category || 'unknown';
  el.sheetNotes.value = s.notes || '';
  el.gridCols.value = s.grid.columns;
  el.gridRows.value = s.grid.rows;
  el.gridCellW.value = s.grid.cellWidth;
  el.gridCellH.value = s.grid.cellHeight;
  el.propCount.textContent = s.props.length;
  el.groupCount.textContent = (s.groups || []).length;

  // Overlay size comes from API-reported sheet dims — don't wait on image load.
  el.canvasInfo.textContent = `${s.width}×${s.height}`;
  el.sheetImage.src = s.urlPath;
  applyZoom();
  drawOverlay();

  renderGroupsList();
  renderPropsList();
  renderPropEditor();
}

function renderGroupsList() {
  const groups = state.sheet?.groups || [];
  const frag = document.createDocumentFragment();
  for (const group of groups) {
    const div = document.createElement('div');
    div.className = 'groupItem';
    if (group.id === state.selectedGroupId) div.classList.add('selected');
    div.innerHTML = `
      <div>${escapeHtml(group.name)} <span class="meta">(${group.role || '—'})</span></div>
      <div class="meta">${group.propIds.length} props${group.description ? ' · ' + escapeHtml(group.description) : ''}</div>`;
    div.addEventListener('click', () => {
      state.selectedGroupId = group.id === state.selectedGroupId ? null : group.id;
      renderGroupsList();
      drawOverlay();
    });
    frag.appendChild(div);
  }
  el.groupsList.replaceChildren(frag);
}

function renderPropsList() {
  const frag = document.createDocumentFragment();
  // Build prop->group lookup
  const propToGroup = new Map();
  for (const g of state.sheet.groups || []) {
    for (const pid of g.propIds) propToGroup.set(pid, g);
  }
  for (const prop of state.sheet.props) {
    const div = document.createElement('div');
    div.className = 'propItem';
    if (prop.id === state.selectedPropId) div.classList.add('selected');
    const group = propToGroup.get(prop.id);
    const groupBadge = group ? `<span class="group-badge">${escapeHtml(group.name)}</span>` : '';
    const extra = prop.direction ? ` · ${prop.direction}${prop.frame != null ? ' f' + prop.frame : ''}` : '';
    div.innerHTML = `
      <div>${escapeHtml(prop.name)}${groupBadge}</div>
      <div class="coords">x:${prop.x} y:${prop.y} w:${prop.width} h:${prop.height}${extra}</div>`;
    div.addEventListener('click', () => {
      state.selectedPropId = prop.id;
      renderPropsList();
      renderPropEditor();
      drawOverlay();
    });
    frag.appendChild(div);
  }
  el.propsList.replaceChildren(frag);
}

function renderPropEditor() {
  const prop = state.sheet?.props.find(p => p.id === state.selectedPropId);
  if (!prop) {
    el.noPropSelected.hidden = false;
    el.propFields.hidden = true;
    return;
  }
  el.noPropSelected.hidden = true;
  el.propFields.hidden = false;
  el.propName.value = prop.name;
  el.propDescription.value = prop.description;
  el.propX.value = prop.x;
  el.propY.value = prop.y;
  el.propW.value = prop.width;
  el.propH.value = prop.height;
}

// --- Canvas overlay drawing ---
function applyZoom() {
  if (!state.sheet) return;
  const w = state.sheet.width * state.zoom;
  const h = state.sheet.height * state.zoom;
  el.sheetImage.style.width = `${w}px`;
  el.sheetImage.style.height = `${h}px`;
  el.overlay.width = w;
  el.overlay.height = h;
  el.overlay.style.width = `${w}px`;
  el.overlay.style.height = `${h}px`;
  el.zoomLabel.textContent = `${Math.round(state.zoom * 100)}%`;
  drawOverlay();
}

function drawOverlay() {
  if (!state.sheet) return;
  const ctx = el.overlay.getContext('2d');
  ctx.clearRect(0, 0, el.overlay.width, el.overlay.height);
  const z = state.zoom;

  // Grid overlay
  const { columns, rows, cellWidth, cellHeight } = state.sheet.grid;
  ctx.strokeStyle = 'rgba(125, 211, 252, 0.15)';
  ctx.lineWidth = 1;
  for (let c = 1; c < columns; c += 1) {
    const x = c * cellWidth * z + 0.5;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, rows * cellHeight * z);
    ctx.stroke();
  }
  for (let r = 1; r < rows; r += 1) {
    const y = r * cellHeight * z + 0.5;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(columns * cellWidth * z, y);
    ctx.stroke();
  }

  // Build set of prop ids in the selected group (if any)
  const selectedGroup = (state.sheet.groups || []).find(
    g => g.id === state.selectedGroupId
  );
  const groupPropIds = selectedGroup ? new Set(selectedGroup.propIds) : null;

  // Draw props
  for (const prop of state.sheet.props) {
    const selected = prop.id === state.selectedPropId;
    const inGroup = groupPropIds && groupPropIds.has(prop.id);
    ctx.strokeStyle = selected
      ? '#fcd34d'
      : inGroup
      ? '#c084fc'
      : '#38bdf8';
    ctx.fillStyle = selected
      ? 'rgba(252, 211, 77, 0.2)'
      : inGroup
      ? 'rgba(192, 132, 252, 0.22)'
      : 'rgba(56, 189, 248, 0.08)';
    ctx.lineWidth = selected || inGroup ? 2 : 1;
    const x = prop.x * z;
    const y = prop.y * z;
    const w = prop.width * z;
    const h = prop.height * z;
    ctx.fillRect(x, y, w, h);
    ctx.strokeRect(x + 0.5, y + 0.5, w, h);
  }

  // Draft rect while dragging
  if (state.draftRect) {
    const { x, y, w, h } = state.draftRect;
    ctx.strokeStyle = '#f87171';
    ctx.fillStyle = 'rgba(248, 113, 113, 0.15)';
    ctx.lineWidth = 2;
    ctx.fillRect(x * z, y * z, w * z, h * z);
    ctx.strokeRect(x * z + 0.5, y * z + 0.5, w * z, h * z);
  }
}

function eventToImageCoords(event) {
  const rect = el.overlay.getBoundingClientRect();
  const x = Math.round((event.clientX - rect.left) / state.zoom);
  const y = Math.round((event.clientY - rect.top) / state.zoom);
  return { x, y };
}

// Click-or-drag pattern:
//  mousedown records position. On mousemove past threshold, we switch to drag mode
//  (draws draft rect). On mouseup: drag-mode → create prop; click-mode → select
//  prop at cursor. This way existing prop rectangles covering the canvas do not
//  prevent creating new overlapping props.
const DRAG_THRESHOLD_PX = 4;
let mouseDownAt = null; // { x, y, ix, iy } (client + image coords)

el.overlay.addEventListener('mousedown', event => {
  if (!state.sheet || event.button !== 0) return;
  event.preventDefault();
  const coords = eventToImageCoords(event);
  mouseDownAt = {
    cx: event.clientX,
    cy: event.clientY,
    x: coords.x,
    y: coords.y
  };
  state.isDragging = false;
  state.draftRect = null;
});

window.addEventListener('mousemove', event => {
  if (!mouseDownAt) return;
  if (!state.isDragging) {
    const dx = event.clientX - mouseDownAt.cx;
    const dy = event.clientY - mouseDownAt.cy;
    if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
    state.isDragging = true;
    state.dragStart = { x: mouseDownAt.x, y: mouseDownAt.y };
  }
  const coords = eventToImageCoords(event);
  const x = Math.max(0, Math.min(state.dragStart.x, coords.x));
  const y = Math.max(0, Math.min(state.dragStart.y, coords.y));
  const w = Math.abs(coords.x - state.dragStart.x);
  const h = Math.abs(coords.y - state.dragStart.y);
  state.draftRect = { x, y, w, h };
  drawOverlay();
});

window.addEventListener('mouseup', async event => {
  if (!mouseDownAt) return;
  const wasDragging = state.isDragging;
  const downAt = mouseDownAt;
  mouseDownAt = null;

  if (!wasDragging) {
    // Treat as click: select prop under cursor.
    state.isDragging = false;
    const hit = [...state.sheet.props]
      .reverse()
      .find(
        p =>
          downAt.x >= p.x &&
          downAt.x <= p.x + p.width &&
          downAt.y >= p.y &&
          downAt.y <= p.y + p.height
      );
    if (hit) {
      state.selectedPropId = hit.id;
    } else {
      state.selectedPropId = null;
    }
    renderPropsList();
    renderPropEditor();
    drawOverlay();
    return;
  }

  // Drag finished — create prop from draft rect.
  state.isDragging = false;
  const rect = state.draftRect;
  state.draftRect = null;
  if (!rect || rect.w < 3 || rect.h < 3) {
    drawOverlay();
    return;
  }
  try {
    const { prop } = await api(
      'POST',
      `/api/assets/sheets/${state.sheet.id}/props`,
      {
        name: `prop_${state.sheet.props.length + 1}`,
        description: '',
        x: rect.x,
        y: rect.y,
        width: rect.w,
        height: rect.h
      }
    );
    state.sheet.props.push(prop);
    state.selectedPropId = prop.id;
    refreshSheetListEntry();
    renderPropsList();
    renderPropEditor();
    el.propCount.textContent = state.sheet.props.length;
    drawOverlay();
    toast('Prop added');
  } catch (error) {
    toast(`Failed to add prop: ${error.message}`, true);
    drawOverlay();
  }
});

// --- Event bindings ---
el.filter.addEventListener('input', applyFilter);

el.zoomIn.addEventListener('click', () => {
  state.zoom = Math.min(4, state.zoom + 0.25);
  applyZoom();
});
el.zoomOut.addEventListener('click', () => {
  state.zoom = Math.max(0.25, state.zoom - 0.25);
  applyZoom();
});

el.saveSheet.addEventListener('click', async () => {
  if (!state.sheet) return;
  try {
    const { sheet } = await api('PUT', `/api/assets/sheets/${state.sheet.id}`, {
      description: el.sheetDescription.value,
      category: el.sheetCategory.value,
      notes: el.sheetNotes.value,
      grid: {
        columns: Number(el.gridCols.value),
        rows: Number(el.gridRows.value),
        cellWidth: Number(el.gridCellW.value),
        cellHeight: Number(el.gridCellH.value)
      }
    });
    state.sheet = sheet;
    refreshSheetListEntry();
    drawOverlay();
    toast('Sheet saved');
  } catch (error) {
    toast(`Failed to save sheet: ${error.message}`, true);
  }
});

el.autoSlice.addEventListener('click', async () => {
  if (!state.sheet) return;
  if (
    state.sheet.props.length > 0 &&
    !confirm('This will overwrite existing props with a fresh grid. Continue?')
  ) {
    return;
  }
  try {
    // Save grid first (in case user changed inputs)
    await api('PUT', `/api/assets/sheets/${state.sheet.id}`, {
      grid: {
        columns: Number(el.gridCols.value),
        rows: Number(el.gridRows.value),
        cellWidth: Number(el.gridCellW.value),
        cellHeight: Number(el.gridCellH.value)
      }
    });
    const { sheet } = await api(
      'POST',
      `/api/assets/sheets/${state.sheet.id}/auto-slice`,
      { replace: true }
    );
    state.sheet = sheet;
    state.selectedPropId = null;
    el.propCount.textContent = sheet.props.length;
    refreshSheetListEntry();
    renderPropsList();
    renderPropEditor();
    drawOverlay();
    toast(`Created ${sheet.props.length} props`);
  } catch (error) {
    toast(`Auto-slice failed: ${error.message}`, true);
  }
});

el.savePropBtn.addEventListener('click', async () => {
  if (!state.sheet || !state.selectedPropId) return;
  try {
    const { prop } = await api(
      'PUT',
      `/api/assets/sheets/${state.sheet.id}/props/${state.selectedPropId}`,
      {
        name: el.propName.value,
        description: el.propDescription.value,
        x: Number(el.propX.value),
        y: Number(el.propY.value),
        width: Number(el.propW.value),
        height: Number(el.propH.value)
      }
    );
    const index = state.sheet.props.findIndex(p => p.id === prop.id);
    if (index !== -1) state.sheet.props[index] = prop;
    renderPropsList();
    renderPropEditor();
    drawOverlay();
    toast('Prop saved');
  } catch (error) {
    toast(`Failed to save prop: ${error.message}`, true);
  }
});

el.deletePropBtn.addEventListener('click', async () => {
  if (!state.sheet || !state.selectedPropId) return;
  if (!confirm('Delete this prop?')) return;
  try {
    await api(
      'DELETE',
      `/api/assets/sheets/${state.sheet.id}/props/${state.selectedPropId}`
    );
    state.sheet.props = state.sheet.props.filter(
      p => p.id !== state.selectedPropId
    );
    // Mirror server-side group cleanup: drop the propId from any group, remove empty groups
    state.sheet.groups = (state.sheet.groups || [])
      .map(g => ({ ...g, propIds: g.propIds.filter(id => id !== state.selectedPropId) }))
      .filter(g => g.propIds.length > 0);
    state.selectedPropId = null;
    el.propCount.textContent = state.sheet.props.length;
    el.groupCount.textContent = state.sheet.groups.length;
    refreshSheetListEntry();
    renderGroupsList();
    renderPropsList();
    renderPropEditor();
    drawOverlay();
    toast('Prop deleted');
  } catch (error) {
    toast(`Failed to delete prop: ${error.message}`, true);
  }
});

function refreshSheetListEntry() {
  const sheet = state.sheets.find(s => s.id === state.selectedSheetId);
  if (sheet && state.sheet) {
    sheet.propCount = state.sheet.props.length;
    sheet.description = state.sheet.description;
    sheet.category = state.sheet.category;
    renderSheetList();
  }
}

function escapeHtml(str) {
  return String(str || '').replace(/[&<>"']/g, ch => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}

loadSheets();
