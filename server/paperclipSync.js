function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pickString(source, keys) {
  if (!isRecord(source)) {
    return null;
  }

  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }

  return null;
}

function normalizeInboxIssue(rawIssue) {
  if (!isRecord(rawIssue)) {
    return null;
  }

  const run = isRecord(rawIssue.activeRun) ? rawIssue.activeRun : null;
  const issueId =
    pickString(rawIssue, ['id', 'taskId']) ||
    pickString(rawIssue, ['identifier']) ||
    null;

  return {
    id: issueId,
    identifier: pickString(rawIssue, ['identifier']) || issueId,
    status: (pickString(rawIssue, ['status']) || 'todo').toLowerCase(),
    agentId:
      pickString(rawIssue, ['assigneeAgentId', 'agentId']) ||
      pickString(run, ['agentId']),
    runId:
      pickString(run, ['id', 'runId']) ||
      pickString(rawIssue, ['executionRunId', 'runId']),
    title: pickString(rawIssue, ['title', 'name']) || '',
    updatedAt: pickString(rawIssue, ['updatedAt', 'timestamp'])
  };
}

function mapIssueStatusToEventType(status) {
  if (status === 'done' || status === 'cancelled') {
    return 'task_completed';
  }

  if (status === 'blocked') {
    return 'task_paused';
  }

  if (status === 'in_progress' || status === 'in_review') {
    return 'tool_called';
  }

  if (status === 'todo' || status === 'backlog') {
    return 'task_assigned';
  }

  return null;
}

function buildEventsFromInboxSnapshot(rawInbox, timestamp = null) {
  const inbox = Array.isArray(rawInbox) ? rawInbox : [];
  const now = timestamp || new Date().toISOString();
  const events = [];

  inbox.forEach(rawIssue => {
    const issue = normalizeInboxIssue(rawIssue);
    if (!issue?.id || !issue.agentId) {
      return;
    }

    const eventType = mapIssueStatusToEventType(issue.status);
    if (!eventType) {
      return;
    }

    const event = {
      event_type: eventType,
      agent_id: issue.agentId,
      task_id: issue.id,
      timestamp: issue.updatedAt || now,
      payload: {
        label: issue.title || issue.identifier,
        source: 'paperclip_inbox',
        issue_identifier: issue.identifier,
        issue_status: issue.status
      }
    };

    if (issue.runId) {
      event.run_id = issue.runId;
    }

    events.push(event);
  });

  return events;
}

function buildEventsFromAgentsList(rawAgents, rawIssues, timestamp = null) {
  const agents = Array.isArray(rawAgents) ? rawAgents : [];
  const issues = Array.isArray(rawIssues) ? rawIssues : [];
  const now = timestamp || new Date().toISOString();
  const events = [];

  const issuesByAgent = {};
  issues.forEach(issue => {
    const agentId = pickString(issue, ['assigneeAgentId', 'agentId']);
    if (agentId) {
      if (!issuesByAgent[agentId]) issuesByAgent[agentId] = [];
      issuesByAgent[agentId].push(issue);
    }
  });

  agents.forEach(agent => {
    const agentId = pickString(agent, ['id']);
    if (!agentId) return;

    const agentName = pickString(agent, ['name', 'title']) || 'Agent';
    const agentIssues = issuesByAgent[agentId] || [];
    const agentStatus = (pickString(agent, ['status']) || 'idle').toLowerCase();

    if (agentIssues.length === 0) {
      // Emit presence for all agents so they appear in the world
      events.push({
        event_type: 'run_started',
        agent_id: agentId,
        run_id: `presence-${agentId}`,
        timestamp: pickString(agent, ['lastHeartbeatAt', 'updatedAt']) || now,
        payload: {
          label: agentName,
          source: 'paperclip_agents',
          agent_name: agentName,
          agent_status: agentStatus,
          agent_role: pickString(agent, ['role']) || 'general'
        }
      });
      return;
    }

    agentIssues.forEach(issue => {
      const issueId = pickString(issue, ['id']);
      if (!issueId) return;
      const status = (pickString(issue, ['status']) || 'todo').toLowerCase();
      const eventType = mapIssueStatusToEventType(status);
      if (!eventType) return;

      const runObj = isRecord(issue.activeRun) ? issue.activeRun : null;
      const event = {
        event_type: eventType,
        agent_id: agentId,
        task_id: issueId,
        timestamp: pickString(issue, ['updatedAt']) || now,
        payload: {
          label: pickString(issue, ['title', 'identifier']) || '',
          source: 'paperclip_agents',
          issue_identifier: pickString(issue, ['identifier']) || issueId,
          issue_status: status,
          agent_name: agentName
        }
      };

      const runId = pickString(runObj, ['id', 'runId']) ||
        pickString(issue, ['executionRunId', 'runId']);
      if (runId) event.run_id = runId;

      events.push(event);
    });
  });

  return events;
}

function createPaperclipPoller(options = {}) {
  const {
    apiUrl,
    apiKey,
    intervalMs = 10000,
    fetchImpl = globalThis.fetch,
    onEvents = () => {},
    onError = () => {},
    endpointPath = '/api/agents/me/inbox-lite',
    companyId = null
  } = options;

  if (!apiUrl || !apiKey) {
    throw new Error('createPaperclipPoller requires apiUrl and apiKey.');
  }

  if (typeof fetchImpl !== 'function') {
    throw new Error('createPaperclipPoller requires fetchImpl function.');
  }

  const useCompanySync = Boolean(companyId);
  let timer = null;
  let inFlightPoll = null;

  function pollNow() {
    if (inFlightPoll) {
      return inFlightPoll;
    }

    inFlightPoll = (async () => {
      const headers = {
        authorization: `Bearer ${apiKey}`,
        accept: 'application/json'
      };

      if (useCompanySync) {
        const [agentsRes, issuesRes] = await Promise.all([
          fetchImpl(`${apiUrl}/api/companies/${companyId}/agents`, { headers }),
          fetchImpl(`${apiUrl}/api/companies/${companyId}/issues?status=todo,in_progress,blocked,in_review`, { headers })
        ]);

        if (!agentsRes.ok) {
          throw new Error(`Paperclip agents fetch failed: ${agentsRes.status}`);
        }
        if (!issuesRes.ok) {
          throw new Error(`Paperclip issues fetch failed: ${issuesRes.status}`);
        }

        const agents = await agentsRes.json();
        const issues = await issuesRes.json();
        const events = buildEventsFromAgentsList(agents, issues);

        if (events.length > 0) {
          await onEvents(events);
        }

        return {
          fetched: (Array.isArray(agents) ? agents.length : 0) + (Array.isArray(issues) ? issues.length : 0),
          emitted: events.length
        };
      }

      const response = await fetchImpl(`${apiUrl}${endpointPath}`, { headers });

      if (!response.ok) {
        throw new Error(`Paperclip inbox fetch failed: ${response.status}`);
      }

      const inbox = await response.json();
      const events = buildEventsFromInboxSnapshot(inbox);

      if (events.length > 0) {
        await onEvents(events);
      }

      return {
        fetched: Array.isArray(inbox) ? inbox.length : 0,
        emitted: events.length
      };
    })().finally(() => {
      inFlightPoll = null;
    });

    return inFlightPoll;
  }

  function start() {
    if (timer) {
      return;
    }

    const safeIntervalMs = Math.max(1000, Number(intervalMs) || 10000);
    timer = setInterval(() => {
      pollNow().catch(error => {
        onError(error);
      });
    }, safeIntervalMs);
  }

  function stop() {
    if (!timer) {
      return;
    }

    clearInterval(timer);
    timer = null;
  }

  return {
    pollNow,
    start,
    stop,
    isRunning: () => Boolean(timer)
  };
}

module.exports = {
  buildEventsFromAgentsList,
  buildEventsFromInboxSnapshot,
  createPaperclipPoller,
  mapIssueStatusToEventType,
  normalizeInboxIssue
};
