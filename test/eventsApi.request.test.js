const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getJson,
  postJson,
  putJson,
  startTestServer,
  stopTestServer
} = require('./helpers/testServer');
const { createWsTicketStore } = require('../server/wsTicketStore');

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

test('/events는 인증 토큰이 없으면 401을 반환한다', async () => {
  const { response, json } = await postJson(
    runtime.baseUrl,
    '/events',
    {
      event_type: 'run_started',
      agent_id: 'agent-no-auth',
      run_id: 'run-no-auth'
    },
    { auth: false }
  );

  assert.equal(response.status, 401);
  assert.equal(json.error, 'Authentication required.');
  assert.equal(json.details[0].code, 'AUTH_REQUIRED');
});

test('/state는 인증 토큰이 잘못되면 403을 반환한다', async () => {
  const { response, json } = await getJson(runtime.baseUrl, '/state', {
    auth: 'wrong-token'
  });

  assert.equal(response.status, 403);
  assert.equal(json.error, 'Forbidden.');
  assert.equal(json.details[0].code, 'INVALID_TOKEN');
});

test('api token 설정값에 공백이 있어도 trim 후 인증한다', async () => {
  const trimmedRuntime = await startTestServer({
    security: {
      apiToken: 'trimmed-token   '
    }
  });

  try {
    const { response } = await getJson(trimmedRuntime.baseUrl, '/state', {
      auth: 'trimmed-token'
    });
    assert.equal(response.status, 200);
  } finally {
    await stopTestServer(trimmedRuntime);
  }
});

test('공백만 있는 api token 설정은 서버 시작을 거부한다', async () => {
  await assert.rejects(
    () =>
      startTestServer({
        security: {
          apiToken: '   '
        }
      }),
    /AGENT_WORLD_API_TOKEN is required/
  );
});

test('/auth/ws-ticket는 인증 토큰이 없으면 401을 반환한다', async () => {
  const { response, json } = await postJson(
    runtime.baseUrl,
    '/auth/ws-ticket',
    {},
    { auth: false }
  );

  assert.equal(response.status, 401);
  assert.equal(json.error, 'Authentication required.');
  assert.equal(json.details[0].code, 'AUTH_REQUIRED');
});

test('/auth/ws-ticket는 인증 토큰이 유효하면 201과 단기 티켓을 반환한다', async () => {
  const { response, json } = await postJson(
    runtime.baseUrl,
    '/auth/ws-ticket',
    {}
  );

  assert.equal(response.status, 201);
  assert.equal(json.status, 'ok');
  assert.equal(typeof json.ticket, 'string');
  assert.equal(json.ticket.length > 10, true);
  assert.equal(typeof json.ttlMs, 'number');
  assert.equal(typeof json.expiresAt, 'string');
});

test('CORS preflight는 허용 Origin만 승인한다', async () => {
  const corsRuntime = await startTestServer({
    security: {
      corsAllowedOrigins: ['https://allowed.example']
    }
  });

  try {
    const allowedResponse = await fetch(`${corsRuntime.baseUrl}/auth/ws-ticket`, {
      method: 'OPTIONS',
      headers: {
        origin: 'https://allowed.example',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization,content-type'
      }
    });
    assert.equal(allowedResponse.status, 204);
    assert.equal(
      allowedResponse.headers.get('access-control-allow-origin'),
      'https://allowed.example'
    );
    assert.match(allowedResponse.headers.get('vary') || '', /Origin/);

    const deniedResponse = await fetch(`${corsRuntime.baseUrl}/auth/ws-ticket`, {
      method: 'OPTIONS',
      headers: {
        origin: 'https://denied.example',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization,content-type'
      }
    });
    const deniedJson = await deniedResponse.json();
    assert.equal(deniedResponse.status, 403);
    assert.equal(deniedJson.error, 'Forbidden.');
    assert.equal(deniedJson.details[0].code, 'CORS_ORIGIN_FORBIDDEN');
  } finally {
    await stopTestServer(corsRuntime);
  }
});

test('/auth/ws-ticket는 티켓 충돌 고갈 시 503 + 안정 코드를 반환한다', async () => {
  const collisionRuntime = await startTestServer({
    createWsTicketStore: wsOptions =>
      createWsTicketStore({
        ...wsOptions,
        now: () => 1000,
        randomBytes: () => Buffer.alloc(24, 9)
      })
  });

  try {
    const first = await postJson(collisionRuntime.baseUrl, '/auth/ws-ticket', {});
    assert.equal(first.response.status, 201);

    const second = await postJson(collisionRuntime.baseUrl, '/auth/ws-ticket', {});
    assert.equal(second.response.status, 503);
    assert.equal(second.json.error, 'WS ticket issuance failed.');
    assert.equal(
      second.json.details[0].code,
      'WS_TICKET_COLLISION_LIMIT_EXCEEDED'
    );
  } finally {
    await stopTestServer(collisionRuntime);
  }
});

test('요청 바디가 빈 배열이면 400으로 거부한다', async () => {
  const { response, json } = await postJson(runtime.baseUrl, '/events', []);

  assert.equal(response.status, 400);
  assert.equal(json.error, 'Event array must not be empty.');
  assert.equal(json.details[0].index, 0);
});

test('/events는 배치 상한을 초과하면 413으로 거부한다', async () => {
  const limitedRuntime = await startTestServer({
    security: { maxEventBatchSize: 1 }
  });

  try {
    const { response, json } = await postJson(limitedRuntime.baseUrl, '/events', [
      {
        event_type: 'run_started',
        agent_id: 'agent-batch-1',
        run_id: 'run-batch-1'
      },
      {
        event_type: 'run_started',
        agent_id: 'agent-batch-2',
        run_id: 'run-batch-2'
      }
    ]);

    assert.equal(response.status, 413);
    assert.equal(json.error, 'Event batch exceeds the configured limit.');
    assert.equal(json.details[0].code, 'EVENT_BATCH_LIMIT_EXCEEDED');
  } finally {
    await stopTestServer(limitedRuntime);
  }
});

test('rate limit 초과 시 429를 반환한다', async () => {
  const limitedRuntime = await startTestServer({
    security: {
      rateLimitWindowMs: 60_000,
      maxRequestsPerWindow: 2
    }
  });

  try {
    const first = await getJson(limitedRuntime.baseUrl, '/state');
    const second = await getJson(limitedRuntime.baseUrl, '/state');
    const third = await getJson(limitedRuntime.baseUrl, '/state');

    assert.equal(first.response.status, 200);
    assert.equal(second.response.status, 200);
    assert.equal(third.response.status, 429);
    assert.equal(third.json.error, 'Too many requests.');
    assert.equal(third.json.details[0].code, 'RATE_LIMITED');
    assert.equal(
      Number(third.response.headers.get('retry-after')) > 0,
      true
    );
  } finally {
    await stopTestServer(limitedRuntime);
  }
});

test('rate limit 기본값(120 req/60s) 동작을 검증한다', async () => {
  const defaultRateLimitRuntime = await startTestServer();

  try {
    for (let i = 1; i <= 120; i += 1) {
      const result = await getJson(defaultRateLimitRuntime.baseUrl, '/state');
      assert.equal(result.response.status, 200, `요청 ${i}회는 통과해야 함`);
    }

    const overflow = await getJson(
      defaultRateLimitRuntime.baseUrl,
      '/state'
    );
    assert.equal(overflow.response.status, 429);
    assert.equal(overflow.json.error, 'Too many requests.');
    assert.equal(overflow.json.details[0].code, 'RATE_LIMITED');
    assert.equal(
      Number(overflow.response.headers.get('retry-after')) > 0,
      true
    );
  } finally {
    await stopTestServer(defaultRateLimitRuntime);
  }
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

test('Paperclip 수동 동기화 API는 비활성 상태에서 503을 반환한다', async () => {
  const { response, json } = await postJson(runtime.baseUrl, '/sync/paperclip', {});

  assert.equal(response.status, 503);
  assert.match(json.error, /Paperclip polling is disabled/);
});

test('Paperclip 수동 동기화 API는 inbox-lite를 이벤트로 정규화해 반영한다', async () => {
  const syncRuntime = await startTestServer({
    paperclipSync: {
      enabled: true,
      intervalMs: 60000,
      apiUrl: 'http://paperclip.local',
      apiKey: 'test-token',
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => [
          {
            id: 'task-sync-1',
            identifier: 'MOO-999',
            title: '동기화 테스트 태스크',
            status: 'in_progress',
            assigneeAgentId: 'agent-sync-1',
            updatedAt: '2026-04-02T10:00:00.000Z'
          }
        ]
      })
    }
  });

  try {
    // Wait briefly for the immediate poll on start() to complete
    await new Promise(r => setTimeout(r, 50));

    const syncResult = await postJson(
      syncRuntime.baseUrl,
      '/sync/paperclip',
      {}
    );
    assert.equal(syncResult.response.status, 200);
    assert.equal(syncResult.json.fetched, 1);
    // emitted may be 0 due to deduplication (initial poll already processed)

    const stateResult = await getJson(syncRuntime.baseUrl, '/state');
    assert.equal(
      stateResult.json.data.agents['agent-sync-1'].tasks[0].id,
      'task-sync-1'
    );
    assert.equal(stateResult.json.data.avatars['agent-sync-1'].state, 'working');
    assert.equal(
      stateResult.json.data.avatars['agent-sync-1'].bubbleText,
      '동기화 테스트 태스크'
    );
  } finally {
    await stopTestServer(syncRuntime);
  }
});

test('Paperclip 동기화에서 blocked 상태는 task_paused로 반영되어 아바타가 idle로 복귀한다', async () => {
  // 3 responses: initial poll on start() + 2 manual syncs
  const responses = [
    [
      {
        id: 'task-sync-blocked',
        identifier: 'MOO-1000',
        title: '외부 확인 대기',
        status: 'in_progress',
        assigneeAgentId: 'agent-sync-blocked',
        updatedAt: '2026-04-02T10:05:00.000Z'
      }
    ],
    [
      {
        id: 'task-sync-blocked',
        identifier: 'MOO-1000',
        title: '외부 확인 대기',
        status: 'in_progress',
        assigneeAgentId: 'agent-sync-blocked',
        updatedAt: '2026-04-02T10:05:00.000Z'
      }
    ],
    [
      {
        id: 'task-sync-blocked',
        identifier: 'MOO-1000',
        title: '외부 확인 대기',
        status: 'blocked',
        assigneeAgentId: 'agent-sync-blocked',
        updatedAt: '2026-04-02T10:06:00.000Z'
      }
    ]
  ];

  const syncRuntime = await startTestServer({
    paperclipSync: {
      enabled: true,
      intervalMs: 60000,
      apiUrl: 'http://paperclip.local',
      apiKey: 'test-token',
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => responses.shift() || []
      })
    }
  });

  try {
    // Wait for the immediate poll on start() to complete
    await new Promise(r => setTimeout(r, 50));

    // This poll returns same in_progress data → deduplicated, 0 emitted
    const firstSync = await postJson(syncRuntime.baseUrl, '/sync/paperclip', {});
    assert.equal(firstSync.response.status, 200);

    // This poll returns blocked status → novel event, emitted
    const blockedSync = await postJson(syncRuntime.baseUrl, '/sync/paperclip', {});
    assert.equal(blockedSync.response.status, 200);
    assert.equal(blockedSync.json.emitted, 1);

    const stateResult = await getJson(syncRuntime.baseUrl, '/state');
    const agent = stateResult.json.data.agents['agent-sync-blocked'];
    const avatar = stateResult.json.data.avatars['agent-sync-blocked'];

    assert.equal(agent.tasks[0].status, 'blocked');
    assert.equal(agent.activity, 'idle');
    assert.equal(avatar.state, 'idle');
    assert.equal(avatar.moving, true);
    // Idle agents now show destination text (Generative Agents behavior)
    assert.equal(typeof avatar.bubbleText, 'string');
  } finally {
    await stopTestServer(syncRuntime);
  }
});

test('Paperclip 수동 동기화 성공 시 메타 상태가 lastSyncAt/lastSyncError를 갱신한다', async () => {
  const syncRuntime = await startTestServer({
    paperclipSync: {
      enabled: true,
      intervalMs: 60000,
      apiUrl: 'http://paperclip.local',
      apiKey: 'test-token',
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => [
          {
            id: 'task-sync-meta',
            identifier: 'MOO-2000',
            title: '메타 동기화 점검',
            status: 'in_progress',
            assigneeAgentId: 'agent-sync-meta',
            updatedAt: '2026-04-02T12:00:00.000Z'
          }
        ]
      })
    }
  });

  try {
    // Wait for the immediate poll on start() to complete
    await new Promise(r => setTimeout(r, 50));

    const syncResult = await postJson(syncRuntime.baseUrl, '/sync/paperclip', {});
    assert.equal(syncResult.response.status, 200);
    assert.equal(syncResult.json.fetched, 1);
    // emitted may be 0 due to deduplication — initial poll already processed

    // Meta fields should be set from the poll (initial or manual)
    const stateResult = await getJson(syncRuntime.baseUrl, '/state');
    assert.equal(typeof stateResult.json.data.meta.paperclip.lastSyncAt, 'string');
    assert.match(stateResult.json.data.meta.paperclip.lastSyncAt, /\d{4}-/);
    assert.equal(stateResult.json.data.meta.paperclip.lastSyncError, null);
    assert.equal(stateResult.json.data.meta.paperclip.lastPolledCount, 1);
  } finally {
    await stopTestServer(syncRuntime);
  }
});

test('Paperclip 수동 동기화는 companyId 모드에서 agents/issues 엔드포인트를 사용해 동기화한다', async () => {
  const syncCompanyRuntime = await startTestServer({
    paperclipSync: {
      enabled: true,
      intervalMs: 60000,
      apiUrl: 'http://paperclip.local',
      apiKey: 'test-token',
      companyId: 'company-1',
      fetchImpl: async url => {
        if (url === 'http://paperclip.local/api/companies/company-1/agents') {
          return {
            ok: true,
            status: 200,
            json: async () => [
              {
                id: 'agent-sync-company',
                name: 'Company Agent',
                status: 'working',
                role: 'engineer'
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
                id: 'task-sync-company-1',
                identifier: 'MOO-3000',
                status: 'in_progress',
                assigneeAgentId: 'agent-sync-company',
                title: '회사 동기화 케이스',
                activeRun: { id: 'run-company-1' },
                updatedAt: '2026-04-02T13:00:00.000Z'
              }
            ]
          };
        }

        throw new Error(`Unexpected URL: ${url}`);
      }
    }
  });

  try {
    // Wait for the immediate poll on start() to complete
    await new Promise(r => setTimeout(r, 50));

    const syncResult = await postJson(
      syncCompanyRuntime.baseUrl,
      '/sync/paperclip',
      {}
    );
    assert.equal(syncResult.response.status, 200);
    assert.equal(syncResult.json.fetched, 2);
    // emitted may be 0 due to deduplication — initial poll already processed

    // State should be correct from initial poll
    const stateResult = await getJson(syncCompanyRuntime.baseUrl, '/state');
    const agent = stateResult.json.data.agents['agent-sync-company'];
    assert.equal(agent.tasks[0].status, 'in_progress');
    assert.equal(agent.tasks[0].id, 'task-sync-company-1');
    assert.equal(agent.tasks[0].label, '회사 동기화 케이스');
    assert.equal(stateResult.json.data.runs['run-company-1'].status, 'running');
  } finally {
    await stopTestServer(syncCompanyRuntime);
  }
});

test('Paperclip 수동 동기화 실패 시 meta.lastSyncError에 원인 메시지가 남는다', async () => {
  const syncFailRuntime = await startTestServer({
    paperclipSync: {
      enabled: true,
      intervalMs: 60000,
      apiUrl: 'http://paperclip.local',
      apiKey: 'test-token',
      fetchImpl: async () => ({
        ok: false,
        status: 500,
        json: async () => ({})
      })
    }
  });

  try {
    const syncFailResult = await postJson(
      syncFailRuntime.baseUrl,
      '/sync/paperclip',
      {}
    );
    assert.equal(syncFailResult.response.status, 502);
    assert.equal(syncFailResult.json.error, 'Paperclip sync failed.');
    assert.equal(syncFailResult.json.details[0].code, 'PAPERCLIP_SYNC_FAILED');

    const stateResult = await getJson(syncFailRuntime.baseUrl, '/state');
    assert.equal(
      typeof stateResult.json.data.meta.paperclip.lastSyncError,
      'string'
    );
    assert.match(
      stateResult.json.data.meta.paperclip.lastSyncError,
      /Paperclip inbox fetch failed: 500/
    );
  } finally {
    await stopTestServer(syncFailRuntime);
  }
});

test('GET /sync/paperclip/companies는 Paperclip에서 컴퍼니 목록을 조회한다', async () => {
  const companiesRuntime = await startTestServer({
    paperclipSync: {
      enabled: true,
      intervalMs: 60000,
      apiUrl: 'http://paperclip.local',
      apiKey: 'test-token',
      fetchImpl: async (url) => {
        if (url.includes('/api/companies') && !url.includes('/agents') && !url.includes('/issues')) {
          return {
            ok: true,
            status: 200,
            json: async () => [
              { id: 'company-1', name: 'Alpha Corp', agentCount: 3 },
              { id: 'company-2', name: 'Beta Inc', agentCount: 1 }
            ]
          };
        }
        return { ok: true, status: 200, json: async () => [] };
      }
    }
  });

  try {
    await new Promise(r => setTimeout(r, 50));

    const result = await getJson(companiesRuntime.baseUrl, '/sync/paperclip/companies');
    assert.equal(result.response.status, 200);
    assert.equal(result.json.status, 'ok');
    assert.equal(result.json.companies.length, 2);
    assert.equal(result.json.companies[0].id, 'company-1');
    assert.equal(result.json.companies[0].name, 'Alpha Corp');
    assert.equal(result.json.companies[1].id, 'company-2');
    assert.equal(result.json.currentCompanyId, null);
  } finally {
    await stopTestServer(companiesRuntime);
  }
});

test('PUT /sync/paperclip/company로 동기화 대상 컴퍼니를 전환할 수 있다', async () => {
  let fetchCallUrls = [];
  const switchRuntime = await startTestServer({
    paperclipSync: {
      enabled: true,
      intervalMs: 60000,
      apiUrl: 'http://paperclip.local',
      apiKey: 'test-token',
      fetchImpl: async (url) => {
        fetchCallUrls.push(url);
        if (url.includes('/api/companies/company-new/agents')) {
          return {
            ok: true,
            status: 200,
            json: async () => [
              { id: 'agent-new', name: 'New Agent', status: 'working' }
            ]
          };
        }
        if (url.includes('/api/companies/company-new/issues')) {
          return {
            ok: true,
            status: 200,
            json: async () => [
              {
                id: 'task-new',
                identifier: 'NEW-1',
                title: '새 회사 태스크',
                status: 'in_progress',
                assigneeAgentId: 'agent-new',
                updatedAt: '2026-04-06T10:00:00.000Z'
              }
            ]
          };
        }
        return { ok: true, status: 200, json: async () => [] };
      }
    }
  });

  try {
    await new Promise(r => setTimeout(r, 50));

    // 초기 상태 확인 — companyId가 null (inbox 모드)
    const before = await getJson(switchRuntime.baseUrl, '/state');
    assert.equal(before.json.data.meta.paperclip.companyId, null);

    // 컴퍼니 전환
    fetchCallUrls = [];
    const switchResult = await putJson(
      switchRuntime.baseUrl,
      '/sync/paperclip/company',
      { companyId: 'company-new', companyName: 'New Company' }
    );
    assert.equal(switchResult.response.status, 200);
    assert.equal(switchResult.json.companyId, 'company-new');
    assert.equal(switchResult.json.companyName, 'New Company');
    assert.equal(switchResult.json.mode, 'company');

    // 새 폴러가 company 모드로 동작하는지 확인
    await new Promise(r => setTimeout(r, 100));
    const after = await getJson(switchRuntime.baseUrl, '/state');
    assert.equal(after.json.data.meta.paperclip.companyId, 'company-new');
    assert.equal(after.json.data.meta.paperclip.companyName, 'New Company');

    // company 엔드포인트가 호출되었는지 확인
    const companyUrls = fetchCallUrls.filter(u => u.includes('company-new'));
    assert.ok(companyUrls.length > 0, 'should have fetched from company endpoints');
  } finally {
    await stopTestServer(switchRuntime);
  }
});

test('PUT /sync/paperclip/company에 companyId를 null로 보내면 inbox 모드로 복귀한다', async () => {
  const inboxRuntime = await startTestServer({
    paperclipSync: {
      enabled: true,
      intervalMs: 60000,
      apiUrl: 'http://paperclip.local',
      apiKey: 'test-token',
      companyId: 'company-initial',
      fetchImpl: async (url) => {
        if (url.includes('/agents') && !url.includes('inbox')) {
          return { ok: true, status: 200, json: async () => [] };
        }
        if (url.includes('/issues')) {
          return { ok: true, status: 200, json: async () => [] };
        }
        return { ok: true, status: 200, json: async () => [] };
      }
    }
  });

  try {
    await new Promise(r => setTimeout(r, 50));

    const before = await getJson(inboxRuntime.baseUrl, '/state');
    assert.equal(before.json.data.meta.paperclip.companyId, 'company-initial');

    const result = await putJson(
      inboxRuntime.baseUrl,
      '/sync/paperclip/company',
      { companyId: null }
    );
    assert.equal(result.response.status, 200);
    assert.equal(result.json.companyId, null);
    assert.equal(result.json.mode, 'inbox');

    const after = await getJson(inboxRuntime.baseUrl, '/state');
    assert.equal(after.json.data.meta.paperclip.companyId, null);
  } finally {
    await stopTestServer(inboxRuntime);
  }
});

test('컴퍼니 전환 시 이전 에이전트/런 상태가 초기화된다', async () => {
  const clearRuntime = await startTestServer({
    paperclipSync: {
      enabled: true,
      intervalMs: 60000,
      apiUrl: 'http://paperclip.local',
      apiKey: 'test-token',
      fetchImpl: async (url) => {
        if (url.includes('inbox-lite')) {
          return {
            ok: true,
            status: 200,
            json: async () => [
              {
                id: 'task-old',
                identifier: 'OLD-1',
                title: '이전 태스크',
                status: 'in_progress',
                assigneeAgentId: 'agent-old',
                updatedAt: '2026-04-06T09:00:00.000Z'
              }
            ]
          };
        }
        if (url.includes('/agents')) {
          return { ok: true, status: 200, json: async () => [] };
        }
        if (url.includes('/issues')) {
          return { ok: true, status: 200, json: async () => [] };
        }
        return { ok: true, status: 200, json: async () => [] };
      }
    }
  });

  try {
    await new Promise(r => setTimeout(r, 100));

    // 기존 에이전트가 있는지 확인
    const before = await getJson(clearRuntime.baseUrl, '/state');
    assert.ok(before.json.data.agents['agent-old'], 'old agent should exist');

    // 컴퍼니 전환
    await putJson(
      clearRuntime.baseUrl,
      '/sync/paperclip/company',
      { companyId: 'company-clean' }
    );

    // 이전 에이전트가 제거되었는지 확인
    const after = await getJson(clearRuntime.baseUrl, '/state');
    assert.equal(
      Object.keys(after.json.data.agents).length,
      0,
      'agents should be cleared after company switch'
    );
    assert.equal(
      Object.keys(after.json.data.runs).length,
      0,
      'runs should be cleared after company switch'
    );
  } finally {
    await stopTestServer(clearRuntime);
  }
});
