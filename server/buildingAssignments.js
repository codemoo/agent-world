// Maps repo-root (or cwd fallback) → building slot in the world.
// Persistent state at data/repoAssignments.json.
//
// Rules:
//  - Known building → reuse. Assign desks to sessions FIFO inside the building.
//  - Unknown repo → start as a tent in an outdoor spot deterministic from hash.
//  - Promote tent → building when totalSeconds + 600*activeSessions > 3600
//    AND a LOCATION_DEFS slot is unclaimed.
//  - Demote building → tent after 14d untouched; GC tent after 3d untouched.
//  - cwd_changed → relocates desk inside the same building unless repoRoot changed.

const fs = require('node:fs');
const path = require('node:path');

const { LOCATION_DEFS, OUTDOOR_STATIONS, hashString } = require('../adapter/worldModel');

const PROMOTE_THRESHOLD = 3600; // "score" in seconds
const DEMOTE_AFTER_MS = 14 * 24 * 60 * 60 * 1000;
const GC_TENT_AFTER_MS = 3 * 24 * 60 * 60 * 1000;

function now() { return Date.now(); }

function makeEmpty() {
  return { version: 1, buildings: [], tents: [] };
}

function loadOrCreate(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.buildings) && Array.isArray(parsed.tents)) {
      return parsed;
    }
  } catch { /* new file */ }
  return makeEmpty();
}

function save(filePath, state) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(state, null, 2), 'utf8');
}

// Pick an outdoor tent tile deterministic from buildingKey. Reuses an
// OUTDOOR_STATIONS-adjacent empty tile near plaza.
function pickTentPosition(buildingKey) {
  const h = hashString(buildingKey || '');
  // Plaza bench area — put tents in a ring near (14,14) to (16,17).
  const spots = [
    { x: 12, y: 16 }, { x: 13, y: 17 }, { x: 15, y: 17 },
    { x: 16, y: 16 }, { x: 16, y: 13 }, { x: 12, y: 12 },
    { x: 11, y: 14 }, { x: 17, y: 14 }, { x: 14, y: 11 },
    { x: 14, y: 18 }
  ];
  return spots[h % spots.length];
}

// Within a building, desk slots are its "work" stations. We reserve up to
// N sessions per building; overflows use a doorway chair at (x+w/2, y+h).
function listWorkStations(locationDef) {
  const st = Array.isArray(locationDef.stations) ? locationDef.stations : [];
  return st.filter(s => s.kind === 'work');
}

function doorwayPosition(locationDef) {
  return {
    x: locationDef.x + Math.floor((locationDef.w || 5) / 2),
    y: locationDef.y + (locationDef.h || 4)
  };
}

function createBuildingAssignments(filePath) {
  const state = loadOrCreate(filePath);
  const locById = Object.fromEntries(LOCATION_DEFS.map(l => [l.id, l]));

  function claimedLocationIds() {
    return new Set(state.buildings.map(b => b.locationId));
  }

  function findBuildingByKey(key) {
    return state.buildings.find(b => b.buildingKey === key) || null;
  }

  function findTentByKey(key) {
    return state.tents.find(t => t.buildingKey === key) || null;
  }

  function nextDeskSlot(building) {
    const loc = locById[building.locationId];
    if (!loc) return doorwayPosition(loc || { x: 0, y: 0, w: 0, h: 0 });
    const workStations = listWorkStations(loc);
    const usedIndexes = new Set(building.desks.map(d => d.stationIndex));
    for (let i = 0; i < workStations.length; i += 1) {
      if (!usedIndexes.has(i)) {
        const s = workStations[i];
        return {
          stationIndex: i,
          stationId: s.id,
          x: loc.x + s.dx,
          y: loc.y + s.dy
        };
      }
    }
    // Overflow: doorway chair.
    const d = doorwayPosition(loc);
    return { stationIndex: -1, stationId: null, x: d.x, y: d.y };
  }

  function promoteTentToBuilding(tent, label) {
    const taken = claimedLocationIds();
    const free = LOCATION_DEFS.find(l => !taken.has(l.id));
    if (!free) return null;
    const building = {
      buildingKey: tent.buildingKey,
      locationId: free.id,
      label: label || tent.label || free.name,
      totalSeconds: tent.totalSeconds || 0,
      lastSeenMs: tent.lastSeenMs || now(),
      desks: []
    };
    state.buildings.push(building);
    state.tents = state.tents.filter(t => t.buildingKey !== tent.buildingKey);
    return building;
  }

  function tick({ activeBuildingKeys, tickMs }) {
    const t = now();
    const activeSet = new Set(activeBuildingKeys);

    // Accumulate totalSeconds on each active building/tent.
    const incSec = (tickMs || 1000) / 1000;
    for (const b of state.buildings) {
      if (activeSet.has(b.buildingKey)) {
        b.totalSeconds = (b.totalSeconds || 0) + incSec;
        b.lastSeenMs = t;
      }
    }
    for (const tent of state.tents) {
      if (activeSet.has(tent.buildingKey)) {
        tent.totalSeconds = (tent.totalSeconds || 0) + incSec;
        tent.lastSeenMs = t;
      }
    }

    // Try tent→building promotions.
    for (const tent of [...state.tents]) {
      const score = (tent.totalSeconds || 0) + 600 * (tent.activeSessions || 0);
      if (score > PROMOTE_THRESHOLD) {
        promoteTentToBuilding(tent, tent.label);
      }
    }

    // Compaction: demote buildings not touched 14d → tent.
    for (const b of [...state.buildings]) {
      if (t - (b.lastSeenMs || 0) > DEMOTE_AFTER_MS) {
        state.buildings = state.buildings.filter(x => x !== b);
        state.tents.push({
          buildingKey: b.buildingKey,
          label: b.label,
          totalSeconds: 0,
          lastSeenMs: b.lastSeenMs
        });
      }
    }
    // GC tents.
    state.tents = state.tents.filter(
      tent => t - (tent.lastSeenMs || 0) < GC_TENT_AFTER_MS
    );
  }

  function assignSession({ buildingKey, label, sessionId }) {
    if (!buildingKey) {
      const fallback = doorwayPosition(LOCATION_DEFS[0]);
      return { kind: 'fallback', x: fallback.x, y: fallback.y };
    }

    let building = findBuildingByKey(buildingKey);
    if (building) {
      // Already has a desk for this session?
      const existing = building.desks.find(d => d.sessionId === sessionId);
      if (existing) {
        return {
          kind: 'building',
          locationId: building.locationId,
          label: building.label,
          x: existing.x,
          y: existing.y,
          stationId: existing.stationId
        };
      }
      const slot = nextDeskSlot(building);
      building.desks.push({ sessionId, ...slot });
      building.lastSeenMs = now();
      return {
        kind: 'building',
        locationId: building.locationId,
        label: building.label,
        x: slot.x,
        y: slot.y,
        stationId: slot.stationId
      };
    }

    let tent = findTentByKey(buildingKey);
    if (!tent) {
      const pos = pickTentPosition(buildingKey);
      tent = {
        buildingKey,
        label: label || '',
        totalSeconds: 0,
        activeSessions: 0,
        lastSeenMs: now(),
        x: pos.x,
        y: pos.y,
        sessionIds: []
      };
      state.tents.push(tent);
    }
    if (!tent.sessionIds.includes(sessionId)) {
      tent.sessionIds.push(sessionId);
      tent.activeSessions = tent.sessionIds.length;
    }
    return { kind: 'tent', label: tent.label, x: tent.x, y: tent.y };
  }

  function releaseSession({ buildingKey, sessionId }) {
    if (!buildingKey) return;
    const building = findBuildingByKey(buildingKey);
    if (building) {
      building.desks = building.desks.filter(d => d.sessionId !== sessionId);
      return;
    }
    const tent = findTentByKey(buildingKey);
    if (tent) {
      tent.sessionIds = (tent.sessionIds || []).filter(id => id !== sessionId);
      tent.activeSessions = tent.sessionIds.length;
    }
  }

  function persist() {
    save(filePath, state);
  }

  function snapshot() {
    return JSON.parse(JSON.stringify(state));
  }

  return {
    assignSession,
    releaseSession,
    tick,
    persist,
    snapshot,
    _state: state
  };
}

module.exports = {
  createBuildingAssignments,
  PROMOTE_THRESHOLD,
  DEMOTE_AFTER_MS,
  GC_TENT_AFTER_MS
};
