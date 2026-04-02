const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getJson,
  postJson,
  startTestServer,
  stopTestServer
} = require('./helpers/testServer');
const { processIncomingEvents } = require('../server/eventsPipeline');
const { applyPaperclipEvent } = require('../adapter/paperclipAdapter');

let runtime;

test.before(async () => {
  runtime = await startTestServer();
});

test.after(async () => {
  await stopTestServer(runtime);
});

test('API 통합 흐름: /events 반영 후 /state에서 런/태스크 상태를 확인한다', async () => {
  const events = [
    {
      event_type: 'run_started',
      agent_id: 'agent-int',
      run_id: 'run-int-1',
      timestamp: '2026-04-02T01:00:00.000Z'
    },
    {
      event_type: 'task_created',
      agent_id: 'agent-int',
      task_id: 'task-int-1',
      run_id: 'run-int-1',
      timestamp: '2026-04-02T01:01:00.000Z',
      payload: { label: 'quality gate' }
    },
    {
      event_type: 'tool_called',
      agent_id: 'agent-int',
      task_id: 'task-int-1',
      run_id: 'run-int-1',
      timestamp: '2026-04-02T01:02:00.000Z',
      payload: { tool_name: 'exec_command' }
    },
    {
      event_type: 'task_completed',
      agent_id: 'agent-int',
      task_id: 'task-int-1',
      run_id: 'run-int-1',
      timestamp: '2026-04-02T01:03:00.000Z'
    },
    {
      event_type: 'run_completed',
      agent_id: 'agent-int',
      run_id: 'run-int-1',
      timestamp: '2026-04-02T01:04:00.000Z'
    }
  ];

  const postResult = await postJson(runtime.baseUrl, '/events', events);
  assert.equal(postResult.response.status, 200);
  assert.equal(postResult.json.processed, 5);

  const stateResult = await getJson(runtime.baseUrl, '/state');
  assert.equal(stateResult.response.status, 200);
  const agent = stateResult.json.data.agents['agent-int'];
  const run = stateResult.json.data.runs['run-int-1'];

  assert.equal(agent.zone, 'idle');
  assert.equal(agent.lastTool, 'exec_command');
  assert.equal(agent.tasks.length, 1);
  assert.equal(agent.tasks[0].status, 'completed');
  assert.equal(agent.tasks[0].label, 'quality gate');
  assert.equal(run.status, 'completed');
  assert.deepEqual(run.taskIds, ['task-int-1']);
});

test('API 통합: 배치 실패 시 world state가 변경되지 않는다(원자성)', async () => {
  const seedResult = await postJson(runtime.baseUrl, '/events', {
    event_type: 'run_started',
    agent_id: 'agent-atomic',
    run_id: 'run-atomic-1',
    timestamp: '2026-04-02T08:00:00.000Z'
  });
  assert.equal(seedResult.response.status, 200);

  const beforeState = await getJson(runtime.baseUrl, '/state');
  const baseline = JSON.parse(JSON.stringify(beforeState.json.data));

  const failedBatch = await postJson(runtime.baseUrl, '/events', [
    {
      event_type: 'task_created',
      agent_id: 'agent-atomic',
      task_id: 'task-atomic-1',
      run_id: 'run-atomic-1',
      timestamp: '2026-04-02T08:01:00.000Z'
    },
    {
      event_type: 'task_completed',
      agent_id: 'agent-atomic',
      run_id: 'run-atomic-1',
      timestamp: '2026-04-02T08:02:00.000Z'
    }
  ]);

  assert.equal(failedBatch.response.status, 400);
  assert.equal(failedBatch.json.error, 'One or more events are invalid.');
  assert.match(
    failedBatch.json.details[0].error,
    /task_id is required for event_type=task_completed/
  );

  const afterState = await getJson(runtime.baseUrl, '/state');
  assert.deepEqual(afterState.json.data, baseline);
});

test('API 통합: apply 단계 예외가 발생해도 world state는 롤백된다', async () => {
  const rollbackRuntime = await startTestServer({
    processIncomingEvents: (input, worldState) =>
      processIncomingEvents(input, worldState, {
        applyEvent: (event, state) => {
          if (event.eventType === 'task_assigned') {
            throw new Error('Injected apply failure for integration test');
          }
          return applyPaperclipEvent(event, state);
        }
      })
  });

  try {
    const seedResult = await postJson(rollbackRuntime.baseUrl, '/events', {
      event_type: 'run_started',
      agent_id: 'agent-int-rollback',
      run_id: 'run-int-rollback',
      timestamp: '2026-04-02T09:00:00.000Z'
    });
    assert.equal(seedResult.response.status, 200);

    const beforeState = await getJson(rollbackRuntime.baseUrl, '/state');
    const baseline = JSON.parse(JSON.stringify(beforeState.json.data));

    const failedBatch = await postJson(rollbackRuntime.baseUrl, '/events', [
      {
        event_type: 'task_created',
        agent_id: 'agent-int-rollback',
        task_id: 'task-int-rollback-1',
        run_id: 'run-int-rollback',
        timestamp: '2026-04-02T09:01:00.000Z'
      },
      {
        event_type: 'task_assigned',
        agent_id: 'agent-int-rollback',
        task_id: 'task-int-rollback-1',
        run_id: 'run-int-rollback',
        timestamp: '2026-04-02T09:02:00.000Z'
      }
    ]);

    assert.equal(failedBatch.response.status, 500);
    assert.match(
      failedBatch.json.error,
      /Injected apply failure for integration test/
    );

    const afterState = await getJson(rollbackRuntime.baseUrl, '/state');
    assert.deepEqual(afterState.json.data, baseline);
  } finally {
    await stopTestServer(rollbackRuntime);
  }
});
