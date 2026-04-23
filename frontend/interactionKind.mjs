// Derive a semantic "interactionKind" for a runtime avatar from its
// current destination + intent. Pure function — no side effects.
//
// See /tmp/aw-plan/v5-plan.md §interactionKindFor for the canonical
// mapping. 19 possible outputs, covering every real station.type in
// adapter/worldModel.js and every intent.kind emitted by
// adapter/claudeAdapter.js.
//
// Contract: every input combination produces a defined output. The
// only fallback is 'wander', reserved for (a) no destination, (b) no
// station in lookup, (c) genuinely unrecognized station.type.

// Outputs — documented in the plan, surfaces a pose + emote table in
// WorldMap.js (Phase 2) and Phase C.2 (mining/foraging split).
export const INTERACTION_KINDS = Object.freeze([
  'desk', 'lounge', 'bed', 'tavern', 'tavern_seat', 'monitor_wall',
  'archive', 'cooking', 'break_area', 'queue_slot', 'exit', 'plaza',
  'park_bench', 'garden', 'nap_spot', 'fishing_spot',
  'mining', 'foraging',
  'frozen', 'wander'
]);

const OUTDOOR_TYPE_MAP = {
  'outdoor.chatting':  'plaza',
  'outdoor.reading':   'park_bench',
  'outdoor.sitting':   'park_bench',
  'outdoor.watching':  'park_bench',
  'outdoor.flowers':   'garden',
  'outdoor.napping':   'nap_spot',
  'outdoor.fishing':   'fishing_spot',
  'outdoor.mining':    'mining',
  'outdoor.foraging':  'foraging'
};

const INDOOR_SPECIFIC_TYPE_MAP = {
  // beds
  'bed.wide.pink':     'bed',
  'bed.wide.blue':     'bed',
  // monitors
  'display':           'monitor_wall',
  'display.alt':       'monitor_wall',
  // archives
  'bookshelf':         'archive',
  'bookshelf.full':    'archive',
  'bookshelf.scroll':  'archive',
  'safe':              'archive',
  // cooking
  'stove':             'cooking',
  'stove.alt':         'cooking',
  // lounges
  'sofa':              'lounge',
  'sofa.alt':          'lounge',
  'sofa.alt2':         'lounge',
  // plants = break/decor
  'plant.pink':        'break_area',
  'plant.purple':      'break_area'
};

export function interactionKindFor(runtime, stationLookup) {
  const intentKind = runtime?.intent?.kind;

  // Intent-driven overrides from claudeAdapter synthetic destinations.
  if (intentKind === 'to_info_desk')  return 'queue_slot';
  if (intentKind === 'to_exit_fade')  return 'exit';
  if (intentKind === 'to_tavern')     return 'tavern';
  if (intentKind === 'frozen')        return 'frozen';

  const dest = runtime?.currentDestination;
  if (!dest) return 'wander';

  // Cafe building → every station inside is tavern-like.
  if (dest.locationId === 'cafe') return 'tavern_seat';

  const stationId = dest.stationId;
  if (!stationId || !stationLookup) return 'wander';
  const st = stationLookup[stationId];
  if (!st || typeof st.type !== 'string') return 'wander';

  const type = st.type;

  // Most-specific maps first.
  const outdoor = OUTDOOR_TYPE_MAP[type];
  if (outdoor) return outdoor;
  const indoor = INDOOR_SPECIFIC_TYPE_MAP[type];
  if (indoor) return indoor;

  // Ambiguous types (chair / chair.alt / table.* / dresser* / cabinet.* /
  // nightstand* / counter) defer to station.kind. Same type can be a
  // desk chair in home_ne or a cafe lounge chair, so we can't decide
  // from the type alone.
  if (st.kind === 'work') return 'desk';
  if (st.kind === 'rest') return 'break_area';

  // Schema drift — safe default.
  return 'wander';
}
