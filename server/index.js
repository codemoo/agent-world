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
} = require('../adapter/worldModel');
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
const { createClaudeSnapshotter } = require('./claudeSnapshotter');
const { createPermissionStore } = require('./permissionStore');
const { createBuildingAssignments } = require('./buildingAssignments');
const { applySnapshotToWorld } = require('../adapter/claudeAdapter');
const { createStateDiffBroadcast } = require('./stateDiffBroadcast');
const { createPtyManager } = require('./ptyServer');
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
    const removedIds = new Set();
    toRemove.forEach(run => {
      removedIds.add(run.id);
      delete worldState.runs[run.id];
    });

    // Clear stale currentRunId references from agents
    if (removedIds.size > 0) {
      Object.values(worldState.agents || {}).forEach(agent => {
        if (agent.currentRunId && removedIds.has(agent.currentRunId)) {
          agent.currentRunId = null;
        }
      });
    }
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
      claude: {
        enabled: false,
        sessionsObserved: 0,
        lastSnapshotAt: null
      }
    }
  };
}

// Seed world-layout.json on first run. Preference order:
//   1. data/world-layout.default.json — the curated baseline shipped
//      with the repo. Every fresh clone lands on the same hand-arranged
//      world without looking half-procedural.
//   2. Procedural fallback from LOCATION_DEFS + OUTDOOR_STATIONS +
//      generateTrees() in case the baseline file is missing.
function seedWorldLayout() {
  const baselinePath = path.join(__dirname, '..', 'data', 'world-layout.default.json');
  if (fs.existsSync(baselinePath)) {
    try {
      return JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
    } catch (err) {
      console.warn('[seed] failed to read baseline layout, falling back to procedural', err.message);
    }
  }
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
  // Separate WS server for PTY streams so we can apply different framing.
  const ptyWss = new WebSocket.Server({ noServer: true });
  const ptyManager = createPtyManager({
    // Pass a getter fn so the manager always sees the current snapshotter
    // reference (it's assigned later in this function).
    claudeSnapshotter: () => claudeSnapshotter,
    idleTimeoutMs: options.ptyIdleTimeoutMs || undefined
  });
  // Load persisted world layout (or seed from code defaults on first run).
  // `options.worldLayoutPath` lets tests point at an isolated file.
  const layoutPath = options.worldLayoutPath || DEFAULT_LAYOUT_PATH;
  const worldLayoutContainer = { current: loadOrSeed(seedWorldLayout, layoutPath) };
  const worldState = createWorldState(worldLayoutContainer.current);
  const wsTicketStoreFactory =
    typeof options.createWsTicketStore === 'function'
      ? options.createWsTicketStore
      : createWsTicketStore;
  const wsTicketStore = wsTicketStoreFactory({
    ttlMs: securityOptions.wsTicketTtlMs,
    maxEntries: securityOptions.maxWsTicketEntries
  });

  function _sendToAll(payload) {
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

  // Pending-permissions store — receives PreToolUse hook POSTs and
  // pushes pending requests over WS for the browser to Allow/Deny.
  const permissionStore = createPermissionStore({
    timeoutMs: Number(process.env.AGENT_WORLD_PERMISSION_TIMEOUT_MS) || 90_000
  });
  permissionStore.events.on('permission-request', (ev) => {
    _sendToAll(JSON.stringify({ type: 'permission-request', data: ev }));
  });
  permissionStore.events.on('permission-resolved', (ev) => {
    _sendToAll(JSON.stringify({ type: 'permission-resolved', data: ev }));
  });

  const diffBroadcaster = createStateDiffBroadcast({
    debounceMs: options.broadcastDebounceMs || 50,
    sendFull: _sendToAll,
    sendPatch: _sendToAll,
    // Diffing is safe once the frontend applies merge-patches. Until that
    // lands (Phase 7 — see /patch handler), keep full snapshots on each flush.
    emitFull: options.broadcastEmitFull !== undefined ? options.broadcastEmitFull : true
  });

  /**
   * Broadcast the current world state to all connected clients.
   * Debounced via stateDiffBroadcast.
   */
  function broadcastState() {
    diffBroadcaster.schedule(worldState);
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

  // Claude Code session visualizer: read ~/.claude sessions and project them
  // into the world. Sole data source as of the Paperclip cutover (Phase 6).
  const claudeEnabled = options.claudeSync?.enabled !== false;
  let claudeSnapshotter = null;
  let buildingAssignments = null;
  if (claudeEnabled) {
    const dataDirOverride = process.env.AGENT_WORLD_DATA_DIR;
    const defaultAssignmentsPath = dataDirOverride && dataDirOverride.trim()
      ? path.join(dataDirOverride.trim(), 'repoAssignments.json')
      : path.join(path.resolve(__dirname, '..'), 'data', 'repoAssignments.json');
    const assignmentsPath = options.claudeSync?.assignmentsPath || defaultAssignmentsPath;
    buildingAssignments = createBuildingAssignments(assignmentsPath);
    claudeSnapshotter = createClaudeSnapshotter({
      tickMs: options.claudeSync?.tickMs || 1000
    });
    claudeSnapshotter.on('snapshot', snap => {
      try {
        const { activeBuildingKeys } = applySnapshotToWorld({
          snapshot: snap,
          worldState,
          buildings: buildingAssignments
        });
        buildingAssignments.tick({
          activeBuildingKeys,
          tickMs: options.claudeSync?.tickMs || 1000
        });
        worldState.meta.claude.enabled = true;
        worldState.meta.claude.sessionsObserved = snap.sessions.length;
        worldState.meta.claude.lastSnapshotAt = new Date(snap.takenAtMs).toISOString();
        // Persist assignments every 30s.
        const nowMs = Date.now();
        if (!claudeSnapshotter._lastPersistMs || nowMs - claudeSnapshotter._lastPersistMs > 30_000) {
          try { buildingAssignments.persist(); } catch { /* non-fatal */ }
          claudeSnapshotter._lastPersistMs = nowMs;
        }
        broadcastState();
      } catch (err) {
        console.error('[claude-sync] apply failed:', err.message);
      }
    });
    claudeSnapshotter.on('error', err => {
      console.error('[claude-sync] snapshotter error:', err.message);
    });
    claudeSnapshotter.start();
    console.log('[claude-sync] started — reading ~/.claude/sessions + hook events');
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
  // Soft-404 for the asset manifest so pages render cleanly without the
  // PixyMoon pack installed (see README). The WorldMap falls back to
  // programmatic drawing when the manifest is empty.
  app.get('/assets/pixymoon/Cute%20RPG%20World/asset-manifest.json', (req, res, next) => {
    const full = path.join(projectRoot, 'assets', 'pixymoon', 'Cute RPG World', 'asset-manifest.json');
    fs.access(full, fs.constants.R_OK, (err) => {
      if (err) {
        res.setHeader('Cache-Control', 'no-store');
        res.status(200).json({ version: 1, sheets: [], sprites: [], groups: [] });
        return;
      }
      next();
    });
  });
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

  // Aggregated health snapshot for the Claude Code visualizer pivot.
  app.get('/healthz', (req, res) => {
    const snap = claudeSnapshotter?.lastSessions;
    const sessionsObserved = snap ? snap.size : 0;
    const memMB = Math.round(process.memoryUsage().rss / 1024 / 1024);
    res.status(200).json({
      status: 'ok',
      sessionsObserved,
      buildingsActive: buildingAssignments?._state?.buildings?.length || 0,
      tentsActive: buildingAssignments?._state?.tents?.length || 0,
      lastSnapshotAt: worldState.meta?.claude?.lastSnapshotAt || null,
      memMB,
      uptimeSec: Math.round(process.uptime())
    });
  });

  // List live Claude sessions (quick overview for the frontend).
  app.get('/api/sessions', guardAndRateLimitHttp('sessions'), (req, res) => {
    const snap = claudeSnapshotter?.lastSessions;
    if (!snap) {
      res.status(200).json({ status: 'ok', sessions: [] });
      return;
    }
    const sessions = [];
    for (const [id, s] of snap) {
      sessions.push({
        sessionId: id,
        pid: s.pid,
        status: s.status,
        cwd: s.cwd,
        repoRoot: s.repoRoot,
        name: s.name,
        lastHookEvent: s.lastHookEvent || null
      });
    }
    res.status(200).json({ status: 'ok', sessions });
  });

  // Per-session detail: includes transcript preview (last msg, tool, model).
  app.get('/api/sessions/:sessionId', guardAndRateLimitHttp('sessions'), async (req, res) => {
    const snap = claudeSnapshotter?.lastSessions;
    const session = snap?.get(req.params.sessionId);
    if (!session) {
      sendError(res, 404, 'Session not found.');
      return;
    }
    let preview = null;
    if (session.transcriptPath) {
      try {
        const { getTail } = require('./transcriptPreview');
        preview = await getTail(session.transcriptPath);
      } catch (err) {
        console.warn('[sessions] transcript preview failed:', err.message);
      }
    }
    const costTotals = claudeSnapshotter?.costTracker?.get?.(session.sessionId) || null;
    res.status(200).json({
      status: 'ok',
      data: {
        sessionId: session.sessionId,
        pid: session.pid,
        cwd: session.cwd,
        repoRoot: session.repoRoot,
        status: session.status,
        startedAtMs: session.startedAtMs,
        version: session.version,
        kind: session.kind,
        transcriptPath: session.transcriptPath,
        lastHookEvent: session.lastHookEvent,
        lastAssistantMessage: preview?.lastAssistantMessage || null,
        lastUserMessage: preview?.lastUserMessage || null,
        lastToolUse: preview?.lastToolUse || null,
        lastModel: preview?.lastModel || null,
        gitBranch: preview?.gitBranch || null,
        cost: costTotals
      }
    });
  });

  // Hook endpoint — our PreToolUse hook script POSTs here with JSON:
  //   { sessionId, tool, toolInput, cwd }
  // The response comes back after the browser clicks Allow/Deny or
  // after the timeout. Decision shape:
  //   { decision: 'allow' | 'deny' | 'ask', reason? }
  // Hook auth: local-only; the hook runs on the same host as this
  // server and we don't fingerprint it. We gate by `127.0.0.1` to
  // keep remote callers out. Browser auth (bearer + ws ticket) still
  // applies to /api/permissions/:id/decide.
  app.post('/api/hooks/permission-request', (req, res) => {
    // Use the raw TCP peer rather than `req.ip`, which respects
    // X-Forwarded-For when `trust proxy` is on and can be spoofed.
    const peer = (req.socket && req.socket.remoteAddress) || '';
    const remote = peer.replace(/^::ffff:/, '');
    if (remote !== '127.0.0.1' && remote !== '::1' && remote !== 'localhost') {
      sendError(res, 403, 'Hook endpoint is localhost-only.');
      return;
    }
    const body = req.body || {};
    const payload = {
      sessionId: String(body.sessionId || '').slice(0, 200),
      tool: String(body.tool || 'unknown').slice(0, 100),
      toolInput: body.toolInput || null,
      cwd: body.cwd ? String(body.cwd).slice(0, 500) : null
    };
    const created = permissionStore.createRequest(payload);
    // `createRequest` returns { requestId, promise } or a bare Promise
    // when the queue is full (overflow fallback).
    const promise = created && created.promise ? created.promise : created;
    if (!promise || typeof promise.then !== 'function') {
      res.status(200).json({ decision: 'ask', reason: 'store-unavailable' });
      return;
    }
    promise.then(result => {
      res.status(200).json(result);
    }).catch(err => {
      console.error('[permission] request failed:', err.message);
      if (!res.headersSent) res.status(200).json({ decision: 'ask', reason: 'error' });
    });
  });

  // Browser → server. Users click Allow / Deny in the toast; the
  // server resolves the pending promise back to the hook.
  app.post('/api/permissions/:requestId/decide', guardAndRateLimitHttp('sessions'), (req, res) => {
    const decision = String((req.body && req.body.decision) || '').toLowerCase();
    const reason = (req.body && req.body.reason) || null;
    const ok = permissionStore.decide(req.params.requestId, decision, reason);
    if (!ok) {
      sendError(res, 404, 'No pending permission with that id.');
      return;
    }
    res.status(200).json({ status: 'ok', decision });
  });

  // Debugging / observability — lists the currently-pending permission
  // requests. The browser doesn't need this (it receives WS events),
  // but it's useful for probes + a cold-start fallback if the client
  // connected AFTER the request was created.
  app.get('/api/permissions/pending', guardAndRateLimitHttp('sessions'), (req, res) => {
    res.status(200).json({ status: 'ok', pending: permissionStore.snapshot() });
  });

  // World-wide cost aggregate — per-session breakdown + sum across all
  // live sessions. Used by the top-left "village total" badge.
  app.get('/api/cost', guardAndRateLimitHttp('sessions'), (req, res) => {
    const tracker = claudeSnapshotter?.costTracker;
    if (!tracker) {
      res.status(200).json({ status: 'ok', worldTotals: null, bySession: {} });
      return;
    }
    res.status(200).json({
      status: 'ok',
      worldTotals: tracker.worldTotals(),
      bySession: tracker.snapshot()
    });
  });

  // Forward-slice of the transcript, normalized into render-ready entries
  // for the in-browser TUI. Uses an opaque byte cursor for incremental polls.
  app.get('/api/sessions/:sessionId/transcript', guardAndRateLimitHttp('sessions'), async (req, res) => {
    const snap = claudeSnapshotter?.lastSessions;
    const session = snap?.get(req.params.sessionId);
    if (!session) { sendError(res, 404, 'Session not found.'); return; }
    if (!session.transcriptPath) { sendError(res, 404, 'No transcript for this session.'); return; }

    const cursorRaw = req.query?.cursor;
    const cursor = typeof cursorRaw === 'string' && cursorRaw.length > 0 ? cursorRaw : null;
    const limit = Math.min(500, Math.max(1, Number(req.query?.limit) || 120));

    try {
      const { getSlice } = require('./transcriptPreview');
      const slice = await getSlice(session.transcriptPath, { cursor, limit });
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json({
        status: 'ok',
        data: {
          sessionId: session.sessionId,
          cwd: session.cwd,
          mtimeMs: slice.mtimeMs,
          size: slice.size,
          gitBranch: slice.gitBranch,
          model: slice.model,
          cursor: slice.cursor,
          truncated: slice.truncated,
          resync: slice.resync,
          entries: slice.entries
        }
      });
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        sendError(res, 410, 'Transcript has disappeared.', [
          { code: 'TRANSCRIPT_GONE', error: err.message }
        ]);
        return;
      }
      sendError(res, 500, 'Failed to read transcript.', [
        { code: 'TRANSCRIPT_SLICE_FAILED', error: err.message }
      ]);
    }
  });

  // Focus the terminal tab for a session. Full implementation in Phase 9;
  // for now, return 501 with a hint.
  app.post('/api/sessions/:sessionId/focus', guardAndRateLimitHttp('sessions'), (req, res) => {
    try {
      const { focusSessionTerminal } = require('./terminalFocus');
      const snap = claudeSnapshotter?.lastSessions;
      const session = snap?.get(req.params.sessionId);
      if (!session) { sendError(res, 404, 'Session not found.'); return; }
      focusSessionTerminal(session).then(
        result => res.status(200).json({ status: 'ok', ...result }),
        err => sendError(res, 500, 'Focus failed.', [{ code: 'FOCUS_FAILED', error: err.message }])
      );
    } catch (err) {
      sendError(res, 501, 'Terminal focus not available.', [
        { code: 'FOCUS_UNAVAILABLE', error: err.message }
      ]);
    }
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

  // Paperclip integration removed in the Claude Code pivot (Phase 6).
  // Archived source + restore instructions live at legacy/paperclip/README.md.
  function paperclipGone(_req, res) {
    res.status(410).json({
      status: 'gone',
      error: 'Paperclip sync was removed. See legacy/paperclip/README.md to restore.',
      archivedAt: 'legacy/paperclip/'
    });
  }
  app.post('/sync/paperclip', paperclipGone);
  app.get('/sync/paperclip/companies', paperclipGone);
  app.put('/sync/paperclip/company', paperclipGone);

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

    // Route by pathname. `/ws/pty` → PTY server; anything else → main state.
    const urlPath = (() => {
      try { return new URL(request.url, 'http://x').pathname; }
      catch { return request.url || '/'; }
    })();

    if (urlPath === '/ws/pty') {
      const u = (() => { try { return new URL(request.url, 'http://x'); } catch { return null; } })();
      const sessionId = u?.searchParams?.get('sessionId') || '';
      const cols = Number(u?.searchParams?.get('cols')) || undefined;
      const rows = Number(u?.searchParams?.get('rows')) || undefined;
      const cwd = u?.searchParams?.get('cwd') || null;
      const mode = u?.searchParams?.get('mode') || 'claude';
      if (!sessionId) {
        rejectUpgrade(socket, 400, 'Bad Request');
        return;
      }
      ptyWss.handleUpgrade(request, socket, head, ws => {
        ws.authSubject = auth.subject;
        ptyManager.attach(ws, { sessionId, cwd, cols, rows, mode });
      });
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
    diffBroadcaster.emitFullNow(worldState, p => ws.send(p));
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
    ptyWss,
    ptyManager,
    worldState,
    wsTicketStore,
    broadcastState,
    claudeSnapshotter,
    buildingAssignments,
    stopBackgroundWorkers: async () => {
      if (claudeSnapshotter) claudeSnapshotter.stop();
      if (buildingAssignments) {
        try { buildingAssignments.persist(); } catch { /* non-fatal */ }
      }
      if (ptyManager) ptyManager.stopAll();
      if (permissionStore) permissionStore.destroy();
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
