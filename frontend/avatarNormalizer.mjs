// Pure world-state → normalized-avatars projection.
// Extracted from WorldMap.js so it's importable by Node tests without
// pulling in the canvas renderer. WorldMap re-imports from here.
//
// Contract (Phase 0, per the plan at /tmp/aw-plan/v5-plan.md §5A):
//
// Every field the current avatarRuntime reads from `avatar.*` must
// survive this normalization. 14 top-level fields total:
//   x, y, moving, state, bubbleText, destination,
//   authoritativePosition, displayName,
//   intent, hatHue, status, toolIcon, model, tool.
//
// Nested shape coverage:
//   destination.x, destination.y, destination.intent.kind
//   tool.name, tool.inputPreview, tool.icon

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hashString(input) {
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash * 31 + input.charCodeAt(i)) >>> 0;
  }
  return hash;
}

export function deriveDefaultPosition(agentId, width, height) {
  const safeWidth = Math.max(1, width);
  const safeHeight = Math.max(1, height);
  const cellCount = safeWidth * safeHeight;
  const hash = hashString(agentId || 'agent');
  const index = hash % cellCount;

  return {
    x: index % safeWidth,
    y: Math.floor(index / safeWidth)
  };
}

export function worldDimensions(worldState) {
  const world = isRecord(worldState?.world) ? worldState.world : {};
  const width = Number.isInteger(world.width) ? world.width : 25;
  const height = Number.isInteger(world.height) ? world.height : 25;

  return {
    width: width > 0 ? width : 25,
    height: height > 0 ? height : 25
  };
}

// Preserve fields from `avatar` that current avatarRuntime.mjs depends on.
// See §5A in v5 plan for the canonical reader set.
function pickRuntimeReaders(avatar) {
  const out = {};
  if (avatar.intent !== undefined)         out.intent = avatar.intent;
  if (typeof avatar.hatHue === 'number')   out.hatHue = avatar.hatHue;
  if (typeof avatar.status === 'string')   out.status = avatar.status;
  if (typeof avatar.toolIcon === 'string') out.toolIcon = avatar.toolIcon;
  if (typeof avatar.model === 'string')    out.model = avatar.model;
  if (isRecord(avatar.tool))               out.tool = avatar.tool;
  // §5B — added alongside the phase that needs them. Phase 1 dialog
  // context reads both. repoLabel may be null when repoRoot hasn't
  // resolved yet; we still pass the null through so the reader sees
  // it as null, not missing.
  if (typeof avatar.repoRoot === 'string')  out.repoRoot = avatar.repoRoot;
  if (typeof avatar.repoLabel === 'string') out.repoLabel = avatar.repoLabel;
  return out;
}

export function normalizeAvatars(worldState) {
  const { width, height } = worldDimensions(worldState);
  const sourceAvatars = isRecord(worldState?.avatars) ? worldState.avatars : {};
  const agents = isRecord(worldState?.agents) ? worldState.agents : {};
  const normalized = {};

  Object.entries(sourceAvatars).forEach(([avatarId, avatar]) => {
    if (!isRecord(avatar)) {
      return;
    }

    const agentId =
      (typeof avatar.agentId === 'string' && avatar.agentId) || avatarId;
    const fallback = deriveDefaultPosition(agentId, width, height);
    const matchedAgent = agents[agentId];
    const displayName =
      (matchedAgent && typeof matchedAgent.name === 'string' && matchedAgent.name) ||
      agentId.slice(0, 8);
    normalized[agentId] = {
      id: agentId,
      displayName,
      x: Number.isFinite(avatar.x) ? clamp(avatar.x, 0, width - 1) : fallback.x,
      y: Number.isFinite(avatar.y) ? clamp(avatar.y, 0, height - 1) : fallback.y,
      authoritativePosition: avatar.moving === false,
      moving: avatar.moving !== false,
      state: avatar.state === 'working' ? 'working' : 'idle',
      bubbleText:
        typeof avatar.bubbleText === 'string' ? avatar.bubbleText.trim() : '',
      destination: isRecord(avatar.destination) ? avatar.destination : null,
      ...pickRuntimeReaders(avatar)
    };
  });

  Object.entries(agents).forEach(([agentId, agent]) => {
    if (normalized[agentId]) {
      return;
    }

    const fallback = deriveDefaultPosition(agentId, width, height);
    const task = Array.isArray(agent?.tasks)
      ? agent.tasks.find(item => item.status && item.status !== 'completed')
      : null;
    const bubbleText = task?.label || task?.id || '';
    const displayName =
      (agent && typeof agent.name === 'string' && agent.name) ||
      agentId.slice(0, 8);
    normalized[agentId] = {
      id: agentId,
      displayName,
      x: fallback.x,
      y: fallback.y,
      authoritativePosition: false,
      moving: !bubbleText,
      state: bubbleText ? 'working' : 'idle',
      bubbleText,
      destination: null
    };
  });

  return normalized;
}
