const crypto = require('node:crypto');

const DEFAULT_WS_TICKET_TTL_MS = 15_000;
const DEFAULT_WS_TICKET_MAX_ENTRIES = 10_000;

class WsTicketIssueError extends Error {
  constructor(message, code = 'WS_TICKET_ISSUE_FAILED') {
    super(message);
    this.name = 'WsTicketIssueError';
    this.code = code;
  }
}

function toPositiveInteger(value, fallbackValue) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : fallbackValue;
}

function getWsTicketFromUrl(urlValue) {
  if (typeof urlValue !== 'string') {
    return null;
  }

  try {
    const parsed = new URL(urlValue, 'http://127.0.0.1');
    const ticket =
      parsed.searchParams.get('ticket') || parsed.searchParams.get('ws_ticket');
    return ticket && ticket.trim().length > 0 ? ticket.trim() : null;
  } catch (_error) {
    return null;
  }
}

function createWsTicketStore(options = {}) {
  const nowFn = typeof options.now === 'function' ? options.now : () => Date.now();
  const randomBytesFn =
    typeof options.randomBytes === 'function'
      ? options.randomBytes
      : size => crypto.randomBytes(size);
  const ttlMs = toPositiveInteger(options.ttlMs, DEFAULT_WS_TICKET_TTL_MS);
  const maxEntries = toPositiveInteger(
    options.maxEntries,
    DEFAULT_WS_TICKET_MAX_ENTRIES
  );
  const entries = new Map();

  function pruneExpired(nowMs) {
    for (const [ticket, entry] of entries.entries()) {
      if (entry.expiresAtMs <= nowMs) {
        entries.delete(ticket);
      }
    }
  }

  function pruneOverflow() {
    while (entries.size >= maxEntries) {
      const first = entries.keys().next();
      if (first.done) {
        return;
      }
      entries.delete(first.value);
    }
  }

  function generateTicket() {
    return randomBytesFn(24).toString('base64url');
  }

  return {
    issue(subject = 'api-token') {
      const nowMs = nowFn();
      pruneExpired(nowMs);
      pruneOverflow();

      let ticket = generateTicket();
      let attempts = 0;
      while (entries.has(ticket) && attempts < 5) {
        ticket = generateTicket();
        attempts += 1;
      }

      if (entries.has(ticket)) {
        throw new WsTicketIssueError(
          'Failed to generate a unique WS ticket after maximum retries.',
          'WS_TICKET_COLLISION_LIMIT_EXCEEDED'
        );
      }

      const expiresAtMs = nowMs + ttlMs;
      entries.set(ticket, {
        subject,
        issuedAtMs: nowMs,
        expiresAtMs,
        used: false
      });

      return {
        ticket,
        ttlMs,
        expiresAt: new Date(expiresAtMs).toISOString()
      };
    },

    consume(ticketValue) {
      const ticket =
        typeof ticketValue === 'string' ? ticketValue.trim() : '';
      if (!ticket) {
        return {
          ok: false,
          statusCode: 401,
          code: 'WS_TICKET_REQUIRED'
        };
      }

      const nowMs = nowFn();
      pruneExpired(nowMs);

      const entry = entries.get(ticket);
      if (!entry) {
        return {
          ok: false,
          statusCode: 403,
          code: 'WS_TICKET_INVALID'
        };
      }

      if (entry.used) {
        return {
          ok: false,
          statusCode: 403,
          code: 'WS_TICKET_REPLAYED'
        };
      }

      entry.used = true;
      entry.usedAtMs = nowMs;
      entries.set(ticket, entry);

      return {
        ok: true,
        subject: entry.subject
      };
    }
  };
}

module.exports = {
  DEFAULT_WS_TICKET_MAX_ENTRIES,
  DEFAULT_WS_TICKET_TTL_MS,
  WsTicketIssueError,
  createWsTicketStore,
  getWsTicketFromUrl
};
