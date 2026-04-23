// Pure world geometry — shared between Paperclip (legacy) and Claude adapters.
// No data-source coupling. Safe to import from any adapter.

const WORLD_WIDTH = 30;
const WORLD_HEIGHT = 30;
const DEFAULT_TILE_TYPE = 'grass';

const FLOOR_WOOD = '#d4b88c';
const FLOOR_TILE = '#b8c4d0';
const FLOOR_CARPET = '#b89976';
const FLOOR_SOFT = '#e0d0a8';
const FLOOR_CONCRETE = '#a8a8a0';
const FLOOR_RED = '#b07060';
const FLOOR_GREEN = '#8fa878';
const FLOOR_DARK = '#6b5a42';

const LOCATION_DEFS = [
  {
    id: 'home_nw', name: 'Architect Studio', type: 'house', x: 2, y: 2, w: 5, h: 6,
    zones: [
      { x1: 0, y1: 0, x2: 5, y2: 2, floor: FLOOR_CARPET },
      { x1: 0, y1: 2, x2: 5, y2: 6, floor: FLOOR_SOFT }
    ],
    interiorWalls: [
      { x1: 0, y1: 2, x2: 2, y2: 2 },
      { x1: 3, y1: 2, x2: 5, y2: 2 }
    ],
    stations: [
      { id: 'nw_w1',        kind: 'work', type: 'bookshelf',         dx: 1, dy: 0, label: 'refs' },
      { id: 'nw_w2',        kind: 'work', type: 'bookshelf.full',    dx: 2, dy: 0, label: 'archive' },
      { id: 'nw_plant',     kind: 'rest', type: 'plant.purple',      dx: 3, dy: 0, label: 'studio plant' },
      { id: 'nw_chair',     kind: 'work', type: 'chair',             dx: 1, dy: 1, label: 'design chair' },
      { id: 'nw_desk',      kind: 'work', type: 'table.mid',         dx: 2, dy: 1, label: 'drafting desk' },
      { id: 'nw_bed',       kind: 'rest', type: 'bed.wide.pink',     dx: 1, dy: 2, label: 'bed' },
      { id: 'nw_wardrobe',  kind: 'rest', type: 'cabinet.wood.alt',  dx: 3, dy: 2, label: 'wardrobe' },
      { id: 'nw_dresser',   kind: 'rest', type: 'dresser',           dx: 1, dy: 3, label: 'dresser' },
      { id: 'nw_nightstand',kind: 'rest', type: 'nightstand',        dx: 2, dy: 3, label: 'nightstand' },
      { id: 'nw_sofa',      kind: 'rest', type: 'sofa',              dx: 3, dy: 3, label: 'reading sofa' },
      { id: 'nw_table',     kind: 'rest', type: 'table.tiny',        dx: 2, dy: 4, label: 'side table' },
      { id: 'nw_chair2',    kind: 'rest', type: 'chair.alt',         dx: 3, dy: 4, label: 'accent chair' }
    ]
  },
  {
    id: 'home_ne', name: 'QA Lab', type: 'house2', x: 23, y: 2, w: 6, h: 4,
    zones: [
      { x1: 0, y1: 0, x2: 4, y2: 4, floor: FLOOR_CONCRETE },
      { x1: 4, y1: 0, x2: 6, y2: 4, floor: FLOOR_TILE }
    ],
    interiorWalls: [
      { x1: 4, y1: 0, x2: 4, y2: 1 },
      { x1: 4, y1: 2, x2: 4, y2: 4 }
    ],
    stations: [
      { id: 'ne_mon1',    kind: 'work', type: 'dresser.beer',      dx: 1, dy: 0, label: 'monitor 1' },
      { id: 'ne_chair1',  kind: 'work', type: 'chair',             dx: 2, dy: 0, label: 'analyst 1' },
      { id: 'ne_mon2',    kind: 'work', type: 'dresser.alt',       dx: 3, dy: 0, label: 'monitor 2' },
      { id: 'ne_bench',   kind: 'work', type: 'table.mid',         dx: 1, dy: 1, label: 'prep bench' },
      { id: 'ne_chair2',  kind: 'work', type: 'chair.alt',         dx: 2, dy: 1, label: 'analyst 2' },
      { id: 'ne_safe',    kind: 'work', type: 'safe',              dx: 3, dy: 1, label: 'sample safe' },
      { id: 'ne_docs',    kind: 'work', type: 'bookshelf.scroll',  dx: 1, dy: 2, label: 'test docs' },
      { id: 'ne_display', kind: 'work', type: 'display',           dx: 2, dy: 2, label: 'test display' },
      { id: 'ne_sofa',    kind: 'rest', type: 'sofa',              dx: 3, dy: 2, label: 'break seat' },
      { id: 'ne_rack',    kind: 'work', type: 'cabinet.metal',     dx: 4, dy: 0, label: 'rack A' },
      { id: 'ne_rack2',   kind: 'work', type: 'cabinet.metal.alt', dx: 4, dy: 1, label: 'rack B' },
      { id: 'ne_case',    kind: 'work', type: 'cabinet.glass',     dx: 4, dy: 2, label: 'sample case' }
    ]
  },
  {
    id: 'cafe', name: 'Agent Lounge', type: 'shop', x: 16, y: 8, w: 5, h: 5,
    zones: [
      { x1: 0, y1: 0, x2: 5, y2: 2, floor: FLOOR_TILE },
      { x1: 0, y1: 2, x2: 5, y2: 5, floor: FLOOR_WOOD }
    ],
    interiorWalls: [
      { x1: 0, y1: 2, x2: 2, y2: 2 },
      { x1: 3, y1: 2, x2: 5, y2: 2 }
    ],
    stations: [
      { id: 'cafe_case',    kind: 'work', type: 'cabinet.glass',   dx: 1, dy: 0, label: 'pastry case' },
      { id: 'cafe_stove',   kind: 'work', type: 'stove',           dx: 2, dy: 0, label: 'main stove' },
      { id: 'cafe_plant',   kind: 'rest', type: 'plant.pink',      dx: 3, dy: 0, label: 'cafe plant' },
      { id: 'cafe_stove2',  kind: 'work', type: 'stove.alt',       dx: 1, dy: 1, label: 'grill' },
      { id: 'cafe_counter', kind: 'work', type: 'counter',         dx: 2, dy: 1, label: 'prep counter' },
      { id: 'cafe_sofa1',   kind: 'rest', type: 'sofa',            dx: 1, dy: 2, label: 'corner booth' },
      { id: 'cafe_sofa2',   kind: 'rest', type: 'sofa.alt',        dx: 3, dy: 2, label: 'window booth' },
      { id: 'cafe_chair1',  kind: 'rest', type: 'chair',           dx: 1, dy: 3, label: 'diner 1' },
      { id: 'cafe_table',   kind: 'rest', type: 'table',           dx: 2, dy: 3, label: 'dining table' },
      { id: 'cafe_chair2',  kind: 'rest', type: 'chair.alt',       dx: 3, dy: 3, label: 'diner 2' },
      { id: 'cafe_sofa3',   kind: 'rest', type: 'sofa.alt2',       dx: 1, dy: 4, label: 'lounge sofa' },
      { id: 'cafe_ns',      kind: 'rest', type: 'nightstand.alt',  dx: 3, dy: 4, label: 'side stand' }
    ]
  },
  {
    id: 'home_sw', name: 'Security HQ', type: 'house.green', x: 2, y: 20, w: 5, h: 6,
    zones: [
      { x1: 0, y1: 0, x2: 5, y2: 3, floor: FLOOR_CONCRETE },
      { x1: 0, y1: 3, x2: 5, y2: 6, floor: FLOOR_SOFT }
    ],
    interiorWalls: [
      { x1: 0, y1: 3, x2: 2, y2: 3 },
      { x1: 3, y1: 3, x2: 5, y2: 3 }
    ],
    stations: [
      { id: 'sw_w1',        kind: 'work', type: 'cabinet.metal',     dx: 1, dy: 0, label: 'evidence' },
      { id: 'sw_w2',        kind: 'work', type: 'cabinet.metal.alt', dx: 2, dy: 0, label: 'armory' },
      { id: 'sw_w3',        kind: 'work', type: 'cabinet.wood.alt',  dx: 3, dy: 0, label: 'gear locker' },
      { id: 'sw_mon1',      kind: 'work', type: 'display',           dx: 1, dy: 1, label: 'monitor 1' },
      { id: 'sw_mon2',      kind: 'work', type: 'display.alt',       dx: 2, dy: 1, label: 'monitor 2' },
      { id: 'sw_safe',      kind: 'work', type: 'safe',              dx: 3, dy: 1, label: 'safe' },
      { id: 'sw_console',   kind: 'work', type: 'table.mid',         dx: 1, dy: 2, label: 'console' },
      { id: 'sw_chair',     kind: 'work', type: 'chair',             dx: 2, dy: 2, label: 'operator' },
      { id: 'sw_records',   kind: 'work', type: 'cabinet.books',     dx: 3, dy: 2, label: 'records' },
      { id: 'sw_nightst',   kind: 'rest', type: 'nightstand',        dx: 1, dy: 3, label: 'nightstand' },
      { id: 'sw_bunk',      kind: 'rest', type: 'bed.wide.blue',     dx: 2, dy: 3, label: 'on-call bunk' },
      { id: 'sw_dresser',   kind: 'rest', type: 'dresser',           dx: 1, dy: 4, label: 'dresser' },
      { id: 'sw_chair2',    kind: 'rest', type: 'chair.alt',         dx: 2, dy: 4, label: 'duty chair' },
      { id: 'sw_table',     kind: 'rest', type: 'table.tiny',        dx: 3, dy: 4, label: 'side table' }
    ]
  },
  {
    id: 'library', name: 'Docs Archive', type: 'house.gray', x: 23, y: 20, w: 6, h: 5,
    zones: [
      { x1: 0, y1: 0, x2: 3, y2: 5, floor: FLOOR_WOOD },
      { x1: 3, y1: 0, x2: 6, y2: 5, floor: FLOOR_GREEN }
    ],
    interiorWalls: [
      { x1: 3, y1: 0, x2: 3, y2: 2 },
      { x1: 3, y1: 3, x2: 3, y2: 5 }
    ],
    stations: [
      { id: 'lib_w1',      kind: 'work', type: 'bookshelf',         dx: 1, dy: 0, label: 'shelf A' },
      { id: 'lib_w2',      kind: 'work', type: 'bookshelf.full',    dx: 2, dy: 0, label: 'shelf B' },
      { id: 'lib_w3',      kind: 'work', type: 'bookshelf.scroll',  dx: 1, dy: 1, label: 'scrolls' },
      { id: 'lib_cab',     kind: 'work', type: 'cabinet.books',     dx: 2, dy: 1, label: 'catalog' },
      { id: 'lib_w4',      kind: 'work', type: 'bookshelf',         dx: 1, dy: 3, label: 'shelf C' },
      { id: 'lib_w5',      kind: 'work', type: 'bookshelf.full',    dx: 2, dy: 3, label: 'shelf D' },
      { id: 'lib_desk',    kind: 'work', type: 'table.mid',         dx: 4, dy: 0, label: 'study desk' },
      { id: 'lib_chair1',  kind: 'work', type: 'chair',             dx: 5, dy: 0, label: 'study chair' },
      { id: 'lib_plant',   kind: 'rest', type: 'plant.purple',      dx: 4, dy: 1, label: 'corner plant' },
      { id: 'lib_sofa',    kind: 'rest', type: 'sofa',              dx: 5, dy: 1, label: 'reading sofa' },
      { id: 'lib_table',   kind: 'rest', type: 'table.tiny',        dx: 4, dy: 3, label: 'side table' },
      { id: 'lib_chair2',  kind: 'rest', type: 'chair.alt',         dx: 5, dy: 3, label: 'lounge chair' }
    ]
  },
  {
    id: 'office', name: 'CEO Office', type: 'tower', x: 10, y: 2, w: 4, h: 4,
    zones: [
      { x1: 0, y1: 0, x2: 4, y2: 4, floor: FLOOR_RED }
    ],
    stations: [
      { id: 'ceo_w1',    kind: 'work', type: 'bookshelf.full',   dx: 1, dy: 0, label: 'private library' },
      { id: 'ceo_safe',  kind: 'work', type: 'safe',             dx: 2, dy: 0, label: 'CEO safe' },
      { id: 'ceo_desk',  kind: 'work', type: 'table.mid',        dx: 1, dy: 1, label: 'CEO desk' },
      { id: 'ceo_chair', kind: 'work', type: 'chair',            dx: 2, dy: 1, label: 'CEO chair' },
      { id: 'ceo_sofa',  kind: 'rest', type: 'sofa',             dx: 1, dy: 2, label: 'guest sofa' },
      { id: 'ceo_table', kind: 'rest', type: 'table.tiny',       dx: 2, dy: 2, label: 'coffee table' }
    ]
  },
  {
    id: 'store', name: 'Deploy Center', type: 'house.green2', x: 2, y: 9, w: 5, h: 4,
    zones: [
      { x1: 0, y1: 0, x2: 5, y2: 4, floor: FLOOR_CONCRETE }
    ],
    stations: [
      { id: 'store_r1',        kind: 'work', type: 'cabinet.metal',    dx: 1, dy: 0, label: 'rack A' },
      { id: 'store_r2',        kind: 'work', type: 'cabinet.metal.alt',dx: 2, dy: 0, label: 'rack B' },
      { id: 'store_vault',     kind: 'work', type: 'safe',             dx: 3, dy: 0, label: 'vault' },
      { id: 'store_counter',   kind: 'work', type: 'counter',          dx: 1, dy: 1, label: 'staging' },
      { id: 'store_drawer',    kind: 'work', type: 'cabinet.drawer',   dx: 2, dy: 1, label: 'parts drawer' },
      { id: 'store_tools',     kind: 'work', type: 'cabinet.wood',     dx: 3, dy: 1, label: 'tools' },
      { id: 'store_desk',      kind: 'work', type: 'table.mid',        dx: 1, dy: 2, label: 'ops desk' },
      { id: 'store_chair',     kind: 'work', type: 'chair',            dx: 2, dy: 2, label: 'ops chair' },
      { id: 'store_case',      kind: 'work', type: 'cabinet.glass',    dx: 3, dy: 2, label: 'sample case' }
    ]
  }
];

const OUTDOOR_STATIONS = [
  { id: 'pond_fish_w',  kind: 'rest', type: 'outdoor.fishing', x: 22, y: 13, label: 'fishing spot', activity: 'fishing by the pond' },
  { id: 'pond_fish_s',  kind: 'rest', type: 'outdoor.watching', x: 24, y: 19, label: 'pond view',   activity: 'watching the water' },
  { id: 'pond_view',    kind: 'rest', type: 'outdoor.sitting', x: 21, y: 17, label: 'park bench',  activity: 'sitting by the pond' },
  { id: 'plaza_bench_n',kind: 'rest', type: 'outdoor.reading', x: 13, y: 12, label: 'plaza bench',  activity: 'reading on a bench' },
  { id: 'plaza_bench_s',kind: 'rest', type: 'outdoor.sitting', x: 15, y: 16, label: 'plaza bench',  activity: 'taking a break' },
  { id: 'plaza_center', kind: 'rest', type: 'outdoor.chatting',x: 14, y: 14, label: 'plaza',        activity: 'chatting at the plaza' },
  { id: 'garden_nw',    kind: 'rest', type: 'outdoor.flowers', x: 10, y: 10, label: 'NW garden',    activity: 'enjoying the flowers' },
  { id: 'garden_ne',    kind: 'rest', type: 'outdoor.flowers', x: 21, y: 7,  label: 'NE garden',    activity: 'smelling the flowers' },
  { id: 'garden_sw',    kind: 'rest', type: 'outdoor.flowers', x: 10, y: 22, label: 'SW garden',    activity: 'picking flowers' },
  { id: 'garden_se',    kind: 'rest', type: 'outdoor.flowers', x: 20, y: 22, label: 'SE garden',    activity: 'strolling the garden' },
  { id: 'mine_n',       kind: 'work', type: 'outdoor.mining',  x: 17, y: 3,  label: 'rock quarry',  activity: 'mining stones' },
  { id: 'mine_s',       kind: 'work', type: 'outdoor.mining',  x: 18, y: 27, label: 'rock pile',    activity: 'breaking rocks' },
  { id: 'forage_w',     kind: 'work', type: 'outdoor.foraging',x: 7,  y: 17, label: 'west woods',   activity: 'foraging berries' },
  { id: 'forage_e',     kind: 'work', type: 'outdoor.foraging',x: 27, y: 8,  label: 'east woods',   activity: 'gathering herbs' },
  { id: 'nap_grass_n',  kind: 'rest', type: 'outdoor.napping', x: 8,  y: 7,  label: 'shady tree',   activity: 'napping under a tree' },
  { id: 'nap_grass_s',  kind: 'rest', type: 'outdoor.napping', x: 21, y: 25, label: 'shady tree',   activity: 'dozing in the grass' }
];

// Build a leisure-rotation pool for a session assigned to `locationId`.
// Returns an array of candidates the agent can visibly rotate through
// while Idle. Each entry is the shape the frontend expects in
// `avatar.destination` so claudeAdapter can splat it directly.
//
// Composition:
//   1. Building's OWN rest stations (indoor; sofas, beds, plants)
//   2. Building's OWN primary work station (the desk — "back at work")
//   3. Two nearest OUTDOOR_STATIONS to the building's centroid
//   4. Plaza center (anchors chat affordance + footpath heatmap signal)
//
// De-dup by station id (outdoor close to building may already be in a
// ring that overlaps with plaza, for instance).
function buildLeisurePool(locationId) {
  const loc = LOCATION_DEFS.find(l => l.id === locationId);
  if (!loc) return [];
  const cx = loc.x + Math.floor((loc.w || 5) / 2);
  const cy = loc.y + Math.floor((loc.h || 4) / 2);
  const pool = [];
  const seen = new Set();

  // Indoor rest stations first — "taking a break at their own building"
  // reads as the strongest narrative of "back at base."
  for (const st of loc.stations || []) {
    if (st.kind !== 'rest') continue;
    if (seen.has(st.id)) continue;
    seen.add(st.id);
    pool.push({
      stationId: st.id,
      stationLabel: st.label || '',
      stationKind: 'rest',
      stationType: st.type,
      stationActivity: null,
      locationId: loc.id,
      locationName: loc.name,
      x: loc.x + (st.dx || 0),
      y: loc.y + (st.dy || 0)
    });
  }

  // One indoor work station — signals "restless, drifting back to work."
  const work = (loc.stations || []).find(s => s.kind === 'work' && s.type && (s.type.startsWith('table') || s.type.startsWith('counter') || s.type === 'chair'));
  if (work && !seen.has(work.id)) {
    seen.add(work.id);
    pool.push({
      stationId: work.id,
      stationLabel: work.label || '',
      stationKind: 'work',
      stationType: work.type,
      stationActivity: null,
      locationId: loc.id,
      locationName: loc.name,
      x: loc.x + (work.dx || 0),
      y: loc.y + (work.dy || 0)
    });
  }

  // Two nearest outdoor stations by Manhattan distance.
  const outdoorRanked = OUTDOOR_STATIONS
    .map(st => ({ st, dist: Math.abs(st.x - cx) + Math.abs(st.y - cy) }))
    .sort((a, b) => a.dist - b.dist)
    .slice(0, 2);
  for (const { st } of outdoorRanked) {
    if (seen.has(st.id)) continue;
    seen.add(st.id);
    pool.push({
      stationId: st.id,
      stationLabel: st.label,
      stationKind: st.kind,
      stationType: st.type,
      stationActivity: st.activity || null,
      locationId: null,
      locationName: st.label,
      x: st.x,
      y: st.y
    });
  }

  // Plaza as the "see-and-be-seen" anchor. Drives 1:1 chat gates.
  const plaza = OUTDOOR_STATIONS.find(st => st.id === 'plaza_center');
  if (plaza && !seen.has(plaza.id)) {
    seen.add(plaza.id);
    pool.push({
      stationId: plaza.id,
      stationLabel: plaza.label,
      stationKind: plaza.kind,
      stationType: plaza.type,
      stationActivity: plaza.activity || null,
      locationId: null,
      locationName: plaza.label,
      x: plaza.x,
      y: plaza.y
    });
  }

  return pool;
}

const SUB_LOCATIONS = {
  'home_nw': ['workbench', 'drafting_table', 'lounge'],
  'home_ne': ['test_station', 'monitor_wall', 'break_area'],
  'home_sw': ['console', 'server_rack', 'meeting_corner'],
  'cafe': ['counter', 'table_1', 'table_2', 'kitchen'],
  'library': ['desk', 'bookshelf', 'reading_area'],
  'office': ['desk', 'meeting_room', 'lobby'],
  'store': ['console', 'rack', 'staging_area'],
};

const ACTIVITY_TEMPLATES = {
  idle: [
    'walking around the village',
    'taking a stroll',
    'wandering through the village',
    'enjoying the scenery',
  ],
  working: [
    'working on a task',
    'deep in thought',
    'focused on work',
    'reviewing code',
    'writing documentation',
    'debugging an issue',
    'planning next steps',
  ],
  at_cafe: ['having coffee', 'chatting with teammates', 'taking a break'],
  at_library: ['reading docs', 'researching a solution', 'browsing the archive'],
  at_office: ['in a standup', 'reviewing reports', 'presenting to CEO'],
  at_home: ['deep in focus mode', 'pair programming', 'whiteboarding'],
  at_store: ['checking deploy pipeline', 'reviewing artifacts'],
};

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

function ensureRecord(value, fieldName) {
  if (!isRecord(value)) {
    throw new Error(`${fieldName} must be a JSON object.`);
  }
}

function pickString(source, keys) {
  if (!isRecord(source)) return null;
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

function addUnique(list, value) {
  if (!value) return;
  if (!list.includes(value)) list.push(value);
}

function hashString(input) {
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash * 31 + input.charCodeAt(i)) >>> 0;
  }
  return hash;
}

function createVillageGrid(width = WORLD_WIDTH, height = WORLD_HEIGHT) {
  const MAIN_X = 14;
  const MAIN_Y = 14;

  const CONNECTORS = [
    { x1: 4, x2: 4, y1: 8, y2: 13 },
    { x1: 12, x2: 13, y1: 6, y2: 6 },
    { x1: 26, x2: 26, y1: 6, y2: 12 },
    { x1: 15, x2: 26, y1: 12, y2: 12 },
    { x1: 18, x2: 18, y1: 13, y2: 13 },
    { x1: 4, x2: 4, y1: 15, y2: 27 },
    { x1: 26, x2: 26, y1: 18, y2: 25 },
    { x1: 15, x2: 26, y1: 18, y2: 18 }
  ];

  const PLAZA = { x1: 13, x2: 15, y1: 13, y2: 15 };
  const parkCX = width - 5;
  const parkCY = Math.floor(height / 2);

  function inRect(x, y, r) {
    return x >= r.x1 && x <= r.x2 && y >= r.y1 && y <= r.y2;
  }

  return Array.from({ length: height }, (_, y) =>
    Array.from({ length: width }, (_, x) => {
      const pdx = x - parkCX;
      const pdy = y - parkCY;
      const pondSq = pdx * pdx + pdy * pdy * 1.5;
      if (pondSq <= 4) return { x, y, type: 'water' };
      if (pondSq <= 7) return { x, y, type: 'sand' };
      if (inRect(x, y, PLAZA)) return { x, y, type: 'stone' };
      if (x === MAIN_X && y >= 2 && y <= height - 3) return { x, y, type: 'path' };
      if (y === MAIN_Y && x >= 2 && x <= width - 3) return { x, y, type: 'path' };
      for (const c of CONNECTORS) {
        if (inRect(x, y, c)) return { x, y, type: 'path' };
      }
      return { x, y, type: DEFAULT_TILE_TYPE };
    })
  );
}

function createWorldModel(layout = null) {
  const stationsByLocation = {};
  if (layout && Array.isArray(layout.indoorStations)) {
    for (const s of layout.indoorStations) {
      if (!stationsByLocation[s.locationId]) stationsByLocation[s.locationId] = [];
      const st = {
        id: s.id,
        kind: s.kind,
        type: s.type,
        dx: s.dx,
        dy: s.dy,
        label: s.label || ''
      };
      if (s.flipX) st.flipX = true;
      if (s.flipY) st.flipY = true;
      stationsByLocation[s.locationId].push(st);
    }
  }

  const outdoorStations = layout && Array.isArray(layout.outdoorStations)
    ? layout.outdoorStations.slice()
    : OUTDOOR_STATIONS.slice();

  const trees = layout && Array.isArray(layout.trees) ? layout.trees.slice() : [];

  const defsById = Object.fromEntries(LOCATION_DEFS.map(l => [l.id, l]));
  const buildingSource = layout && Array.isArray(layout.buildings)
    ? layout.buildings
    : LOCATION_DEFS;

  return {
    width: WORLD_WIDTH,
    height: WORLD_HEIGHT,
    defaultTile: DEFAULT_TILE_TYPE,
    tiles: createVillageGrid(),
    locations: buildingSource.map(loc => {
      const def = defsById[loc.id] || null;
      return {
        id: loc.id,
        name: loc.name,
        type: loc.type,
        x: loc.x,
        y: loc.y,
        w: loc.w,
        h: loc.h,
        subLocations: SUB_LOCATIONS[loc.id] || [],
        stations: layout
          ? (stationsByLocation[loc.id] || [])
          : (def && Array.isArray(def.stations) ? def.stations : []),
        zones: def && Array.isArray(def.zones) ? def.zones : [],
        interiorWalls: def && Array.isArray(def.interiorWalls) ? def.interiorWalls : []
      };
    }),
    outdoorStations,
    trees
  };
}

function normalizeWorldModel(world) {
  if (!isRecord(world)) return createWorldModel();

  const width = isPositiveInteger(world.width) ? world.width : WORLD_WIDTH;
  const height = isPositiveInteger(world.height) ? world.height : WORLD_HEIGHT;
  const validTiles =
    Array.isArray(world.tiles) &&
    world.tiles.length === height &&
    world.tiles.every(row => Array.isArray(row) && row.length === width);

  const result = {
    width,
    height,
    defaultTile:
      typeof world.defaultTile === 'string' && world.defaultTile.length > 0
        ? world.defaultTile
        : DEFAULT_TILE_TYPE,
    tiles: validTiles ? world.tiles : createVillageGrid(width, height)
  };

  if (Array.isArray(world.locations)) result.locations = world.locations;
  if (Array.isArray(world.outdoorStations)) result.outdoorStations = world.outdoorStations;
  if (Array.isArray(world.trees)) result.trees = world.trees;

  return result;
}

function ensureWorldState(worldState) {
  ensureRecord(worldState, 'worldState');
  worldState.agents = isRecord(worldState.agents) ? worldState.agents : {};
  worldState.zones = isRecord(worldState.zones) ? worldState.zones : {};
  worldState.runs = isRecord(worldState.runs) ? worldState.runs : {};
  worldState.world = normalizeWorldModel(worldState.world);
  worldState.avatars = isRecord(worldState.avatars) ? worldState.avatars : {};
}

function collectSpawnCandidates(world) {
  const points = [];
  const W = world.width, H = world.height;
  const locations = Array.isArray(world.locations) ? world.locations : [];
  for (const loc of locations) {
    const x = loc.x + Math.floor((loc.w || 5) / 2);
    const y = loc.y + (loc.h || 4);
    if (x >= 0 && x < W && y >= 0 && y < H) points.push({ x, y });
  }
  const outdoor = Array.isArray(world.outdoorStations) ? world.outdoorStations : [];
  for (const s of outdoor) {
    if (Number.isInteger(s.x) && Number.isInteger(s.y) &&
        s.x >= 0 && s.x < W && s.y >= 0 && s.y < H) {
      points.push({ x: s.x, y: s.y });
    }
  }
  return points;
}

function deriveInitialAvatarPosition(agentId, world) {
  const hash = hashString(agentId);
  const pool = collectSpawnCandidates(world);
  if (pool.length > 0) {
    const base = pool[hash % pool.length];
    const jitterX = ((hash >>> 5) % 3) - 1;
    const jitterY = ((hash >>> 11) % 3) - 1;
    const W = world.width, H = world.height;
    return {
      x: Math.max(0, Math.min(W - 1, base.x + jitterX)),
      y: Math.max(0, Math.min(H - 1, base.y + jitterY))
    };
  }
  const area = world.width * world.height;
  const cellIndex = area > 0 ? hash % area : 0;
  return {
    x: cellIndex % world.width,
    y: Math.floor(cellIndex / world.width)
  };
}

function ensureAvatar(worldState, agentId, opts = {}) {
  if (!worldState.avatars[agentId]) {
    // Prefer a caller-supplied preferredPosition when the session has a
    // known building/desk assignment. Falls back to the hash-based
    // spawn distribution so unassigned agents don't all stack on top
    // of each other at the plaza.
    let position;
    const pref = opts && opts.preferredPosition;
    if (pref && Number.isFinite(pref.x) && Number.isFinite(pref.y)) {
      const W = worldState.world?.width || 30;
      const H = worldState.world?.height || 30;
      position = {
        x: Math.max(0, Math.min(W - 1, Math.round(pref.x))),
        y: Math.max(0, Math.min(H - 1, Math.round(pref.y)))
      };
    } else {
      position = deriveInitialAvatarPosition(agentId, worldState.world);
    }
    worldState.avatars[agentId] = {
      id: agentId,
      agentId,
      x: position.x,
      y: position.y,
      moving: true,
      state: 'idle',
      currentTaskId: null,
      bubbleText: '',
      lastUpdatedAt: null
    };
  }
  return worldState.avatars[agentId];
}

function findLocationForPosition(x, y, world) {
  const locations = world.locations || LOCATION_DEFS;
  for (const loc of locations) {
    if (x >= loc.x && x < loc.x + loc.w && y >= loc.y && y < loc.y + loc.h) {
      return loc.id;
    }
  }
  return null;
}

module.exports = {
  WORLD_WIDTH,
  WORLD_HEIGHT,
  DEFAULT_TILE_TYPE,
  LOCATION_DEFS,
  OUTDOOR_STATIONS,
  buildLeisurePool,
  SUB_LOCATIONS,
  ACTIVITY_TEMPLATES,
  FLOOR_WOOD,
  FLOOR_TILE,
  FLOOR_CARPET,
  FLOOR_SOFT,
  FLOOR_CONCRETE,
  FLOOR_RED,
  FLOOR_GREEN,
  FLOOR_DARK,
  isRecord,
  isPositiveInteger,
  ensureRecord,
  pickString,
  addUnique,
  hashString,
  createVillageGrid,
  createWorldModel,
  normalizeWorldModel,
  ensureWorldState,
  collectSpawnCandidates,
  deriveInitialAvatarPosition,
  ensureAvatar,
  findLocationForPosition
};
