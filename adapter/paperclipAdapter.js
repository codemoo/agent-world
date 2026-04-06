const VALID_EVENT_TYPES = new Set([
  'task_created',
  'task_assigned',
  'task_paused',
  'tool_called',
  'task_completed',
  'run_started',
  'run_completed'
]);

const TASK_REQUIRED_EVENT_TYPES = new Set([
  'task_created',
  'task_assigned',
  'task_paused',
  'tool_called',
  'task_completed'
]);

const RUN_REQUIRED_EVENT_TYPES = new Set(['run_started', 'run_completed']);
const WORKING_TASK_STATUSES = new Set(['created', 'assigned', 'in_progress']);

const WORLD_WIDTH = 30;
const WORLD_HEIGHT = 30;
const DEFAULT_TILE_TYPE = 'grass';

// Named locations for the Smallville-style village.
// Each location has a `stations` list — interior furniture that agents can target.
// Station coords (dx, dy) are interior tile offsets from the building's (x, y).
// For a w=5/h=4 building, interior tiles are dx:1..3, dy:1..2 (6 cells).
// For a w=6/h=5 building (cafe), interior dx:1..4, dy:1..3 (12 cells).
//
// `kind`: "work" for agents in state=working, "rest" for agents in state=idle.
// `type`: sprite key used by the renderer to draw the furniture.
// Station `type` values correspond to keys in frontend/furnitureCatalog.mjs.
// Allowed types include: bed.gray, bed.pink, bed.blue, bed.wide.pink,
//   bed.wide.blue, sofa, sofa.alt, sofa.alt2, chair, chair.red, chair.blue,
//   chair.wood, chair.arm, chair.side, table, table.alt, table.round,
//   table.large, desk, desk.wood, drawer, drawer.alt, drawer.plain,
//   bookshelf, bookshelf.alt, bookshelf.full, bookshelf.scroll, stove,
//   stove.alt, stove.blue, counter, counter.alt, cabinet.metal,
//   cabinet.glass, cabinet.wood, cabinet.books, wardrobe, rack, rack.alt,
//   plant.purple, plant.pink, plant.yellow, curtain.
// Station dx/dy is the TOP-LEFT tile of the furniture's footprint, in
// building-local coords. The renderer reads sprite sizes from
// frontend/furnitureCatalog.mjs and claims adjacent tiles based on w×h:
//   • 1×1 pieces: 1 tile                          (most furniture)
//   • 2×1 wide:   claims (dx, dy) and (dx+1, dy)  (bed.wide.*, chair.red, chair.blue)
//   • 1×2 tall:   claims (dx, dy) and (dx, dy+1)  (bed.gray/pink/blue, plant.*)
//   • 2×2:        claims a 2×2 block              (table.large)
// The door tile is RESERVED at (dx=Math.floor(w/2), dy=h-1) — no station
// may overlap it (the renderer cuts the bottom wall there for the entrance).
// Top-wall row (dy=0) is used for wall-hung decorations (shelves, cabinets).
// 1×2 tall items at dy=0 are fine — they occupy tile rows 0..1 inside the
// building. Just make sure nothing else is placed in the row below them.
// Don't place 2×1 items with dx at the last interior column.
// Layouts inspired by Smallville (Park et al. "Generative Agents") —
// each building has zones (workspace / rest / kitchen / storage) like
// Smallville arenas (bedroom / common room / kitchen / bathroom).
// Building sizes vary (4×4 to 6×6) for visual variety.
//
// Per-building extras:
//   zones[]         — per-room floor tint rectangles (building-local coords)
//                     { x1, y1, x2, y2, floor: '#hex' }
//   interiorWalls[] — line segments dividing rooms; break them with gaps
//                     to make doorways. Coords are fractional tiles.
//                     { x1, y1, x2, y2 }
// Station footprints must NOT overlap walls or each other.
const FLOOR_WOOD = '#d4b88c';
const FLOOR_TILE = '#b8c4d0';
const FLOOR_CARPET = '#b89976';
const FLOOR_SOFT = '#e0d0a8';
const FLOOR_CONCRETE = '#a8a8a0';
const FLOOR_RED = '#b07060';    // executive / premium carpet
const FLOOR_GREEN = '#8fa878';  // study / reading room
const FLOOR_DARK = '#6b5a42';   // tavern / dim interior

const LOCATION_DEFS = [
  {
    // Architect Studio — studio (top) + living quarters (bottom).
    // Wall at y=2, doorway at dx=2.
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
      // Studio zone — drafting desk tucked into corner, shelves lining wall
      { id: 'nw_w1',        kind: 'work', type: 'bookshelf',         dx: 1, dy: 0, label: 'refs' },
      { id: 'nw_w2',        kind: 'work', type: 'bookshelf.full',    dx: 2, dy: 0, label: 'archive' },
      { id: 'nw_plant',     kind: 'rest', type: 'plant.purple',      dx: 3, dy: 0, label: 'studio plant' },
      { id: 'nw_chair',     kind: 'work', type: 'chair',             dx: 1, dy: 1, label: 'design chair' },
      { id: 'nw_desk',      kind: 'work', type: 'table.mid',         dx: 2, dy: 1, label: 'drafting desk' },
      // Living zone — bed nook on left, reading nook on right
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
    // QA Lab — testing floor (left) + equipment bay (right).
    // Vertical wall at x=4, doorway at dy=1.
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
      // Testing floor (dx=1..3) — 2 analyst stations back-to-back + docs
      { id: 'ne_mon1',    kind: 'work', type: 'dresser.beer',      dx: 1, dy: 0, label: 'monitor 1' },
      { id: 'ne_chair1',  kind: 'work', type: 'chair',             dx: 2, dy: 0, label: 'analyst 1' },
      { id: 'ne_mon2',    kind: 'work', type: 'dresser.alt',       dx: 3, dy: 0, label: 'monitor 2' },
      { id: 'ne_bench',   kind: 'work', type: 'table.mid',         dx: 1, dy: 1, label: 'prep bench' },
      { id: 'ne_chair2',  kind: 'work', type: 'chair.alt',         dx: 2, dy: 1, label: 'analyst 2' },
      { id: 'ne_safe',    kind: 'work', type: 'safe',              dx: 3, dy: 1, label: 'sample safe' },
      { id: 'ne_docs',    kind: 'work', type: 'bookshelf.scroll',  dx: 1, dy: 2, label: 'test docs' },
      { id: 'ne_display', kind: 'work', type: 'display',           dx: 2, dy: 2, label: 'test display' },
      { id: 'ne_sofa',    kind: 'rest', type: 'sofa',              dx: 3, dy: 2, label: 'break seat' },
      // Equipment bay (dx=4) — server rack wall
      { id: 'ne_rack',    kind: 'work', type: 'cabinet.metal',     dx: 4, dy: 0, label: 'rack A' },
      { id: 'ne_rack2',   kind: 'work', type: 'cabinet.metal.alt', dx: 4, dy: 1, label: 'rack B' },
      { id: 'ne_case',    kind: 'work', type: 'cabinet.glass',     dx: 4, dy: 2, label: 'sample case' }
    ]
  },
  {
    // Agent Lounge — cafe split into kitchen (top) + dining (bottom).
    // Wall at y=2, order window gap at dx=2.
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
      // Kitchen — stoves + pastry case, plant in corner
      { id: 'cafe_case',    kind: 'work', type: 'cabinet.glass',   dx: 1, dy: 0, label: 'pastry case' },
      { id: 'cafe_stove',   kind: 'work', type: 'stove',           dx: 2, dy: 0, label: 'main stove' },
      { id: 'cafe_plant',   kind: 'rest', type: 'plant.pink',      dx: 3, dy: 0, label: 'cafe plant' },
      { id: 'cafe_stove2',  kind: 'work', type: 'stove.alt',       dx: 1, dy: 1, label: 'grill' },
      { id: 'cafe_counter', kind: 'work', type: 'counter',         dx: 2, dy: 1, label: 'prep counter' },
      // Dining — booth corners + dining table + coffee area
      { id: 'cafe_sofa1',   kind: 'rest', type: 'sofa',            dx: 1, dy: 2, label: 'corner booth' },
      { id: 'cafe_sofa2',   kind: 'rest', type: 'sofa.alt',        dx: 3, dy: 2, label: 'window booth' },
      { id: 'cafe_chair1',  kind: 'rest', type: 'chair',           dx: 1, dy: 3, label: 'diner 1' },
      { id: 'cafe_table',   kind: 'rest', type: 'table',           dx: 2, dy: 3, label: 'dining table' },
      { id: 'cafe_chair2',  kind: 'rest', type: 'chair.alt',       dx: 3, dy: 3, label: 'diner 2' },
      { id: 'cafe_sofa3',   kind: 'rest', type: 'sofa.alt2',       dx: 1, dy: 4, label: 'lounge sofa' },
      // dx=2 dy=4 is reserved for the door (entry tile).
      { id: 'cafe_ns',      kind: 'rest', type: 'nightstand.alt',  dx: 3, dy: 4, label: 'side stand' }
    ]
  },
  {
    // Security HQ — ops floor (top) + on-call bunk room (bottom).
    // Wall at y=3, doorway at dx=2.
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
      // Ops floor — evidence wall, dual-monitor console, safe
      { id: 'sw_w1',        kind: 'work', type: 'cabinet.metal',     dx: 1, dy: 0, label: 'evidence' },
      { id: 'sw_w2',        kind: 'work', type: 'cabinet.metal.alt', dx: 2, dy: 0, label: 'armory' },
      { id: 'sw_w3',        kind: 'work', type: 'cabinet.wood.alt',  dx: 3, dy: 0, label: 'gear locker' },
      { id: 'sw_mon1',      kind: 'work', type: 'display',           dx: 1, dy: 1, label: 'monitor 1' },
      { id: 'sw_mon2',      kind: 'work', type: 'display.alt',       dx: 2, dy: 1, label: 'monitor 2' },
      { id: 'sw_safe',      kind: 'work', type: 'safe',              dx: 3, dy: 1, label: 'safe' },
      { id: 'sw_console',   kind: 'work', type: 'table.mid',         dx: 1, dy: 2, label: 'console' },
      { id: 'sw_chair',     kind: 'work', type: 'chair',             dx: 2, dy: 2, label: 'operator' },
      { id: 'sw_records',   kind: 'work', type: 'cabinet.books',     dx: 3, dy: 2, label: 'records' },
      // Bunk room
      { id: 'sw_nightst',   kind: 'rest', type: 'nightstand',        dx: 1, dy: 3, label: 'nightstand' },
      { id: 'sw_bunk',      kind: 'rest', type: 'bed.wide.blue',     dx: 2, dy: 3, label: 'on-call bunk' },
      { id: 'sw_dresser',   kind: 'rest', type: 'dresser',           dx: 1, dy: 4, label: 'dresser' },
      { id: 'sw_chair2',    kind: 'rest', type: 'chair.alt',         dx: 2, dy: 4, label: 'duty chair' },
      { id: 'sw_table',     kind: 'rest', type: 'table.tiny',        dx: 3, dy: 4, label: 'side table' }
    ]
  },
  {
    // Docs Archive — stacks (left) + reading room (right).
    // Vertical wall at x=3, doorway at dy=2.
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
      // Stacks — wall of bookshelves (6 shelves)
      { id: 'lib_w1',      kind: 'work', type: 'bookshelf',         dx: 1, dy: 0, label: 'shelf A' },
      { id: 'lib_w2',      kind: 'work', type: 'bookshelf.full',    dx: 2, dy: 0, label: 'shelf B' },
      { id: 'lib_w3',      kind: 'work', type: 'bookshelf.scroll',  dx: 1, dy: 1, label: 'scrolls' },
      { id: 'lib_cab',     kind: 'work', type: 'cabinet.books',     dx: 2, dy: 1, label: 'catalog' },
      { id: 'lib_w4',      kind: 'work', type: 'bookshelf',         dx: 1, dy: 3, label: 'shelf C' },
      { id: 'lib_w5',      kind: 'work', type: 'bookshelf.full',    dx: 2, dy: 3, label: 'shelf D' },
      // Reading room — study desk + cozy reading nook
      { id: 'lib_desk',    kind: 'work', type: 'table.mid',         dx: 4, dy: 0, label: 'study desk' },
      { id: 'lib_chair1',  kind: 'work', type: 'chair',             dx: 5, dy: 0, label: 'study chair' },
      { id: 'lib_plant',   kind: 'rest', type: 'plant.purple',      dx: 4, dy: 1, label: 'corner plant' },
      { id: 'lib_sofa',    kind: 'rest', type: 'sofa',              dx: 5, dy: 1, label: 'reading sofa' },
      { id: 'lib_table',   kind: 'rest', type: 'table.tiny',        dx: 4, dy: 3, label: 'side table' },
      { id: 'lib_chair2',  kind: 'rest', type: 'chair.alt',         dx: 5, dy: 3, label: 'lounge chair' }
    ]
  },
  {
    // CEO Office — premium executive suite, red carpet, sparse layout
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
    // Deploy Center — staging workshop, concrete floor
    id: 'store', name: 'Deploy Center', type: 'house.green2', x: 2, y: 9, w: 5, h: 4,
    zones: [
      { x1: 0, y1: 0, x2: 5, y2: 4, floor: FLOOR_CONCRETE }
    ],
    stations: [
      // Rack wall along top + vault
      { id: 'store_r1',        kind: 'work', type: 'cabinet.metal',    dx: 1, dy: 0, label: 'rack A' },
      { id: 'store_r2',        kind: 'work', type: 'cabinet.metal.alt',dx: 2, dy: 0, label: 'rack B' },
      { id: 'store_vault',     kind: 'work', type: 'safe',             dx: 3, dy: 0, label: 'vault' },
      // Parts staging row
      { id: 'store_counter',   kind: 'work', type: 'counter',          dx: 1, dy: 1, label: 'staging' },
      { id: 'store_drawer',    kind: 'work', type: 'cabinet.drawer',   dx: 2, dy: 1, label: 'parts drawer' },
      { id: 'store_tools',     kind: 'work', type: 'cabinet.wood',     dx: 3, dy: 1, label: 'tools' },
      // Ops desk + sample display
      { id: 'store_desk',      kind: 'work', type: 'table.mid',        dx: 1, dy: 2, label: 'ops desk' },
      { id: 'store_chair',     kind: 'work', type: 'chair',            dx: 2, dy: 2, label: 'ops chair' },
      { id: 'store_case',      kind: 'work', type: 'cabinet.glass',    dx: 3, dy: 2, label: 'sample case' }
    ]
  }
];

// Outdoor stations — absolute world coords (not building-local).
// Each spot is a named waypoint where agents can work or rest with a
// scenario-specific activity. These add variety beyond building interiors.
const OUTDOOR_STATIONS = [
  // Pond / fishing
  { id: 'pond_fish_w',  kind: 'rest', type: 'outdoor.fishing', x: 22, y: 13, label: 'fishing spot', activity: 'fishing by the pond' },
  { id: 'pond_fish_s',  kind: 'rest', type: 'outdoor.watching', x: 24, y: 19, label: 'pond view',   activity: 'watching the water' },
  { id: 'pond_view',    kind: 'rest', type: 'outdoor.sitting', x: 21, y: 17, label: 'park bench',  activity: 'sitting by the pond' },

  // Central plaza
  { id: 'plaza_bench_n',kind: 'rest', type: 'outdoor.reading', x: 13, y: 12, label: 'plaza bench',  activity: 'reading on a bench' },
  { id: 'plaza_bench_s',kind: 'rest', type: 'outdoor.sitting', x: 15, y: 16, label: 'plaza bench',  activity: 'taking a break' },
  { id: 'plaza_center', kind: 'rest', type: 'outdoor.chatting',x: 14, y: 14, label: 'plaza',        activity: 'chatting at the plaza' },

  // Flower gardens
  { id: 'garden_nw',    kind: 'rest', type: 'outdoor.flowers', x: 10, y: 10, label: 'NW garden',    activity: 'enjoying the flowers' },
  { id: 'garden_ne',    kind: 'rest', type: 'outdoor.flowers', x: 21, y: 7,  label: 'NE garden',    activity: 'smelling the flowers' },
  { id: 'garden_sw',    kind: 'rest', type: 'outdoor.flowers', x: 10, y: 22, label: 'SW garden',    activity: 'picking flowers' },
  { id: 'garden_se',    kind: 'rest', type: 'outdoor.flowers', x: 20, y: 22, label: 'SE garden',    activity: 'strolling the garden' },

  // Mining / outdoor work spots (near rock piles)
  { id: 'mine_n',       kind: 'work', type: 'outdoor.mining',  x: 17, y: 3,  label: 'rock quarry',  activity: 'mining stones' },
  { id: 'mine_s',       kind: 'work', type: 'outdoor.mining',  x: 18, y: 27, label: 'rock pile',    activity: 'breaking rocks' },

  // Foraging / farming
  { id: 'forage_w',     kind: 'work', type: 'outdoor.foraging',x: 7,  y: 17, label: 'west woods',   activity: 'foraging berries' },
  { id: 'forage_e',     kind: 'work', type: 'outdoor.foraging',x: 27, y: 8,  label: 'east woods',   activity: 'gathering herbs' },

  // Napping spots under trees
  { id: 'nap_grass_n',  kind: 'rest', type: 'outdoor.napping', x: 8,  y: 7,  label: 'shady tree',   activity: 'napping under a tree' },
  { id: 'nap_grass_s',  kind: 'rest', type: 'outdoor.napping', x: 21, y: 25, label: 'shady tree',   activity: 'dozing in the grass' }
];

// Sub-locations within buildings (for fine-grained agent positioning)
const SUB_LOCATIONS = {
  'home_nw': ['workbench', 'drafting_table', 'lounge'],
  'home_ne': ['test_station', 'monitor_wall', 'break_area'],
  'home_sw': ['console', 'server_rack', 'meeting_corner'],
  'cafe': ['counter', 'table_1', 'table_2', 'kitchen'],
  'library': ['desk', 'bookshelf', 'reading_area'],
  'office': ['desk', 'meeting_room', 'lobby'],
  'store': ['console', 'rack', 'staging_area'],
};

// Activity templates based on agent state and location
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
  if (!isRecord(source)) {
    return null;
  }

  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }

  return null;
}

function createVillageGrid(width = WORLD_WIDTH, height = WORLD_HEIGHT) {
  // Central cross roads (single tile wide)
  const MAIN_X = 14;
  const MAIN_Y = 14;

  // Connectors: door coords routed to main cross, avoiding pond at (22..28, 13..17)
  // Each entry is a rectangle of path tiles (inclusive).
  const CONNECTORS = [
    // home_nw door(4,8) → main y=14
    { x1: 4, x2: 4, y1: 8, y2: 13 },
    // office door(12,6) → main x=14
    { x1: 12, x2: 13, y1: 6, y2: 6 },
    // home_ne door(26,6) → main x=14 (L-shape above pond)
    { x1: 26, x2: 26, y1: 6, y2: 12 },
    { x1: 15, x2: 26, y1: 12, y2: 12 },
    // cafe door(18,13) → main y=14
    { x1: 18, x2: 18, y1: 13, y2: 13 },
    // home_sw door(4,26) → main y=14 (shares x=4 with home_nw)
    { x1: 4, x2: 4, y1: 15, y2: 27 },
    // library door(26,25) → main x=14 (L-shape below pond)
    { x1: 26, x2: 26, y1: 18, y2: 25 },
    { x1: 15, x2: 26, y1: 18, y2: 18 }
  ];

  // Stone plaza at center cross intersection
  const PLAZA = { x1: 13, x2: 15, y1: 13, y2: 15 };

  // Pond (Johnson Park) east of center
  const parkCX = width - 5;
  const parkCY = Math.floor(height / 2);

  // Flower clusters scattered outside paths
  const FLOWER_CLUSTERS = [
    { cx: 10, cy: 10, r: 2 },
    { cx: 20, cy: 9, r: 2 },
    { cx: 10, cy: 22, r: 2 },
    { cx: 20, cy: 22, r: 2 }
  ];

  function inRect(x, y, r) {
    return x >= r.x1 && x <= r.x2 && y >= r.y1 && y <= r.y2;
  }

  return Array.from({ length: height }, (_, y) =>
    Array.from({ length: width }, (_, x) => {
      // Water + sand halo first (layered under everything else)
      const pdx = x - parkCX;
      const pdy = y - parkCY;
      const pondSq = pdx * pdx + pdy * pdy * 1.5;
      if (pondSq <= 4) return { x, y, type: 'water' };
      if (pondSq <= 7) return { x, y, type: 'sand' };

      // Plaza (stone)
      if (inRect(x, y, PLAZA)) return { x, y, type: 'stone' };

      // Main cross roads
      if (x === MAIN_X && y >= 2 && y <= height - 3) return { x, y, type: 'path' };
      if (y === MAIN_Y && x >= 2 && x <= width - 3) return { x, y, type: 'path' };

      // Connectors
      for (const c of CONNECTORS) {
        if (inRect(x, y, c)) return { x, y, type: 'path' };
      }

      // Flower beds (decorative, counted as grass but marked for renderer)
      for (const cl of FLOWER_CLUSTERS) {
        const fdx = x - cl.cx;
        const fdy = y - cl.cy;
        if (fdx * fdx + fdy * fdy <= cl.r * cl.r) {
          // keep as grass — flowers are rendered as decoration layer
        }
      }

      return { x, y, type: DEFAULT_TILE_TYPE };
    })
  );
}

// `layout` (optional): persisted overrides from server/worldLayout.js.
//   { indoorStations: [...with locationId], outdoorStations: [...], trees: [...] }
// When provided, stations are re-grouped by locationId into each location's
// `stations` list (replacing the code defaults), and outdoorStations/trees
// replace the code defaults too. `layout` is null for fresh/test worlds.
function createWorldModel(layout = null) {
  // Group indoor stations by locationId when a layout is supplied.
  // flipX/flipY are only included when truthy, keeping old state shapes.
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

  // Buildings: if layout provides its own array, use that (editable).
  // Otherwise fall back to LOCATION_DEFS. We always preserve LOCATION_DEFS'
  // zones + interiorWalls by id so interior floor tints don't vanish when
  // the user only moves/renames a building.
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

function normalizePaperclipEvent(rawEvent) {
  ensureRecord(rawEvent, 'event');

  const payload = isRecord(rawEvent.payload) ? rawEvent.payload : {};
  const eventType = pickString(rawEvent, ['event_type', 'eventType', 'type']);
  const agentId =
    pickString(rawEvent, ['agent_id', 'agentId']) ||
    pickString(payload, ['agent_id', 'agentId']);
  const taskId =
    pickString(rawEvent, ['task_id', 'taskId']) ||
    pickString(payload, ['task_id', 'taskId']);
  const runId =
    pickString(rawEvent, ['run_id', 'runId']) ||
    pickString(payload, ['run_id', 'runId']);
  const timestamp =
    pickString(rawEvent, ['timestamp', 'occurred_at', 'occurredAt']) ||
    new Date().toISOString();

  return {
    eventType,
    agentId,
    taskId,
    runId,
    timestamp,
    payload
  };
}

function validatePaperclipEvent(event) {
  ensureRecord(event, 'normalized event');

  if (!event.eventType) {
    throw new Error('event_type is required.');
  }

  if (!VALID_EVENT_TYPES.has(event.eventType)) {
    throw new Error(`Unsupported event_type: ${event.eventType}`);
  }

  if (!event.agentId) {
    throw new Error('agent_id is required.');
  }

  if (TASK_REQUIRED_EVENT_TYPES.has(event.eventType) && !event.taskId) {
    throw new Error(`task_id is required for event_type=${event.eventType}`);
  }

  if (RUN_REQUIRED_EVENT_TYPES.has(event.eventType) && !event.runId) {
    throw new Error(`run_id is required for event_type=${event.eventType}`);
  }
}

function normalizeWorldModel(world) {
  if (!isRecord(world)) {
    return createWorldModel();
  }

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

  // Preserve locations metadata
  if (Array.isArray(world.locations)) {
    result.locations = world.locations;
  }
  if (Array.isArray(world.outdoorStations)) {
    result.outdoorStations = world.outdoorStations;
  }
  if (Array.isArray(world.trees)) {
    result.trees = world.trees;
  }

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

function ensureAgent(worldState, agentId) {
  if (!worldState.agents[agentId]) {
    worldState.agents[agentId] = {
      id: agentId,
      name: null,
      zone: 'idle',
      activity: 'idle',
      tasks: [],
      currentRunId: null,
      lastTool: null,
      lastEventAt: null
    };
  }

  return worldState.agents[agentId];
}

function ensureRun(worldState, runId) {
  if (!runId) {
    return null;
  }

  if (!worldState.runs[runId]) {
    worldState.runs[runId] = {
      id: runId,
      status: 'running',
      agentIds: [],
      taskIds: [],
      startedAt: null,
      completedAt: null,
      updatedAt: null
    };
  }

  return worldState.runs[runId];
}

function addUnique(list, value) {
  if (!value) {
    return;
  }

  if (!list.includes(value)) {
    list.push(value);
  }
}

function upsertTask(agent, taskId) {
  let task = agent.tasks.find(item => item.id === taskId);
  if (!task) {
    task = { id: taskId, status: 'created', label: '', updatedAt: null };
    agent.tasks.push(task);
  }

  return task;
}

function hashString(input) {
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash * 31 + input.charCodeAt(i)) >>> 0;
  }
  return hash;
}

// Build a diverse pool of spawn points so agents don't all start on the
// same building door. Pulls from:
//   - one tile below each building door
//   - every outdoor station position (fishing spots, napping spots,
//     garden benches, mining quarries, etc.)
// The agent's ID hash picks an index, then we add a small deterministic
// jitter so two agents with adjacent hashes don't stack on one tile.
function collectSpawnCandidates(world) {
  const points = [];
  const W = world.width, H = world.height;
  const locations = Array.isArray(world.locations) ? world.locations : [];
  for (const loc of locations) {
    const x = loc.x + Math.floor((loc.w || 5) / 2);
    const y = loc.y + (loc.h || 4); // one tile below the door
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
    // Tiny per-agent jitter (-1..1) in both axes so agents with adjacent
    // hashes don't stack. Clamped to world bounds.
    const jitterX = ((hash >>> 5) % 3) - 1;
    const jitterY = ((hash >>> 11) % 3) - 1;
    const W = world.width, H = world.height;
    return {
      x: Math.max(0, Math.min(W - 1, base.x + jitterX)),
      y: Math.max(0, Math.min(H - 1, base.y + jitterY))
    };
  }

  // Last-resort fallback: hash into the full grid.
  const area = world.width * world.height;
  const cellIndex = area > 0 ? hash % area : 0;
  return {
    x: cellIndex % world.width,
    y: Math.floor(cellIndex / world.width)
  };
}

function ensureAvatar(worldState, agentId) {
  if (!worldState.avatars[agentId]) {
    const position = deriveInitialAvatarPosition(agentId, worldState.world);
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

function getActiveTask(agent) {
  const candidates = agent.tasks.filter(task =>
    WORKING_TASK_STATUSES.has(task.status)
  );

  if (candidates.length === 0) {
    return null;
  }

  candidates.sort((left, right) => {
    const leftTime = left.updatedAt || '';
    const rightTime = right.updatedAt || '';
    return rightTime.localeCompare(leftTime);
  });

  return candidates[0];
}

function pickActivityText(agent, locationId) {
  const seed = hashString(agent.id + (agent.lastEventAt || ''));
  const isWorking = agent.activity === 'working';

  if (isWorking) {
    const activeTask = getActiveTask(agent);
    if (activeTask && activeTask.label) {
      return activeTask.label;
    }
    const pool = ACTIVITY_TEMPLATES.working;
    return pool[seed % pool.length];
  }

  // Pick activity based on current location
  const locKey = locationId ? `at_${locationId.split('_')[0]}` : null;
  const pool = (locKey && ACTIVITY_TEMPLATES[locKey]) || ACTIVITY_TEMPLATES.idle;
  return pool[seed % pool.length];
}

function pickDestination(agent, currentLocationId, world) {
  const locations = world.locations || LOCATION_DEFS;
  if (!locations || locations.length === 0) return null;

  const seed = hashString(agent.id + (agent.lastEventAt || '') + 'dest');
  // Pick a random location that isn't the current one
  const candidates = locations.filter(loc => loc.id !== currentLocationId);
  if (candidates.length === 0) return locations[0];
  return candidates[seed % candidates.length];
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

function syncAvatarFromAgent(worldState, agent, timestamp) {
  const avatar = ensureAvatar(worldState, agent.id);
  const activeTask = getActiveTask(agent);

  // Propagate agent name to avatar for display
  if (agent.name) {
    avatar.displayName = agent.name;
  }

  // Server no longer picks destinations. The client-side runtime
  // (avatarRuntime.mjs) routes agents through the full station list
  // (buildings + outdoor mining/napping/fishing/etc.) and owns the
  // destination-driven bubble text. Server just sets state + task label.
  avatar.destination = null;

  if (activeTask) {
    avatar.state = 'working';
    avatar.moving = true;
    avatar.currentTaskId = activeTask.id;
    avatar.bubbleText = activeTask.label || '';
  } else {
    avatar.state = 'idle';
    avatar.moving = true;
    avatar.currentTaskId = null;
    // Leave bubbleText empty for idle agents — client sets it from the
    // station activity when they arrive at fishing/mining/garden spots.
    avatar.bubbleText = '';
  }

  avatar.lastUpdatedAt = timestamp || new Date().toISOString();
  return avatar;
}

function applyPaperclipEvent(event, worldState) {
  validatePaperclipEvent(event);
  ensureWorldState(worldState);

  const agent = ensureAgent(worldState, event.agentId);

  // Skip if event is older than the last event processed for this agent
  if (agent.lastEventAt && event.timestamp < agent.lastEventAt) {
    return event;
  }

  const run = ensureRun(worldState, event.runId);

  const agentName = pickString(event.payload, ['agent_name', 'agentName']);
  if (agentName) {
    agent.name = agentName;
  }

  agent.lastEventAt = event.timestamp;
  if (run) {
    addUnique(run.agentIds, event.agentId);
    run.updatedAt = event.timestamp;
    agent.currentRunId = run.id;
  }

  switch (event.eventType) {
    case 'task_created': {
      const task = upsertTask(agent, event.taskId);
      task.status = 'created';
      task.label =
        pickString(event.payload, ['label', 'title', 'name']) || task.label;
      task.updatedAt = event.timestamp;
      addUnique(run?.taskIds || [], event.taskId);
      agent.zone = 'intake';
      agent.activity = 'working';
      break;
    }
    case 'task_assigned': {
      const task = upsertTask(agent, event.taskId);
      task.status = 'assigned';
      task.label =
        pickString(event.payload, ['label', 'title', 'name']) || task.label;
      task.updatedAt = event.timestamp;
      addUnique(run?.taskIds || [], event.taskId);
      agent.zone = 'planning';
      agent.activity = 'working';
      break;
    }
    case 'task_paused': {
      const task = upsertTask(agent, event.taskId);
      if (task.updatedAt && event.timestamp < task.updatedAt) break;
      const issueStatus =
        pickString(event.payload, ['issue_status', 'issueStatus']) || 'paused';
      task.status = issueStatus;
      task.label =
        pickString(event.payload, ['label', 'title', 'name']) || task.label;
      task.updatedAt = event.timestamp;
      addUnique(run?.taskIds || [], event.taskId);
      agent.zone = issueStatus === 'blocked' ? 'blocked' : 'idle';
      agent.activity = 'idle';
      break;
    }
    case 'tool_called': {
      const task = upsertTask(agent, event.taskId);
      task.status = task.status === 'completed' ? 'completed' : 'in_progress';
      task.label =
        pickString(event.payload, ['label', 'title', 'name']) || task.label;
      task.updatedAt = event.timestamp;
      addUnique(run?.taskIds || [], event.taskId);
      agent.lastTool =
        pickString(event.payload, ['tool_name', 'toolName', 'name']) || null;
      agent.zone = 'tools';
      agent.activity = task.status === 'completed' ? 'idle' : 'working';
      break;
    }
    case 'task_completed': {
      const task = upsertTask(agent, event.taskId);
      task.status = 'completed';
      task.updatedAt = event.timestamp;
      addUnique(run?.taskIds || [], event.taskId);
      agent.zone = 'done';
      break;
    }
    case 'run_started': {
      if (run) {
        run.status = 'running';
        run.startedAt = run.startedAt || event.timestamp;
      }
      agent.zone = 'planning';
      break;
    }
    case 'run_completed': {
      if (run) {
        run.status = 'completed';
        run.completedAt = event.timestamp;
      }
      agent.zone = 'idle';
      agent.currentRunId = null;
      break;
    }
    default:
      break;
  }

  agent.activity = getActiveTask(agent) ? 'working' : 'idle';
  syncAvatarFromAgent(worldState, agent, event.timestamp);

  return event;
}

function handlePaperclipEvent(rawEvent, worldState) {
  const normalizedEvent = normalizePaperclipEvent(rawEvent);
  validatePaperclipEvent(normalizedEvent);
  return applyPaperclipEvent(normalizedEvent, worldState);
}

module.exports = {
  VALID_EVENT_TYPES,
  WORLD_WIDTH,
  WORLD_HEIGHT,
  DEFAULT_TILE_TYPE,
  LOCATION_DEFS,
  OUTDOOR_STATIONS,
  SUB_LOCATIONS,
  ACTIVITY_TEMPLATES,
  createVillageGrid,
  createWorldModel,
  normalizePaperclipEvent,
  validatePaperclipEvent,
  applyPaperclipEvent,
  handlePaperclipEvent
};
