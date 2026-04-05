const test = require('node:test');
const assert = require('node:assert/strict');

const {
  WORLD_WIDTH,
  WORLD_HEIGHT,
  normalizePaperclipEvent,
  validatePaperclipEvent,
  handlePaperclipEvent
} = require('../adapter/paperclipAdapter');

function createWorldState() {
  return {
    agents: {},
    zones: {},
    runs: {}
  };
}

test('camelCase 입력 이벤트를 표준 스키마로 정규화한다', () => {
  const normalized = normalizePaperclipEvent({
    eventType: 'task_created',
    agentId: 'agent-1',
    taskId: 'task-1',
    runId: 'run-1',
    timestamp: '2026-04-02T00:00:00.000Z',
    payload: { label: 'API 정리' }
  });

  assert.equal(normalized.eventType, 'task_created');
  assert.equal(normalized.agentId, 'agent-1');
  assert.equal(normalized.taskId, 'task-1');
  assert.equal(normalized.runId, 'run-1');
  assert.equal(normalized.payload.label, 'API 정리');
});

test('task lifecycle 시나리오(생성->할당->도구호출->완료->run 완료)를 반영한다', () => {
  const worldState = createWorldState();
  const events = [
    {
      event_type: 'task_created',
      agent_id: 'agent-1',
      task_id: 'task-1',
      run_id: 'run-1',
      timestamp: '2026-04-02T00:00:00.000Z',
      payload: { label: '이슈 처리' }
    },
    {
      eventType: 'task_assigned',
      agentId: 'agent-1',
      taskId: 'task-1',
      runId: 'run-1',
      timestamp: '2026-04-02T00:01:00.000Z'
    },
    {
      event_type: 'tool_called',
      agent_id: 'agent-1',
      task_id: 'task-1',
      run_id: 'run-1',
      timestamp: '2026-04-02T00:02:00.000Z',
      payload: { tool_name: 'exec_command' }
    },
    {
      event_type: 'task_completed',
      agent_id: 'agent-1',
      task_id: 'task-1',
      run_id: 'run-1',
      timestamp: '2026-04-02T00:03:00.000Z'
    },
    {
      event_type: 'run_completed',
      agent_id: 'agent-1',
      run_id: 'run-1',
      timestamp: '2026-04-02T00:04:00.000Z'
    }
  ];

  events.forEach(event => handlePaperclipEvent(event, worldState));

  const agent = worldState.agents['agent-1'];
  assert.equal(agent.zone, 'idle');
  assert.equal(agent.lastTool, 'exec_command');
  assert.equal(agent.tasks.length, 1);
  assert.equal(agent.tasks[0].status, 'completed');
  assert.equal(agent.tasks[0].label, '이슈 처리');

  const run = worldState.runs['run-1'];
  assert.equal(run.status, 'completed');
  assert.deepEqual(run.taskIds, ['task-1']);

  assert.equal(worldState.world.width, WORLD_WIDTH);
  assert.equal(worldState.world.height, WORLD_HEIGHT);
  assert.equal(worldState.world.tiles.length, WORLD_HEIGHT);
  assert.equal(worldState.world.tiles[0].length, WORLD_WIDTH);

  const avatar = worldState.avatars['agent-1'];
  assert.equal(Boolean(avatar), true);
  assert.equal(avatar.agentId, 'agent-1');
  assert.equal(avatar.state, 'idle');
  assert.equal(avatar.moving, true);
  // Idle agents now show destination text (Generative Agents behavior)
  assert.equal(typeof avatar.bubbleText, 'string');
});

test('작업 시작 시 아바타가 working 상태로 전환되고 말풍선을 표시한다', () => {
  const worldState = createWorldState();
  const created = {
    event_type: 'task_created',
    agent_id: 'agent-bubble',
    task_id: 'task-bubble',
    timestamp: '2026-04-02T00:10:00.000Z',
    payload: { label: '회귀 테스트 작성' }
  };
  handlePaperclipEvent(created, worldState);

  const avatar = worldState.avatars['agent-bubble'];
  assert.equal(avatar.state, 'working');
  // moving=true so the client-side runtime can route this agent to a
  // work station. The runtime will linger at the station between picks.
  assert.equal(avatar.moving, true);
  assert.equal(avatar.currentTaskId, 'task-bubble');
  assert.equal(avatar.bubbleText, '회귀 테스트 작성');

  const completed = {
    event_type: 'task_completed',
    agent_id: 'agent-bubble',
    task_id: 'task-bubble',
    timestamp: '2026-04-02T00:11:00.000Z'
  };
  handlePaperclipEvent(completed, worldState);

  assert.equal(avatar.state, 'idle');
  assert.equal(avatar.moving, true);
  // Idle agents now get destination text (Generative Agents behavior)
  assert.equal(typeof avatar.bubbleText, 'string');
});

test('task_paused(blocked) 이벤트는 작업 상태를 비활성으로 전환한다', () => {
  const worldState = createWorldState();

  handlePaperclipEvent(
    {
      event_type: 'task_assigned',
      agent_id: 'agent-blocked',
      task_id: 'task-blocked',
      timestamp: '2026-04-02T00:20:00.000Z',
      payload: { label: '승인 대기 이슈' }
    },
    worldState
  );

  handlePaperclipEvent(
    {
      event_type: 'task_paused',
      agent_id: 'agent-blocked',
      task_id: 'task-blocked',
      timestamp: '2026-04-02T00:21:00.000Z',
      payload: { issue_status: 'blocked' }
    },
    worldState
  );

  const agent = worldState.agents['agent-blocked'];
  const task = agent.tasks.find(item => item.id === 'task-blocked');
  const avatar = worldState.avatars['agent-blocked'];

  assert.equal(task.status, 'blocked');
  assert.equal(agent.activity, 'idle');
  assert.equal(agent.zone, 'blocked');
  assert.equal(avatar.state, 'idle');
  assert.equal(avatar.moving, true);
  // Idle agents now get destination text (Generative Agents behavior)
  assert.equal(typeof avatar.bubbleText, 'string');
});

test('applyPaperclipEvent: 이전 타임스탬프의 이벤트는 무시한다', () => {
  const worldState = createWorldState();
  
  // 1. 최신 이벤트 먼저 처리 (12:00)
  handlePaperclipEvent({
    event_type: 'task_created',
    agent_id: 'agent-ts',
    task_id: 'task-ts',
    timestamp: '2026-04-05T12:00:00.000Z',
    payload: { label: 'Latest' }
  }, worldState);

  const agent = worldState.agents['agent-ts'];
  assert.equal(agent.tasks[0].label, 'Latest');
  assert.equal(agent.lastEventAt, '2026-04-05T12:00:00.000Z');

  // 2. 과거 이벤트 처리 (11:59) - 무시되어야 함
  handlePaperclipEvent({
    event_type: 'task_created',
    agent_id: 'agent-ts',
    task_id: 'task-ts',
    timestamp: '2026-04-05T11:59:00.000Z',
    payload: { label: 'Old' }
  }, worldState);

  assert.equal(agent.tasks[0].label, 'Latest');
  assert.equal(agent.lastEventAt, '2026-04-05T12:00:00.000Z');
});

test('task event에 task_id가 없으면 검증 에러를 낸다', () => {
  const normalized = normalizePaperclipEvent({
    event_type: 'task_completed',
    agent_id: 'agent-1'
  });

  assert.throws(
    () => validatePaperclipEvent(normalized),
    /task_id is required for event_type=task_completed/
  );
});

test('run event에 run_id가 없으면 검증 에러를 낸다', () => {
  const normalized = normalizePaperclipEvent({
    event_type: 'run_started',
    agent_id: 'agent-1'
  });

  assert.throws(
    () => validatePaperclipEvent(normalized),
    /run_id is required for event_type=run_started/
  );
});
