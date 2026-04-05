const BASE_MOVE_INTERVAL_MS = 380;

// Movement vectors — reduced idle probability (1 in 8 instead of 1 in 5)
const MOVES = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, 0]
];

const DIRECTION_BY_MOVE = {
  '1,0': 'right',
  '-1,0': 'left',
  '0,1': 'down',
  '0,-1': 'up'
};

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function nextMoveTime(timestamp, rng = Math.random) {
  return (
    timestamp +
    BASE_MOVE_INTERVAL_MS +
    Math.floor(rng() * BASE_MOVE_INTERVAL_MS)
  );
}

function chooseMove(rng = Math.random) {
  const index = Math.floor(rng() * MOVES.length);
  return MOVES[index] || MOVES[0];
}

function resolveDirection(deltaX, deltaY, fallback = 'down') {
  if (deltaX > 0) {
    return 'right';
  }

  if (deltaX < 0) {
    return 'left';
  }

  if (deltaY > 0) {
    return 'down';
  }

  if (deltaY < 0) {
    return 'up';
  }

  return fallback;
}

// A* pathfinding for goal-directed movement
// Per-agent path noise: hash avatar ID to a stable integer seed.
function agentHashSeed(agentId) {
  if (!agentId) return 0;
  let h = 2166136261;
  for (let i = 0; i < agentId.length; i++) {
    h ^= agentId.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0);
}

const NEIGHBOR_ROTATIONS = [
  [[0, 1], [1, 0], [0, -1], [-1, 0]],
  [[1, 0], [0, -1], [-1, 0], [0, 1]],
  [[0, -1], [-1, 0], [0, 1], [1, 0]],
  [[-1, 0], [0, 1], [1, 0], [0, -1]]
];

function findPath(startX, startY, goalX, goalY, width, height, blockedTiles, opts = {}) {
  if (startX === goalX && startY === goalY) return [];

  const { agentSeed = 0, softBlocked = null } = opts;

  const key = (x, y) => `${x},${y}`;
  const openSet = new Map();
  const closedSet = new Set();
  const cameFrom = new Map();
  const gScore = new Map();
  const fScore = new Map();

  const startKey = key(startX, startY);
  gScore.set(startKey, 0);
  fScore.set(startKey, Math.abs(goalX - startX) + Math.abs(goalY - startY));
  openSet.set(startKey, { x: startX, y: startY });

  // Each agent explores neighbors in a different order → different tie-breaks
  // → varied paths even between identical endpoints.
  const neighbors = NEIGHBOR_ROTATIONS[agentSeed % NEIGHBOR_ROTATIONS.length];
  let iterations = 0;
  const maxIterations = width * height * 2;

  while (openSet.size > 0 && iterations < maxIterations) {
    iterations++;

    // Find node with lowest fScore in openSet
    let currentKey = null;
    let currentNode = null;
    let bestF = Infinity;
    for (const [k, node] of openSet) {
      const f = fScore.get(k) || Infinity;
      if (f < bestF) {
        bestF = f;
        currentKey = k;
        currentNode = node;
      }
    }

    if (!currentKey) break;

    if (currentNode.x === goalX && currentNode.y === goalY) {
      // Reconstruct path
      const path = [];
      let ck = currentKey;
      while (cameFrom.has(ck)) {
        const [px, py] = ck.split(',').map(Number);
        path.unshift({ x: px, y: py });
        ck = cameFrom.get(ck);
      }
      return path;
    }

    openSet.delete(currentKey);
    closedSet.add(currentKey);

    for (const [dx, dy] of neighbors) {
      const nx = currentNode.x + dx;
      const ny = currentNode.y + dy;

      if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;

      const nKey = key(nx, ny);
      if (closedSet.has(nKey)) continue;
      if (blockedTiles && blockedTiles.has(nKey)) continue;

      // Soft-block: extra cost for tiles currently occupied by other agents
      // so routes bend around them instead of overlapping.
      const softCost = softBlocked && softBlocked.has(nKey) ? 3 : 0;
      // Per-tile deterministic jitter per agent (0..2) — scatters paths
      // without making them chaotic.
      const jitter = ((agentSeed ^ (nx * 73856093) ^ (ny * 19349663)) >>> 0) % 3 === 0 ? 1 : 0;
      const tentativeG = (gScore.get(currentKey) || 0) + 1 + softCost + jitter;

      if (tentativeG < (gScore.get(nKey) || Infinity)) {
        cameFrom.set(nKey, currentKey);
        gScore.set(nKey, tentativeG);
        fScore.set(nKey, tentativeG + Math.abs(goalX - nx) + Math.abs(goalY - ny));
        if (!openSet.has(nKey)) {
          openSet.set(nKey, { x: nx, y: ny });
        }
      }
    }
  }

  return null; // No path found
}

export function syncAvatarRuntimeEntries(
  avatarRuntime,
  avatars,
  now,
  rng = Math.random
) {
  const aliveIds = new Set();

  Object.entries(avatars).forEach(([avatarId, avatar]) => {
    aliveIds.add(avatarId);

    const runtime = avatarRuntime.get(avatarId);
    // Only lock position when agent is NOT moving (i.e. working)
    // Moving/idle agents should have client-side movement freedom
    const authoritativePosition = avatar.authoritativePosition !== false && !avatar.moving;

    if (!runtime) {
      avatarRuntime.set(avatarId, {
        ...avatar,
        authoritativePosition,
        direction: 'down',
        nextMoveAt: nextMoveTime(now, rng),
        path: null,
        pathIndex: 0,
        arrivalPauseUntil: 0,
        agentSeed: agentHashSeed(avatarId),
      });
      return;
    }

    const prevMoving = runtime.moving;
    const prevX = runtime.x;
    const prevY = runtime.y;

    runtime.moving = avatar.moving;
    runtime.state = avatar.state;
    // Preserve client-set bubble text (station activities like
    // "mining stones") when server sends an empty value. Server wins
    // only for task labels when working.
    if (avatar.bubbleText) {
      runtime.bubbleText = avatar.bubbleText;
    } else if (runtime.bubbleText == null) {
      runtime.bubbleText = '';
    }
    runtime.authoritativePosition = authoritativePosition;
    runtime.displayName = avatar.displayName;

    // Only snap position from server when agent is NOT moving client-side
    // (i.e. when working or when first transitioning to moving state)
    if (authoritativePosition || !prevMoving) {
      runtime.x = avatar.x;
      runtime.y = avatar.y;
    }

    // Update destination from server state
    if (avatar.destination && avatar.destination.x !== undefined) {
      const destChanged = !runtime.currentDestination ||
        runtime.currentDestination.x !== avatar.destination.x ||
        runtime.currentDestination.y !== avatar.destination.y;
      if (destChanged) {
        runtime.currentDestination = avatar.destination;
        runtime.path = null; // Force re-pathfind
        runtime.pathIndex = 0;
      }
    } else if (!runtime.moving) {
      runtime.currentDestination = null;
      runtime.path = null;
    }

    if (authoritativePosition && (prevX !== avatar.x || prevY !== avatar.y)) {
      runtime.direction = resolveDirection(
        avatar.x - prevX,
        avatar.y - prevY,
        runtime.direction
      );
    }

    if (!runtime.moving) {
      runtime.nextMoveAt = nextMoveTime(now, rng);
    }
  });

  Array.from(avatarRuntime.keys()).forEach(avatarId => {
    if (!aliveIds.has(avatarId)) {
      avatarRuntime.delete(avatarId);
    }
  });
}

function pickClientDestination(runtime, locations, rng) {
  if (!locations || locations.length === 0) return null;
  // Pick a location different from where we currently are
  const candidates = locations.filter(loc => {
    const cx = loc.x + Math.floor((loc.w || 5) / 2);
    const cy = loc.y + (loc.h || 4) - 1;
    return !(runtime.x === cx && runtime.y === cy);
  });
  const pool = candidates.length > 0 ? candidates : locations;
  const chosen = pool[Math.floor(rng() * pool.length)];
  return {
    locationId: chosen.id,
    locationName: chosen.name,
    x: chosen.x + Math.floor((chosen.w || 5) / 2),
    y: chosen.y + (chosen.h || 4) - 1,
  };
}

// Pick a station matching the agent's current state.
// - state==='working' → prefer a 'work' station
// - state==='idle'    → prefer a 'rest' station
// Build a bubble text given a chosen destination and agent state.
// Outdoor stations carry an explicit `activity` phrase; indoor stations
// fall back to "working at <label> @ <room>" / "resting at <label> @ <room>".
function formatStationBubble(dest, state, phase /* 'at' | 'heading to' */) {
  if (!dest) return '';
  if (dest.stationActivity) {
    return phase === 'heading to'
      ? `heading out to ${dest.stationLabel || 'the spot'}`
      : dest.stationActivity;
  }
  const target = dest.stationLabel
    ? `${dest.stationLabel} @ ${dest.locationName}`
    : dest.locationName;
  if (phase === 'heading to') return `heading to ${target}`;
  return state === 'working' ? `working at ${target}` : `resting at ${target}`;
}

// Claimed stations (currently targeted by another agent) are skipped.
// Also skips `lastStationId` so an agent doesn't immediately re-pick the
// same spot they just left — keeps rotation lively.
function pickStationForState(runtime, stations, rng, claimedStationIds, lastStationId = null) {
  if (!stations || stations.length === 0) return null;
  const wantKind = runtime.state === 'working' ? 'work' : 'rest';
  const available = (s) => !claimedStationIds.has(s.id) && s.id !== lastStationId;
  const preferred = stations.filter(s => s.kind === wantKind && available(s));
  const fallback = stations.filter(available);
  // If excluding lastStationId left nothing, allow it again.
  const finalPool = preferred.length > 0 ? preferred :
    fallback.length > 0 ? fallback :
    stations.filter(s => !claimedStationIds.has(s.id));
  if (finalPool.length === 0) return null;
  const chosen = finalPool[Math.floor(rng() * finalPool.length)];
  return {
    stationId: chosen.id,
    locationId: chosen.locationId,
    locationName: chosen.locationName,
    stationLabel: chosen.label,
    stationKind: chosen.kind,
    stationActivity: chosen.activity || null,
    x: chosen.x,
    y: chosen.y
  };
}

export function advanceAvatarRuntimeEntries(
  avatarRuntime,
  dimensions,
  timestamp,
  rng = Math.random,
  blockedTiles = null,
  locations = null,
  stations = null
) {
  const width = Number.isInteger(dimensions?.width) ? dimensions.width : 30;
  const height = Number.isInteger(dimensions?.height) ? dimensions.height : 30;

  // Collect which stations are currently claimed (targeted or occupied) so
  // routing picks different ones for each agent.
  const claimedStationIds = new Set();
  avatarRuntime.forEach(r => {
    const id = r.currentDestination?.stationId;
    if (id) claimedStationIds.add(id);
  });

  // Soft-block: tiles currently occupied by other agents. Used as extra A*
  // cost so routes bend around other avatars instead of stacking.
  const occupiedTiles = new Set();
  avatarRuntime.forEach(r => {
    occupiedTiles.add(`${r.x},${r.y}`);
  });

  function pickDestination(runtime, lastStationId = null) {
    // Prefer station-targeted routing when stations are available.
    if (stations && stations.length > 0) {
      const st = pickStationForState(runtime, stations, rng, claimedStationIds, lastStationId);
      if (st) {
        claimedStationIds.add(st.stationId);
        return st;
      }
    }
    return pickClientDestination(runtime, locations, rng);
  }

  avatarRuntime.forEach(runtime => {
    if (!runtime.moving || runtime.authoritativePosition) {
      return;
    }

    if (timestamp < runtime.nextMoveAt) {
      return;
    }

    // If paused at arrival, wait then pick a new destination
    if (runtime.arrivalPauseUntil && timestamp < runtime.arrivalPauseUntil) {
      return;
    }
    if (runtime.arrivalPauseUntil && timestamp >= runtime.arrivalPauseUntil) {
      runtime.arrivalPauseUntil = 0;
      // Release the previously claimed station (if any) before re-picking
      const prevStationId = runtime.currentDestination?.stationId || null;
      if (prevStationId) {
        claimedStationIds.delete(prevStationId);
      }
      const newDest = pickDestination(runtime, prevStationId);
      if (newDest) {
        runtime.currentDestination = newDest;
        runtime.path = null;
        runtime.pathIndex = 0;
        runtime.bubbleText = formatStationBubble(newDest, runtime.state, 'heading to');
      }
    }

    // Goal-directed movement with A* pathfinding
    if (runtime.currentDestination) {
      const dest = runtime.currentDestination;

      // Check if we've arrived at destination
      if (runtime.x === dest.x && runtime.y === dest.y) {
        // Pause at destination for a while. Keep currentDestination so the
        // station stays claimed while this agent uses it (released on pick-next).
        const restTime =
          runtime.state === 'working' ? 8000 + Math.floor(rng() * 8000)
            : 4000 + Math.floor(rng() * 6000);
        runtime.arrivalPauseUntil = timestamp + restTime;
        runtime.path = null;
        runtime.pathIndex = 0;
        runtime.nextMoveAt = nextMoveTime(timestamp, rng);
        // Switch bubble text from "heading to" → at-station activity.
        if (dest.stationId) {
          runtime.bubbleText = formatStationBubble(dest, runtime.state, 'at');
        }
        return;
      }

      // Compute path if needed
      if (!runtime.path) {
        // Soft-block other agents' current tiles (but not our own).
        const myKey = `${runtime.x},${runtime.y}`;
        const softBlocked = new Set();
        for (const k of occupiedTiles) if (k !== myKey) softBlocked.add(k);
        runtime.path = findPath(
          runtime.x, runtime.y,
          dest.x, dest.y,
          width, height,
          blockedTiles,
          { agentSeed: runtime.agentSeed || 0, softBlocked }
        );
        runtime.pathIndex = 0;

        // If no path found, release the claim and fall back to re-picking
        // a different station next frame.
        if (!runtime.path) {
          if (runtime.currentDestination?.stationId) {
            claimedStationIds.delete(runtime.currentDestination.stationId);
          }
          runtime.currentDestination = null;
        }
      }

      // Follow path
      if (runtime.path && runtime.pathIndex < runtime.path.length) {
        const nextStep = runtime.path[runtime.pathIndex];
        const dx = nextStep.x - runtime.x;
        const dy = nextStep.y - runtime.y;

        if (dx !== 0 || dy !== 0) {
          runtime.direction = resolveDirection(dx, dy, runtime.direction);
        }

        runtime.x = nextStep.x;
        runtime.y = nextStep.y;
        runtime.pathIndex++;
        runtime.nextMoveAt = nextMoveTime(timestamp, rng);
        return;
      }

      // Path completed
      runtime.currentDestination = null;
      runtime.path = null;
      runtime.pathIndex = 0;
    }

    // Fallback: pick a new destination (station-preferred) if available.
    const fallbackDest = pickDestination(runtime);
    if (fallbackDest) {
      runtime.currentDestination = fallbackDest;
      runtime.path = null;
      runtime.pathIndex = 0;
      runtime.bubbleText = formatStationBubble(fallbackDest, runtime.state, 'heading to');
      runtime.nextMoveAt = nextMoveTime(timestamp, rng);
      return;
    }

    // Random walk as last resort
    const [dx, dy] = chooseMove(rng);
    const nextX = clamp(runtime.x + dx, 0, width - 1);
    const nextY = clamp(runtime.y + dy, 0, height - 1);

    // Collision check against buildings, props, and water
    if (blockedTiles && blockedTiles.has(`${nextX},${nextY}`)) {
      runtime.nextMoveAt = nextMoveTime(timestamp, rng);
      return;
    }

    if (nextX !== runtime.x || nextY !== runtime.y) {
      runtime.direction = DIRECTION_BY_MOVE[`${dx},${dy}`] || runtime.direction;
    }

    runtime.x = nextX;
    runtime.y = nextY;
    runtime.nextMoveAt = nextMoveTime(timestamp, rng);
  });
}
