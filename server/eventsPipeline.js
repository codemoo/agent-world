const {
  normalizePaperclipEvent,
  validatePaperclipEvent,
  applyPaperclipEvent
} = require('../legacy/paperclip/paperclipAdapter');

class EventValidationError extends Error {
  constructor(message, details = []) {
    super(message);
    this.name = 'EventValidationError';
    this.statusCode = 400;
    this.details = details;
  }
}

function cloneState(state) {
  if (typeof globalThis.structuredClone === 'function') {
    return globalThis.structuredClone(state);
  }

  return JSON.parse(JSON.stringify(state));
}

function replaceState(targetState, nextState) {
  Object.keys(targetState).forEach(key => {
    delete targetState[key];
  });
  Object.assign(targetState, nextState);
}

function normalizeEventBatch(input) {
  if (Array.isArray(input)) {
    if (input.length === 0) {
      throw new EventValidationError('Event array must not be empty.', [
        { index: 0, error: 'At least one event is required.' }
      ]);
    }
    return input;
  }

  if (typeof input === 'object' && input !== null) {
    return [input];
  }

  throw new EventValidationError('Request body must be an event object or array.');
}

function processIncomingEvents(input, worldState, options = {}) {
  const applyEvent =
    typeof options.applyEvent === 'function'
      ? options.applyEvent
      : applyPaperclipEvent;
  const afterEachApply =
    typeof options.afterEachApply === 'function' ? options.afterEachApply : null;
  const rawEvents = normalizeEventBatch(input);
  const normalizedEvents = [];
  const errors = [];

  rawEvents.forEach((rawEvent, index) => {
    try {
      const event = normalizePaperclipEvent(rawEvent);
      validatePaperclipEvent(event);
      normalizedEvents.push(event);
    } catch (error) {
      errors.push({ index, error: error.message });
    }
  });

  if (errors.length > 0) {
    throw new EventValidationError('One or more events are invalid.', errors);
  }

  const snapshot = cloneState(worldState);

  try {
    normalizedEvents.forEach(event => {
      applyEvent(event, worldState);
      if (afterEachApply) {
        afterEachApply(worldState, event);
      }
    });
  } catch (error) {
    replaceState(worldState, snapshot);
    throw error;
  }

  return normalizedEvents;
}

module.exports = {
  EventValidationError,
  processIncomingEvents
};
