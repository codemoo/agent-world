import { buildConversation } from './agentDialogues.mjs';
import { interactionKindFor } from './interactionKind.mjs';
import { resolvePose, POSES } from './poseResolver.mjs';

const BASE_MOVE_INTERVAL_MS = 380;

// Visual channel tuning (consumed by WorldMap renderer).
// Keep constants here so runtime + renderer stay coherent.
export const VISUAL = Object.freeze({
  // Sub-tile interpolation: ~200ms glide between tile centers. Snaps
  // (server authority, destination change, chat start) set prev=current
  // so the glide doesn't span the map.
  STEP_LERP_MS: 200,
  // Tool pop emote: when (tool.name, inputPreview) changes, pop the icon
  // above the head for this long. Rate-limited per-agent.
  TOOL_POP_MS: 1100,
  TOOL_POP_MIN_GAP_MS: 800,
  // Productivity burst: ≥N edit/write invocations within WINDOW_MS → glow.
  EDIT_BURST_COUNT: 3,
  EDIT_BURST_WINDOW_MS: 10_000,
  EDIT_BURST_GLOW_MS: 4_000,
  // Status-transition poof: short radial burst on meaningful transitions.
  POOF_MS: 320
});

const EDIT_TOOL_NAMES = new Set(['Edit', 'Write', 'NotebookEdit']);

// Transitions worth announcing with a poof burst.
// Ignores benign Working↔Idle churn + initial-connect floods.
function isNoteworthyTransition(prev, next) {
  if (!prev || !next || prev === next) return false;
  if (prev === 'Waiting' && next === 'Working') return true;
  if (prev === 'Errored') return true;      // recovery from error
  if (next === 'Errored') return true;      // entering error
  if (prev === 'Idle' && next === 'Working') return true;
  if (prev === 'IdleStale' && next === 'Working') return true;
  if (next === 'Finished') return true;
  return false;
}

// Ambient chat tuning — conversations are scripted by buildConversation:
// 2 turns (short greeting exchange) or 4 turns (greeting → reply → topic
// → reply). Both participants pause movement and turn to face each
// other for the full duration.
const CHAT_PROXIMITY = 2;           // Chebyshev tiles
const CHAT_TURN_MS = 3500;          // milliseconds per line
const CHAT_TAIL_MS = 600;           // linger on last speaker after final line
const CHAT_COOLDOWN_MS = 6000;      // per-agent cooldown after any conversation
const CHAT_PAIR_COOLDOWN_MS = 45000; // same pair can't re-chat for 45s
const CHAT_START_CHANCE = 0.3;      // chance per eligible tick to start chat

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
      // Seed lastToolKey from the first-observed tool so the next sync
      // doesn't mistake the initial tool for a new invocation.
      const initialTool = avatar.tool;
      const initialToolKey = initialTool && initialTool.name
        ? `${initialTool.name}::${initialTool.inputPreview || ''}`
        : '';
      const initialStatus = typeof avatar.status === 'string' ? avatar.status : undefined;
      avatarRuntime.set(avatarId, {
        ...avatar,
        authoritativePosition,
        direction: 'down',
        nextMoveAt: nextMoveTime(now, rng),
        path: null,
        pathIndex: 0,
        arrivalPauseUntil: 0,
        agentSeed: agentHashSeed(avatarId),
        // Sub-tile interpolation state. prev* = previous discrete tile;
        // the renderer lerps between (prev*, x/y) across STEP_LERP_MS.
        // Starting equal to x/y means "no glide on first frame."
        prevX: avatar.x,
        prevY: avatar.y,
        stepStartedAt: now - 1000,
        // Tool-pop emote channel (see VISUAL.TOOL_POP_MS). Captures the
        // icon that popped most recently + when. lastToolKey is seeded
        // from the current tool so only subsequent changes trigger a pop.
        lastToolKey: initialToolKey,
        toolPopAt: 0,
        toolPopIcon: '',
        toolPopLastAt: 0,
        // Productivity burst: timestamps of recent Edit/Write invocations.
        editBurstTs: [],
        productiveUntil: 0,
        // Status-transition poof. prevServerStatus seeded from initial
        // status so the first post-connect diff doesn't poof-storm. It
        // still captures real subsequent transitions.
        prevServerStatus: initialStatus,
        poofAt: 0,
        // One-tick facing override for reactions (e.g. "look at neighbor
        // who just errored"). Renderer reads facingOverride || direction.
        // Cleared at the top of advanceAvatarRuntimeEntries every tick.
        facingOverride: null
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
      // Detect an actual server-driven teleport. Same-tile syncs are
      // common (state diffs) — don't break the ongoing lerp for those.
      if (runtime.x !== avatar.x || runtime.y !== avatar.y) {
        runtime.prevX = avatar.x;
        runtime.prevY = avatar.y;
        runtime.stepStartedAt = now - VISUAL.STEP_LERP_MS; // force progress=1
      }
      runtime.x = avatar.x;
      runtime.y = avatar.y;
    }

    // Update destination from server state. When the server attaches an
    // `intent` (e.g. to_info_desk, to_exit_fade), we also sync intent-only
    // metadata so arrival behavior can differ per kind.
    if (avatar.destination && avatar.destination.x !== undefined) {
      const destChanged = !runtime.currentDestination ||
        runtime.currentDestination.x !== avatar.destination.x ||
        runtime.currentDestination.y !== avatar.destination.y ||
        runtime.currentDestination.intent?.kind !== avatar.destination.intent?.kind;
      if (destChanged) {
        runtime.currentDestination = avatar.destination;
        runtime.intent = avatar.destination.intent || null;
        runtime.path = null; // Force re-pathfind
        runtime.pathIndex = 0;
        runtime.arrivalPauseUntil = 0; // resume pathing immediately
        // Don't glide visually across a destination change — A* will
        // restart from current tile. Collapse lerp.
        runtime.prevX = runtime.x;
        runtime.prevY = runtime.y;
        runtime.stepStartedAt = now - VISUAL.STEP_LERP_MS;
      }
    } else if (!runtime.moving) {
      runtime.currentDestination = null;
      runtime.intent = null;
      runtime.path = null;
    }
    // Top-level intent signal (falls back to destination.intent).
    if (avatar.intent) runtime.intent = avatar.intent;

    // Propagate cosmetic channels from the server (hat hue, tool icon, status).
    if (typeof avatar.hatHue === 'number') runtime.hatHue = avatar.hatHue;
    if (typeof avatar.status === 'string') runtime.serverStatus = avatar.status;
    if (typeof avatar.toolIcon === 'string') runtime.toolIcon = avatar.toolIcon;
    if (typeof avatar.model === 'string') runtime.model = avatar.model;
    // Phase 1 dialog context (§5B) — repoRoot identifies same-repo
    // conversations, repoLabel renders the {repo} placeholder.
    if (typeof avatar.repoRoot === 'string')  runtime.repoRoot = avatar.repoRoot;
    if (typeof avatar.repoLabel === 'string') runtime.repoLabel = avatar.repoLabel;

    // Tool-pop emote: detect a *new* tool invocation by hashing the
    // (name, inputPreview) tuple. The server rewrites avatar.tool to null
    // between invocations, so a flicker null→{Bash}→null→{Bash} would
    // otherwise over-fire. The tuple-based key collapses that pattern
    // into a single real change per invocation.
    const toolInfo = avatar.tool;
    const toolKey = toolInfo && toolInfo.name
      ? `${toolInfo.name}::${toolInfo.inputPreview || ''}`
      : '';
    if (toolKey && toolKey !== runtime.lastToolKey) {
      // Rate-limit to 1 pop per TOOL_POP_MIN_GAP_MS per agent so Bash
      // spam doesn't strobe the viewer.
      if (now - runtime.toolPopLastAt > VISUAL.TOOL_POP_MIN_GAP_MS) {
        runtime.toolPopAt = now;
        runtime.toolPopLastAt = now;
        runtime.toolPopIcon = toolInfo.icon || avatar.toolIcon || '⚙';
      }
      // Productivity burst: record Edit/Write/NotebookEdit invocations in
      // a rolling 10s window. Three within window → 4s glow.
      if (EDIT_TOOL_NAMES.has(toolInfo.name)) {
        const cutoff = now - VISUAL.EDIT_BURST_WINDOW_MS;
        runtime.editBurstTs = runtime.editBurstTs.filter(t => t > cutoff);
        runtime.editBurstTs.push(now);
        if (runtime.editBurstTs.length >= VISUAL.EDIT_BURST_COUNT) {
          runtime.productiveUntil = now + VISUAL.EDIT_BURST_GLOW_MS;
        }
      }
    }
    runtime.lastToolKey = toolKey;

    // Status-transition poof. Only fires on meaningful transitions, and
    // only after we've observed at least one prior status (suppresses
    // initial-connect storm).
    const nextStatus = typeof avatar.status === 'string' ? avatar.status : runtime.serverStatus;
    if (
      runtime.prevServerStatus !== undefined &&
      isNoteworthyTransition(runtime.prevServerStatus, nextStatus)
    ) {
      runtime.poofAt = now;
    }
    runtime.prevServerStatus = nextStatus;

    // to_exit_fade — drive a fade from 1 → 0 across the intent's ttl.
    if (runtime.intent?.kind === 'to_exit_fade') {
      const expiresAt = runtime.intent.expiresAt || now + 30_000;
      const remaining = Math.max(0, expiresAt - now);
      runtime.fadeOpacity = Math.max(0.05, Math.min(1, remaining / 30_000));
    } else {
      runtime.fadeOpacity = 1;
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

// Build { [stationId]: station } for O(1) lookup during pose
// resolution. Stations may appear multiple times across ticks so we
// dedupe by id.
function buildStationLookup(stations) {
  const lookup = {};
  if (!Array.isArray(stations)) return lookup;
  for (const st of stations) {
    if (st && typeof st.id === 'string') lookup[st.id] = st;
  }
  return lookup;
}

function faceDirection(dx, dy) {
  if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? 'right' : 'left';
  if (dy === 0 && dx === 0) return 'down';
  return dy > 0 ? 'down' : 'up';
}

// Pair two agents into a scripted conversation: alternating lines, both
// paused + facing each other for the full duration.
function startConversation(a, b, timestamp, rng) {
  // Phase 1 context-aware dialog: pass each side's repoRoot/repoLabel/
  // serverStatus so buildConversation can pick a same-repo / error /
  // waiting-support pool when it applies.
  const ctx = {
    a: { repoRoot: a.repoRoot, repoLabel: a.repoLabel, serverStatus: a.serverStatus },
    b: { repoRoot: b.repoRoot, repoLabel: b.repoLabel, serverStatus: b.serverStatus }
  };
  const lines = buildConversation(ctx, rng);
  const turns = lines.length; // 2 or 4
  const endAt = timestamp + CHAT_TURN_MS * turns + CHAT_TAIL_MS;
  a.chatPauseUntil = endAt;
  b.chatPauseUntil = endAt;
  a.chatPartnerId = b.id || null;
  b.chatPartnerId = a.id || null;
  a.chatQueue = [];
  b.chatQueue = [];
  for (let i = 0; i < turns; i++) {
    const speaker = i % 2 === 0 ? a : b;
    speaker.chatQueue.push({
      text: lines[i],
      showAt: timestamp + i * CHAT_TURN_MS,
      expireAt: timestamp + (i + 1) * CHAT_TURN_MS
    });
  }
  // Both turn to face each other.
  const ddx = b.x - a.x;
  const ddy = b.y - a.y;
  a.direction = faceDirection(ddx, ddy);
  b.direction = faceDirection(-ddx, -ddy);
  // Abandon in-flight paths so they don't resume stepping mid-chat.
  a.path = null; a.pathIndex = 0;
  b.path = null; b.pathIndex = 0;
  // Collapse any in-flight lerp so facing-each-other doesn't glide.
  a.prevX = a.x; a.prevY = a.y; a.stepStartedAt = timestamp - 1000;
  b.prevX = b.x; b.prevY = b.y; b.stepStartedAt = timestamp - 1000;
  // Per-pair cooldown so the same duo doesn't re-chat immediately.
  const until = endAt + CHAT_PAIR_COOLDOWN_MS;
  if (!a.chatRecentPartners) a.chatRecentPartners = {};
  if (!b.chatRecentPartners) b.chatRecentPartners = {};
  if (b.id) a.chatRecentPartners[b.id] = until;
  if (a.id) b.chatRecentPartners[a.id] = until;
}

// Step 1: expire finished conversations + surface the currently-active
// line for each agent. Step 2: try to pair up any eligible agents.
function updateAgentChats(avatarRuntime, timestamp, rng) {
  avatarRuntime.forEach(runtime => {
    if (runtime.chatPauseUntil && runtime.chatPauseUntil <= timestamp) {
      // conversation ended → free up state + apply a cooldown
      runtime.chatPauseUntil = 0;
      runtime.chatPartnerId = null;
      runtime.chatQueue = null;
      runtime.chatCooldownUntil = timestamp + CHAT_COOLDOWN_MS;
      runtime.chat = null;
      // force re-pathfind with fresh state
      runtime.path = null;
      runtime.pathIndex = 0;
    }
    // Derive the currently-visible line from the queue, if any.
    if (runtime.chatQueue) {
      const active = runtime.chatQueue.find(
        item => item.showAt <= timestamp && item.expireAt > timestamp
      );
      runtime.chat = active
        ? { text: active.text, expiresAt: active.expireAt }
        : null;
    }
  });

  // Try to start new conversations for nearby pairs.
  const agents = Array.from(avatarRuntime.values());
  if (agents.length < 2) return;
  for (let i = 0; i < agents.length; i++) {
    const a = agents[i];
    if (a.chatPauseUntil && timestamp < a.chatPauseUntil) continue;
    if (a.chatCooldownUntil && timestamp < a.chatCooldownUntil) continue;
    for (let j = i + 1; j < agents.length; j++) {
      const b = agents[j];
      if (b.chatPauseUntil && timestamp < b.chatPauseUntil) continue;
      if (b.chatCooldownUntil && timestamp < b.chatCooldownUntil) continue;
      const dx = Math.abs(a.x - b.x);
      const dy = Math.abs(a.y - b.y);
      if (dx > CHAT_PROXIMITY || dy > CHAT_PROXIMITY) continue;
      if (dx === 0 && dy === 0) continue;
      if (rng() > CHAT_START_CHANCE) continue;
      // Per-pair cooldown
      const aRecent = a.chatRecentPartners && b.id ? a.chatRecentPartners[b.id] : 0;
      if (aRecent && timestamp < aRecent) continue;
      startConversation(a, b, timestamp, rng);
      break;
    }
  }
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

  // Single owner for facingOverride: clear it at the start of every tick
  // so one-tick reaction facings don't survive past the frame that set
  // them. Reactions downstream write it freshly after this point.
  avatarRuntime.forEach(runtime => {
    runtime.facingOverride = null;
  });

  // Ambient chat: expire stale lines + let nearby agents greet each
  // other. Runs before movement so the current-tick chat state is
  // rendered alongside the resulting positions.
  updateAgentChats(avatarRuntime, timestamp, rng);

  // Per-tick visual flags:
  //   seated  — paused at a station → idle frame + small down-shift
  //   talking — paused in a conversation → idle frame (still standing)
  avatarRuntime.forEach(runtime => {
    runtime.seated = Boolean(
      runtime.arrivalPauseUntil &&
      timestamp < runtime.arrivalPauseUntil &&
      runtime.currentDestination?.stationId
    );
    runtime.talking = Boolean(
      runtime.chatPauseUntil && timestamp < runtime.chatPauseUntil
    );
  });

  // Phase 2: resolve interactionKind + pose per tick. Reset one-shot
  // triggers (farewell, stretch) when the destination changes so the
  // next arrival fires them again.
  const stationLookup = buildStationLookup(stations);
  avatarRuntime.forEach(runtime => {
    const dest = runtime.currentDestination;
    const destKey = dest
      ? `${dest.locationId || ''}:${dest.stationId || ''}:${dest.x},${dest.y}`
      : '';
    if (runtime._prevDestKey !== destKey) {
      runtime.farewellConsumed = false;
      runtime.stretchConsumed = false;
      runtime._prevDestKey = destKey;
    }

    runtime.interactionKind = interactionKindFor(runtime, stationLookup);

    // One-shot pose triggers on arrival.
    const arrived = runtime.arrivalPauseUntil && timestamp < runtime.arrivalPauseUntil;
    if (arrived && runtime.interactionKind === 'exit' &&
        (runtime.fadeOpacity == null || runtime.fadeOpacity > 0.85) &&
        !runtime.farewellConsumed) {
      runtime.farewellUntil = timestamp + 1500;
      runtime.farewellConsumed = true;
    }
    if (arrived && runtime.interactionKind === 'break_area' &&
        !runtime.stretchConsumed) {
      runtime.stretchUntil = timestamp + 800;
      runtime.stretchConsumed = true;
    }

    const { pose, emote } = resolvePose(runtime, timestamp);
    runtime.pose = pose;
    runtime.persistentEmote = emote;

    // Impatient pose: flip facingOverride left↔right every ~4s so the
    // sprite visibly "looks around" while queueing. Purely visual,
    // cleared next tick by the clear-step above.
    if (pose === POSES.IMPATIENT) {
      const phase = Math.floor(timestamp / 4000) % 2;
      runtime.facingOverride = phase === 0 ? 'left' : 'right';
    }
  });

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
    // Frozen during an ambient chat — pathfinding resumes when the
    // conversation ends (updateAgentChats clears chatPauseUntil).
    if (runtime.chatPauseUntil && timestamp < runtime.chatPauseUntil) {
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
      const intentKind = runtime.intent?.kind;
      // Sticky intents: don't auto-repick. Server will update destination
      // when the session's status changes (e.g. permission granted).
      const stickyIntents = new Set(['to_info_desk', 'to_tavern', 'to_exit_fade', 'frozen', 'at_desk']);
      if (stickyIntents.has(intentKind) && runtime.currentDestination) {
        // Extend the pause so the sprite keeps "sitting" at the spot.
        runtime.arrivalPauseUntil = timestamp + 8000 + Math.floor(rng() * 4000);
      } else {
        // Release the previously claimed station (if any) before re-picking.
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

        // Capture lerp start BEFORE updating x/y. Teleports (|dx|+|dy|>1)
        // shouldn't glide; collapse prev=next for those.
        if (Math.abs(dx) + Math.abs(dy) > 1) {
          runtime.prevX = nextStep.x;
          runtime.prevY = nextStep.y;
          runtime.stepStartedAt = timestamp - VISUAL.STEP_LERP_MS;
        } else {
          runtime.prevX = runtime.x;
          runtime.prevY = runtime.y;
          runtime.stepStartedAt = timestamp;
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
      runtime.prevX = runtime.x;
      runtime.prevY = runtime.y;
      runtime.stepStartedAt = timestamp;
    }

    runtime.x = nextX;
    runtime.y = nextY;
    runtime.nextMoveAt = nextMoveTime(timestamp, rng);
  });
}
