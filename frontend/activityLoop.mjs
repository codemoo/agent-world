// Phase D — per-station activity beats during long dwells.
//
// While an agent is seated at a station during a long dwell, swap the
// persistent emote briefly on a dephased cadence so the scene reads as
// "actively doing" rather than "frozen."
//
// Codex-trimmed scope: only the kinds with a clear semantic read.
//   mining    ⛏ → 💥   (pick strike)
//   foraging  🌿 → 🧺   (gathering into basket)
//   archive   — → 📄   (page turn — no persistent emote otherwise)
//
// Skipped (Codex):
//   - fishing_spot (💧 abstract, reads as glitch)
//   - desk typing (renderer already bobs)
//   - monitor_wall (no good beat icon)
//
// Pure function — no side effects. Caller is responsible for calling
// only when `runtime.seated` AND no higher-priority emote is active
// (tool-pop, reaction, arrival one-shot, chat bubble).

const LOOPS = {
  mining:    { period: 1400, beatStart: 1000, beatEnd: 1200, emote: '💥' },
  foraging:  { period: 1800, beatStart: 1200, beatEnd: 1450, emote: '🧺' },
  archive:   { period: 2600, beatStart: 2000, beatEnd: 2220, emote: '📄' }
};

// Returns { emoteOverride } where emoteOverride is the beat emote if
// we're inside the beat window, otherwise null. Callers should only
// overwrite persistentEmote when emoteOverride is non-null.
export function computeActivityLoop(kind, agentSeed, now) {
  const loop = LOOPS[kind];
  if (!loop) return { emoteOverride: null };

  // Dephase per agent: offset into the loop period by a seeded phase.
  const phase = (Number.isFinite(agentSeed) ? agentSeed : 0) % loop.period;
  const t = ((now | 0) + phase) % loop.period;

  if (t >= loop.beatStart && t < loop.beatEnd) {
    return { emoteOverride: loop.emote };
  }
  return { emoteOverride: null };
}

// Exported for tests to verify the catalog is in sync with callers.
export const ACTIVITY_LOOP_KINDS = Object.freeze(Object.keys(LOOPS));
