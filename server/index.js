const express = require('express');
const fs = require('fs');
const http = require('http');
const path = require('path');
const WebSocket = require('ws');
const {
  createWorldModel,
  createVillageGrid,
  LOCATION_DEFS,
  OUTDOOR_STATIONS,
  WORLD_WIDTH,
  WORLD_HEIGHT
} = require('../adapter/paperclipAdapter');
const { generateTrees } = require('../adapter/treeGenerator');
const {
  loadOrSeed,
  saveLayout,
  buildSeedLayout,
  validateLayout,
  DEFAULT_LAYOUT_PATH
} = require('./worldLayout');
const {
  EventValidationError,
  processIncomingEvents
} = require('./eventsPipeline');
const { createPaperclipPoller } = require('./paperclipSync');
const { createAssetManager } = require('./assetManager');
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
  // Behind a reverse proxy (FRP, nginx, cloudflare…) the socket protocol
  // can be http while the user-facing origin is https. Trust the
  // X-Forwarded-Proto header to decide same-origin.
  const forwardedProto =
    typeof req.headers?.['x-forwarded-proto'] === 'string'
      ? req.headers['x-forwarded-proto'].split(',')[0].trim()
      : '';
  const protocol = forwardedProto || req.protocol || 'http';
  const requestOrigin = host ? `${protocol}://${host}` : null;
  // Also accept the flipped-protocol variant so we don't block when the
  // proxy forwards without setting x-forwarded-proto at all.
  const flippedOrigin = host
    ? `${protocol === 'https' ? 'http' : 'https'}://${host}`
    : null;
  const sameOrigin = Boolean(
    (requestOrigin && rawOrigin === requestOrigin) ||
    (flippedOrigin && rawOrigin === flippedOrigin)
  );
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

function cleanupWorldState(worldState, stateLimits) {
  const runs = Object.values(worldState.runs || {});
  if (runs.length > stateLimits.maxRuns * 0.9) {
    // Sort by updatedAt or completedAt and remove oldest 10%
    runs.sort((a, b) => {
      const timeA = a.updatedAt || a.completedAt || '';
      const timeB = b.updatedAt || b.completedAt || '';
      return timeA.localeCompare(timeB);
    });

    const toRemove = runs.slice(0, Math.ceil(stateLimits.maxRuns * 0.2));
    toRemove.forEach(run => {
      delete worldState.runs[run.id];
    });
  }

  // Cleanup old tasks for each agent
  Object.values(worldState.agents || {}).forEach(agent => {
    if (Array.isArray(agent.tasks) && agent.tasks.length > 100) {
      agent.tasks.sort((a, b) => {
        const timeA = a.updatedAt || '';
        const timeB = b.updatedAt || '';
        return timeA.localeCompare(timeB);
      });
      agent.tasks = agent.tasks.slice(-50);
    }
  });
}

function isAllowedUpgradeOrigin(request, securityOptions) {
  const cors = evaluateCorsOrigin(
    {
      headers: request?.headers || {},
      protocol: request?.socket?.encrypted ? 'https' : 'http'
    },
    securityOptions
  );

  return {
    hasOrigin: cors.hasOrigin,
    allowed: cors.allowed
  };
}

function createWorldState(layout = null) {
  return {
    world: createWorldModel(layout),
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

// Seed world-layout.json on first run: flatten in-code LOCATION_DEFS +
// OUTDOOR_STATIONS and procedurally generate the initial tree set.
function seedWorldLayout() {
  const tiles = createVillageGrid(WORLD_WIDTH, WORLD_HEIGHT);
  const locations = LOCATION_DEFS.map(loc => ({
    x: loc.x, y: loc.y, w: loc.w, h: loc.h
  }));
  const trees = generateTrees(WORLD_WIDTH, WORLD_HEIGHT, locations, tiles);
  return buildSeedLayout({
    locationDefs: LOCATION_DEFS,
    outdoorStations: OUTDOOR_STATIONS,
    trees
  });
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
  // Trust reverse proxy (FRP / nginx / cloudflare) so req.protocol reflects
  // X-Forwarded-Proto and req.ip reflects X-Forwarded-For. Required for
  // external-tunnel deployments to compute same-origin correctly.
  app.set('trust proxy', true);
  const server = http.createServer(app);
  const wss = new WebSocket.Server({ noServer: true });
  // Load persisted world layout (or seed from code defaults on first run).
  // `options.worldLayoutPath` lets tests point at an isolated file.
  const layoutPath = options.worldLayoutPath || DEFAULT_LAYOUT_PATH;
  const worldLayoutContainer = { current: loadOrSeed(seedWorldLayout, layoutPath) };
  const worldState = createWorldState(worldLayoutContainer.current);
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
      afterEachApply: () => {
        cleanupWorldState(worldState, securityOptions.stateLimits);
        enforceStateCapacity(worldState, securityOptions.stateLimits);
      }
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
  const paperclipCompanyId =
    configuredPaperclipSync.companyId ??
    (options.paperclipSync ? null : (process.env.PAPERCLIP_COMPANY_ID || null));
  if (paperclipSyncEnabled && paperclipApiUrl && paperclipApiKey) {
    paperclipPoller = createPaperclipPoller({
      apiUrl: paperclipApiUrl,
      apiKey: paperclipApiKey,
      intervalMs: pollIntervalMs,
      fetchImpl: configuredPaperclipSync.fetchImpl,
      endpointPath:
        configuredPaperclipSync.endpointPath || '/api/agents/me/inbox-lite',
      companyId: paperclipCompanyId,
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
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,OPTIONS');
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

  const assetManager = createAssetManager({ projectRoot });

  // Serve index.html with injected runtime config (auth token)
  const frontendDir = path.join(projectRoot, 'frontend');
  function frontendMtime(filename) {
    try {
      return fs.statSync(path.join(frontendDir, filename)).mtimeMs | 0;
    } catch (_) {
      return Date.now();
    }
  }
  function serveHtmlWithRuntime(res, filename, scriptFile) {
    const filePath = path.join(frontendDir, filename);
    fs.readFile(filePath, 'utf8', (err, html) => {
      if (err) {
        res.status(500).send(`Failed to load ${filename}`);
        return;
      }
      const runtimeConfig = JSON.stringify({
        authToken: securityOptions.apiToken || ''
      });
      // Append mtime-based cache-buster to the script src.
      const v = frontendMtime(scriptFile);
      const injectedHtml = html
        .replace(
          `<script src="${scriptFile}" type="module"></script>`,
          `<script>window.__AGENT_WORLD_RUNTIME__=${runtimeConfig};</script>\n    <script src="${scriptFile}?v=${v}" type="module"></script>`
        );
      // Never cache the HTML itself.
      res.setHeader('Cache-Control', 'no-store');
      res.type('html').send(injectedHtml);
    });
  }
  app.get('/', (req, res) => {
    serveHtmlWithRuntime(res, 'index.html', 'main.js');
  });
  app.get('/assets-manager', (req, res) => {
    serveHtmlWithRuntime(res, 'assetsManager.html', 'assetsManager.js');
  });
  // Force no-cache on frontend JS/HTML so edits propagate to browsers
  // without manual hard-refresh. Static assets (images/PNG) still cache.
  app.use(express.static(frontendDir, {
    etag: false,
    lastModified: false,
    cacheControl: false,
    setHeaders(res, filePath) {
      if (/\.(?:m?js|html)$/i.test(filePath)) {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
      }
    }
  }));

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
        afterEachApply: () => {
          cleanupWorldState(worldState, securityOptions.stateLimits);
          enforceStateCapacity(worldState, securityOptions.stateLimits);
        }
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

  // World layout editing — GET returns current JSON, PUT saves new layout.
  // PUT rebuilds worldState.world (stations / trees) while preserving
  // agents, avatars, runs, and meta so editing doesn't reset the session.
  app.get('/api/world/layout', guardAndRateLimitHttp('world_layout'), (req, res) => {
    res.status(200).json({ status: 'ok', data: worldLayoutContainer.current });
  });

  app.put('/api/world/layout', guardAndRateLimitHttp('world_layout'), (req, res) => {
    try {
      const incoming = req.body;
      validateLayout(incoming);
      const saved = saveLayout(incoming, layoutPath);
      worldLayoutContainer.current = saved;
      // Rebuild just the world portion of state; keep session state intact.
      worldState.world = createWorldModel(saved);
      broadcastState();
      res.status(200).json({ status: 'ok', data: saved });
    } catch (err) {
      sendError(res, 400, 'Invalid world layout.', [
        { code: 'WORLD_LAYOUT_INVALID', message: err.message }
      ]);
    }
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

  // --- Asset management endpoints ---
  const assetGuard = guardAndRateLimitHttp('assets');

  app.get('/api/assets/sheets', assetGuard, (req, res) => {
    try {
      const payload = assetManager.listSheets();
      res.status(200).json({ status: 'ok', ...payload });
    } catch (error) {
      sendError(res, 500, 'Failed to list asset sheets.', [
        { code: 'ASSET_LIST_FAILED', error: error.message }
      ]);
    }
  });

  app.get('/api/assets/search', assetGuard, (req, res) => {
    try {
      const q = typeof req.query.q === 'string' ? req.query.q.trim().toLowerCase() : '';
      const category = typeof req.query.category === 'string' ? req.query.category : null;
      const tags = typeof req.query.tags === 'string'
        ? req.query.tags.split(',').map(t => t.trim().toLowerCase()).filter(Boolean)
        : [];
      const limit = Math.min(
        Math.max(parseInt(req.query.limit || '50', 10) || 50, 1),
        500
      );
      const scope = req.query.scope || 'sheets'; // sheets | groups | props
      const results = assetManager.search({ q, category, tags, limit, scope });
      res.status(200).json({ status: 'ok', ...results });
    } catch (error) {
      sendError(res, 500, 'Asset search failed.', [
        { code: 'ASSET_SEARCH_FAILED', error: error.message }
      ]);
    }
  });

  app.get('/api/assets/catalog', assetGuard, (req, res) => {
    try {
      const catalog = assetManager.catalog();
      res.status(200).json({ status: 'ok', ...catalog });
    } catch (error) {
      sendError(res, 500, 'Asset catalog failed.', [
        { code: 'ASSET_CATALOG_FAILED', error: error.message }
      ]);
    }
  });

  app.get('/api/assets/sheets/:id', assetGuard, (req, res) => {
    const sheet = assetManager.getSheet(req.params.id);
    if (!sheet) {
      sendError(res, 404, 'Sheet not found.');
      return;
    }
    res.status(200).json({ status: 'ok', sheet });
  });

  app.put('/api/assets/sheets/:id', assetGuard, (req, res) => {
    const sheet = assetManager.updateSheet(req.params.id, req.body || {});
    if (!sheet) {
      sendError(res, 404, 'Sheet not found.');
      return;
    }
    res.status(200).json({ status: 'ok', sheet });
  });

  app.post('/api/assets/sheets/:id/auto-slice', assetGuard, (req, res) => {
    const sheet = assetManager.autoSlice(req.params.id, req.body || {});
    if (!sheet) {
      sendError(res, 404, 'Sheet not found.');
      return;
    }
    res.status(200).json({ status: 'ok', sheet });
  });

  app.post('/api/assets/sheets/:id/props', assetGuard, (req, res) => {
    const prop = assetManager.addProp(req.params.id, req.body || {});
    if (!prop) {
      sendError(res, 404, 'Sheet not found.');
      return;
    }
    res.status(201).json({ status: 'ok', prop });
  });

  app.put('/api/assets/sheets/:id/props/:propId', assetGuard, (req, res) => {
    const prop = assetManager.updateProp(
      req.params.id,
      req.params.propId,
      req.body || {}
    );
    if (!prop) {
      sendError(res, 404, 'Prop not found.');
      return;
    }
    res.status(200).json({ status: 'ok', prop });
  });

  app.delete('/api/assets/sheets/:id/props/:propId', assetGuard, (req, res) => {
    const ok = assetManager.deleteProp(req.params.id, req.params.propId);
    if (!ok) {
      sendError(res, 404, 'Prop not found.');
      return;
    }
    res.status(200).json({ status: 'ok' });
  });

  server.on('upgrade', (request, socket, head) => {
    const wsOrigin = isAllowedUpgradeOrigin(request, securityOptions);
    if (wsOrigin.hasOrigin && !wsOrigin.allowed) {
      console.warn('[ws-upgrade] rejected: origin not allowed', {
        origin: request.headers.origin,
        host: request.headers.host,
        forwardedProto: request.headers['x-forwarded-proto']
      });
      rejectUpgrade(
        socket,
        403,
        'Forbidden'
      );
      return;
    }

    const wsTicket = getWsTicketFromUrl(request.url);
    const auth = wsTicketStore.consume(wsTicket);
    if (!auth.ok) {
      console.warn('[ws-upgrade] rejected: ticket invalid', {
        status: auth.statusCode,
        hasTicket: Boolean(wsTicket)
      });
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
      console.warn('[ws-upgrade] rejected: rate limited', {
        retryAfterSec: rateLimitResult.retryAfterSec
      });
      rejectUpgrade(socket, 429, 'Too Many Requests', rateLimitResult.retryAfterSec);
      return;
    }

    wss.handleUpgrade(request, socket, head, ws => {
      ws.authSubject = auth.subject;
      wss.emit('connection', ws, request);
    });
  });

  // WebSocket connection for the front-end
  wss.on('connection', (ws, request) => {
    const subject = ws.authSubject || 'anon';
    const host = request?.headers?.host || 'unknown';
    console.log('[ws] connected', { subject, host, clients: wss.clients.size });
    // Send current state to new client
    ws.send(JSON.stringify({ type: 'state', data: worldState }));
    ws.on('close', (code, reason) => {
      console.log('[ws] closed', {
        subject, code, reason: reason?.toString?.().slice(0, 80),
        clients: wss.clients.size
      });
    });
    ws.on('error', err => {
      console.log('[ws] error', { subject, msg: err.message });
    });
  });

  // Periodic keepalive ping. We just emit pings at 20s intervals so idle
  // proxies (FRP/nginx/cloudflare) see traffic and don't close the
  // connection. We do NOT forcibly terminate on missed pongs — the
  // browser and underlying TCP will detect a real disconnection, and
  // being too aggressive here caused flapping when the round-trip
  // exceeded our threshold.
  const wsHeartbeatInterval = setInterval(() => {
    wss.clients.forEach(ws => {
      if (ws.readyState === 1 /* OPEN */) {
        try { ws.ping(); } catch (_) {}
      }
    });
  }, 20000);
  wss.on('close', () => clearInterval(wsHeartbeatInterval));

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
      clearInterval(wsHeartbeatInterval);
    }
  };
}

function startServer(port = process.env.PORT || 3102, options = {}) {
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
  startServer,
  cleanupWorldState
};
