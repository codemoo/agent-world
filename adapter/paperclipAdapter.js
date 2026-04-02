const VALID_EVENT_TYPES = new Set([
  'task_created',
  'task_assigned',
  'tool_called',
  'task_completed',
  'run_started',
  'run_completed'
]);

const TASK_REQUIRED_EVENT_TYPES = new Set([
  'task_created',
  'task_assigned',
  'tool_called',
  'task_completed'
]);

const RUN_REQUIRED_EVENT_TYPES = new Set(['run_started', 'run_completed']);

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

function ensureWorldState(worldState) {
  ensureRecord(worldState, 'worldState');
  worldState.agents = isRecord(worldState.agents) ? worldState.agents : {};
  worldState.zones = isRecord(worldState.zones) ? worldState.zones : {};
  worldState.runs = isRecord(worldState.runs) ? worldState.runs : {};
}

function ensureAgent(worldState, agentId) {
  if (!worldState.agents[agentId]) {
    worldState.agents[agentId] = {
      id: agentId,
      zone: 'idle',
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
      break;
    }
    case 'task_assigned': {
      const task = upsertTask(agent, event.taskId);
      task.status = 'assigned';
      task.updatedAt = event.timestamp;
      addUnique(run?.taskIds || [], event.taskId);
      agent.zone = 'planning';
      break;
    }
    case 'tool_called': {
      const task = upsertTask(agent, event.taskId);
      task.status = task.status === 'completed' ? 'completed' : 'in_progress';
      task.updatedAt = event.timestamp;
      addUnique(run?.taskIds || [], event.taskId);
      agent.lastTool =
        pickString(event.payload, ['tool_name', 'toolName', 'name']) || null;
      agent.zone = 'tools';
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

  return event;
}

function handlePaperclipEvent(rawEvent, worldState) {
  const normalizedEvent = normalizePaperclipEvent(rawEvent);
  validatePaperclipEvent(normalizedEvent);
  return applyPaperclipEvent(normalizedEvent, worldState);
}

module.exports = {
  VALID_EVENT_TYPES,
  normalizePaperclipEvent,
  validatePaperclipEvent,
  applyPaperclipEvent,
  handlePaperclipEvent
};
