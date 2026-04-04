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

const WORLD_WIDTH = 25;
const WORLD_HEIGHT = 25;
const DEFAULT_TILE_TYPE = 'grass';

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

function ensureRecord(value, fieldName) {
  if (!isRecord(value)) {
    throw new Error(`${fieldName} must be a JSON object.`);
  }
}

function pickString(source, keys) {
  if (!isRecord(source)) {
    return null;
  }

  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }

  return null;
}

function createGrassGrid(width = WORLD_WIDTH, height = WORLD_HEIGHT) {
  return Array.from({ length: height }, (_, y) =>
    Array.from({ length: width }, (_, x) => ({
      x,
      y,
      type: DEFAULT_TILE_TYPE
    }))
  );
}

function createWorldModel() {
  return {
    width: WORLD_WIDTH,
    height: WORLD_HEIGHT,
    defaultTile: DEFAULT_TILE_TYPE,
    tiles: createGrassGrid()
  };
}

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

  return {
    eventType,
    agentId,
    taskId,
    runId,
    timestamp,
    payload
  };
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

function normalizeWorldModel(world) {
  if (!isRecord(world)) {
    return createWorldModel();
  }

  const width = isPositiveInteger(world.width) ? world.width : WORLD_WIDTH;
  const height = isPositiveInteger(world.height) ? world.height : WORLD_HEIGHT;
  const validTiles =
    Array.isArray(world.tiles) &&
    world.tiles.length === height &&
    world.tiles.every(row => Array.isArray(row) && row.length === width);

  return {
    width,
    height,
    defaultTile:
      typeof world.defaultTile === 'string' && world.defaultTile.length > 0
        ? world.defaultTile
        : DEFAULT_TILE_TYPE,
    tiles: validTiles ? world.tiles : createGrassGrid(width, height)
  };
}

function ensureWorldState(worldState) {
  ensureRecord(worldState, 'worldState');
  worldState.agents = isRecord(worldState.agents) ? worldState.agents : {};
  worldState.zones = isRecord(worldState.zones) ? worldState.zones : {};
  worldState.runs = isRecord(worldState.runs) ? worldState.runs : {};
  worldState.world = normalizeWorldModel(worldState.world);
  worldState.avatars = isRecord(worldState.avatars) ? worldState.avatars : {};
}

function ensureAgent(worldState, agentId) {
  if (!worldState.agents[agentId]) {
    worldState.agents[agentId] = {
      id: agentId,
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
  if (!runId) {
    return null;
  }

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

function addUnique(list, value) {
  if (!value) {
    return;
  }

  if (!list.includes(value)) {
    list.push(value);
  }
}

function upsertTask(agent, taskId) {
  let task = agent.tasks.find(item => item.id === taskId);
  if (!task) {
    task = { id: taskId, status: 'created', label: '', updatedAt: null };
    agent.tasks.push(task);
  }

  return task;
}

function hashString(input) {
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash * 31 + input.charCodeAt(i)) >>> 0;
  }
  return hash;
}

function deriveInitialAvatarPosition(agentId, world) {
  const hash = hashString(agentId);
  const area = world.width * world.height;
  const cellIndex = area > 0 ? hash % area : 0;

  return {
    x: cellIndex % world.width,
    y: Math.floor(cellIndex / world.width)
  };
}

function ensureAvatar(worldState, agentId) {
  if (!worldState.avatars[agentId]) {
    const position = deriveInitialAvatarPosition(agentId, worldState.world);
    worldState.avatars[agentId] = {
      id: agentId,
      agentId,
      x: position.x,
      y: position.y,
      moving: true,
      state: 'idle',
      currentTaskId: null,
      bubbleText: '',
      lastUpdatedAt: null
    };
  }

  return worldState.avatars[agentId];
}

function getActiveTask(agent) {
  const candidates = agent.tasks.filter(task =>
    WORKING_TASK_STATUSES.has(task.status)
  );

  if (candidates.length === 0) {
    return null;
  }

  candidates.sort((left, right) => {
    const leftTime = left.updatedAt || '';
    const rightTime = right.updatedAt || '';
    return rightTime.localeCompare(leftTime);
  });

  return candidates[0];
}

function syncAvatarFromAgent(worldState, agent, timestamp) {
  const avatar = ensureAvatar(worldState, agent.id);
  const activeTask = getActiveTask(agent);

  if (activeTask) {
    avatar.state = 'working';
    avatar.moving = false;
    avatar.currentTaskId = activeTask.id;
    avatar.bubbleText = activeTask.label || `Task ${activeTask.id}`;
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
  const run = ensureRun(worldState, event.runId);

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
  VALID_EVENT_TYPES,
  WORLD_WIDTH,
  WORLD_HEIGHT,
  DEFAULT_TILE_TYPE,
  createGrassGrid,
  createWorldModel,
  normalizePaperclipEvent,
  validatePaperclipEvent,
  applyPaperclipEvent,
  handlePaperclipEvent
};
