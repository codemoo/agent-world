// Maps Claude session snapshots → world-agent state + intent-tagged
// destinations. avatarRuntime.mjs consumes `avatar.destination.{x,y}` for
// A*-pathed movement; we additionally attach an `intent` so the runtime
// can special-case non-station targets (info desk queue, exit fade, etc).

const path = require('node:path');
const { ensureWorldState, ensureAvatar, hashString, buildLeisurePool } = require('./worldModel');
const { STATUSES } = require('../server/sessionStatus');

// Idle agents rotate through a building-local leisure pool on a
// per-session dephased 90s cadence. Dephase via hash(sessionId) so
// three sessions entering Idle within the same tick don't all rotate
// together 90s later (cohort flipping). leisureAnchorAt lives on
// `agent` — persisted alongside the rest of the agent dict.
const LEISURE_SLOT_MS = 90_000;
const LEISURE_CLEAR_AFTER_WORK_MS = 60_000;

// Minimum time the bubble must hold its current text before a lower-
// priority signal can replace it. Waiting/Errored always preempt.
// Prevents the "flicker between tool line and last-assistant snippet"
// that happens when transcript writes land mid-snapshot-tick.
const BUBBLE_MIN_DWELL_MS = 2500;

// Source priority — higher wins. Waiting/Errored are "alert" sources
// and override dwell; other sources must wait out BUBBLE_MIN_DWELL_MS
// before they can change the displayed text. Tie goes to the newer
// signal with a different content key.
const BUBBLE_SOURCE_PRIORITY = Object.freeze({
  waiting: 100,
  errored: 90,
  tool_active: 60,
  assistant: 40,
  tool_recent: 30,
  station: 20,
  location: 10,
  empty: 0
});

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
  AtLeisure:    'at_leisure',     // rotating building-local leisure rest
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
    // Idle/IdleStale default to Wander at the status level; the adapter
    // upgrades them to AtLeisure downstream IFF the agent has a building
    // assignment (tent sessions keep wandering autonomously).
    case STATUSES.Idle:       return { kind: INTENT.Wander };
    case STATUSES.IdleStale:  return { kind: INTENT.Wander };
    case STATUSES.Finished:   return { kind: INTENT.ToExitFade, expiresAt: now + 30_000 };
    default:                  return { kind: INTENT.Wander };
  }
}

// Resolve which leisure-pool slot a session should be in right now.
// slot = floor((now - anchor + phaseMs) / LEISURE_SLOT_MS)
// phaseMs = hash(sessionId) % LEISURE_SLOT_MS — dephases per-session
// rotation so cohorts entering Idle simultaneously don't rotate together.
function leisureSlotIndex(sessionId, leisureAnchorAt, now) {
  const phase = hashString(sessionId || '') % LEISURE_SLOT_MS;
  const age = Math.max(0, now - (leisureAnchorAt || now));
  return Math.floor((age + phase) / LEISURE_SLOT_MS);
}

function pickLeisureStation(pool, sessionId, slot) {
  if (!Array.isArray(pool) || pool.length === 0) return null;
  const idx = Math.abs(hashString(`${sessionId || ''}:${slot}`)) % pool.length;
  return pool[idx];
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

// Build the raw bubble candidate: source tag + text + a contentKey that
// lets the stabilizer detect "meaningful" changes (new toolUseId, new
// assistant message) vs "same signal, different tick" noise.
function pickBubbleCandidate({ status, tool, lastAssistantSnippet, lastAssistantTs, destination }) {
  if (status === STATUSES.Waiting) {
    return { source: 'waiting', text: '🔒 waiting for approval', key: 'waiting' };
  }
  if (status === STATUSES.Errored) {
    const line = tool?.name ? `⚠ ${formatToolLine(tool)}` : '⚠ errored';
    return { source: 'errored', text: line, key: `errored:${tool?.name || ''}` };
  }
  const toolName = tool?.name || '';
  const toolKey = toolName
    ? `${toolName}::${tool?.inputPreview || ''}`
    : '';
  if (status === STATUSES.Working && toolName) {
    return { source: 'tool_active', text: formatToolLine(tool), key: `tool_active:${toolKey}` };
  }
  if (lastAssistantSnippet) {
    // Content key tracks the snippet — new messages cycle the bubble,
    // same snippet keeps it stable even if the snapshotter re-reads.
    const snippet = lastAssistantSnippet.slice(0, 72);
    const stamp = lastAssistantTs || snippet;
    return { source: 'assistant', text: `💬 ${snippet}`, key: `assistant:${stamp}` };
  }
  if (toolName) {
    return { source: 'tool_recent', text: formatToolLine(tool), key: `tool_recent:${toolKey}` };
  }
  if (destination?.stationActivity) {
    return { source: 'station', text: destination.stationActivity, key: `station:${destination.stationId || destination.stationLabel || ''}` };
  }
  if (destination) {
    return { source: 'location', text: `at ${destination.locationName}`, key: `location:${destination.locationName}` };
  }
  return { source: 'empty', text: '', key: 'empty' };
}

// Apply priority + dwell hysteresis. Writes the decision back to
// `agent.bubble` so subsequent ticks can compare. Returns the text to
// display right now.
function stabilizeBubble(agent, candidate, now) {
  const prev = agent.bubble || null;

  // First bubble — always accept.
  if (!prev) {
    agent.bubble = { text: candidate.text, source: candidate.source, key: candidate.key, changedAt: now };
    return candidate.text;
  }

  // Same content → keep it; refresh the source label only (priority
  // may have changed even if text didn't, but visually it's fine).
  if (prev.text === candidate.text && prev.key === candidate.key) {
    prev.source = candidate.source;
    return prev.text;
  }

  const prevPri = BUBBLE_SOURCE_PRIORITY[prev.source] ?? 0;
  const newPri = BUBBLE_SOURCE_PRIORITY[candidate.source] ?? 0;
  const age = now - (prev.changedAt || 0);

  // Upgrades to a higher-priority source always land immediately
  // (Waiting/Errored/toolActive preempt assistant/station/empty).
  if (newPri > prevPri) {
    agent.bubble = { text: candidate.text, source: candidate.source, key: candidate.key, changedAt: now };
    return candidate.text;
  }

  // Downgrades (higher → lower priority) must wait out the dwell
  // window. During that window, keep showing the previous text so a
  // brief Working→Idle flicker doesn't steal the tool line.
  if (newPri < prevPri && age < BUBBLE_MIN_DWELL_MS) {
    return prev.text;
  }

  // Same priority — allow the swap only if the content key actually
  // changed (real new message) OR dwell window elapsed. Either way,
  // the new text becomes current.
  if (newPri === prevPri && prev.key === candidate.key) {
    return prev.text;
  }

  agent.bubble = { text: candidate.text, source: candidate.source, key: candidate.key, changedAt: now };
  return candidate.text;
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
// `agent` is the mutable worldState agent record — we persist
// `leisureAnchorAt` on it so rotation survives across ticks.
function destinationForSession(session, assignment, queuePosition, now, agent = null) {
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
    default: {
      // Tent sessions (no assignment.locationId) fall through to the
      // client's wander autonomy — no known building to orbit.
      if (!assignment || !assignment.locationId) return null;

      // Building-local at_leisure rotation. Per-session dephased 90s
      // slot; pool composed of indoor rest, indoor work (desk), two
      // nearest outdoor stations, and plaza.
      const pool = buildLeisurePool(assignment.locationId);
      if (pool.length === 0) {
        // No pool (shouldn't happen if assignment.locationId is valid)
        // — fall back to anchoring at the desk.
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

      // Initialise leisureAnchorAt on first Idle observation. Leave it
      // alone on brief Idle↔Working flickers so the slot isn't reset
      // every time an assistant message lands. The anchor is cleared
      // upstream in applySnapshotToWorld when sustained Working is
      // detected.
      if (agent && !agent.leisureAnchorAt) {
        agent.leisureAnchorAt = now;
      }

      const slot = leisureSlotIndex(session.sessionId, agent?.leisureAnchorAt || now, now);
      const pick = pickLeisureStation(pool, session.sessionId, slot) || pool[0];

      return {
        x: pick.x, y: pick.y,
        stationId: pick.stationId,
        locationId: pick.locationId,
        locationName: pick.locationName || label,
        stationLabel: pick.stationLabel || '',
        stationKind: pick.stationKind || 'rest',
        stationActivity: pick.stationActivity || null,
        intent: { kind: INTENT.AtLeisure }
      };
    }
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
    if (session.cost && typeof session.cost === 'object') {
      // Strip to the shape the frontend needs — avoids leaking internal
      // field renames into the broadcast schema.
      agent.cost = {
        usd: Number(session.cost.usd || 0),
        input: session.cost.input || 0,
        output: session.cost.output || 0,
        cacheWrite: session.cost.cacheWrite || 0,
        cacheRead: session.cost.cacheRead || 0,
        messageCount: session.cost.messageCount || 0,
        model: session.cost.model || agent.model || null
      };
    }

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

    // Spawn at the assigned desk when we have one — otherwise fall
    // back to the hash-based location pool in deriveInitialAvatarPosition.
    // Only takes effect on FIRST appearance; existing avatars keep
    // whatever runtime-authoritative position they had.
    const preferred = assignment && Number.isFinite(assignment.x) && Number.isFinite(assignment.y)
      ? { x: assignment.x, y: assignment.y }
      : null;
    const avatar = ensureAvatar(worldState, session.sessionId, { preferredPosition: preferred });
    avatar.displayName = agent.name;
    avatar.state = agent.activity === 'working' ? 'working' : 'idle';
    avatar.moving = true;
    avatar.hatHue = hatHueFromBranch(agent.gitBranch);
    // Also expose the raw branch on the avatar so client-side code
    // (courier pulse peer matching, reaction repo scoping) doesn't
    // have to reach into state.agents by id. The adapter is the only
    // writer; runtime mirrors it on sync.
    avatar.gitBranch = agent.gitBranch || null;
    avatar.status = session.status;
    avatar.toolIcon = agent.tool?.icon || null;
    avatar.model = agent.model;
    avatar.buildingLabel = assignment?.label || agent.name;
    avatar.buildingKey = session.buildingKey;
    avatar.pid = session.pid;

    // Leisure anchor lifecycle — clear only after sustained Working
    // (>60s continuous) or building change, never on brief Idle↔Working
    // flickers. An Idle→Working transition records lastWorkingAt;
    // when that age exceeds LEISURE_CLEAR_AFTER_WORK_MS the agent
    // is considered "back at work for real" and the anchor resets
    // so the next Idle spell starts a fresh rotation.
    if (session.status === STATUSES.Working) {
      if (!agent.firstWorkingAt) agent.firstWorkingAt = now;
      agent.lastWorkingAt = now;
      if (now - agent.firstWorkingAt > LEISURE_CLEAR_AFTER_WORK_MS) {
        agent.leisureAnchorAt = null;
      }
    } else {
      // Any non-Working status resets the "sustained working" streak.
      agent.firstWorkingAt = null;
    }

    const queuePos = queueIndex.has(session.sessionId) ? queueIndex.get(session.sessionId) : -1;
    const destination = destinationForSession(session, assignment, queuePos, now, agent);
    avatar.destination = destination;
    avatar.intent = destination?.intent || null;

    // Compute a (source, text, contentKey) tuple describing the best
    // bubble for this tick. The stabilizer below decides whether to
    // actually flip the displayed text based on priority + dwell time.
    const candidate = pickBubbleCandidate({
      status: session.status,
      tool: agent.tool,
      lastAssistantSnippet: agent.lastAssistantSnippet,
      lastAssistantTs: session.lastAssistantTs,
      destination
    });
    avatar.bubbleText = stabilizeBubble(agent, candidate, now);

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
