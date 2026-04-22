// Archived Paperclip-specific event adapter.
// World geometry lives in adapter/worldModel.js — this file now only holds
// Paperclip event pipeline (task/run/tool semantics). See ./README.md for
// restore instructions.

const {
  WORLD_WIDTH,
  WORLD_HEIGHT,
  DEFAULT_TILE_TYPE,
  LOCATION_DEFS,
  OUTDOOR_STATIONS,
  SUB_LOCATIONS,
  ACTIVITY_TEMPLATES,
  isRecord,
  ensureRecord,
  pickString,
  addUnique,
  hashString,
  createVillageGrid,
  createWorldModel,
  normalizeWorldModel,
  ensureWorldState,
  ensureAvatar,
  findLocationForPosition
} = require('../../adapter/worldModel');

const VALID_EVENT_TYPES = new Set([
  'task_created',
  'task_assigned',
  'task_paused',
  'tool_called',
  'task_completed',
  'run_started',
  'run_completed'
]);

const TASK_REQUIRED_EVENT_TYPES = new Set([
  'task_created',
  'task_assigned',
  'task_paused',
  'tool_called',
  'task_completed'
]);

const RUN_REQUIRED_EVENT_TYPES = new Set(['run_started', 'run_completed']);
const WORKING_TASK_STATUSES = new Set(['created', 'assigned', 'in_progress']);

function normalizePaperclipEvent(rawEvent) {
  ensureRecord(rawEvent, 'event');

  const payload = isRecord(rawEvent.payload) ? rawEvent.payload : {};
  const eventType = pickString(rawEvent, ['event_type', 'eventType', 'type']);
  const agentId =
    pickString(rawEvent, ['agent_id', 'agentId']) ||
    pickString(payload, ['agent_id', 'agentId']);
  const taskId =
    pickString(rawEvent, ['task_id', 'taskId']) ||
    pickString(payload, ['task_id', 'taskId']);
  const runId =
    pickString(rawEvent, ['run_id', 'runId']) ||
    pickString(payload, ['run_id', 'runId']);
  const timestamp =
    pickString(rawEvent, ['timestamp', 'occurred_at', 'occurredAt']) ||
    new Date().toISOString();

  return { eventType, agentId, taskId, runId, timestamp, payload };
}

function validatePaperclipEvent(event) {
  ensureRecord(event, 'normalized event');

  if (!event.eventType) {
    throw new Error('event_type is required.');
  }

  if (!VALID_EVENT_TYPES.has(event.eventType)) {
    throw new Error(`Unsupported event_type: ${event.eventType}`);
  }

  if (!event.agentId) {
    throw new Error('agent_id is required.');
  }

  if (TASK_REQUIRED_EVENT_TYPES.has(event.eventType) && !event.taskId) {
    throw new Error(`task_id is required for event_type=${event.eventType}`);
  }

  if (RUN_REQUIRED_EVENT_TYPES.has(event.eventType) && !event.runId) {
    throw new Error(`run_id is required for event_type=${event.eventType}`);
  }
}

function ensureAgent(worldState, agentId) {
  if (!worldState.agents[agentId]) {
    worldState.agents[agentId] = {
      id: agentId,
      name: null,
      zone: 'idle',
      activity: 'idle',
      tasks: [],
      currentRunId: null,
      lastTool: null,
      lastEventAt: null
    };
  }
  return worldState.agents[agentId];
}

function ensureRun(worldState, runId) {
  if (!runId) return null;
  if (!worldState.runs[runId]) {
    worldState.runs[runId] = {
      id: runId,
      status: 'running',
      agentIds: [],
      taskIds: [],
      startedAt: null,
      completedAt: null,
      updatedAt: null
    };
  }
  return worldState.runs[runId];
}

function upsertTask(agent, taskId) {
  let task = agent.tasks.find(item => item.id === taskId);
  if (!task) {
    task = { id: taskId, status: 'created', label: '', updatedAt: null };
    agent.tasks.push(task);
  }
  return task;
}

function getActiveTask(agent) {
  const candidates = agent.tasks.filter(task =>
    WORKING_TASK_STATUSES.has(task.status)
  );

  if (candidates.length === 0) return null;

  candidates.sort((left, right) => {
    const leftTime = left.updatedAt || '';
    const rightTime = right.updatedAt || '';
    return rightTime.localeCompare(leftTime);
  });

  return candidates[0];
}

function pickActivityText(agent, locationId) {
  const seed = hashString(agent.id + (agent.lastEventAt || ''));
  const isWorking = agent.activity === 'working';

  if (isWorking) {
    const activeTask = getActiveTask(agent);
    if (activeTask && activeTask.label) return activeTask.label;
    const pool = ACTIVITY_TEMPLATES.working;
    return pool[seed % pool.length];
  }

  const locKey = locationId ? `at_${locationId.split('_')[0]}` : null;
  const pool = (locKey && ACTIVITY_TEMPLATES[locKey]) || ACTIVITY_TEMPLATES.idle;
  return pool[seed % pool.length];
}

function pickDestination(agent, currentLocationId, world) {
  const locations = world.locations || LOCATION_DEFS;
  if (!locations || locations.length === 0) return null;

  const seed = hashString(agent.id + (agent.lastEventAt || '') + 'dest');
  const candidates = locations.filter(loc => loc.id !== currentLocationId);
  if (candidates.length === 0) return locations[0];
  return candidates[seed % candidates.length];
}

function syncAvatarFromAgent(worldState, agent, timestamp) {
  const avatar = ensureAvatar(worldState, agent.id);
  const activeTask = getActiveTask(agent);

  if (agent.name) avatar.displayName = agent.name;
  avatar.destination = null;

  if (activeTask) {
    avatar.state = 'working';
    avatar.moving = true;
    avatar.currentTaskId = activeTask.id;
    avatar.bubbleText = activeTask.label || '';
  } else {
    avatar.state = 'idle';
    avatar.moving = true;
    avatar.currentTaskId = null;
    avatar.bubbleText = '';
  }

  avatar.lastUpdatedAt = timestamp || new Date().toISOString();
  return avatar;
}

function applyPaperclipEvent(event, worldState) {
  validatePaperclipEvent(event);
  ensureWorldState(worldState);

  const agent = ensureAgent(worldState, event.agentId);

  if (agent.lastEventAt && event.timestamp < agent.lastEventAt) {
    return event;
  }

  const run = ensureRun(worldState, event.runId);

  const agentName = pickString(event.payload, ['agent_name', 'agentName']);
  if (agentName) agent.name = agentName;

  agent.lastEventAt = event.timestamp;
  if (run) {
    addUnique(run.agentIds, event.agentId);
    run.updatedAt = event.timestamp;
    agent.currentRunId = run.id;
  }

  switch (event.eventType) {
    case 'task_created': {
      const task = upsertTask(agent, event.taskId);
      task.status = 'created';
      task.label =
        pickString(event.payload, ['label', 'title', 'name']) || task.label;
      task.updatedAt = event.timestamp;
      addUnique(run?.taskIds || [], event.taskId);
      agent.zone = 'intake';
      agent.activity = 'working';
      break;
    }
    case 'task_assigned': {
      const task = upsertTask(agent, event.taskId);
      task.status = 'assigned';
      task.label =
        pickString(event.payload, ['label', 'title', 'name']) || task.label;
      task.updatedAt = event.timestamp;
      addUnique(run?.taskIds || [], event.taskId);
      agent.zone = 'planning';
      agent.activity = 'working';
      break;
    }
    case 'task_paused': {
      const task = upsertTask(agent, event.taskId);
      if (task.updatedAt && event.timestamp < task.updatedAt) break;
      const issueStatus =
        pickString(event.payload, ['issue_status', 'issueStatus']) || 'paused';
      task.status = issueStatus;
      task.label =
        pickString(event.payload, ['label', 'title', 'name']) || task.label;
      task.updatedAt = event.timestamp;
      addUnique(run?.taskIds || [], event.taskId);
      agent.zone = issueStatus === 'blocked' ? 'blocked' : 'idle';
      agent.activity = 'idle';
      break;
    }
    case 'tool_called': {
      const task = upsertTask(agent, event.taskId);
      task.status = task.status === 'completed' ? 'completed' : 'in_progress';
      task.label =
        pickString(event.payload, ['label', 'title', 'name']) || task.label;
      task.updatedAt = event.timestamp;
      addUnique(run?.taskIds || [], event.taskId);
      agent.lastTool =
        pickString(event.payload, ['tool_name', 'toolName', 'name']) || null;
      agent.zone = 'tools';
      agent.activity = task.status === 'completed' ? 'idle' : 'working';
      break;
    }
    case 'task_completed': {
      const task = upsertTask(agent, event.taskId);
      task.status = 'completed';
      task.updatedAt = event.timestamp;
      addUnique(run?.taskIds || [], event.taskId);
      agent.zone = 'done';
      break;
    }
    case 'run_started': {
      if (run) {
        run.status = 'running';
        run.startedAt = run.startedAt || event.timestamp;
      }
      agent.zone = 'planning';
      break;
    }
    case 'run_completed': {
      if (run) {
        run.status = 'completed';
        run.completedAt = event.timestamp;
      }
      agent.zone = 'idle';
      agent.currentRunId = null;
      break;
    }
    default:
      break;
  }

  agent.activity = getActiveTask(agent) ? 'working' : 'idle';
  syncAvatarFromAgent(worldState, agent, event.timestamp);

  return event;
}

function handlePaperclipEvent(rawEvent, worldState) {
  const normalizedEvent = normalizePaperclipEvent(rawEvent);
  validatePaperclipEvent(normalizedEvent);
  return applyPaperclipEvent(normalizedEvent, worldState);
}

module.exports = {
  // Re-exports from worldModel for backward compatibility.
  // New code should import these from ./worldModel directly.
  WORLD_WIDTH,
  WORLD_HEIGHT,
  DEFAULT_TILE_TYPE,
  LOCATION_DEFS,
  OUTDOOR_STATIONS,
  SUB_LOCATIONS,
  ACTIVITY_TEMPLATES,
  createVillageGrid,
  createWorldModel,
  normalizeWorldModel,
  ensureWorldState,
  ensureAvatar,
  findLocationForPosition,
  hashString,
  // Paperclip-specific.
  VALID_EVENT_TYPES,
  normalizePaperclipEvent,
  validatePaperclipEvent,
  applyPaperclipEvent,
  handlePaperclipEvent
};
