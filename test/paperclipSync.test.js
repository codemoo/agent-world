const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildEventsFromInboxSnapshot,
  createPaperclipPoller,
  mapIssueStatusToEventType,
  normalizeInboxIssue
} = require('../server/paperclipSync');

test('inbox 항목을 정규화할 때 run/agent/task 필드를 추출한다', () => {
  const issue = normalizeInboxIssue({
    id: 'task-1',
    identifier: 'MOO-100',
    status: 'in_progress',
    assigneeAgentId: 'agent-1',
    title: '동기화 테스트',
    activeRun: { id: 'run-1' },
    updatedAt: '2026-04-02T11:00:00.000Z'
  });

  assert.equal(issue.id, 'task-1');
  assert.equal(issue.identifier, 'MOO-100');
  assert.equal(issue.agentId, 'agent-1');
  assert.equal(issue.runId, 'run-1');
  assert.equal(issue.status, 'in_progress');
});

test('inbox 스냅샷을 이벤트 배열로 정규화한다', () => {
  const events = buildEventsFromInboxSnapshot(
    [
      {
        id: 'task-2',
        identifier: 'MOO-101',
        status: 'in_progress',
        assigneeAgentId: 'agent-2',
        title: '리그레션 점검',
        updatedAt: '2026-04-02T11:10:00.000Z'
      },
      {
        id: 'task-3',
        identifier: 'MOO-102',
        status: 'done',
        assigneeAgentId: 'agent-3',
        title: '배포 확인',
        updatedAt: '2026-04-02T11:11:00.000Z'
      },
      {
        id: 'task-4',
        identifier: 'MOO-103',
        status: 'blocked',
        assigneeAgentId: 'agent-4',
        title: '외부 승인 대기',
        updatedAt: '2026-04-02T11:12:00.000Z'
      }
    ],
    '2026-04-02T11:59:00.000Z'
  );

  assert.equal(events.length, 3);
  assert.equal(events[0].event_type, 'tool_called');
  assert.equal(events[0].task_id, 'task-2');
  assert.equal(events[0].payload.issue_identifier, 'MOO-101');
  assert.equal(events[1].event_type, 'task_completed');
  assert.equal(events[1].task_id, 'task-3');
  assert.equal(events[2].event_type, 'task_paused');
  assert.equal(events[2].task_id, 'task-4');
  assert.equal(events[2].payload.issue_status, 'blocked');
});

test('상태별 이벤트 타입 매핑 정책을 고정한다', () => {
  assert.equal(mapIssueStatusToEventType('done'), 'task_completed');
  assert.equal(mapIssueStatusToEventType('cancelled'), 'task_completed');
  assert.equal(mapIssueStatusToEventType('blocked'), 'task_paused');
  assert.equal(mapIssueStatusToEventType('in_progress'), 'tool_called');
  assert.equal(mapIssueStatusToEventType('in_review'), 'tool_called');
  assert.equal(mapIssueStatusToEventType('todo'), 'task_assigned');
  assert.equal(mapIssueStatusToEventType('unknown'), null);
});

test('poller.pollNow는 inbox를 가져와 이벤트를 전달한다', async () => {
  const captured = [];
  const poller = createPaperclipPoller({
    apiUrl: 'http://paperclip.local',
    apiKey: 'token',
    endpointPath: '/api/agents/me/inbox-lite',
    fetchImpl: async url => {
      assert.equal(url, 'http://paperclip.local/api/agents/me/inbox-lite');
      return {
        ok: true,
        status: 200,
        json: async () => [
          {
            id: 'task-4',
            identifier: 'MOO-103',
            status: 'todo',
            assigneeAgentId: 'agent-4',
            title: '동기화 경로 테스트',
            updatedAt: '2026-04-02T11:20:00.000Z'
          }
        ]
      };
    },
    onEvents: events => {
      captured.push(...events);
    }
  });

  const result = await poller.pollNow();

  assert.equal(result.fetched, 1);
  assert.equal(result.emitted, 1);
  assert.equal(captured.length, 1);
  assert.equal(captured[0].event_type, 'task_assigned');
  assert.equal(captured[0].agent_id, 'agent-4');
});

test('poller.pollNow는 fetch 실패를 예외로 전달한다', async () => {
  const poller = createPaperclipPoller({
    apiUrl: 'http://paperclip.local',
    apiKey: 'token',
    fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({}) })
  });

  await assert.rejects(() => poller.pollNow(), /Paperclip inbox fetch failed: 401/);
});

test('poller.pollNow 동시 호출은 in-flight promise를 재사용한다', async () => {
  let callCount = 0;
  let resolver;
  const fetchGate = new Promise(resolve => {
    resolver = resolve;
  });

  const poller = createPaperclipPoller({
    apiUrl: 'http://paperclip.local',
    apiKey: 'token',
    fetchImpl: async () => {
      callCount += 1;
      await fetchGate;
      return {
        ok: true,
        status: 200,
        json: async () => []
      };
    }
  });

  const first = poller.pollNow();
  const second = poller.pollNow();

  assert.equal(callCount, 1);
  assert.equal(first, second);

  resolver();
  const [left, right] = await Promise.all([first, second]);
  assert.deepEqual(left, { fetched: 0, emitted: 0 });
  assert.deepEqual(right, { fetched: 0, emitted: 0 });
});
