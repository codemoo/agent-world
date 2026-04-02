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
