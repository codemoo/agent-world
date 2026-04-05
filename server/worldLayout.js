// world-layout.json persistence: load, save, and seed from code defaults.
//
// Schema (version 1):
//   {
//     "version": 1,
//     "indoorStations": [
//       { id, locationId, kind, type, dx, dy, label, activity? }
//     ],
//     "outdoorStations": [
//       { id, kind, type, x, y, label, activity }
//     ],
//     "trees": [ { x, y, type } ]
//   }
//
// `indoorStations` flattens LOCATION_DEFS.stations with an explicit
// locationId field so the editor can treat them as a flat list. The
// adapter re-groups them by locationId when building worldState.
//
// Writes are atomic (tmp file + rename). Reads are synchronous.

const fs = require('fs');
const path = require('path');

const LAYOUT_VERSION = 1;
const DEFAULT_LAYOUT_PATH = path.join(__dirname, '..', 'world-layout.json');

function isRecord(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isFiniteNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function cleanString(v) {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;
}

// Flip fields are additive and optional: undefined ⇒ not flipped. Any truthy
// value coerces to a boolean on save. Kept additive so older layout files
// without flip fields remain valid.
function validateOptionalBool(v, label) {
  if (v === undefined) return;
  if (typeof v !== 'boolean') throw new Error(`${label} must be a boolean if present`);
}

function validateIndoorStation(s, idx) {
  if (!isRecord(s)) throw new Error(`indoorStations[${idx}] must be an object`);
  if (!cleanString(s.id)) throw new Error(`indoorStations[${idx}].id required`);
  if (!cleanString(s.locationId)) throw new Error(`indoorStations[${idx}].locationId required`);
  if (s.kind !== 'work' && s.kind !== 'rest') {
    throw new Error(`indoorStations[${idx}].kind must be 'work' or 'rest'`);
  }
  if (!cleanString(s.type)) throw new Error(`indoorStations[${idx}].type required`);
  if (!Number.isInteger(s.dx) || s.dx < 0) throw new Error(`indoorStations[${idx}].dx must be non-negative int`);
  if (!Number.isInteger(s.dy) || s.dy < 0) throw new Error(`indoorStations[${idx}].dy must be non-negative int`);
  validateOptionalBool(s.flipX, `indoorStations[${idx}].flipX`);
  validateOptionalBool(s.flipY, `indoorStations[${idx}].flipY`);
}

function validateOutdoorStation(s, idx) {
  if (!isRecord(s)) throw new Error(`outdoorStations[${idx}] must be an object`);
  if (!cleanString(s.id)) throw new Error(`outdoorStations[${idx}].id required`);
  if (s.kind !== 'work' && s.kind !== 'rest') {
    throw new Error(`outdoorStations[${idx}].kind must be 'work' or 'rest'`);
  }
  if (!cleanString(s.type)) throw new Error(`outdoorStations[${idx}].type required`);
  if (!Number.isInteger(s.x) || s.x < 0) throw new Error(`outdoorStations[${idx}].x must be non-negative int`);
  if (!Number.isInteger(s.y) || s.y < 0) throw new Error(`outdoorStations[${idx}].y must be non-negative int`);
  validateOptionalBool(s.flipX, `outdoorStations[${idx}].flipX`);
  validateOptionalBool(s.flipY, `outdoorStations[${idx}].flipY`);
}

function validateTree(t, idx) {
  if (!isRecord(t)) throw new Error(`trees[${idx}] must be an object`);
  if (!Number.isInteger(t.x) || t.x < 0) throw new Error(`trees[${idx}].x must be non-negative int`);
  if (!Number.isInteger(t.y) || t.y < 0) throw new Error(`trees[${idx}].y must be non-negative int`);
  if (!cleanString(t.type)) throw new Error(`trees[${idx}].type required`);
  validateOptionalBool(t.flipX, `trees[${idx}].flipX`);
  validateOptionalBool(t.flipY, `trees[${idx}].flipY`);
}

function validateLayout(layout) {
  if (!isRecord(layout)) throw new Error('layout must be a JSON object');
  if (layout.version !== LAYOUT_VERSION) {
    throw new Error(`unsupported layout version: ${layout.version}`);
  }
  if (!Array.isArray(layout.indoorStations)) throw new Error('indoorStations must be an array');
  if (!Array.isArray(layout.outdoorStations)) throw new Error('outdoorStations must be an array');
  if (!Array.isArray(layout.trees)) throw new Error('trees must be an array');
  layout.indoorStations.forEach(validateIndoorStation);
  layout.outdoorStations.forEach(validateOutdoorStation);
  layout.trees.forEach(validateTree);
}

function normalizeLayout(layout) {
  // Only emit flip fields when they're true, so unflipped items stay compact
  // and older layouts don't grow noisy fields on round-trip.
  const withFlip = (obj, src) => {
    if (src.flipX === true) obj.flipX = true;
    if (src.flipY === true) obj.flipY = true;
    return obj;
  };
  return {
    version: LAYOUT_VERSION,
    indoorStations: layout.indoorStations.map(s => withFlip({
      id: s.id.trim(),
      locationId: s.locationId.trim(),
      kind: s.kind,
      type: s.type.trim(),
      dx: s.dx,
      dy: s.dy,
      label: cleanString(s.label) || '',
      ...(s.activity ? { activity: s.activity.trim() } : {})
    }, s)),
    outdoorStations: layout.outdoorStations.map(s => withFlip({
      id: s.id.trim(),
      kind: s.kind,
      type: s.type.trim(),
      x: s.x,
      y: s.y,
      label: cleanString(s.label) || '',
      activity: cleanString(s.activity) || ''
    }, s)),
    trees: layout.trees.map(t => withFlip({
      x: t.x,
      y: t.y,
      type: t.type.trim()
    }, t))
  };
}

function loadLayout(filePath = DEFAULT_LAYOUT_PATH) {
  if (!fs.existsSync(filePath)) return null;
  const raw = fs.readFileSync(filePath, 'utf8');
  const parsed = JSON.parse(raw);
  validateLayout(parsed);
  return normalizeLayout(parsed);
}

function saveLayout(layout, filePath = DEFAULT_LAYOUT_PATH) {
  validateLayout(layout);
  const normalized = normalizeLayout(layout);
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(normalized, null, 2), 'utf8');
  fs.renameSync(tmp, filePath);
  return normalized;
}

// Build a seed layout from in-code defaults. Caller provides LOCATION_DEFS,
// OUTDOOR_STATIONS (from adapter) and trees (from treeGenerator).
function buildSeedLayout({ locationDefs, outdoorStations, trees }) {
  const indoorStations = [];
  for (const loc of locationDefs) {
    if (!Array.isArray(loc.stations)) continue;
    for (const s of loc.stations) {
      indoorStations.push({
        id: s.id,
        locationId: loc.id,
        kind: s.kind,
        type: s.type,
        dx: s.dx,
        dy: s.dy,
        label: s.label || ''
      });
    }
  }
  return {
    version: LAYOUT_VERSION,
    indoorStations,
    outdoorStations: outdoorStations.map(s => ({
      id: s.id,
      kind: s.kind,
      type: s.type,
      x: s.x,
      y: s.y,
      label: s.label || '',
      activity: s.activity || ''
    })),
    trees: trees.map(t => ({ x: t.x, y: t.y, type: t.type }))
  };
}

// Load existing layout, or generate+save seed from defaults, and return the
// resulting layout. `seedBuilder` is called only when file doesn't exist.
function loadOrSeed(seedBuilder, filePath = DEFAULT_LAYOUT_PATH) {
  const existing = loadLayout(filePath);
  if (existing) return existing;
  const seed = seedBuilder();
  validateLayout(seed);
  return saveLayout(seed, filePath);
}

module.exports = {
  LAYOUT_VERSION,
  DEFAULT_LAYOUT_PATH,
  loadLayout,
  saveLayout,
  buildSeedLayout,
  loadOrSeed,
  validateLayout,
  normalizeLayout
};
