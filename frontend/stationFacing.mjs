// Resolve the direction an agent should face after arriving at a
// station. Pure function — no side effects.
//
// Return values:
//   'up' | 'down' | 'left' | 'right' — force this facing.
//   null — keep the arrival direction (social stations, ambiguous types).
//
// Rules (Codex-reviewed, Phase B):
//   - Explicit station.facing always wins.
//   - Work props (desks/monitors/archives/mining/foraging): 'up' — the
//     prop sprite is conventionally drawn behind (north of) the tile.
//   - Bed: 'up' — sleep frame reads cleaner with a fixed orientation.
//   - Rest outdoor social (plaza, park bench variants, garden, sofas,
//     plants, nightstand-side-tables): null — social framing is
//     better-preserved by the arrival-walk direction.
//   - outdoor.napping: 'up' — sleep is read vertically.

export function computeStationFacing(station) {
  if (!station) return null;
  if (typeof station.facing === 'string' && station.facing) return station.facing;

  const type = String(station.type || '');

  // Outdoor explicit.
  if (type === 'outdoor.fishing')  return 'up';
  if (type === 'outdoor.mining')   return 'up';
  if (type === 'outdoor.foraging') return 'up';
  if (type === 'outdoor.napping')  return 'up';
  if (type === 'outdoor.flowers')  return null;
  if (type === 'outdoor.chatting') return null;
  if (type === 'outdoor.reading')  return null;
  if (type === 'outdoor.sitting')  return null;
  if (type === 'outdoor.watching') return null;

  // Indoor work props — prop drawn north of tile.
  if (type.startsWith('bookshelf')) return 'up';
  if (type.startsWith('cabinet'))   return 'up';
  if (type.startsWith('display'))   return 'up';
  if (type.startsWith('dresser'))   return 'up';
  if (type === 'safe')              return 'up';
  if (type.startsWith('stove'))     return 'up';
  if (type === 'counter')           return 'up';
  if (type.startsWith('table'))     return 'up';

  // Indoor rest — social framing.
  if (type.startsWith('sofa'))      return null;
  if (type.startsWith('plant'))     return null;
  if (type.startsWith('nightstand')) return null;

  // Chairs lean toward the work prop they're paired with; default 'up'.
  if (type === 'chair' || type.startsWith('chair.')) return 'up';

  // Beds — facing up is the canonical sleep pose.
  if (type.startsWith('bed')) return 'up';

  // Fallback by station.kind.
  if (station.kind === 'work') return 'up';
  return null;
}
