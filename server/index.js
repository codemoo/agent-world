const express = require('express');
const http = require('http');
const path = require('path');
const WebSocket = require('ws');
const { createWorldModel } = require('../adapter/paperclipAdapter');
const {
  EventValidationError,
  processIncomingEvents
} = require('./eventsPipeline');
const { createPaperclipPoller } = require('./paperclipSync');
const {
  DEFAULT_WS_TICKET_MAX_ENTRIES,
  DEFAULT_WS_TICKET_TTL_MS,
  WsTicketIssueError,
  createWsTicketStore,
  getWsTicketFromUrl
} = require('./wsTicketStore');

const DEFAULT_JSON_BODY_LIMIT = '256kb';
const DEFAULT_RATE_LIMIT_WINDOW_MS = 60_000;
const DEFAULT_RATE_LIMIT_MAX_REQUESTS = 120;
const DEFAULT_MAX_EVENT_BATCH_SIZE = 100;
const DEFAULT_MAX_STATE_AGENTS = 500;
const DEFAULT_MAX_STATE_RUNS = 2_000;
const DEFAULT_MAX_STATE_TASKS = 10_000;

class RequestGuardError extends Error {
  constructor(statusCode, message, details = []) {
    super(message);
    this.name = 'RequestGuardError';
    this.statusCode = statusCode;
    this.details = details;
  }
}

function toPositiveInteger(value, fallbackValue) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : fallbackValue;
}

function parseBearerToken(authorizationValue) {
  if (typeof authorizationValue !== 'string') {
    return null;
  }

  const [scheme, token] = authorizationValue.trim().split(/\s+/, 2);
  if (!scheme || !token) {
    return null;
  }

  if (!/^Bearer$/i.test(scheme)) {
    return null;
  }

  return token.trim() || null;
}

function normalizeApiToken(tokenValue) {
  if (typeof tokenValue !== 'string') {
    return null;
  }
  const normalized = tokenValue.trim();
  return normalized.length > 0 ? normalized : null;
}

function normalizeCorsAllowedOrigins(rawOrigins) {
  if (Array.isArray(rawOrigins)) {
    return rawOrigins
      .map(value => (typeof value === 'string' ? value.trim() : ''))
      .filter(Boolean);
  }

  if (typeof rawOrigins === 'string') {
    return rawOrigins
      .split(',')
      .map(value => value.trim())
      .filter(Boolean);
  }

  return [];
}

function addVaryHeader(res, headerName) {
  const previous = res.getHeader('Vary');
  if (!previous) {
    res.setHeader('Vary', headerName);
    return;
  }

  const nextValues = new Set(
    String(previous)
      .split(',')
      .map(value => value.trim())
      .filter(Boolean)
  );
  nextValues.add(headerName);
  res.setHeader('Vary', Array.from(nextValues).join(', '));
}

function evaluateCorsOrigin(req, securityOptions) {
  const rawOrigin =
    typeof req.headers?.origin === 'string' ? req.headers.origin.trim() : '';

  if (!rawOrigin) {
    return { hasOrigin: false, allowed: true, origin: null };
  }

  const host = typeof req.headers?.host === 'string' ? req.headers.host.trim() : '';
  const requestOrigin = host ? `${req.protocol}://${host}` : null;
  const sameOrigin = Boolean(requestOrigin && rawOrigin === requestOrigin);
  const allowlisted = securityOptions.corsAllowedOrigins.includes(rawOrigin);

  return {
    hasOrigin: true,
    allowed: sameOrigin || allowlisted,
    origin: rawOrigin
  };
}

function resolveSecurityOptions(options = {}) {
  const security = options.security || {};
  const authEnabled = security.enabled !== false;
  const apiToken = normalizeApiToken(
    security.apiToken ?? process.env.AGENT_WORLD_API_TOKEN ?? null
  );

  if (authEnabled && !apiToken) {
    throw new Error(
      'AGENT_WORLD_API_TOKEN is required unless createServer({ security: { enabled: false } }) is set.'
    );
  }

  return {
    authEnabled,
    apiToken,
    maxEventBatchSize: toPositiveInteger(
      security.maxEventBatchSize ?? process.env.AGENT_WORLD_MAX_EVENT_BATCH_SIZE,
      DEFAULT_MAX_EVENT_BATCH_SIZE
    ),
    rateLimitWindowMs: toPositiveInteger(
      security.rateLimitWindowMs ?? process.env.AGENT_WORLD_RATE_LIMIT_WINDOW_MS,
      DEFAULT_RATE_LIMIT_WINDOW_MS
    ),
    maxRequestsPerWindow: toPositiveInteger(
      security.maxRequestsPerWindow ??
        process.env.AGENT_WORLD_RATE_LIMIT_MAX_REQUESTS,
      DEFAULT_RATE_LIMIT_MAX_REQUESTS
    ),
    stateLimits: {
      maxAgents: toPositiveInteger(
        security.maxStateAgents ?? process.env.AGENT_WORLD_MAX_STATE_AGENTS,
        DEFAULT_MAX_STATE_AGENTS
      ),
      maxRuns: toPositiveInteger(
        security.maxStateRuns ?? process.env.AGENT_WORLD_MAX_STATE_RUNS,
        DEFAULT_MAX_STATE_RUNS
      ),
      maxTasks: toPositiveInteger(
        security.maxStateTasks ?? process.env.AGENT_WORLD_MAX_STATE_TASKS,
        DEFAULT_MAX_STATE_TASKS
      )
    },
    wsTicketTtlMs: toPositiveInteger(
      security.wsTicketTtlMs ?? process.env.AGENT_WORLD_WS_TICKET_TTL_MS,
      DEFAULT_WS_TICKET_TTL_MS
    ),
    maxWsTicketEntries: toPositiveInteger(
      security.maxWsTicketEntries ??
        process.env.AGENT_WORLD_MAX_WS_TICKET_ENTRIES,
      DEFAULT_WS_TICKET_MAX_ENTRIES
    ),
    corsAllowedOrigins: normalizeCorsAllowedOrigins(
      security.corsAllowedOrigins ??
        process.env.AGENT_WORLD_CORS_ALLOWED_ORIGINS ??
        ''
    )
  };
}

function createFixedWindowRateLimiter(windowMs, maxRequests) {
  const buckets = new Map();

  return function consume(key) {
    const now = Date.now();
    let bucket = buckets.get(key);

    if (!bucket || now - bucket.windowStart >= windowMs) {
      bucket = { windowStart: now, count: 0 };
    }

    if (bucket.count >= maxRequests) {
      const retryAfterMs = Math.max(0, windowMs - (now - bucket.windowStart));
      buckets.set(key, bucket);
      return {
        allowed: false,
        retryAfterSec: Math.max(1, Math.ceil(retryAfterMs / 1000))
      };
    }

    bucket.count += 1;
    buckets.set(key, bucket);

    if (buckets.size > 10_000) {
      for (const [bucketKey, entry] of buckets.entries()) {
        if (now - entry.windowStart >= windowMs) {
          buckets.delete(bucketKey);
        }
      }
    }

    return { allowed: true, retryAfterSec: 0 };
  };
}

function validateRequestAuth(requestLike, securityOptions) {
  if (!securityOptions.authEnabled) {
    return { ok: true, subject: 'auth-disabled' };
  }

  const bearerToken = parseBearerToken(
    requestLike?.headers?.authorization || null
  );
  const resolvedToken = bearerToken;

  if (!resolvedToken) {
    return {
      ok: false,
      statusCode: 401,
      message: 'Authentication required.',
      details: [{ code: 'AUTH_REQUIRED', error: 'Bearer token is required.' }]
    };
  }

  if (resolvedToken !== securityOptions.apiToken) {
    return {
      ok: false,
      statusCode: 403,
      message: 'Forbidden.',
      details: [{ code: 'INVALID_TOKEN', error: 'Invalid authentication token.' }]
    };
  }

  return { ok: true, subject: 'api-token' };
}

function enforceStateCapacity(worldState, stateLimits) {
  const agentCount = Object.keys(worldState.agents || {}).length;
  const runCount = Object.keys(worldState.runs || {}).length;
  const taskCount = Object.values(worldState.agents || {}).reduce(
    (sum, agent) =>
      sum + (Array.isArray(agent?.tasks) ? agent.tasks.length : 0),
    0
  );

  const details = [];
  if (agentCount > stateLimits.maxAgents) {
    details.push({
      code: 'STATE_AGENTS_LIMIT_EXCEEDED',
      limit: stateLimits.maxAgents,
      current: agentCount
    });
  }
  if (runCount > stateLimits.maxRuns) {
    details.push({
      code: 'STATE_RUNS_LIMIT_EXCEEDED',
      limit: stateLimits.maxRuns,
      current: runCount
    });
  }
  if (taskCount > stateLimits.maxTasks) {
    details.push({
      code: 'STATE_TASKS_LIMIT_EXCEEDED',
      limit: stateLimits.maxTasks,
      current: taskCount
    });
  }

  if (details.length > 0) {
    throw new RequestGuardError(
      429,
      'World state capacity exceeded. Incoming events were rejected.',
      details
    );
  }
}

function createWorldState() {
  return {
    world: createWorldModel(),
    agents: {},
    avatars: {},
    zones: {},
    runs: {},
    meta: {
      paperclip: {
        enabled: false,
        lastSyncAt: null,
        lastSyncError: null,
        lastPolledCount: 0
      }
    }
  };
}

function sendError(res, statusCode, message, details) {
  const body = { error: message };
  if (Array.isArray(details) && details.length > 0) {
    body.details = details;
  }
  res.status(statusCode).json(body);
}

function rejectUpgrade(socket, statusCode, statusText, retryAfterSec) {
  const retryAfterHeader =
    typeof retryAfterSec === 'number' && retryAfterSec > 0
      ? `Retry-After: ${retryAfterSec}\r\n`
      : '';
  socket.write(
    `HTTP/1.1 ${statusCode} ${statusText}\r\nConnection: close\r\n${retryAfterHeader}\r\n`
  );
  socket.destroy();
}

function createServer(options = {}) {
  const processIncomingEventsFn =
    typeof options.processIncomingEvents === 'function'
      ? options.processIncomingEvents
      : processIncomingEvents;
  const securityOptions = resolveSecurityOptions(options);
  const configuredPaperclipSync = options.paperclipSync || {};
  const pollIntervalMs = Number(
    configuredPaperclipSync.intervalMs ??
      process.env.PAPERCLIP_SYNC_INTERVAL_MS ??
      0
  );
  const paperclipSyncEnabled =
    configuredPaperclipSync.enabled ??
    (pollIntervalMs > 0 &&
      Boolean(process.env.PAPERCLIP_API_URL) &&
      Boolean(process.env.PAPERCLIP_API_KEY));
  const consumeRateLimit = createFixedWindowRateLimiter(
    securityOptions.rateLimitWindowMs,
    securityOptions.maxRequestsPerWindow
  );
  const app = express();
  const server = http.createServer(app);
  const wss = new WebSocket.Server({ noServer: true });
  const worldState = createWorldState();
  worldState.meta.paperclip.enabled = Boolean(paperclipSyncEnabled);
  const wsTicketStoreFactory =
    typeof options.createWsTicketStore === 'function'
      ? options.createWsTicketStore
      : createWsTicketStore;
  const wsTicketStore = wsTicketStoreFactory({
    ttlMs: securityOptions.wsTicketTtlMs,
    maxEntries: securityOptions.maxWsTicketEntries
  });
  let paperclipPoller = null;

  /**
   * Broadcast the current world state to all connected clients.
   */
  function broadcastState() {
    const payload = JSON.stringify({ type: 'state', data: worldState });
    wss.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        try {
          client.send(payload);
        } catch (error) {
          console.error('WebSocket broadcast failed:', error.message);
        }
      }
    });
  }

  function guardAndRateLimitHttp(scope) {
    return (req, res, next) => {
      const auth = validateRequestAuth(req, securityOptions);
      if (!auth.ok) {
        sendError(res, auth.statusCode, auth.message, auth.details);
        return;
      }
      req.authSubject = auth.subject;

      const rateKey = `${scope}:${req.ip || req.socket.remoteAddress || 'unknown'}:${auth.subject}`;
      const rateLimitResult = consumeRateLimit(rateKey);
      if (!rateLimitResult.allowed) {
        res.setHeader('Retry-After', String(rateLimitResult.retryAfterSec));
        sendError(res, 429, 'Too many requests.', [
          { code: 'RATE_LIMITED', error: 'Rate limit exceeded.' }
        ]);
        return;
      }

      next();
    };
  }

  async function applyInboxEvents(events) {
    const appliedEvents = processIncomingEventsFn(events, worldState, {
      afterEachApply: () => enforceStateCapacity(worldState, securityOptions.stateLimits)
    });
    worldState.meta.paperclip.lastSyncAt = new Date().toISOString();
    worldState.meta.paperclip.lastSyncError = null;
    worldState.meta.paperclip.lastPolledCount = Array.isArray(events)
      ? events.length
      : 0;
    broadcastState();
    return appliedEvents.length;
  }

  const paperclipApiUrl =
    configuredPaperclipSync.apiUrl || process.env.PAPERCLIP_API_URL || null;
  const paperclipApiKey =
    configuredPaperclipSync.apiKey || process.env.PAPERCLIP_API_KEY || null;
  if (paperclipSyncEnabled && paperclipApiUrl && paperclipApiKey) {
    paperclipPoller = createPaperclipPoller({
      apiUrl: paperclipApiUrl,
      apiKey: paperclipApiKey,
      intervalMs: pollIntervalMs,
      fetchImpl: configuredPaperclipSync.fetchImpl,
      endpointPath:
        configuredPaperclipSync.endpointPath || '/api/agents/me/inbox-lite',
      onEvents: applyInboxEvents,
      onError: error => {
        worldState.meta.paperclip.lastSyncError = error.message;
        console.error('Paperclip polling failed:', error.message);
      }
    });
    paperclipPoller.start();
  }

  app.use(
    express.json({ limit: options.jsonBodyLimit || DEFAULT_JSON_BODY_LIMIT })
  );

  app.use((req, res, next) => {
    const cors = evaluateCorsOrigin(req, securityOptions);

    if (cors.hasOrigin) {
      addVaryHeader(res, 'Origin');

      if (!cors.allowed) {
        sendError(res, 403, 'Forbidden.', [
          {
            code: 'CORS_ORIGIN_FORBIDDEN',
            error: 'Origin is not allowed by CORS policy.'
          }
        ]);
        return;
      }

      res.setHeader('Access-Control-Allow-Origin', cors.origin);
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'authorization,content-type');
      res.setHeader('Access-Control-Max-Age', '600');
    }

    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  const projectRoot = path.resolve(__dirname, '..');
  app.use('/assets', express.static(path.join(projectRoot, 'assets')));
  app.use(express.static(path.join(projectRoot, 'frontend')));

  app.post('/events', guardAndRateLimitHttp('events'), (req, res, next) => {
    try {
      const incomingCount = Array.isArray(req.body) ? req.body.length : 1;
      if (incomingCount > securityOptions.maxEventBatchSize) {
        throw new RequestGuardError(
          413,
          'Event batch exceeds the configured limit.',
          [
            {
              code: 'EVENT_BATCH_LIMIT_EXCEEDED',
              limit: securityOptions.maxEventBatchSize,
              current: incomingCount
            }
          ]
        );
      }

      const appliedEvents = processIncomingEventsFn(req.body, worldState, {
        afterEachApply: () =>
          enforceStateCapacity(worldState, securityOptions.stateLimits)
      });
      broadcastState();
      res.status(200).json({
        status: 'ok',
        processed: appliedEvents.length,
        events: appliedEvents.map(event => ({
          eventType: event.eventType,
          agentId: event.agentId,
          taskId: event.taskId,
          runId: event.runId,
          timestamp: event.timestamp
        }))
      });
    } catch (err) {
      if (err instanceof EventValidationError) {
        sendError(res, err.statusCode, err.message, err.details);
        return;
      }

      if (err instanceof RequestGuardError) {
        sendError(res, err.statusCode, err.message, err.details);
        return;
      }

      next(err);
    }
  });

  app.get('/state', guardAndRateLimitHttp('state'), (req, res) => {
    res.status(200).json({ status: 'ok', data: worldState });
  });

  app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  app.post(
    '/auth/ws-ticket',
    guardAndRateLimitHttp('ws_ticket'),
    (req, res, next) => {
      try {
        const ticketPayload = wsTicketStore.issue(req.authSubject);
        res.status(201).json({
          status: 'ok',
          ...ticketPayload
        });
      } catch (error) {
        if (error instanceof WsTicketIssueError) {
          sendError(res, 503, 'WS ticket issuance failed.', [
            {
              code: error.code || 'WS_TICKET_ISSUE_FAILED',
              error: error.message
            }
          ]);
          return;
        }

        next(error);
      }
    }
  );

  app.post(
    '/sync/paperclip',
    guardAndRateLimitHttp('paperclip_sync'),
    async (req, res) => {
      if (!paperclipPoller) {
        sendError(
          res,
          503,
          'Paperclip polling is disabled. Configure PAPERCLIP_SYNC_INTERVAL_MS or createServer({ paperclipSync }).'
        );
        return;
      }

      try {
        const result = await paperclipPoller.pollNow();
        res.status(200).json({
          status: 'ok',
          fetched: result.fetched,
          emitted: result.emitted
        });
      } catch (error) {
        worldState.meta.paperclip.lastSyncError = error.message;
        sendError(res, 502, 'Paperclip sync failed.', [
          {
            code: 'PAPERCLIP_SYNC_FAILED',
            error: error.message
          }
        ]);
      }
    }
  );

  server.on('upgrade', (request, socket, head) => {
    const wsTicket = getWsTicketFromUrl(request.url);
    const auth = wsTicketStore.consume(wsTicket);
    if (!auth.ok) {
      rejectUpgrade(
        socket,
        auth.statusCode,
        auth.statusCode === 401 ? 'Unauthorized' : 'Forbidden'
      );
      return;
    }

    const rateKey = `ws_upgrade:${request.socket.remoteAddress || 'unknown'}:${auth.subject}`;
    const rateLimitResult = consumeRateLimit(rateKey);
    if (!rateLimitResult.allowed) {
      rejectUpgrade(socket, 429, 'Too Many Requests', rateLimitResult.retryAfterSec);
      return;
    }

    wss.handleUpgrade(request, socket, head, ws => {
      ws.authSubject = auth.subject;
      wss.emit('connection', ws, request);
    });
  });

  // WebSocket connection for the front-end
  wss.on('connection', ws => {
    // Send current state to new client
    ws.send(JSON.stringify({ type: 'state', data: worldState }));
  });

  app.use((err, req, res, next) => {
    if (
      err instanceof SyntaxError &&
      err.status === 400 &&
      Object.prototype.hasOwnProperty.call(err, 'body')
    ) {
      sendError(res, 400, 'Malformed JSON body.', [
        {
          code: 'MALFORMED_JSON',
          error: 'Malformed JSON body.'
        }
      ]);
      return;
    }

    next(err);
  });

  app.use((err, req, res, next) => {
    console.error(err);

    if (err instanceof RequestGuardError) {
      sendError(res, err.statusCode, err.message, err.details);
      return;
    }

    sendError(res, 500, 'Internal server error.');
  });

  return {
    app,
    server,
    wss,
    worldState,
    wsTicketStore,
    broadcastState,
    paperclipPoller,
    stopBackgroundWorkers: () => {
      if (paperclipPoller) {
        paperclipPoller.stop();
      }
    }
  };
}

function startServer(port = process.env.PORT || 3000, options = {}) {
  const runtime = createServer(options);
  const listenPort = Number(port);

  return new Promise(resolve => {
    runtime.server.listen(listenPort, () => {
      resolve({
        ...runtime,
        port: runtime.server.address().port
      });
    });
  });
}

if (require.main === module) {
  startServer().then(({ port }) => {
    console.log(`Agent World server running on http://localhost:${port}`);
  });
}

module.exports = {
  RequestGuardError,
  createServer,
  startServer
};
