// Maps Claude session snapshots → world-agent state + intent-tagged
// destinations. avatarRuntime.mjs consumes `avatar.destination.{x,y}` for
// A*-pathed movement; we additionally attach an `intent` so the runtime
// can special-case non-station targets (info desk queue, exit fade, etc).

const path = require('node:path');
const { ensureWorldState, ensureAvatar, hashString } = require('./worldModel');
const { STATUSES } = require('../server/sessionStatus');

const TOOL_ICON = Object.freeze({
  Bash: '🖥',
  Edit: '✏',
  Write: '✏',
  Read: '📖',
  Grep: '🔎',
  Glob: '🔎',
  Task: '👥',
  WebFetch: '🌐',
  WebSearch: '🌐',
  NotebookEdit: '✏'
});

// Per-tool gist extractor. Falls back to the snapshotter's inputPreview.
function toolGist(tool) {
  if (!tool) return null;
  if (tool.inputPreview) return tool.inputPreview;
  return null;
}

function formatToolLine(tool) {
  if (!tool?.name) return '';
  const icon = tool.icon || TOOL_ICON[tool.name] || '⚙';
  const gist = toolGist(tool);
  if (!gist) return `${icon} ${tool.name}`;
  // Shorten file paths to basename for readability.
  let readable = gist;
  if (/^[\/.][\/\w.\-]+/.test(gist) && gist.length > 40) {
    readable = gist.split('/').slice(-2).join('/');
  }
  return `${icon} ${tool.name} ${readable}`;
}

const ACTIVITY_BY_STATUS = Object.freeze({
  [STATUSES.Working]:   'working',
  [STATUSES.Waiting]:   'idle',
  [STATUSES.Errored]:   'idle',
  [STATUSES.Idle]:      'idle',
  [STATUSES.IdleStale]: 'idle',
  [STATUSES.Finished]:  'idle'
});

// Intent tag for scripted routes. avatarRuntime inspects this on the
// current destination and adapts its arrival behavior.
const INTENT = Object.freeze({
  AtDesk:       'at_desk',        // sit at a building's work station
  ToInfoDesk:   'to_info_desk',   // join the permission queue at plaza
  ToTavern:     'to_tavern',      // wander to the cafe after an error
  ToExitFade:   'to_exit_fade',   // walk to exit + fade away
  Wander:       'wander',         // defer to runtime autonomy
  Frozen:       'frozen'          // pin in place (halo pulse)
});

// Well-known world coordinates. Plaza is a 3×3 stone patch at (13,13)–(15,15).
// Info desk = plaza N bench (13,12). Queue extends south.
// Tavern = Agent Lounge (cafe) sofa area.
// Exit = top-right corner, off-world edge.
const INFO_DESK_BASE = Object.freeze({ x: 13, y: 12, label: 'info desk' });
const INFO_DESK_QUEUE_SLOTS = [
  { x: 13, y: 12 }, { x: 14, y: 12 }, { x: 15, y: 12 },
  { x: 13, y: 13 }, { x: 15, y: 13 },
  { x: 13, y: 15 }, { x: 14, y: 15 }, { x: 15, y: 15 }
];
const TAVERN = Object.freeze({ x: 19, y: 10, label: 'the tavern' });
const EXIT = Object.freeze({ x: 29, y: 0, label: 'world exit' });

function intentFromStatus(status, now = Date.now()) {
  switch (status) {
    case STATUSES.Working:    return { kind: INTENT.AtDesk };
    case STATUSES.Waiting:    return { kind: INTENT.ToInfoDesk, expiresAt: now + 10 * 60_000 };
    case STATUSES.Errored:    return { kind: INTENT.ToTavern, expiresAt: now + 60_000 };
    case STATUSES.Idle:       return { kind: INTENT.Wander };
    case STATUSES.IdleStale:  return { kind: INTENT.Wander };
    case STATUSES.Finished:   return { kind: INTENT.ToExitFade, expiresAt: now + 30_000 };
    default:                  return { kind: INTENT.Wander };
  }
}

function hatHueFromBranch(branch) {
  if (!branch || typeof branch !== 'string') return null;
  return hashString(branch) % 360;
}

// Agent name = last segment of the working folder (user spec). If the user
// `cd src` inside a repo, the name updates to "src" while the building
// assignment (keyed on repoRoot) stays put.
function shortenName(cwd, repoRoot) {
  const pick = cwd || repoRoot;
  if (!pick) return 'session';
  const base = path.basename(pick.replace(/\/+$/, ''));
  return base || 'session';
}

function ensureClaudeAgent(worldState, session, now) {
  const id = session.sessionId;
  if (!worldState.agents[id]) {
    worldState.agents[id] = {
      id,
      sessionId: id,
      pid: session.pid,
      name: shortenName(session.cwd, session.repoRoot),
      zone: 'idle',
      activity: 'idle',
      tasks: [],
      status: session.status,
      lastEventAt: new Date(now).toISOString(),
      lastTool: null,
      tool: null,
      gitBranch: null,
      repoRoot: session.repoRoot,
      buildingKey: session.buildingKey,
      cwd: session.cwd,
      model: null
    };
  }
  return worldState.agents[id];
}

function extractToolName(preview) {
  if (!preview) return null;
  // If the snapshotter already extracted it, use that.
  if (typeof preview?.tool?.name === 'string') return preview.tool.name;
  const rec = preview.lastToolUse;
  if (!rec) return null;
  if (typeof rec.name === 'string') return rec.name;
  const content = rec?.message?.content;
  if (Array.isArray(content)) {
    const used = content.find(c => c && c.type === 'tool_use');
    if (used?.name) return used.name;
  }
  return null;
}

// Infer the best destination + intent for a session's current status.
function destinationForSession(session, assignment, queuePosition, now) {
  const intent = intentFromStatus(session.status, now);
  const label = assignment?.label || shortenName(session.cwd, session.repoRoot);

  switch (session.status) {
    case STATUSES.Working: {
      if (!assignment) return null;
      return {
        x: assignment.x, y: assignment.y,
        stationId: assignment.stationId || `desk-${session.sessionId.slice(0, 8)}`,
        locationId: assignment.locationId,
        locationName: label,
        stationLabel: assignment.label || 'desk',
        stationKind: 'work',
        stationActivity: null,
        intent
      };
    }
    case STATUSES.Waiting: {
      const slot = INFO_DESK_QUEUE_SLOTS[Math.max(0, Math.min(queuePosition, INFO_DESK_QUEUE_SLOTS.length - 1))];
      return {
        x: slot.x, y: slot.y,
        stationId: `info_desk_${queuePosition}`,
        locationId: null,
        locationName: INFO_DESK_BASE.label,
        stationLabel: `queue #${queuePosition + 1}`,
        stationKind: 'work',
        stationActivity: '🔒 waiting for approval',
        intent
      };
    }
    case STATUSES.Errored: {
      return {
        x: TAVERN.x, y: TAVERN.y,
        stationId: `tavern_${session.sessionId.slice(0, 8)}`,
        locationId: 'cafe',
        locationName: TAVERN.label,
        stationLabel: 'tavern bench',
        stationKind: 'rest',
        stationActivity: '⚠ drowning sorrows',
        intent
      };
    }
    case STATUSES.Finished: {
      return {
        x: EXIT.x, y: EXIT.y,
        stationId: null,
        locationId: null,
        locationName: EXIT.label,
        stationLabel: 'leaving',
        stationKind: 'rest',
        stationActivity: 'signing off…',
        intent
      };
    }
    case STATUSES.Idle:
    case STATUSES.IdleStale:
    default:
      // Let avatarRuntime pick autonomously — but anchor them near their
      // building when it exists, so they don't wander the whole map.
      if (assignment) {
        return {
          x: assignment.x, y: assignment.y,
          stationId: assignment.stationId || null,
          locationId: assignment.locationId,
          locationName: label,
          stationLabel: assignment.label || '',
          stationKind: 'rest',
          stationActivity: null,
          intent: { kind: INTENT.Wander }
        };
      }
      return null;
  }
}

// Apply a snapshot to worldState. `buildings` is a BuildingAssignments instance.
// `previewByPath` is optional: a Map<transcriptPath, transcriptPreview>.
function applySnapshotToWorld({
  snapshot,
  worldState,
  buildings,
  previewByPath = null,
  now = Date.now()
}) {
  ensureWorldState(worldState);

  const activeBuildingKeys = [];
  const seenSessionIds = new Set();

  // Pre-compute permission queue order: Waiting sessions sorted by hook ts ASC.
  const waiting = snapshot.sessions
    .filter(s => s.status === STATUSES.Waiting)
    .sort((a, b) => (a.lastHookEvent?.ts || 0) - (b.lastHookEvent?.ts || 0));
  const queueIndex = new Map(waiting.map((s, i) => [s.sessionId, i]));

  for (const session of snapshot.sessions) {
    seenSessionIds.add(session.sessionId);
    if (session.buildingKey) activeBuildingKeys.push(session.buildingKey);

    const agent = ensureClaudeAgent(worldState, session, now);
    agent.pid = session.pid;
    agent.status = session.status;
    agent.buildingKey = session.buildingKey;
    agent.cwd = session.cwd;
    agent.repoRoot = session.repoRoot;
    // Keep the display name tracking cwd (user spec: 작업폴더 마지막 이름).
    agent.name = shortenName(session.cwd, session.repoRoot);
    agent.activity = ACTIVITY_BY_STATUS[session.status] || 'idle';
    agent.lastEventAt = new Date(now).toISOString();
    agent.hasTranscript = Boolean(session.transcriptPath);

    // Enriched fields are populated in the snapshotter tick (every 1s when
    // the transcript mtime advances). Fallback to legacy previewByPath shape.
    if (session.tool) {
      agent.tool = {
        name: session.tool.name,
        icon: TOOL_ICON[session.tool.name] || '⚙',
        inputPreview: session.tool.inputPreview || null
      };
    } else {
      agent.tool = null;
    }
    if (typeof session.gitBranch === 'string') agent.gitBranch = session.gitBranch;
    if (typeof session.model === 'string') agent.model = session.model;
    if (typeof session.lastAssistantSnippet === 'string') agent.lastAssistantSnippet = session.lastAssistantSnippet;
    if (typeof session.lastUserSnippet === 'string') agent.lastUserSnippet = session.lastUserSnippet;

    // Legacy path (in case a caller still passes previewByPath).
    const preview = session.transcriptPath && previewByPath
      ? previewByPath.get(session.transcriptPath)
      : null;
    if (preview) {
      if (!agent.model && preview.lastModel) agent.model = preview.lastModel;
      if (!agent.gitBranch && preview.gitBranch) agent.gitBranch = preview.gitBranch;
      if (!agent.tool) {
        const toolName = extractToolName(preview);
        agent.tool = toolName ? { name: toolName, icon: TOOL_ICON[toolName] || '⚙' } : null;
      }
    }

    const assignment = buildings.assignSession({
      buildingKey: session.buildingKey,
      label: agent.name,
      sessionId: session.sessionId
    });

    const avatar = ensureAvatar(worldState, session.sessionId);
    avatar.displayName = agent.name;
    avatar.state = agent.activity === 'working' ? 'working' : 'idle';
    avatar.moving = true;
    avatar.hatHue = hatHueFromBranch(agent.gitBranch);
    avatar.status = session.status;
    avatar.toolIcon = agent.tool?.icon || null;
    avatar.model = agent.model;
    avatar.buildingLabel = assignment?.label || agent.name;
    avatar.buildingKey = session.buildingKey;
    avatar.pid = session.pid;

    const queuePos = queueIndex.has(session.sessionId) ? queueIndex.get(session.sessionId) : -1;
    const destination = destinationForSession(session, assignment, queuePos, now);
    avatar.destination = destination;
    avatar.intent = destination?.intent || null;

    // Bubble text priority:
    //   Waiting   → 🔒 waiting for approval
    //   Errored   → ⚠ <tool?> or ⚠ errored
    //   Working   → <toolIcon> <toolName>
    //   Idle with known last tool → "✏ Edit …" (ghosted by status colour)
    //   Idle with last assistant snippet → that snippet
    //   fallback  → station activity / "at X"
    if (session.status === STATUSES.Waiting) {
      avatar.bubbleText = '🔒 waiting for approval';
    } else if (session.status === STATUSES.Errored) {
      avatar.bubbleText = agent.tool?.name
        ? `⚠ ${formatToolLine(agent.tool)}`
        : '⚠ errored';
    } else if (session.status === STATUSES.Working && agent.tool?.name) {
      avatar.bubbleText = formatToolLine(agent.tool);
    } else if (agent.lastAssistantSnippet) {
      avatar.bubbleText = `💬 ${agent.lastAssistantSnippet.slice(0, 72)}`;
    } else if (agent.tool?.name) {
      // Idle but we saw a tool earlier. Dimmer tone happens client-side.
      avatar.bubbleText = formatToolLine(agent.tool);
    } else if (destination?.stationActivity) {
      avatar.bubbleText = destination.stationActivity;
    } else if (destination) {
      avatar.bubbleText = `at ${destination.locationName}`;
    } else {
      avatar.bubbleText = '';
    }

    // Expose a stable "repo label" separate from the display name, so the
    // sidebar can show both: cwd-basename (who's talking now) + repoRoot
    // basename (which building they belong to).
    avatar.repoLabel = session.repoRoot ? path.basename(session.repoRoot) : null;
    agent.repoLabel = avatar.repoLabel;

    avatar.lastUpdatedAt = new Date(now).toISOString();
  }

  // Remove agents/avatars for sessions no longer present.
  for (const agentId of Object.keys(worldState.agents)) {
    const agent = worldState.agents[agentId];
    if (!agent.sessionId) continue; // not a Claude agent
    if (!seenSessionIds.has(agentId)) {
      buildings.releaseSession({
        buildingKey: agent.buildingKey,
        sessionId: agentId
      });
      delete worldState.agents[agentId];
      delete worldState.avatars[agentId];
    }
  }

  return { activeBuildingKeys };
}

module.exports = {
  TOOL_ICON,
  INTENT,
  INFO_DESK_BASE,
  INFO_DESK_QUEUE_SLOTS,
  TAVERN,
  EXIT,
  intentFromStatus,
  hatHueFromBranch,
  destinationForSession,
  ensureClaudeAgent,
  applySnapshotToWorld
};
