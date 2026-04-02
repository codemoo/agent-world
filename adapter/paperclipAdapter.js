/**
 * Transforms Paperclip events into Agent World state mutations.
 *
 * The exported functions should apply the event to the provided worldState.
 * This file contains only a stub implementation; customise it to match your Paperclip event schema.
 */

/**
 * @param {object} event – raw event data from Paperclip
 * @param {object} worldState – mutable in‑memory world state
 */
function handlePaperclipEvent(event, worldState) {
  const { event_type, agent_id, task_id, timestamp, payload } = event;
  // Ensure agent exists
  if (!worldState.agents[agent_id]) {
    worldState.agents[agent_id] = { id: agent_id, zone: 'idle', tasks: [] };
  }

  switch (event_type) {
    case 'task_created':
      worldState.agents[agent_id].tasks.push({
        id: task_id,
        status: 'created',
        label: payload?.label || ''
      });
      break;
    case 'task_assigned':
      worldState.agents[agent_id].zone = 'planning';
      break;
    case 'tool_called':
      worldState.agents[agent_id].zone = 'tools';
      break;
    case 'task_completed':
      worldState.agents[agent_id].zone = 'done';
      break;
    case 'run_completed':
      worldState.agents[agent_id].zone = 'idle';
      break;
    default:
      // Unknown events are ignored for now
      break;
  }
}

module.exports = { handlePaperclipEvent };