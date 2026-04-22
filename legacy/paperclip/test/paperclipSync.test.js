const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildEventsFromAgentsList,
  buildEventsFromInboxSnapshot,
  createPaperclipPoller,
  eventFingerprint,
  fetchPaperclipCompanies,
  mapIssueStatusToEventType,
  normalizeInboxIssue
} = require('../paperclipSync');

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

test('buildEventsFromAgentsList는 issue가 없고 idle인 agent에 대해���도 presence 이벤트를 생성한다', () => {
  const events = buildEventsFromAgentsList(
    [
      {
        id: 'agent-idle',
        name: 'Agent Idle',
        status: 'idle',
        updatedAt: '2026-04-02T12:00:00.000Z'
      }
    ],
    []
  );

  assert.equal(events.length, 1);
  assert.equal(events[0].event_type, 'run_started');
  assert.equal(events[0].agent_id, 'agent-idle');
  assert.equal(events[0].payload.agent_status, 'idle');
});

test('buildEventsFromAgentsList는 issue가 없지만 working 상태인 agent에 대해 presence run 이벤트를 생성한다', () => {
  const events = buildEventsFromAgentsList(
    [
      {
        id: 'agent-presence',
        name: 'Agent Presence',
        status: 'working',
        updatedAt: '2026-04-02T12:00:00.000Z'
      }
    ],
    []
  );

  assert.equal(events.length, 1);
  assert.equal(events[0].event_type, 'run_started');
  assert.equal(events[0].agent_id, 'agent-presence');
  assert.equal(events[0].run_id, 'presence-agent-presence');
  assert.equal(events[0].timestamp, '2026-04-02T12:00:00.000Z');
});

test('poller.pollNow는 company sync에서 agents/issues를 병렬 조회해 이벤트를 정규화한다', async () => {
  const calledUrls = [];
  const captured = [];
  const poller = createPaperclipPoller({
    apiUrl: 'http://paperclip.local',
    apiKey: 'token',
    companyId: 'company-1',
    endpointPath: '/api/agents/me/inbox-lite',
    onEvents: events => {
      captured.push(...events);
    },
    fetchImpl: async url => {
      calledUrls.push(url);

      if (url === 'http://paperclip.local/api/companies/company-1/agents') {
        return {
          ok: true,
          status: 200,
          json: async () => [
            {
              id: 'agent-company',
              name: 'Agent Company',
              status: 'working'
            }
          ]
        };
      }

      if (
        url ===
        'http://paperclip.local/api/companies/company-1/issues?status=todo,in_progress,blocked,in_review'
      ) {
        return {
          ok: true,
          status: 200,
          json: async () => [
            {
              id: 'task-company-1',
              identifier: 'MOO-901',
              status: 'blocked',
              assigneeAgentId: 'agent-company',
              title: '회사 동기화 케이스',
              activeRun: { id: 'run-company-1' },
              updatedAt: '2026-04-02T12:10:00.000Z'
            }
          ]
        };
      }

      throw new Error(`Unexpected URL: ${url}`);
    }
  });

  const result = await poller.pollNow();

  assert.equal(calledUrls.length, 2);
  assert.equal(
    calledUrls.includes(
      'http://paperclip.local/api/companies/company-1/agents'
    ),
    true
  );
  assert.equal(
    calledUrls.includes(
      'http://paperclip.local/api/companies/company-1/issues?status=todo,in_progress,blocked,in_review'
    ),
    true
  );
  assert.equal(result.fetched, 2);
  assert.equal(result.emitted, 1);
  assert.equal(captured.length, 1);
  assert.equal(captured[0].event_type, 'task_paused');
  assert.equal(captured[0].agent_id, 'agent-company');
  assert.equal(captured[0].task_id, 'task-company-1');
  assert.equal(captured[0].run_id, 'run-company-1');
});

test('poller.pollNow는 company sync에서 agents 조회 실패를 바로 예외로 전달한다', async () => {
  const poller = createPaperclipPoller({
    apiUrl: 'http://paperclip.local',
    apiKey: 'token',
    companyId: 'company-1',
    fetchImpl: async url => {
      if (url === 'http://paperclip.local/api/companies/company-1/agents') {
        return {
          ok: false,
          status: 503,
          json: async () => ({})
        };
      }

      return {
        ok: true,
        status: 200,
        json: async () => []
      };
    }
  });

  await assert.rejects(
    () => poller.pollNow(),
    /Paperclip agents fetch failed: 503/
  );
});

test('poller.pollNow는 company sync에서 issues 조회 실패를 바로 예외로 전달한다', async () => {
  const poller = createPaperclipPoller({
    apiUrl: 'http://paperclip.local',
    apiKey: 'token',
    companyId: 'company-1',
    fetchImpl: async url => {
      if (
        url ===
        'http://paperclip.local/api/companies/company-1/agents'
      ) {
        return {
          ok: true,
          status: 200,
          json: async () => []
        };
      }

      if (
        url ===
        'http://paperclip.local/api/companies/company-1/issues?status=todo,in_progress,blocked,in_review'
      ) {
        return {
          ok: false,
          status: 502,
          json: async () => ({})
        };
      }

      throw new Error(`Unexpected URL: ${url}`);
    }
  });

  await assert.rejects(
    () => poller.pollNow(),
    /Paperclip issues fetch failed: 502/
  );
});

test('eventFingerprint produces stable keys for deduplication', () => {
  const ev = {
    agent_id: 'a1',
    task_id: 't1',
    event_type: 'tool_called',
    timestamp: '2026-04-02T12:00:00.000Z'
  };
  const fp1 = eventFingerprint(ev);
  const fp2 = eventFingerprint(ev);
  assert.equal(fp1, fp2);

  const different = eventFingerprint({ ...ev, timestamp: '2026-04-02T12:01:00.000Z' });
  assert.notEqual(fp1, different);
});

test('poller deduplicates identical events across consecutive polls', async () => {
  const captured = [];
  const inbox = [
    {
      id: 'task-dup',
      identifier: 'MOO-200',
      status: 'in_progress',
      assigneeAgentId: 'agent-dup',
      title: 'Dedup test',
      updatedAt: '2026-04-02T12:00:00.000Z'
    }
  ];

  const poller = createPaperclipPoller({
    apiUrl: 'http://paperclip.local',
    apiKey: 'token',
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => inbox
    }),
    onEvents: events => { captured.push(...events); }
  });

  // First poll — event is novel
  await poller.pollNow();
  assert.equal(captured.length, 1);

  // Second poll — same snapshot, should be deduplicated
  await poller.pollNow();
  assert.equal(captured.length, 1, 'duplicate event should be skipped');

  // Third poll — status changes, new event emitted
  inbox[0].status = 'done';
  inbox[0].updatedAt = '2026-04-02T12:01:00.000Z';
  await poller.pollNow();
  assert.equal(captured.length, 2, 'changed event should be emitted');
});

test('poller.start() fires an immediate poll', async () => {
  let pollCount = 0;
  const poller = createPaperclipPoller({
    apiUrl: 'http://paperclip.local',
    apiKey: 'token',
    intervalMs: 60000, // long interval so setInterval doesn't fire
    fetchImpl: async () => {
      pollCount += 1;
      return { ok: true, status: 200, json: async () => [] };
    }
  });

  poller.start();
  // Wait a short time for the immediate poll to complete
  await new Promise(r => setTimeout(r, 50));
  poller.stop();
  assert.ok(pollCount >= 1, 'should have polled at least once immediately');
});

test('poller tracks consecutive errors and exposes count', async () => {
  const errors = [];
  const poller = createPaperclipPoller({
    apiUrl: 'http://paperclip.local',
    apiKey: 'token',
    fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }),
    onError: err => errors.push(err)
  });

  assert.equal(poller.getConsecutiveErrors(), 0);

  await poller.pollNow().catch(() => {});
  // pollNow itself throws; consecutiveErrors only incremented by start()'s catch
  // But getConsecutiveErrors should reflect the counter
  assert.equal(poller.getConsecutiveErrors(), 0, 'direct pollNow does not increment counter');
});

test('normalizeInboxIssue extracts agentName when available', () => {
  const issue = normalizeInboxIssue({
    id: 'task-name',
    status: 'todo',
    assigneeAgentId: 'agent-name',
    assigneeAgentName: 'Designer Agent'
  });

  assert.equal(issue.agentName, 'Designer Agent');
});

test('buildEventsFromInboxSnapshot includes agent_name in payload when available', () => {
  const events = buildEventsFromInboxSnapshot([
    {
      id: 'task-named',
      status: 'in_progress',
      assigneeAgentId: 'agent-named',
      assigneeAgentName: 'Build Agent',
      title: 'named test',
      updatedAt: '2026-04-02T13:00:00.000Z'
    }
  ]);

  assert.equal(events.length, 1);
  assert.equal(events[0].payload.agent_name, 'Build Agent');
});

test('fetchPaperclipCompanies는 배열 응답에서 컴퍼니 목록을 정규화한다', async () => {
  const companies = await fetchPaperclipCompanies({
    apiUrl: 'http://paperclip.local',
    apiKey: 'token',
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => [
        { id: 'c1', name: 'Alpha', agentCount: 5 },
        { id: 'c2', title: 'Beta' },
        { name: 'NoId' }  // id 없으면 필터됨
      ]
    })
  });

  assert.equal(companies.length, 2);
  assert.equal(companies[0].id, 'c1');
  assert.equal(companies[0].name, 'Alpha');
  assert.equal(companies[0].agentCount, 5);
  assert.equal(companies[1].id, 'c2');
  assert.equal(companies[1].name, 'Beta');
  assert.equal(companies[1].agentCount, null);
});

test('fetchPaperclipCompanies는 { data: [...] } 래핑 응답도 처리한다', async () => {
  const companies = await fetchPaperclipCompanies({
    apiUrl: 'http://paperclip.local',
    apiKey: 'token',
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ id: 'c3', name: 'Gamma' }] })
    })
  });

  assert.equal(companies.length, 1);
  assert.equal(companies[0].id, 'c3');
});

test('fetchPaperclipCompanies는 fetch 실패 시 예외를 던진다', async () => {
  await assert.rejects(
    () => fetchPaperclipCompanies({
      apiUrl: 'http://paperclip.local',
      apiKey: 'token',
      fetchImpl: async () => ({ ok: false, status: 403 })
    }),
    /Paperclip companies fetch failed: 403/
  );
});
