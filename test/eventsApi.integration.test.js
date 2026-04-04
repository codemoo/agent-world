const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getJson,
  issueWsTicket,
  openWebSocket,
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
  const avatar = stateResult.json.data.avatars['agent-int'];

  assert.equal(agent.zone, 'idle');
  assert.equal(agent.lastTool, 'exec_command');
  assert.equal(agent.tasks.length, 1);
  assert.equal(agent.tasks[0].status, 'completed');
  assert.equal(agent.tasks[0].label, 'quality gate');
  assert.equal(run.status, 'completed');
  assert.deepEqual(run.taskIds, ['task-int-1']);
  assert.equal(stateResult.json.data.world.width, 25);
  assert.equal(stateResult.json.data.world.height, 25);
  assert.equal(stateResult.json.data.world.tiles.length, 25);
  assert.equal(avatar.state, 'idle');
  assert.equal(avatar.moving, true);
});

test('API 통합: task_paused(blocked) 이벤트는 작업/아바타를 idle로 전환한다', async () => {
  const events = [
    {
      event_type: 'task_assigned',
      agent_id: 'agent-paused',
      task_id: 'task-paused-1',
      run_id: 'run-paused-1',
      timestamp: '2026-04-02T02:00:00.000Z',
      payload: { label: '승인 대기' }
    },
    {
      event_type: 'task_paused',
      agent_id: 'agent-paused',
      task_id: 'task-paused-1',
      run_id: 'run-paused-1',
      timestamp: '2026-04-02T02:01:00.000Z',
      payload: { issue_status: 'blocked' }
    }
  ];

  const postResult = await postJson(runtime.baseUrl, '/events', events);
  assert.equal(postResult.response.status, 200);
  assert.equal(postResult.json.processed, 2);

  const stateResult = await getJson(runtime.baseUrl, '/state');
  const agent = stateResult.json.data.agents['agent-paused'];
  const avatar = stateResult.json.data.avatars['agent-paused'];

  assert.equal(agent.tasks[0].status, 'blocked');
  assert.equal(agent.zone, 'blocked');
  assert.equal(agent.activity, 'idle');
  assert.equal(avatar.state, 'idle');
  assert.equal(avatar.moving, true);
  assert.equal(avatar.bubbleText, '');
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

test('API 통합: 상태 저장소 상한을 초과하면 429로 거부하고 롤백한다', async () => {
  const cappedRuntime = await startTestServer({
    security: {
      maxStateAgents: 1,
      maxStateRuns: 10,
      maxStateTasks: 10
    }
  });

  try {
    const beforeState = await getJson(cappedRuntime.baseUrl, '/state');
    const baseline = JSON.parse(JSON.stringify(beforeState.json.data));

    const failedBatch = await postJson(cappedRuntime.baseUrl, '/events', [
      {
        event_type: 'run_started',
        agent_id: 'agent-cap-1',
        run_id: 'run-cap-1'
      },
      {
        event_type: 'run_started',
        agent_id: 'agent-cap-2',
        run_id: 'run-cap-2'
      }
    ]);

    assert.equal(failedBatch.response.status, 429);
    assert.equal(
      failedBatch.json.error,
      'World state capacity exceeded. Incoming events were rejected.'
    );
    assert.equal(failedBatch.json.details[0].code, 'STATE_AGENTS_LIMIT_EXCEEDED');

    const afterState = await getJson(cappedRuntime.baseUrl, '/state');
    assert.deepEqual(afterState.json.data, baseline);
  } finally {
    await stopTestServer(cappedRuntime);
  }
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
    assert.equal(failedBatch.json.error, 'Internal server error.');

    const afterState = await getJson(rollbackRuntime.baseUrl, '/state');
    assert.deepEqual(afterState.json.data, baseline);
  } finally {
    await stopTestServer(rollbackRuntime);
  }
});

test('API 통합: WS 티켓은 1회성으로만 사용 가능하다', async () => {
  const ticketResult = await issueWsTicket(runtime.baseUrl);
  assert.equal(ticketResult.response.status, 201);
  const ticket = ticketResult.json.ticket;
  assert.equal(typeof ticket, 'string');
  assert.equal(ticket.length > 0, true);

  const socket = await openWebSocket(runtime.wsUrl, { ticket, auth: false });
  socket.close();

  await assert.rejects(
    () => openWebSocket(runtime.wsUrl, { ticket, auth: false }),
    /401|403|Unauthorized|Forbidden|Unexpected server response/
  );
});

test('API 통합: 만료된 WS 티켓은 연결이 거부된다', async () => {
  const shortTtlRuntime = await startTestServer({
    security: {
      wsTicketTtlMs: 5
    }
  });

  try {
    const ticketResult = await issueWsTicket(shortTtlRuntime.baseUrl);
    assert.equal(ticketResult.response.status, 201);
    const ticket = ticketResult.json.ticket;

    await new Promise(resolve => setTimeout(resolve, 20));

    await assert.rejects(
      () => openWebSocket(shortTtlRuntime.wsUrl, { ticket, auth: false }),
      /401|403|Unauthorized|Forbidden|Unexpected server response/
    );
  } finally {
    await stopTestServer(shortTtlRuntime);
  }
});

test('API 통합: CORS allowlist는 허용/비허용 Origin을 분기한다', async () => {
  const corsRuntime = await startTestServer({
    security: {
      corsAllowedOrigins: ['https://allowed.example']
    }
  });

  try {
    const allowedResponse = await fetch(`${corsRuntime.baseUrl}/auth/ws-ticket`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${corsRuntime.authToken}`,
        'content-type': 'application/json',
        origin: 'https://allowed.example'
      },
      body: '{}'
    });
    const allowedJson = await allowedResponse.json();
    assert.equal(allowedResponse.status, 201);
    assert.equal(allowedJson.status, 'ok');
    assert.equal(
      allowedResponse.headers.get('access-control-allow-origin'),
      'https://allowed.example'
    );

    const deniedResponse = await fetch(`${corsRuntime.baseUrl}/auth/ws-ticket`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${corsRuntime.authToken}`,
        'content-type': 'application/json',
        origin: 'https://denied.example'
      },
      body: '{}'
    });
    const deniedJson = await deniedResponse.json();
    assert.equal(deniedResponse.status, 403);
    assert.equal(deniedJson.error, 'Forbidden.');
    assert.equal(deniedJson.details[0].code, 'CORS_ORIGIN_FORBIDDEN');
  } finally {
    await stopTestServer(corsRuntime);
  }
});
