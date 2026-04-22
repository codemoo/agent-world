// Client-side history of the world state and discrete events. Two rings:
//
//   • snapshots[] — per-second lightweight snapshot of every live avatar
//     ({x, y, status, bubbleText, toolIcon, toolName, displayName}).
//     Backs the timeline scrubber. 60 entries (~60s window).
//   • events[] — discrete events derived from snapshot-to-snapshot diffs:
//     session_started, session_ended, status changed, new tool, entered
//     error. Backs the event log panel. 200 entries (~3 minutes of churn).
//
// Sources:
//   • WorldMap's `avatarRuntime` Map (authoritative for rendering state).
//   • worldMap.state.agents (authoritative for server-side status/tool).
//
// We don't read from `runtime.toolPopAt` as the source of truth for tool
// events — pop is rate-limited and would under-count. We read tool-use
// deltas straight from server state (avatar.tool.name + inputPreview
// tuple), which is what the adapter already computed.

const SNAPSHOT_INTERVAL_MS = 1000;
const SNAPSHOT_WINDOW = 60;
const EVENT_LIMIT = 200;

export default class HistoryBuffer {
  constructor({ worldMap, window: win = window } = {}) {
    this.worldMap = worldMap;
    this.window = win;
    this.snapshots = []; // oldest → newest
    this.events = [];    // oldest → newest
    this._lastAgentSnap = new Map(); // sessionId → last-snap state (for diff)
    this._firstSeenAt = new Map();   // sessionId → ms when first snapshot captured
    this._tickHandle = win.setInterval(() => this._tick(), SNAPSHOT_INTERVAL_MS);
    // Initial fill so the event log doesn't start blank.
    this._tick();
  }

  _collectAvatarState() {
    const runtime = this.worldMap?.avatarRuntime;
    const state = this.worldMap?.state;
    const agentsMap = (state && state.agents) || {};
    const out = {};
    for (const id of Object.keys(agentsMap)) {
      const a = agentsMap[id];
      if (!a || !a.sessionId) continue;
      const rt = runtime ? runtime.get(id) : null;
      out[id] = {
        id,
        sessionId: a.sessionId || id,
        x: rt ? rt.x : null,
        y: rt ? rt.y : null,
        prevX: rt ? rt.prevX : null,
        prevY: rt ? rt.prevY : null,
        direction: rt ? rt.direction : 'down',
        name: a.name || (rt && rt.displayName) || id,
        status: a.status || (rt && rt.serverStatus) || 'Idle',
        toolName: a.tool?.name || null,
        toolIcon: a.tool?.icon || (rt && rt.toolIcon) || null,
        toolKey: a.tool?.name
          ? `${a.tool.name}::${a.tool.inputPreview || ''}`
          : '',
        bubble: (rt && rt.bubbleText) || '',
        hatHue: rt ? rt.hatHue : null,
        repoLabel: a.repoLabel || null,
        productiveUntil: rt?.productiveUntil || 0,
        fadeOpacity: rt?.fadeOpacity ?? 1
      };
    }
    return out;
  }

  _tick() {
    const now = Date.now();
    const agents = this._collectAvatarState();

    // Diff against last snap → emit events.
    for (const id of Object.keys(agents)) {
      const cur = agents[id];
      const prev = this._lastAgentSnap.get(id);
      if (!prev) {
        if (!this._firstSeenAt.has(id)) {
          this._firstSeenAt.set(id, now);
          this._push('session_started', now, id, cur, `${cur.name} started`);
        }
        continue;
      }
      if (prev.status !== cur.status) {
        this._push('status_changed', now, id, cur,
          `${cur.name} · ${prev.status} → ${cur.status}`);
      }
      if (cur.toolKey && cur.toolKey !== prev.toolKey) {
        const label = cur.toolName || 'tool';
        this._push('tool_invoked', now, id, cur,
          `${cur.name} · ${cur.toolIcon || '⚙'} ${label}`);
      }
    }
    // Detect session_ended: ids in prev but not in current.
    for (const id of this._lastAgentSnap.keys()) {
      if (!agents[id]) {
        const prev = this._lastAgentSnap.get(id);
        this._push('session_ended', now, id, prev,
          `${prev.name} signed off`);
      }
    }

    // Commit snapshot.
    this.snapshots.push({ ts: now, agents });
    if (this.snapshots.length > SNAPSHOT_WINDOW) this.snapshots.shift();
    this._lastAgentSnap = new Map(Object.entries(agents));
    for (const id of Array.from(this._firstSeenAt.keys())) {
      if (!agents[id]) this._firstSeenAt.delete(id);
    }
    // Notify listeners (scrubber, event log).
    const detail = { snapshotCount: this.snapshots.length, eventCount: this.events.length };
    this.window.dispatchEvent(new CustomEvent('history-updated', { detail }));
  }

  _push(kind, ts, sessionId, agentState, label) {
    const ev = {
      id: `${ts}-${sessionId}-${kind}-${this.events.length}`,
      kind, ts, sessionId,
      name: agentState?.name || sessionId,
      status: agentState?.status || null,
      toolName: agentState?.toolName || null,
      toolIcon: agentState?.toolIcon || null,
      label
    };
    this.events.push(ev);
    if (this.events.length > EVENT_LIMIT) {
      // Drop oldest ~20 to reduce churn vs. dropping one at a time.
      this.events.splice(0, 20);
    }
    this.window.dispatchEvent(new CustomEvent('history-event', { detail: ev }));
  }

  getSnapshots() { return this.snapshots; }
  getEvents() { return this.events; }

  // Nearest snapshot at-or-before the target timestamp, or null if none.
  getSnapshotAt(targetMs) {
    const snaps = this.snapshots;
    if (!snaps.length) return null;
    if (targetMs >= snaps[snaps.length - 1].ts) return snaps[snaps.length - 1];
    for (let i = snaps.length - 1; i >= 0; i--) {
      if (snaps[i].ts <= targetMs) return snaps[i];
    }
    return snaps[0];
  }

  destroy() {
    if (this._tickHandle) this.window.clearInterval(this._tickHandle);
  }
}
