const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const {
  EventValidationError,
  processIncomingEvents
} = require('./eventsPipeline');

function createWorldState() {
  return {
    agents: {},
    zones: {},
    runs: {}
  };
}

function sendError(res, statusCode, message, details) {
  const body = { error: message };
  if (Array.isArray(details) && details.length > 0) {
    body.details = details;
  }
  res.status(statusCode).json(body);
}

function createServer(options = {}) {
  const processIncomingEventsFn =
    typeof options.processIncomingEvents === 'function'
      ? options.processIncomingEvents
      : processIncomingEvents;
  const app = express();
  const server = http.createServer(app);
  const wss = new WebSocket.Server({ server });
  const worldState = createWorldState();

  /**
   * Broadcast the current world state to all connected clients.
   */
  function broadcastState() {
    const payload = JSON.stringify({ type: 'state', data: worldState });
    wss.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    });
  }

  app.use(express.json());
  app.post('/events', (req, res) => {
    try {
      const appliedEvents = processIncomingEventsFn(req.body, worldState);
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

      throw err;
    }
  });

  app.get('/state', (req, res) => {
    res.status(200).json({ status: 'ok', data: worldState });
  });

  app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  // WebSocket connection for the front‑end
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
    sendError(res, 500, err.message || 'Internal server error.');
  });

  return {
    app,
    server,
    wss,
    worldState,
    broadcastState
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
  createServer,
  startServer
};
