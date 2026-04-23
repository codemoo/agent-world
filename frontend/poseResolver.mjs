// Map (interactionKind, serverStatus) → pose + persistentEmote for
// client-side rendering. Pure function called once per tick per agent.
//
// Poses are additive to the existing `seated` state from avatarRuntime —
// they're applied as micro-transforms (y-bob, scale, facing flip) and
// overhead emotes during sprite render. No new spritesheet frames.
//
// See /tmp/aw-plan/v5-plan.md Phase 2 for the pose table.

// Pose identifiers consumed by the renderer.
export const POSES = Object.freeze({
  IDLE:            'idle',
  LEANING:         'leaning',
  TYPING:          'typing',
  DRINKING:        'drinking',
  IMPATIENT:       'impatient',
  STRETCHING:      'stretching',
  WATCHING:        'watching',
  SLEEPING:        'sleeping',
  WAVING_GOODBYE:  'waving_goodbye'
});

// Returns { pose, emote } for a runtime at `now`. Emote is the
// persistent Lane-0 icon (rendered when no tool-pop/reaction is
// active). Pose is the body-language class.
//
// The caller owns runtime.stretchUntil / runtime.farewellUntil
// lifecycle (set on arrival, cleared naturally when the timestamp
// passes). This function only reads them.
export function resolvePose(runtime, now) {
  const kind = runtime && runtime.interactionKind;
  const status = runtime && runtime.serverStatus;

  // One-shot timed poses take priority while their window is open.
  if (runtime && runtime.farewellUntil && now < runtime.farewellUntil) {
    return { pose: POSES.WAVING_GOODBYE, emote: '👋' };
  }
  if (runtime && runtime.stretchUntil && now < runtime.stretchUntil) {
    return { pose: POSES.STRETCHING, emote: null };
  }

  // Errored overlay trumps station for 2s after entering Errored.
  // Uses runtime.erroredPoseUntil so the sprite doesn't constantly
  // read the errored face (that's a reaction, handled in Phase 3).
  if (runtime && runtime.erroredPoseUntil && now < runtime.erroredPoseUntil) {
    return { pose: POSES.LEANING, emote: '😔' };
  }

  // Phase C.3 — arrival one-shots for leisure stations that otherwise
  // have no persistent emote. Makes the "sit down" moment readable.
  // Lower priority than farewell/stretch/errored; higher than station.
  if (runtime && runtime.arrivalOneShotUntil && now < runtime.arrivalOneShotUntil) {
    return {
      pose: runtime.arrivalOneShotPose || POSES.LEANING,
      emote: runtime.arrivalOneShotEmote || null
    };
  }

  switch (kind) {
    case 'desk':
      return {
        pose: status === 'Working' ? POSES.TYPING : POSES.LEANING,
        emote: null
      };
    case 'archive':
      return {
        pose: status === 'Working' ? POSES.TYPING : POSES.LEANING,
        emote: null
      };
    case 'tavern':
    case 'tavern_seat':
      return { pose: POSES.DRINKING, emote: '🍺' };
    case 'monitor_wall':
      return { pose: POSES.WATCHING, emote: '📺' };
    case 'bed':
    case 'nap_spot':
      return { pose: POSES.SLEEPING, emote: '💤' };
    case 'lounge':
    case 'park_bench':
      return { pose: POSES.LEANING, emote: null };
    case 'plaza':
      return { pose: POSES.LEANING, emote: null };
    case 'garden':
      return { pose: POSES.LEANING, emote: null };
    case 'fishing_spot':
      return { pose: POSES.WATCHING, emote: '🎣' };
    case 'mining':
      return { pose: POSES.TYPING, emote: '⛏' };
    case 'foraging':
      return { pose: POSES.TYPING, emote: '🌿' };
    case 'break_area':
      return { pose: POSES.LEANING, emote: null };
    case 'queue_slot':
      return {
        pose: status === 'Waiting' ? POSES.IMPATIENT : POSES.IDLE,
        emote: null
      };
    case 'exit':
      // Farewell handled above via farewellUntil; when window is closed
      // the sprite is just fading out — no pose.
      return { pose: POSES.IDLE, emote: null };
    case 'frozen':
      return { pose: POSES.IDLE, emote: null };
    case 'wander':
    default:
      return { pose: POSES.IDLE, emote: null };
  }
}
