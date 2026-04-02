const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { handlePaperclipEvent } = require('../adapter/paperclipAdapter');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

/**
 * Simple in‑memory world state. In a real application you may persist this to a database.
 */
const worldState = {
  agents: {},
  zones: {},
  runs: {}
};

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

// Example endpoint for receiving events from Paperclip via HTTP POST.
// In production you might use gRPC, AMQP, Kafka or direct integration.
app.use(express.json());
app.post('/events', (req, res) => {
  try {
    const event = req.body;
    // Normalize and apply the event to the world state
    handlePaperclipEvent(event, worldState);
    // Notify front‑end clients
    broadcastState();
    res.status(200).json({ status: 'ok' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// WebSocket connection for the front‑end
wss.on('connection', ws => {
  // Send current state to new client
  ws.send(JSON.stringify({ type: 'state', data: worldState }));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Agent World server running on http://localhost:${PORT}`);
});