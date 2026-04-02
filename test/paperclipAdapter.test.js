const test = require('node:test');
const assert = require('node:assert/strict');

const {
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
