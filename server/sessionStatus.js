// Pure classifier: session snapshot → status string.
// No I/O. All timing values are millisecond epoch.

const STATUSES = Object.freeze({
  Working: 'Working',
  Waiting: 'Waiting',
  Errored: 'Errored',
  Idle: 'Idle',
  IdleStale: 'IdleStale',
  Finished: 'Finished'
});

const HOOK = Object.freeze({
  SessionStart: 'SessionStart',
  SessionEnd: 'SessionEnd',
  Stop: 'Stop',
  UserPromptSubmit: 'UserPromptSubmit',
  PermissionRequest: 'PermissionRequest',
  SubagentStart: 'SubagentStart',
  SubagentStop: 'SubagentStop',
  PostToolUse: 'PostToolUse',
  PostToolUseFailure: 'PostToolUseFailure',
  CwdChanged: 'CwdChanged'
});

function ageMs(nowMs, whenMs) {
  if (!Number.isFinite(whenMs)) return Infinity;
  return Math.max(0, nowMs - whenMs);
}

// Pid dead but session metadata/transcript still around.
// We give a 5s grace to avoid flickering between tick reads.
const PID_DEATH_GRACE_MS = 5_000;

// If no Claude activity at all in this window, call it IdleStale.
const IDLE_STALE_MS = 120_000;

function classify({
  now,
  pidAlive,
  pidSeenAliveAtMs,
  lastHookEvent,          // { type, ts } | null
  transcriptMtimeMs,       // number | null
  cpuPercent               // number | null
}) {
  const hookAge = lastHookEvent ? ageMs(now, lastHookEvent.ts) : Infinity;
  const transcriptAge = transcriptMtimeMs ? ageMs(now, transcriptMtimeMs) : Infinity;
  const cpu = Number.isFinite(cpuPercent) ? cpuPercent : 0;

  if (lastHookEvent?.type === HOOK.SessionEnd) return STATUSES.Finished;
  if (!pidAlive && pidSeenAliveAtMs && ageMs(now, pidSeenAliveAtMs) > PID_DEATH_GRACE_MS) {
    return STATUSES.Finished;
  }
  if (lastHookEvent?.type === HOOK.PermissionRequest && hookAge < 10 * 60_000) {
    return STATUSES.Waiting;
  }
  if (lastHookEvent?.type === HOOK.PostToolUseFailure && hookAge < 30_000) {
    return STATUSES.Errored;
  }
  if (
    (lastHookEvent?.type === HOOK.UserPromptSubmit ||
      lastHookEvent?.type === HOOK.SubagentStart) &&
    hookAge < 60_000
  ) {
    return STATUSES.Working;
  }
  if (lastHookEvent?.type === HOOK.Stop && transcriptAge > 15_000) {
    return STATUSES.Idle;
  }
  if (transcriptAge < 8_000 || cpu > 2) return STATUSES.Working;
  if (transcriptAge < IDLE_STALE_MS) return STATUSES.Idle;
  return STATUSES.IdleStale;
}

module.exports = { STATUSES, HOOK, classify };
