const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getJson,
  postJson,
  startTestServer,
  stopTestServer
} = require('./helpers/testServer');

let runtime;

test.before(async () => {
  runtime = await startTestServer();
});

test.after(async () => {
  await stopTestServer(runtime);
});

test('/events 성공 응답은 고정 계약(status/processed/events)을 따른다', async () => {
  const payload = {
    event_type: 'run_started',
    agent_id: 'agent-request-success',
    run_id: 'run-request-success',
    timestamp: '2026-04-02T07:20:00.000Z'
  };
  const { response, json } = await postJson(runtime.baseUrl, '/events', payload);

  assert.equal(response.status, 200);
  assert.equal(json.status, 'ok');
  assert.equal(json.processed, 1);
  assert.equal(Array.isArray(json.events), true);
  assert.equal(json.events.length, 1);
  assert.deepEqual(json.events[0], {
    eventType: 'run_started',
    agentId: 'agent-request-success',
    taskId: null,
    runId: 'run-request-success',
    timestamp: '2026-04-02T07:20:00.000Z'
  });
});

test('요청 바디가 빈 배열이면 400으로 거부한다', async () => {
  const { response, json } = await postJson(runtime.baseUrl, '/events', []);

  assert.equal(response.status, 400);
  assert.equal(json.error, 'Event array must not be empty.');
  assert.equal(json.details[0].index, 0);
});

test('run_started/run_completed에서 run_id 누락 시 400으로 거부한다', async () => {
  for (const eventType of ['run_started', 'run_completed']) {
    const { response, json } = await postJson(runtime.baseUrl, '/events', {
      event_type: eventType,
      agent_id: 'agent-request-missing-run'
    });

    assert.equal(response.status, 400);
    assert.equal(json.error, 'One or more events are invalid.');
    assert.equal(json.details[0].index, 0);
    assert.match(
      json.details[0].error,
      new RegExp(`run_id is required for event_type=${eventType}`)
    );
  }
});

test('배치 요청 중 1개라도 실패하면 전체를 거부한다', async () => {
  const { response, json } = await postJson(runtime.baseUrl, '/events', [
    {
      event_type: 'task_created',
      agent_id: 'agent-request',
      task_id: 'task-request'
    },
    {
      event_type: 'task_completed',
      agent_id: 'agent-request'
    }
  ]);

  assert.equal(response.status, 400);
  assert.equal(json.error, 'One or more events are invalid.');
  assert.equal(json.details[0].index, 1);
  assert.match(
    json.details[0].error,
    /task_id is required for event_type=task_completed/
  );

  const stateResult = await getJson(runtime.baseUrl, '/state');
  assert.equal(stateResult.json.data.agents['agent-request'], undefined);
});

test('잘못된 JSON body는 { error, details } 포맷으로 반환한다', async () => {
  const response = await fetch(`${runtime.baseUrl}/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"event_type":"run_started"'
  });
  const json = await response.json();

  assert.equal(response.status, 400);
  assert.equal(json.error, 'Malformed JSON body.');
  assert.equal(Array.isArray(json.details), true);
  assert.equal(json.details[0].code, 'MALFORMED_JSON');
  assert.equal(json.details[0].error, 'Malformed JSON body.');
});
