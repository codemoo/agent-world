const test = require('node:test');
const assert = require('node:assert/strict');

const {
  openWebSocket,
  postJson,
  startTestServer,
  stopTestServer,
  waitForWebSocketMessage
} = require('./helpers/testServer');

let runtime;

test.before(async () => {
  runtime = await startTestServer();
});

test.after(async () => {
  await stopTestServer(runtime);
});

test('E2E: WebSocket 클라이언트가 /events 반영 결과를 실시간 수신한다', async () => {
  const socket = await openWebSocket(runtime.wsUrl);
  const parsedUrl = new URL(socket.url);
  assert.equal(typeof parsedUrl.searchParams.get('ticket'), 'string');
  assert.equal(parsedUrl.searchParams.get('ticket').length > 0, true);
  assert.equal(parsedUrl.searchParams.get('token'), null);

  try {
    const pushedStatePromise = waitForWebSocketMessage(
      socket,
      3000,
      message => Boolean(message?.data?.agents?.['agent-ws'])
    );

    const postResult = await postJson(runtime.baseUrl, '/events', {
      event_type: 'task_created',
      agent_id: 'agent-ws',
      task_id: 'task-ws-1',
      payload: { label: 'ws-check' }
    });
    assert.equal(postResult.response.status, 200);

    const pushedState = await pushedStatePromise;
    assert.equal(pushedState.type, 'state');
    assert.equal(
      pushedState.data.agents['agent-ws'].tasks[0].id,
      'task-ws-1'
    );
    assert.equal(
      pushedState.data.agents['agent-ws'].tasks[0].label,
      'ws-check'
    );
  } finally {
    socket.close();
  }
});

test('E2E: WebSocket은 인증 토큰 없이 연결할 수 없다', async () => {
  await assert.rejects(
    () => openWebSocket(runtime.wsUrl, { auth: false }),
    /401|Unauthorized|Unexpected server response/
  );
});

test('E2E: WebSocket은 허용되지 않은 Origin이면 403으로 거부한다', async () => {
  const ticketResult = await postJson(runtime.baseUrl, '/auth/ws-ticket', {});
  assert.equal(ticketResult.response.status, 201);
  const ticket = ticketResult.json.ticket;
  assert.equal(typeof ticket, 'string');

  await assert.rejects(
    () =>
      openWebSocket(runtime.wsUrl, {
        ticket,
        headers: { Origin: 'https://evil.example' },
        auth: false
      }),
    /403|Forbidden|Unexpected server response/
  );
});
