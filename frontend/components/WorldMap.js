import {
  advanceAvatarRuntimeEntries,
  syncAvatarRuntimeEntries
} from '../avatarRuntime.mjs';
import { FURNITURE_SPRITES, FURNITURE_RENDER_SIZE, FURNITURE_ALIASES } from '../furnitureCatalog.mjs';

function resolveFurnitureKey(type) {
  const raw = `furniture.${type}`;
  return FURNITURE_ALIASES[raw] || raw;
}

function resolveFurnitureType(type) {
  const resolved = resolveFurnitureKey(type);
  return resolved.replace(/^furniture\./, '');
}

// Tile size range: MIN keeps mobile playable (30x30 world fits in 300px).
// MAX caps desktop so the world doesn't look chunky on large monitors.
const MIN_TILE_SIZE = 10;
const MAX_TILE_SIZE = 36;
const BASE_MOVE_INTERVAL_MS = 380;
const WALK_FRAME_INTERVAL_MS = 180;
const AUTHORITATIVE_DRIFT_THRESHOLD = 2;
const AUTHORITATIVE_PULL_INTERVAL_MS = 120;
const DEFAULT_ASSET_ROOT = '/assets/pixymoon/Cute RPG World';

const COLORS = {
  background: '#10200f',
  border: '#375934',
  grassA: '#5aad5e',
  grassB: '#62b866',
  dirt: '#c4a46c',
  path: '#d4c4a0',
  sand: '#e0d3a8',
  water: '#5a9ec4',
  idleAvatar: '#f2f7ff',
  workingAvatar: '#ffc857',
  avatarOutline: '#1a1f2b',
  label: '#f5ffef',
  propShadow: 'rgba(0, 0, 0, 0.18)',
  // Speech bubbles — RPG comic style: cream fill, warm brown border
  bubbleBg: '#fff8e4',
  bubbleBgWorking: '#ffe8b0',
  bubbleBorder: '#6b4a25',
  bubbleText: '#3e2a15',
  bubbleShadow: 'rgba(30, 20, 10, 0.3)',
  // Location signs — wooden plank style
  signPlank: '#9a6a3a',
  signPlankDark: '#6b4425',
  signPlankBorder: '#3e2814',
  signText: '#fff3d6',
  signTextShadow: 'rgba(0, 0, 0, 0.5)',
  signRivet: '#d4b080',
  // Name labels — outlined text
  nameText: '#ffffff',
  nameTextWorking: '#ffe180',
  nameOutline: '#1a1208',
  // Sidebar / panel
  panelBg: 'rgba(15, 23, 42, 0.92)',
  panelText: '#e2e8f0',
  panelHighlight: '#7dd3fc',
  panelBorder: 'rgba(148, 163, 184, 0.3)',
  // Time display
  timeBg: 'rgba(15, 23, 42, 0.85)',
  timeText: '#fef3c7',
};

// Movement vectors — reduced idle probability (1 in 8 instead of 1 in 5)
const MOVES = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, 0]
];

const DIRECTION_BY_MOVE = {
  '1,0': 'right',
  '-1,0': 'left',
  '0,1': 'down',
  '0,-1': 'up'
};

const TILE_TYPE_TO_SPRITE = {
  grass: ['terrain.grassA', 'terrain.grassB'],
  dirt: ['terrain.dirt'],
  path: ['terrain.path'],
  sand: ['terrain.sand'],
  stone: ['terrain.stone'],
  water: ['terrain.water']
};

const FIELD_B_TILESET = 'Cute RPG World (RPG Maker)/Cute RPG World - RPG Maker MZ/tilesets/CuteRPG_Field_B.png';
const FIELD_B_GRID = { mode: 'grid', columns: 16, rows: 16 };
const FOREST_B_TILESET = 'Cute RPG World (RPG Maker)/Cute RPG World - RPG Maker MZ/tilesets/CuteRPG_Forest_B.png';
const FOREST_B_GRID = { mode: 'grid', columns: 16, rows: 16 };
const FIELD_C_TILESET = 'Cute RPG World (RPG Maker)/Cute RPG World - RPG Maker MZ/tilesets/CuteRPG_Field_C.png';
const FIELD_C_GRID = { mode: 'grid', columns: 16, rows: 16 };
const VILLAGE_B_TILESET = 'Cute RPG World (RPG Maker)/Cute RPG World - RPG Maker MZ/tilesets/CuteRPG_Village_B.png';
const VILLAGE_B_GRID = { mode: 'grid', columns: 16, rows: 16 };
const INTERIOR_B_TILESET = 'Cute RPG World (RPG Maker)/Cute RPG World - RPG Maker MZ/tilesets/CuteRPG_Interior_B.png';
const INTERIOR_B_GRID = { mode: 'grid', columns: 16, rows: 16 };
// 53 character sheets available — each has 4 skin-tone variants in the top half
// Layout per sheet: 12 cols × 8 rows (864×576), but only top 4 rows populated
// Each variant: 3 cols × 4 rows (down/left/right/up directions, 3 animation frames)
const CHARACTER_SHEETS = Array.from({ length: 53 }, (_, i) => {
  const n = String(i + 1).padStart(3, '0');
  return `Cute RPG World (RPG Maker)/Cute RPG World - RPG Maker MZ/characters/!Character_RM_${n}.png`;
});
const CHARACTER_SHEET = CHARACTER_SHEETS[0];
const CHARACTER_GRID = { mode: 'grid', columns: 12, rows: 8 };
// 4 character variants per sheet (4 across top half, each 3cols × 4rows)
const CHARACTERS_PER_SHEET = 4;
const TOTAL_CHARACTERS = CHARACTER_SHEETS.length * CHARACTERS_PER_SHEET;
const WATER_TILESET = 'Cute RPG World (RPG Maker)/Cute RPG World - RPG Maker MZ/tilesets/CuteRPG_Field_A1.png';

const DEFAULT_SPRITE_DEFINITIONS = [
  {
    key: 'terrain.grassA',
    candidates: [
      { url: FIELD_B_TILESET, frame: { ...FIELD_B_GRID, column: 1, row: 2 } }
    ]
  },
  {
    key: 'terrain.grassB',
    candidates: [
      { url: FIELD_B_TILESET, frame: { ...FIELD_B_GRID, column: 3, row: 2 } }
    ]
  },
  {
    key: 'terrain.dirt',
    candidates: []
  },
  {
    key: 'terrain.path',
    candidates: []
  },
  {
    key: 'terrain.sand',
    candidates: []
  },
  {
    key: 'terrain.stone',
    candidates: []
  },
  {
    key: 'terrain.water',
    candidates: []
  },
  // Trees: verified by visual inspection of CuteRPG_Field_B.png. Small trees
  // are 1×2 (1 tile wide canopy + trunk), big trees are 2×2.
  {
    key: 'prop.tree',
    candidates: [
      { url: FIELD_B_TILESET, frame: { sx: 576, sy: 576, sw: 48, sh: 96 } } // col 12, rows 12-13
    ]
  },
  {
    key: 'prop.tree.alt',
    candidates: [
      { url: FIELD_B_TILESET, frame: { sx: 624, sy: 576, sw: 48, sh: 96 } } // col 13
    ]
  },
  {
    key: 'prop.tree.alt2',
    candidates: [
      { url: FIELD_B_TILESET, frame: { sx: 672, sy: 576, sw: 48, sh: 96 } } // col 14
    ]
  },
  {
    key: 'prop.tree.alt3',
    candidates: [
      { url: FIELD_B_TILESET, frame: { sx: 720, sy: 576, sw: 48, sh: 96 } } // col 15
    ]
  },
  {
    key: 'prop.tree.conifer',
    candidates: [
      { url: FIELD_B_TILESET, frame: { sx: 528, sy: 576, sw: 48, sh: 96 } } // col 11, pointed conifer
    ]
  },
  {
    key: 'prop.tree.big',
    candidates: [
      { url: FIELD_B_TILESET, frame: { sx: 240, sy: 384, sw: 96, sh: 96 } } // cols 5-6, row 8 (blue-green)
    ]
  },
  {
    key: 'prop.tree.big.alt',
    candidates: [
      { url: FIELD_B_TILESET, frame: { sx: 240, sy: 576, sw: 96, sh: 96 } } // cols 5-6, row 12 (lighter)
    ]
  },
  {
    key: 'prop.rock',
    candidates: []
  },
  {
    key: 'prop.rock.small',
    candidates: []
  },
  {
    key: 'deco.flower.pink',
    candidates: [
      { url: FOREST_B_TILESET, frame: { ...FOREST_B_GRID, column: 5, row: 4 } }
    ]
  },
  {
    key: 'deco.flower.purple',
    candidates: [
      { url: FOREST_B_TILESET, frame: { ...FOREST_B_GRID, column: 6, row: 5 } }
    ]
  },
  {
    key: 'deco.flower.mixed',
    candidates: [
      { url: FIELD_C_TILESET, frame: { ...FIELD_C_GRID, column: 2, row: 9 } }
    ]
  },
  {
    key: 'deco.flower.red',
    candidates: [
      { url: FIELD_B_TILESET, frame: { ...FIELD_B_GRID, column: 10, row: 5 } }
    ]
  },
  // Pre-composed building sprites from RPG Maker MZ C-series tilesets (768×768)
  // Each C tileset has the same layout but different roof colors: C1=orange, C2=green, C3=gray
  // Top row has 4 individual house variants, each ~186×216px with slight padding
  {
    key: 'building.house',
    candidates: [
      {
        url: 'Cute RPG World (RPG Maker)/Cute RPG World - RPG Maker MZ/tilesets/CuteRPG_Houses_RPGMaker_C1.png',
        frame: { sx: 3, sy: 24, sw: 186, sh: 216 }
      }
    ]
  },
  {
    key: 'building.house2',
    candidates: [
      {
        url: 'Cute RPG World (RPG Maker)/Cute RPG World - RPG Maker MZ/tilesets/CuteRPG_Houses_RPGMaker_C1.png',
        frame: { sx: 195, sy: 24, sw: 186, sh: 216 }
      }
    ]
  },
  {
    key: 'building.house.green',
    candidates: [
      {
        url: 'Cute RPG World (RPG Maker)/Cute RPG World - RPG Maker MZ/tilesets/CuteRPG_Houses_RPGMaker_C2.png',
        frame: { sx: 3, sy: 24, sw: 186, sh: 216 }
      }
    ]
  },
  {
    key: 'building.house.green2',
    candidates: [
      {
        url: 'Cute RPG World (RPG Maker)/Cute RPG World - RPG Maker MZ/tilesets/CuteRPG_Houses_RPGMaker_C2.png',
        frame: { sx: 195, sy: 24, sw: 186, sh: 216 }
      }
    ]
  },
  {
    key: 'building.house.gray',
    candidates: [
      {
        url: 'Cute RPG World (RPG Maker)/Cute RPG World - RPG Maker MZ/tilesets/CuteRPG_Houses_RPGMaker_C3.png',
        frame: { sx: 3, sy: 24, sw: 186, sh: 216 }
      }
    ]
  },
  {
    key: 'building.tower',
    candidates: [
      {
        url: 'Cute RPG World (RPG Maker)/Cute RPG World - RPG Maker MZ/tilesets/CuteRPG_Houses_RPGMaker_C3.png',
        frame: { sx: 387, sy: 24, sw: 186, sh: 216 }
      }
    ]
  },
  {
    key: 'building.large',
    candidates: [
      {
        url: 'Cute RPG World (RPG Maker)/Cute RPG World - RPG Maker MZ/tilesets/CuteRPG_Houses_RPGMaker_C1.png',
        frame: { sx: 3, sy: 552, sw: 237, sh: 216 }
      }
    ]
  },
  {
    key: 'building.shop',
    candidates: [
      {
        url: 'Cute RPG World (RPG Maker)/Cute RPG World - RPG Maker MZ/tilesets/CuteRPG_Houses_RPGMaker_C1.png',
        frame: { sx: 579, sy: 24, sw: 186, sh: 216 }
      }
    ]
  },
  // Interior furniture — pulled from frontend/furnitureCatalog.mjs.
  // Coordinates there are verified against grid-annotated screenshots of
  // Interior_B/Interior_C tilesets (see scripts/ for the annotator).
  ...FURNITURE_SPRITES.map(def => ({
    key: def.key,
    candidates: [{ url: def.url, frame: def.frame }]
  })),
  {
    key: 'avatar.idle.down',
    candidates: [
      { url: CHARACTER_SHEET, frame: { ...CHARACTER_GRID, column: 1, row: 0 } }
    ]
  },
  {
    key: 'avatar.walk.down.0',
    candidates: [
      { url: CHARACTER_SHEET, frame: { ...CHARACTER_GRID, column: 0, row: 0 } }
    ]
  },
  {
    key: 'avatar.walk.down.1',
    candidates: [
      { url: CHARACTER_SHEET, frame: { ...CHARACTER_GRID, column: 2, row: 0 } }
    ]
  },
  {
    key: 'avatar.idle.left',
    candidates: [
      { url: CHARACTER_SHEET, frame: { ...CHARACTER_GRID, column: 1, row: 1 } }
    ]
  },
  {
    key: 'avatar.walk.left.0',
    candidates: [
      { url: CHARACTER_SHEET, frame: { ...CHARACTER_GRID, column: 0, row: 1 } }
    ]
  },
  {
    key: 'avatar.walk.left.1',
    candidates: [
      { url: CHARACTER_SHEET, frame: { ...CHARACTER_GRID, column: 2, row: 1 } }
    ]
  },
  {
    key: 'avatar.idle.right',
    candidates: [
      { url: CHARACTER_SHEET, frame: { ...CHARACTER_GRID, column: 1, row: 2 } }
    ]
  },
  {
    key: 'avatar.walk.right.0',
    candidates: [
      { url: CHARACTER_SHEET, frame: { ...CHARACTER_GRID, column: 0, row: 2 } }
    ]
  },
  {
    key: 'avatar.walk.right.1',
    candidates: [
      { url: CHARACTER_SHEET, frame: { ...CHARACTER_GRID, column: 2, row: 2 } }
    ]
  },
  {
    key: 'avatar.idle.up',
    candidates: [
      { url: CHARACTER_SHEET, frame: { ...CHARACTER_GRID, column: 1, row: 3 } }
    ]
  },
  {
    key: 'avatar.walk.up.0',
    candidates: [
      { url: CHARACTER_SHEET, frame: { ...CHARACTER_GRID, column: 0, row: 3 } }
    ]
  },
  {
    key: 'avatar.walk.up.1',
    candidates: [
      { url: CHARACTER_SHEET, frame: { ...CHARACTER_GRID, column: 2, row: 3 } }
    ]
  }
];

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hashString(input) {
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash * 31 + input.charCodeAt(i)) >>> 0;
  }
  return hash;
}

function hashCoord(seed, x, y) {
  return (seed ^ (x * 73856093) ^ (y * 19349663)) >>> 0;
}

function deriveDefaultPosition(agentId, width, height) {
  const safeWidth = Math.max(1, width);
  const safeHeight = Math.max(1, height);
  const cellCount = safeWidth * safeHeight;
  const hash = hashString(agentId || 'agent');
  const index = hash % cellCount;

  return {
    x: index % safeWidth,
    y: Math.floor(index / safeWidth)
  };
}

function worldDimensions(worldState) {
  const world = isRecord(worldState?.world) ? worldState.world : {};
  const width = Number.isInteger(world.width) ? world.width : 25;
  const height = Number.isInteger(world.height) ? world.height : 25;

  return {
    width: width > 0 ? width : 25,
    height: height > 0 ? height : 25
  };
}

function normalizeAvatars(worldState) {
  const { width, height } = worldDimensions(worldState);
  const sourceAvatars = isRecord(worldState?.avatars) ? worldState.avatars : {};
  const agents = isRecord(worldState?.agents) ? worldState.agents : {};
  const normalized = {};

  Object.entries(sourceAvatars).forEach(([avatarId, avatar]) => {
    if (!isRecord(avatar)) {
      return;
    }

    const agentId =
      (typeof avatar.agentId === 'string' && avatar.agentId) || avatarId;
    const fallback = deriveDefaultPosition(agentId, width, height);
    const matchedAgent = agents[agentId];
    const displayName =
      (matchedAgent && typeof matchedAgent.name === 'string' && matchedAgent.name) ||
      agentId.slice(0, 8);
    normalized[agentId] = {
      id: agentId,
      displayName,
      x: Number.isFinite(avatar.x) ? clamp(avatar.x, 0, width - 1) : fallback.x,
      y: Number.isFinite(avatar.y) ? clamp(avatar.y, 0, height - 1) : fallback.y,
      authoritativePosition: avatar.moving === false,
      moving: avatar.moving !== false,
      state: avatar.state === 'working' ? 'working' : 'idle',
      bubbleText:
        typeof avatar.bubbleText === 'string' ? avatar.bubbleText.trim() : '',
      destination: isRecord(avatar.destination) ? avatar.destination : null
    };
  });

  Object.entries(agents).forEach(([agentId, agent]) => {
    if (normalized[agentId]) {
      return;
    }

    const fallback = deriveDefaultPosition(agentId, width, height);
    const task = Array.isArray(agent?.tasks)
      ? agent.tasks.find(item => item.status && item.status !== 'completed')
      : null;
    const bubbleText = task?.label || task?.id || '';
    const displayName =
      (agent && typeof agent.name === 'string' && agent.name) ||
      agentId.slice(0, 8);
    normalized[agentId] = {
      id: agentId,
      displayName,
      x: fallback.x,
      y: fallback.y,
      authoritativePosition: false,
      moving: !bubbleText,
      state: bubbleText ? 'working' : 'idle',
      bubbleText,
      destination: null
    };
  });

  return normalized;
}

function nextMoveTime(timestamp, rng = Math.random) {
  return (
    timestamp +
    BASE_MOVE_INTERVAL_MS +
    Math.floor(rng() * BASE_MOVE_INTERVAL_MS)
  );
}

function chooseMove(rng = Math.random) {
  const index = Math.floor(rng() * MOVES.length);
  return MOVES[index] || MOVES[0];
}

function drawRoundedRect(context, x, y, width, height, radius) {
  if (typeof context.roundRect === 'function') {
    context.roundRect(x, y, width, height, radius);
    return;
  }

  const safeRadius = Math.min(radius, width / 2, height / 2);
  context.moveTo(x + safeRadius, y);
  context.lineTo(x + width - safeRadius, y);
  context.arcTo(x + width, y, x + width, y + safeRadius, safeRadius);
  context.lineTo(x + width, y + height - safeRadius);
  context.arcTo(
    x + width,
    y + height,
    x + width - safeRadius,
    y + height,
    safeRadius
  );
  context.lineTo(x + safeRadius, y + height);
  context.arcTo(x, y + height, x, y + height - safeRadius, safeRadius);
  context.lineTo(x, y + safeRadius);
  context.arcTo(x, y, x + safeRadius, y, safeRadius);
}

function normalizeTileType(tile, fallback = 'grass') {
  if (typeof tile === 'string' && tile.trim()) {
    return tile.trim().toLowerCase();
  }

  if (isRecord(tile) && typeof tile.type === 'string' && tile.type.trim()) {
    return tile.type.trim().toLowerCase();
  }

  return fallback;
}

function normalizeTiles(worldState, width, height) {
  const world = isRecord(worldState?.world) ? worldState.world : {};
  const defaultTile =
    typeof world.defaultTile === 'string' && world.defaultTile.trim()
      ? world.defaultTile.trim().toLowerCase()
      : 'grass';
  const rows = Array.isArray(world.tiles) ? world.tiles : [];

  return Array.from({ length: height }, (_, y) => {
    const row = Array.isArray(rows[y]) ? rows[y] : [];
    return Array.from({ length: width }, (_, x) =>
      normalizeTileType(row[x], defaultTile)
    );
  });
}

function normalizeSceneEntity(input, width, height, category) {
  if (!isRecord(input)) {
    return null;
  }

  if (!Number.isFinite(input.x) || !Number.isFinite(input.y)) {
    return null;
  }

  const x = clamp(Math.floor(input.x), 0, width - 1);
  const y = clamp(Math.floor(input.y), 0, height - 1);
  const type =
    typeof input.type === 'string' && input.type.trim().length > 0
      ? input.type.trim().toLowerCase()
      : category === 'building'
        ? 'house'
        : 'tree';

  const widthTiles =
    Number.isFinite(input.widthTiles) && input.widthTiles > 0
      ? Math.floor(input.widthTiles)
      : category === 'building'
        ? 2
        : 1;
  const heightTiles =
    Number.isFinite(input.heightTiles) && input.heightTiles > 0
      ? Math.floor(input.heightTiles)
      : category === 'building'
        ? 2
        : 1;

  return {
    x,
    y,
    type,
    widthTiles,
    heightTiles
  };
}

function collectExplicitEntities(worldState, width, height) {
  const world = isRecord(worldState?.world) ? worldState.world : {};
  const explicitBuildings = [];
  const explicitProps = [];

  const buildingSources = [
    world?.buildings,
    world?.structures,
    worldState?.buildings,
    worldState?.structures
  ];
  buildingSources.forEach(source => {
    if (!Array.isArray(source)) {
      return;
    }

    source.forEach(item => {
      const normalized = normalizeSceneEntity(item, width, height, 'building');
      if (!normalized) {
        return;
      }

      if (normalized.type.includes('tree') || normalized.type.includes('rock')) {
        explicitProps.push(normalized);
      } else {
        explicitBuildings.push(normalized);
      }
    });
  });

  const propSources = [world?.props, world?.objects, worldState?.props, worldState?.objects];
  propSources.forEach(source => {
    if (!Array.isArray(source)) {
      return;
    }

    source.forEach(item => {
      const normalized = normalizeSceneEntity(item, width, height, 'prop');
      if (normalized) {
        explicitProps.push(normalized);
      }
    });
  });

  return { explicitBuildings, explicitProps, explicitDecorations: [] };
}

function inferPropSpriteKey(type) {
  if (type === 'rock.small') return 'prop.rock.small';
  if (type.includes('rock') || type.includes('stone')) return 'prop.rock';
  if (type === 'tree.big') return 'prop.tree.big';
  if (type === 'tree.big.alt') return 'prop.tree.big.alt';
  if (type === 'tree.alt') return 'prop.tree.alt';
  if (type === 'tree.alt2') return 'prop.tree.alt2';
  if (type === 'tree.alt3') return 'prop.tree.alt3';
  if (type === 'tree.conifer') return 'prop.tree.conifer';
  return 'prop.tree';
}

function inferDecoSpriteKey(type) {
  if (type === 'flower.purple') return 'deco.flower.purple';
  if (type === 'flower.mixed') return 'deco.flower.mixed';
  if (type === 'flower.red') return 'deco.flower.red';
  return 'deco.flower.pink';
}

function inferBuildingSpriteKey(type) {
  if (type.includes('tower') || type.includes('castle')) return 'building.tower';
  if (type === 'house2') return 'building.house2';
  if (type === 'house.green') return 'building.house.green';
  if (type === 'house.green2') return 'building.house.green2';
  if (type === 'house.gray') return 'building.house.gray';
  if (type === 'large') return 'building.large';
  if (type === 'shop') return 'building.shop';
  return 'building.house';
}

function overlapsBuilding(x, y, buildings) {
  return buildings.some(building => {
    const x2 = building.x + building.widthTiles - 1;
    const y2 = building.y + building.heightTiles - 1;
    return x >= building.x && x <= x2 && y >= building.y && y <= y2;
  });
}

function createGeneratedScene(worldState, width, height) {
  const agents = isRecord(worldState?.agents) ? Object.keys(worldState.agents) : [];
  const seed = hashString(`${width}:${height}:${agents.sort().join(',')}`);
  const midX = Math.floor(width / 2);
  const midY = Math.floor(height / 2);

  const world = isRecord(worldState?.world) ? worldState.world : {};
  const tileRows = Array.isArray(world.tiles) ? world.tiles : [];

  function getTileType(x, y) {
    const row = Array.isArray(tileRows[y]) ? tileRows[y] : [];
    const cell = row[x];
    if (typeof cell === 'string') return cell;
    if (isRecord(cell) && typeof cell.type === 'string') return cell.type;
    return 'grass';
  }

  function isOccupied(x, y, buildings, existingItems) {
    if (overlapsBuilding(x, y, buildings)) return true;
    return existingItems.some(p => p.x === x && p.y === y);
  }

  // ===== BUILDINGS — from world locations or default village layout =====
  const worldLocations = isRecord(worldState?.world) && Array.isArray(worldState.world.locations)
    ? worldState.world.locations
    : null;

  const buildingDefs = worldLocations
    ? worldLocations.map(loc => ({
        x: loc.x, y: loc.y,
        type: loc.type || 'house',
        widthTiles: loc.w || 5, heightTiles: loc.h || 4,
        locationId: loc.id, locationName: loc.name,
        stations: Array.isArray(loc.stations) ? loc.stations : [],
        zones: Array.isArray(loc.zones) ? loc.zones : [],
        interiorWalls: Array.isArray(loc.interiorWalls) ? loc.interiorWalls : []
      }))
    : [
        { x: 2, y: 2, type: 'house', widthTiles: 5, heightTiles: 4 },
        { x: clamp(width - 7, 9, width - 5), y: 2, type: 'house2', widthTiles: 5, heightTiles: 4 },
        { x: clamp(midX - 3, 3, width - 7), y: clamp(midY + 3, 5, height - 5), type: 'shop', widthTiles: 6, heightTiles: 5 },
        { x: 2, y: clamp(height - 6, midY + 3, height - 4), type: 'house.green', widthTiles: 5, heightTiles: 4 },
        { x: clamp(width - 7, 9, width - 5), y: clamp(height - 6, midY + 3, height - 4), type: 'house.gray', widthTiles: 5, heightTiles: 4 },
      ];
  const rawBuildings = buildingDefs.map(item => normalizeSceneEntity(item, width, height, 'building'));

  const generatedBuildings = rawBuildings.filter(Boolean);
  // Preserve location metadata + stations on buildings
  if (worldLocations) {
    generatedBuildings.forEach((b, i) => {
      if (buildingDefs[i]) {
        b.locationId = buildingDefs[i].locationId;
        b.locationName = buildingDefs[i].locationName;
        b.stations = buildingDefs[i].stations || [];
        b.zones = buildingDefs[i].zones || [];
        b.interiorWalls = buildingDefs[i].interiorWalls || [];
      }
    });
  }

  const props = [];
  const decorations = [];

  // ===== TREES =====
  // If the server supplies persisted trees (from world-layout.json / editor),
  // use those as the source of truth. Otherwise fall back to procedural
  // placement so a layoutless dev world still has a forest border.
  const persistedTrees = Array.isArray(world.trees) ? world.trees : null;
  if (persistedTrees && persistedTrees.length > 0) {
    for (const t of persistedTrees) {
      if (overlapsBuilding(t.x, t.y, generatedBuildings)) continue;
      const entry = { x: t.x, y: t.y, type: t.type || 'tree', widthTiles: 1, heightTiles: 1 };
      if (t.flipX) entry.flipX = true;
      if (t.flipY) entry.flipY = true;
      props.push(entry);
    }
  } else {
    // Procedural fallback — forest border + interior scatter.
    const topY = 1;
    const bottomY = height - 2;
    const SMALL_TREE_TYPES = ['tree', 'tree.alt', 'tree.alt2', 'tree.alt3', 'tree.conifer'];
    const BIG_TREE_TYPES = ['tree.big', 'tree.big.alt'];
    const pickTree = (h, bigFreq) => {
      const isBig = h % bigFreq === 0;
      if (isBig) return BIG_TREE_TYPES[(h >>> 3) % BIG_TREE_TYPES.length];
      return SMALL_TREE_TYPES[(h >>> 3) % SMALL_TREE_TYPES.length];
    };
    for (let x = 0; x < width; x++) {
      if (isOccupied(x, topY, generatedBuildings, props)) continue;
      const h = hashCoord(seed, x, topY);
      if (h % 3 !== 2) {
        props.push({ x, y: topY, type: pickTree(h, 5), widthTiles: 1, heightTiles: 1 });
      }
    }
    for (let x = 0; x < width; x++) {
      if (isOccupied(x, bottomY, generatedBuildings, props)) continue;
      const h = hashCoord(seed, x, bottomY);
      if (h % 3 !== 2) {
        props.push({ x, y: bottomY, type: pickTree(h, 4), widthTiles: 1, heightTiles: 1 });
      }
    }
    for (let y = 2; y < height - 2; y++) {
      if (!isOccupied(0, y, generatedBuildings, props)) {
        const h = hashCoord(seed, 0, y);
        if (h % 3 !== 2) {
          props.push({ x: 0, y, type: pickTree(h, 6), widthTiles: 1, heightTiles: 1 });
        }
      }
      if (!isOccupied(width - 1, y, generatedBuildings, props)) {
        const h = hashCoord(seed, width - 1, y);
        if (h % 3 !== 2) {
          props.push({ x: width - 1, y, type: pickTree(h, 6), widthTiles: 1, heightTiles: 1 });
        }
      }
    }
    for (let y = 2; y < height - 2; y++) {
      if (!isOccupied(1, y, generatedBuildings, props)) {
        const h = hashCoord(seed + 1, 1, y);
        if (h % 4 === 0) {
          props.push({ x: 1, y, type: pickTree(h, 8), widthTiles: 1, heightTiles: 1 });
        }
      }
      if (!isOccupied(width - 2, y, generatedBuildings, props)) {
        const h = hashCoord(seed + 1, width - 2, y);
        if (h % 4 === 0) {
          props.push({ x: width - 2, y, type: pickTree(h, 8), widthTiles: 1, heightTiles: 1 });
        }
      }
    }
    const interiorTreePositions = [
      [midX - 5, midY - 3], [midX + 5, midY - 3],
      [midX - 5, midY + 3], [midX + 5, midY + 3],
      [7, midY], [width - 8, midY],
      [midX - 3, midY + 6], [midX + 3, midY - 6],
      [4, midY - 2], [width - 5, midY + 2]
    ];
    interiorTreePositions.forEach(([tx, ty]) => {
      if (tx < 2 || tx >= width - 2 || ty < 2 || ty >= height - 2) return;
      if (isOccupied(tx, ty, generatedBuildings, props)) return;
      const tt = getTileType(tx, ty);
      if (tt === 'path' || tt === 'water' || tt === 'sand') return;
      const h = hashCoord(seed + 7, tx, ty);
      props.push({ x: tx, y: ty, type: pickTree(h, 3), widthTiles: 1, heightTiles: 1 });
    });
  }

  // Scatter rocks (sparse, on grass only)
  for (let y = 2; y < height - 2; y++) {
    for (let x = 2; x < width - 2; x++) {
      if (isOccupied(x, y, generatedBuildings, props)) continue;
      const tt = getTileType(x, y);
      if (tt === 'path' || tt === 'water' || tt === 'sand') continue;
      const value = hashCoord(seed, x, y) % 400;
      if (value === 0) props.push({ x, y, type: 'rock', widthTiles: 1, heightTiles: 1 });
      else if (value === 1) props.push({ x, y, type: 'rock.small', widthTiles: 1, heightTiles: 1 });
    }
  }

  // Mining quarry clusters — visible rock piles AROUND mining spots
  // (not on the spot tile itself so agents can stand there).
  const rockPiles = [
    { cx: 17, cy: 3 },  // mine_n quarry
    { cx: 18, cy: 27 }  // mine_s quarry
  ];
  const pileOffsets = [[1,0],[-1,0],[0,-1],[1,-1],[-1,1],[2,0]];
  for (const pile of rockPiles) {
    pileOffsets.forEach(([dx, dy], idx) => {
      const rx = pile.cx + dx;
      const ry = pile.cy + dy;
      if (rx < 1 || rx >= width - 1 || ry < 1 || ry >= height - 1) return;
      if (isOccupied(rx, ry, generatedBuildings, props)) return;
      const tt = getTileType(rx, ry);
      if (tt === 'path' || tt === 'water' || tt === 'sand') return;
      props.push({ x: rx, y: ry, type: idx % 2 === 0 ? 'rock' : 'rock.small', widthTiles: 1, heightTiles: 1 });
    });
  }

  // ===== DECORATIONS (non-blocking ground layer) =====

  // Flower garden CLUSTERS — denser patches in specific spots for visual focus
  const gardenClusters = [
    { cx: 10, cy: 10, r: 2.2, theme: 'pink' },   // NW garden
    { cx: 21, cy: 7,  r: 1.8, theme: 'purple' }, // NE garden
    { cx: 10, cy: 22, r: 2.2, theme: 'red' },    // SW garden
    { cx: 20, cy: 22, r: 2.2, theme: 'mixed' },  // SE garden
    { cx: 13, cy: 11, r: 1.5, theme: 'mixed' },  // Near plaza N
    { cx: 13, cy: 17, r: 1.5, theme: 'pink' }    // Near plaza S
  ];
  const clusterThemes = {
    pink:   ['flower.pink', 'flower.mixed'],
    purple: ['flower.purple', 'flower.mixed'],
    red:    ['flower.red', 'flower.mixed'],
    mixed:  ['flower.pink', 'flower.purple', 'flower.red', 'flower.mixed']
  };
  for (const cl of gardenClusters) {
    for (let y = Math.max(2, Math.floor(cl.cy - cl.r)); y <= Math.min(height-3, Math.ceil(cl.cy + cl.r)); y++) {
      for (let x = Math.max(2, Math.floor(cl.cx - cl.r)); x <= Math.min(width-3, Math.ceil(cl.cx + cl.r)); x++) {
        const dx = x - cl.cx, dy = y - cl.cy;
        if (dx*dx + dy*dy > cl.r*cl.r) continue;
        if (getTileType(x, y) !== 'grass') continue;
        if (isOccupied(x, y, generatedBuildings, props)) continue;
        // Leave gaps so the cluster looks natural, not a solid disc
        if (hashCoord(seed + 11, x, y) % 3 === 0) continue;
        const pool = clusterThemes[cl.theme];
        const idx = hashCoord(seed + 13, x, y) % pool.length;
        decorations.push({ x, y, type: pool[idx] });
      }
    }
  }

  // Sparse background flowers on open grass (outside clusters)
  for (let y = 2; y < height - 2; y++) {
    for (let x = 2; x < width - 2; x++) {
      const tt = getTileType(x, y);
      if (tt !== 'grass') continue;
      if (isOccupied(x, y, generatedBuildings, props)) continue;
      // Skip tiles already decorated by clusters
      if (decorations.some(d => d.x === x && d.y === y)) continue;
      const value = hashCoord(seed + 7, x, y) % 80;
      if (value < 2) {
        const flowerType = ['flower.pink', 'flower.purple', 'flower.mixed', 'flower.red'][value % 4];
        decorations.push({ x, y, type: flowerType });
      }
    }
  }

  return {
    generatedBuildings,
    generatedProps: props,
    generatedDecorations: decorations
  };
}

function buildSceneLayout(worldState) {
  const { width, height } = worldDimensions(worldState);
  const tiles = normalizeTiles(worldState, width, height);

  const { explicitBuildings, explicitProps, explicitDecorations } = collectExplicitEntities(
    worldState,
    width,
    height
  );

  const { generatedBuildings, generatedProps, generatedDecorations } = createGeneratedScene(
    worldState,
    width,
    height
  );

  const buildings = (explicitBuildings.length > 0 ? explicitBuildings : generatedBuildings)
    .filter(Boolean)
    .map(item => ({
      ...item,
      spriteKey: inferBuildingSpriteKey(item.type)
    }));

  const props = (explicitProps.length > 0 ? explicitProps : generatedProps)
    .filter(Boolean)
    .map(item => ({
      ...item,
      spriteKey: inferPropSpriteKey(item.type)
    }))
    .filter(item => !overlapsBuilding(item.x, item.y, buildings));

  // Compute blocked tile set for collision
  // Buildings: only block the perimeter wall tiles, interior tiles are walkable
  const blockedTiles = new Set();
  const interiorTiles = new Set();
  buildings.forEach(b => {
    const bw = b.widthTiles || 2;
    const bh = b.heightTiles || 2;
    for (let by = b.y; by < b.y + bh; by++) {
      for (let bx = b.x; bx < b.x + bw; bx++) {
        const isEdge = bx === b.x || bx === b.x + bw - 1 || by === b.y || by === b.y + bh - 1;
        if (isEdge) {
          // Leave bottom-center tile(s) as a door — walkable
          const isDoor = by === b.y + bh - 1 && bx > b.x && bx < b.x + bw - 1;
          if (!isDoor) {
            blockedTiles.add(`${bx},${by}`);
          }
        }
        // Mark interior (non-edge) tiles and door tiles as interior
        if (!isEdge || (by === b.y + bh - 1 && bx > b.x && bx < b.x + bw - 1)) {
          interiorTiles.add(`${bx},${by}`);
        }
      }
    }
  });
  props.forEach(p => blockedTiles.add(`${p.x},${p.y}`));
  // Block water tiles
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (tiles[y] && tiles[y][x] === 'water') {
        blockedTiles.add(`${x},${y}`);
      }
    }
  }

  const decoSource = explicitDecorations.length > 0 ? explicitDecorations : (generatedDecorations || []);
  const decorations = decoSource
    .filter(d => d && !overlapsBuilding(d.x, d.y, buildings))
    .map(d => ({ ...d, spriteKey: inferDecoSpriteKey(d.type) }));

  // Extract locations data for rendering location name signs
  const world = isRecord(worldState?.world) ? worldState.world : {};
  const locations = Array.isArray(world.locations) ? world.locations : [];

  // Expand per-building stations into a flat list with absolute tile coords,
  // for use by avatar routing.
  const stations = [];
  buildings.forEach(b => {
    const list = Array.isArray(b.stations) ? b.stations : [];
    for (const st of list) {
      stations.push({
        id: st.id,
        kind: st.kind,
        type: st.type,
        label: st.label || st.id,
        locationId: b.locationId || null,
        locationName: b.locationName || null,
        x: b.x + (st.dx || 0),
        y: b.y + (st.dy || 0)
      });
    }
  });
  // Outdoor stations (absolute coords, not building-local).
  const outdoorSource = Array.isArray(world.outdoorStations) ? world.outdoorStations : [];
  for (const os of outdoorSource) {
    stations.push({
      id: os.id,
      kind: os.kind,
      type: os.type,
      label: os.label || os.id,
      activity: os.activity || null,
      locationId: null,
      locationName: os.label || 'outdoors',
      x: os.x,
      y: os.y
    });
  }

  return {
    width,
    height,
    tiles,
    buildings,
    props,
    decorations,
    blockedTiles,
    interiorTiles,
    locations,
    stations
  };
}

function resolveUrl(basePath, filePath) {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    return null;
  }

  if (/^https?:\/\//i.test(filePath) || filePath.startsWith('/')) {
    return filePath;
  }

  const normalizedBase = (basePath || '').replace(/\/+$/, '');
  const normalizedPath = filePath.replace(/^\/+/, '');
  return `${normalizedBase}/${normalizedPath}`;
}

function loadImage(url, imageFactory) {
  return new Promise((resolve, reject) => {
    const image = imageFactory();
    image.crossOrigin = 'anonymous';
    image.decoding = 'async';
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`Image load failed: ${url}`));
    image.src = encodeURI(url);
  });
}

function resolveFrame(image, frame) {
  if (!isRecord(frame)) {
    return {
      sx: 0,
      sy: 0,
      sw: image.width,
      sh: image.height
    };
  }

  if (frame.mode === 'grid') {
    const columns = clamp(Math.floor(frame.columns || 1), 1, 256);
    const rows = clamp(Math.floor(frame.rows || 1), 1, 256);
    const column = clamp(Math.floor(frame.column || 0), 0, columns - 1);
    const row = clamp(Math.floor(frame.row || 0), 0, rows - 1);
    const sw = Math.max(1, Math.floor(image.width / columns));
    const sh = Math.max(1, Math.floor(image.height / rows));

    return {
      sx: column * sw,
      sy: row * sh,
      sw,
      sh
    };
  }

  const sx = clamp(Math.floor(frame.sx || frame.x || 0), 0, image.width - 1);
  const sy = clamp(Math.floor(frame.sy || frame.y || 0), 0, image.height - 1);
  const sw = clamp(
    Math.floor(frame.sw || frame.width || image.width),
    1,
    image.width - sx
  );
  const sh = clamp(
    Math.floor(frame.sh || frame.height || image.height),
    1,
    image.height - sy
  );

  return { sx, sy, sw, sh };
}

function normalizeManifestEntry(entry) {
  if (!isRecord(entry)) {
    return null;
  }

  const key =
    typeof entry.key === 'string' && entry.key.trim().length > 0
      ? entry.key.trim()
      : null;
  const url =
    typeof entry.url === 'string' && entry.url.trim().length > 0
      ? entry.url.trim()
      : typeof entry.src === 'string' && entry.src.trim().length > 0
        ? entry.src.trim()
        : null;

  if (!key || !url) {
    return null;
  }

  const frame = isRecord(entry.frame) ? entry.frame : null;
  return {
    key,
    candidates: [{ url, frame }]
  };
}

async function loadManifestDefinitions(assetRoot, fetchImpl) {
  try {
    const manifestUrl = resolveUrl(assetRoot, 'asset-manifest.json');
    const response = await fetchImpl(manifestUrl, { cache: 'no-store' });
    if (!response.ok) {
      return [];
    }

    const payload = await response.json();
    const source =
      Array.isArray(payload)
        ? payload
        : Array.isArray(payload?.sprites)
          ? payload.sprites
          : isRecord(payload?.sprites)
            ? Object.entries(payload.sprites).map(([key, value]) => ({
                key,
                ...(isRecord(value) ? value : { url: value })
              }))
            : [];

    return source
      .map(item => normalizeManifestEntry(item))
      .filter(Boolean)
      .map(item => ({
        key: item.key,
        candidates: item.candidates.map(candidate => ({
          ...candidate,
          url: resolveUrl(payload?.assetRoot || assetRoot, candidate.url)
        }))
      }));
  } catch (_error) {
    return [];
  }
}

class SpriteStore {
  constructor({ assetRoot, fetchImpl, imageFactory }) {
    this.assetRoot = assetRoot;
    this.fetchImpl = fetchImpl;
    this.imageFactory = imageFactory;
    this.sprites = new Map();
    this.characterSheetImages = [];
    this.loaded = false;
    this.summary = {
      loadedCount: 0,
      missingKeys: []
    };
  }

  getSprite(key) {
    return this.sprites.get(key) || null;
  }

  async load() {
    const manifestDefinitions = await loadManifestDefinitions(
      this.assetRoot,
      this.fetchImpl
    );
    const definitionMap = new Map(
      DEFAULT_SPRITE_DEFINITIONS.map(definition => [definition.key, definition])
    );

    manifestDefinitions.forEach(definition => {
      definitionMap.set(definition.key, definition);
    });

    const definitions = Array.from(definitionMap.values());
    const missingKeys = [];

    for (const definition of definitions) {
      const sprite = await this.loadDefinition(definition);
      if (!sprite) {
        missingKeys.push(definition.key);
        continue;
      }

      this.sprites.set(definition.key, sprite);
    }

    // Load all character sheet images for per-agent variants
    this.characterSheetImages = [];
    for (const sheetPath of CHARACTER_SHEETS) {
      const url = resolveUrl(this.assetRoot, sheetPath);
      if (!url) continue;
      try {
        const img = await loadImage(url, this.imageFactory);
        this.characterSheetImages.push(img);
      } catch (_e) {
        // skip unavailable sheets
      }
    }

    this.loaded = true;
    this.summary = {
      loadedCount: this.sprites.size,
      missingKeys
    };

    return this.summary;
  }

  async loadDefinition(definition) {
    const candidates = Array.isArray(definition?.candidates)
      ? definition.candidates
      : [];

    for (const candidate of candidates) {
      const resolvedUrl = resolveUrl(this.assetRoot, candidate.url);
      if (!resolvedUrl) {
        continue;
      }

      try {
        const image = await loadImage(resolvedUrl, this.imageFactory);
        const frame = resolveFrame(image, candidate.frame);

        return {
          image,
          ...frame
        };
      } catch (_error) {
        // Keep trying the next source candidate.
      }
    }

    return null;
  }
}

function chooseTerrainSpriteKey(tileType, x, y) {
  const candidates = TILE_TYPE_TO_SPRITE[tileType] || TILE_TYPE_TO_SPRITE.grass;
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return 'terrain.grassA';
  }

  if (candidates.length === 1) {
    return candidates[0];
  }

  return candidates[(x + y) % candidates.length];
}

export default class WorldMap {
  constructor(root, options = {}) {
    if (!root) {
      throw new Error('WorldMap requires a root element.');
    }

    this.root = root;
    this.canvas = document.createElement('canvas');
    this.context = this.canvas.getContext('2d');
    this.random = typeof options.random === 'function' ? options.random : Math.random;
    this.state = null;
    this.sceneLayout = null;
    this.avatarRuntime = new Map();
    this.frameId = null;
    this.tileSize = 24;
    this.offsetX = 0;
    this.offsetY = 0;

    const assetRoot =
      typeof options.assetRoot === 'string' && options.assetRoot.trim().length > 0
        ? options.assetRoot.trim()
        : DEFAULT_ASSET_ROOT;
    this.spriteStore = new SpriteStore({
      assetRoot,
      fetchImpl: typeof window.fetch === 'function' ? window.fetch.bind(window) : null,
      imageFactory:
        typeof options.imageFactory === 'function'
          ? options.imageFactory
          : () => new Image()
    });
    this.assetSummary = null;

    this.selectedAgent = null;

    // Editor hook state — populated by WorldEditor via setEditorMode /
    // setEditorState. When editor is null, rendering + clicks behave normally.
    this.editor = null;
    this.editorState = null;

    // Sky overlay mode: 'day' (no tint), 'night' (fixed night tint),
    // 'clock' (follow real time). Persisted per browser.
    const savedMode = typeof localStorage !== 'undefined'
      ? localStorage.getItem('agent-world.sky-mode') : null;
    this.skyMode = (savedMode === 'night' || savedMode === 'clock') ? savedMode : 'day';

    this.canvas.style.display = 'block';
    this.canvas.style.width = '100%';
    this.canvas.style.height = '100%';
    this.canvas.style.cursor = 'pointer';
    this.root.appendChild(this.canvas);

    // Sky mode cycler — tiny button in the top-right that toggles
    // day → night → live clock → day.
    const skyBtn = document.createElement('button');
    skyBtn.id = 'sky-mode-toggle';
    skyBtn.title = 'Cycle sky mode (Day / Night / Live clock)';
    const skyLabels = { day: '☀️ Day', night: '🌙 Night', clock: '🕐 Live' };
    const cycle = { day: 'night', night: 'clock', clock: 'day' };
    const refresh = () => { skyBtn.textContent = skyLabels[this.skyMode]; };
    Object.assign(skyBtn.style, {
      position: 'fixed', top: '12px', right: '232px', zIndex: 10,
      padding: '6px 10px', borderRadius: '6px',
      background: 'rgba(15,23,42,0.85)', border: '1px solid #94a3b8',
      color: '#e2e8f0', fontSize: '12px', cursor: 'pointer',
      fontFamily: 'inherit'
    });
    skyBtn.addEventListener('click', () => {
      this.setSkyMode(cycle[this.skyMode]);
      refresh();
    });
    refresh();
    document.body.appendChild(skyBtn);
    this.skyBtn = skyBtn;

    this.handleResize = this.handleResize.bind(this);
    this.handleClick = this.handleClick.bind(this);
    this.handleMouseDown = this.handleMouseDown.bind(this);
    this.handleTouchStart = this.handleTouchStart.bind(this);
    window.addEventListener('resize', this.handleResize);
    this.canvas.addEventListener('click', this.handleClick);
    this.canvas.addEventListener('mousedown', this.handleMouseDown);
    this.canvas.addEventListener('touchstart', this.handleTouchStart, { passive: false });
    this.handleResize();

    this.loadSprites();
  }

  async loadSprites() {
    if (!this.spriteStore.fetchImpl) {
      this.assetSummary = { loadedCount: 0, missingKeys: [] };
      return;
    }

    try {
      this.assetSummary = await this.spriteStore.load();
      this.render(performance.now());
    } catch (_error) {
      console.error('[WorldMap] sprite load failed:', _error);
      this.assetSummary = { loadedCount: 0, missingKeys: [] };
    }
  }

  destroy() {
    this.stop();
    window.removeEventListener('resize', this.handleResize);
    this.canvas.removeEventListener('click', this.handleClick);
    this.canvas.removeEventListener('mousedown', this.handleMouseDown);
    this.canvas.removeEventListener('touchstart', this.handleTouchStart);
  }

  handleTouchStart(event) {
    if (!event.touches || event.touches.length !== 1) return; // single-touch only
    const touch = event.touches[0];
    const rect = this.canvas.getBoundingClientRect();
    const cx = touch.clientX - rect.left;
    const cy = touch.clientY - rect.top;
    const tileX = Math.floor((cx - this.offsetX) / this.tileSize);
    const tileY = Math.floor((cy - this.offsetY) / this.tileSize);

    // Editor mode: translate touch to editor handler.
    if (this.editor && typeof this.editor.onCanvasMouseDown === 'function') {
      event.preventDefault();
      // Synthesize a mouse-like event object for consistency.
      this.editor.onCanvasMouseDown(tileX, tileY, this.state, {
        clientX: touch.clientX, clientY: touch.clientY,
        preventDefault: () => event.preventDefault(),
        isTouch: true
      });
      return;
    }

    // Non-editor: tap selects nearest agent (parity with click).
    let closestAgent = null;
    let closestDist = Infinity;
    const hitRadius = this.tileSize * 1.2; // touch is less precise
    this.avatarRuntime.forEach(avatar => {
      const ax = this.offsetX + avatar.x * this.tileSize + this.tileSize / 2;
      const ay = this.offsetY + avatar.y * this.tileSize + this.tileSize / 2;
      const dist = Math.sqrt((cx - ax) ** 2 + (cy - ay) ** 2);
      if (dist < hitRadius && dist < closestDist) {
        closestDist = dist;
        closestAgent = avatar;
      }
    });
    if (closestAgent) {
      event.preventDefault();
      this.selectedAgent = closestAgent;
    }
  }

  handleMouseDown(event) {
    if (!this.editor || typeof this.editor.onCanvasMouseDown !== 'function') return;
    if (event.button !== 0) return;
    const rect = this.canvas.getBoundingClientRect();
    const cx = event.clientX - rect.left;
    const cy = event.clientY - rect.top;
    const tileX = Math.floor((cx - this.offsetX) / this.tileSize);
    const tileY = Math.floor((cy - this.offsetY) / this.tileSize);
    this.editor.onCanvasMouseDown(tileX, tileY, this.state, event);
  }

  handleClick(event) {
    // In editor mode, mousedown already handled selection/placement;
    // suppress the subsequent click handler (which would select an agent).
    if (this.editor) return;

    const rect = this.canvas.getBoundingClientRect();
    const clickX = event.clientX - rect.left;
    const clickY = event.clientY - rect.top;

    // Check if click is on an agent
    let closestAgent = null;
    let closestDist = Infinity;
    const hitRadius = this.tileSize * 0.8;

    this.avatarRuntime.forEach(avatar => {
      const ax = this.offsetX + avatar.x * this.tileSize + this.tileSize / 2;
      const ay = this.offsetY + avatar.y * this.tileSize + this.tileSize / 2;
      const dist = Math.sqrt((clickX - ax) ** 2 + (clickY - ay) ** 2);
      if (dist < hitRadius && dist < closestDist) {
        closestDist = dist;
        closestAgent = avatar;
      }
    });

    this.selectedAgent = closestAgent;
  }

  setEditorMode(on, editor) {
    this.editor = on ? editor : null;
    if (!on) this.editorState = null;
    this.canvas.style.cursor = on ? 'crosshair' : 'pointer';
    this._refreshSceneLayout();
    this.render(performance.now());
  }

  setEditorState(state) {
    this.editorState = state || null;
    this._refreshSceneLayout();
    this.render(performance.now());
  }

  setWorldState(nextState) {
    this.state = nextState || null;
    this._refreshSceneLayout();
    this.syncRuntime();
    this.handleResize();
    this.render(performance.now());
  }

  // Rebuild sceneLayout from this.state, merging editor's working layout
  // when it's set. This lets drag/delete/add update the live rendered
  // sprites (not just the editor overlay).
  _refreshSceneLayout() {
    if (!this.state) { this.sceneLayout = null; return; }
    const effective = this.editorState && this.editorState.layout
      ? this._patchStateWithEditorLayout(this.state, this.editorState.layout)
      : this.state;
    this.sceneLayout = buildSceneLayout(effective);
  }

  _patchStateWithEditorLayout(state, layout) {
    const patched = { ...state, world: { ...state.world } };
    patched.world.trees = layout.trees.slice();
    patched.world.outdoorStations = layout.outdoorStations.slice();
    // Group indoor stations back into per-location lists.
    const byLoc = {};
    for (const s of layout.indoorStations) {
      if (!byLoc[s.locationId]) byLoc[s.locationId] = [];
      byLoc[s.locationId].push({
        id: s.id, kind: s.kind, type: s.type,
        dx: s.dx, dy: s.dy, label: s.label
      });
    }
    // If the editor has a buildings[] list, rebuild locations from it so
    // dragging a building updates its position (and all its stations) live.
    if (Array.isArray(layout.buildings)) {
      const origById = {};
      for (const l of (patched.world.locations || [])) origById[l.id] = l;
      patched.world.locations = layout.buildings.map(b => {
        const orig = origById[b.id] || {};
        return {
          ...orig,
          id: b.id, name: b.name, type: b.type,
          x: b.x, y: b.y, w: b.w, h: b.h,
          stations: byLoc[b.id] || []
        };
      });
    } else if (Array.isArray(patched.world.locations)) {
      patched.world.locations = patched.world.locations.map(loc => ({
        ...loc, stations: byLoc[loc.id] || []
      }));
    }
    return patched;
  }

  start() {
    if (this.frameId) {
      return;
    }

    const loop = timestamp => {
      this.update(timestamp);
      this.render(timestamp);
      this.frameId = window.requestAnimationFrame(loop);
    };

    this.frameId = window.requestAnimationFrame(loop);
  }

  stop() {
    if (!this.frameId) {
      return;
    }

    window.cancelAnimationFrame(this.frameId);
    this.frameId = null;
  }

  handleResize() {
    const { width, height } = worldDimensions(this.state);
    const viewportWidth = Math.max(320, this.root.clientWidth || window.innerWidth);
    const viewportHeight = Math.max(
      320,
      this.root.clientHeight || window.innerHeight
    );

    const computedTileSize = Math.floor(
      Math.min(viewportWidth / width, viewportHeight / height)
    );
    this.tileSize = clamp(computedTileSize, MIN_TILE_SIZE, MAX_TILE_SIZE);

    const worldPixelWidth = width * this.tileSize;
    const worldPixelHeight = height * this.tileSize;
    this.offsetX = Math.floor((viewportWidth - worldPixelWidth) / 2);
    this.offsetY = Math.floor((viewportHeight - worldPixelHeight) / 2);

    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.floor(viewportWidth * dpr);
    this.canvas.height = Math.floor(viewportHeight * dpr);
    this.canvas.style.width = `${viewportWidth}px`;
    this.canvas.style.height = `${viewportHeight}px`;
    this.context.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  syncRuntime() {
    const avatars = normalizeAvatars(this.state);
    syncAvatarRuntimeEntries(
      this.avatarRuntime,
      avatars,
      performance.now(),
      this.random
    );
  }

  update(timestamp) {
    if (!this.state) {
      return;
    }

    const blocked = this.sceneLayout ? this.sceneLayout.blockedTiles : null;
    const locations = this.state?.data?.world?.locations || this.state?.world?.locations || null;
    const stations = this.sceneLayout ? this.sceneLayout.stations : null;
    advanceAvatarRuntimeEntries(
      this.avatarRuntime,
      worldDimensions(this.state),
      timestamp,
      this.random,
      blocked,
      locations,
      stations
    );
  }

  drawSprite(spriteKey, dx, dy, dw, dh, options = null) {
    const sprite = this.spriteStore.getSprite(spriteKey);
    if (!sprite) {
      return false;
    }

    this.context.imageSmoothingEnabled = false;
    const flipX = options && options.flipX;
    const flipY = options && options.flipY;
    if (flipX || flipY) {
      const ctx = this.context;
      const cx = dx + dw / 2;
      const cy = dy + dh / 2;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.scale(flipX ? -1 : 1, flipY ? -1 : 1);
      ctx.translate(-cx, -cy);
      ctx.drawImage(
        sprite.image, sprite.sx, sprite.sy, sprite.sw, sprite.sh,
        Math.floor(dx), Math.floor(dy), Math.ceil(dw), Math.ceil(dh)
      );
      ctx.restore();
    } else {
      this.context.drawImage(
        sprite.image, sprite.sx, sprite.sy, sprite.sw, sprite.sh,
        Math.floor(dx), Math.floor(dy), Math.ceil(dw), Math.ceil(dh)
      );
    }

    return true;
  }

  drawTerrainTile(tileType, x, y, timestamp) {
    const spriteKey = chooseTerrainSpriteKey(tileType, x, y);
    const px = this.offsetX + x * this.tileSize;
    const py = this.offsetY + y * this.tileSize;

    if (this.drawSprite(spriteKey, px, py, this.tileSize, this.tileSize)) {
      return;
    }

    if (tileType === 'water') {
      this.drawWaterTile(px, py, x, y, timestamp || 0);
      return;
    }

    const fallbackColorByType = {
      dirt: COLORS.dirt,
      path: COLORS.path,
      sand: COLORS.sand,
      stone: '#8d97a0'
    };

    this.context.fillStyle =
      fallbackColorByType[tileType] ||
      ((x + y) % 2 === 0 ? COLORS.grassA : COLORS.grassB);
    this.context.fillRect(px, py, this.tileSize, this.tileSize);
  }

  drawWaterTile(px, py, tileX, tileY, timestamp) {
    const t = this.tileSize;
    const ctx = this.context;
    const phase = (timestamp / 1200) + tileX * 0.7 + tileY * 0.5;

    // Base water color with subtle variation per tile
    const brightness = Math.sin(phase) * 8;
    const r = Math.round(70 + brightness);
    const g = Math.round(148 + brightness * 1.5);
    const b = Math.round(196 + brightness);
    ctx.fillStyle = `rgb(${r},${g},${b})`;
    ctx.fillRect(px, py, t, t);

    // Animated ripple highlights
    ctx.strokeStyle = 'rgba(180, 220, 255, 0.35)';
    ctx.lineWidth = 1;
    const rippleOffset = Math.sin(phase * 1.3) * t * 0.15;
    ctx.beginPath();
    ctx.moveTo(px + t * 0.15, py + t * 0.35 + rippleOffset);
    ctx.quadraticCurveTo(px + t * 0.5, py + t * 0.25 + rippleOffset, px + t * 0.85, py + t * 0.35 + rippleOffset);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(px + t * 0.1, py + t * 0.65 - rippleOffset * 0.7);
    ctx.quadraticCurveTo(px + t * 0.5, py + t * 0.75 - rippleOffset * 0.7, px + t * 0.9, py + t * 0.65 - rippleOffset * 0.7);
    ctx.stroke();

    // Small sparkle
    const sparkleAlpha = Math.max(0, Math.sin(phase * 2.1 + 1.5)) * 0.4;
    if (sparkleAlpha > 0.05) {
      ctx.fillStyle = `rgba(255, 255, 255, ${sparkleAlpha})`;
      const sx = px + t * (0.3 + Math.sin(phase * 0.8) * 0.2);
      const sy = py + t * (0.4 + Math.cos(phase * 0.6) * 0.15);
      ctx.beginPath();
      ctx.arc(sx, sy, t * 0.04, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  drawProp(prop) {
    const px = this.offsetX + prop.x * this.tileSize;
    const py = this.offsetY + prop.y * this.tileSize;
    const isTree = typeof prop.spriteKey === 'string' && prop.spriteKey.startsWith('prop.tree');
    const isBigTree = prop.spriteKey === 'prop.tree.big' || prop.spriteKey === 'prop.tree.big.alt';

    this.context.fillStyle = COLORS.propShadow;
    this.context.beginPath();
    this.context.ellipse(
      px + this.tileSize * 0.5,
      py + this.tileSize * 0.86,
      this.tileSize * (isBigTree ? 0.42 : isTree ? 0.28 : 0.3),
      this.tileSize * (isBigTree ? 0.16 : isTree ? 0.12 : 0.12),
      0,
      0,
      Math.PI * 2
    );
    this.context.fill();

    const flipOpt = (prop.flipX || prop.flipY)
      ? { flipX: Boolean(prop.flipX), flipY: Boolean(prop.flipY) }
      : null;
    if (isTree) {
      // Big trees (2×2 sprites) render wider; small trees (1×2 sprites) are
      // half the width and render as a single-tile footprint with tall canopy.
      const th = this.tileSize * 1.6;
      const tw = isBigTree ? this.tileSize * 1.6 : this.tileSize * 0.9;
      if (this.drawSprite(prop.spriteKey, px + this.tileSize * 0.5 - tw / 2, py - th + this.tileSize * 0.9, tw, th, flipOpt)) {
        return;
      }
    } else if (
      this.drawSprite(
        prop.spriteKey,
        px,
        py - this.tileSize * 0.2,
        this.tileSize,
        this.tileSize * 1.2,
        flipOpt
      )
    ) {
      return;
    }

    if (prop.spriteKey === 'prop.rock' || prop.spriteKey === 'prop.rock.small') {
      const small = prop.spriteKey === 'prop.rock.small';
      const r = this.tileSize * (small ? 0.16 : 0.24);
      const cx = px + this.tileSize * 0.5;
      const cy = py + this.tileSize * 0.62;
      // Stone body
      this.context.fillStyle = '#9a9fa5';
      this.context.beginPath();
      this.context.ellipse(cx, cy, r, r * 0.8, 0, 0, Math.PI * 2);
      this.context.fill();
      // Highlight
      this.context.fillStyle = 'rgba(255, 255, 255, 0.25)';
      this.context.beginPath();
      this.context.ellipse(cx - r * 0.2, cy - r * 0.2, r * 0.5, r * 0.35, -0.3, 0, Math.PI * 2);
      this.context.fill();
      // Outline
      this.context.strokeStyle = '#6b7280';
      this.context.lineWidth = 1;
      this.context.beginPath();
      this.context.ellipse(cx, cy, r, r * 0.8, 0, 0, Math.PI * 2);
      this.context.stroke();
      return;
    }

    // Default tree fallback
    this.context.fillStyle = '#2a6b2f';
    this.context.beginPath();
    this.context.arc(px + this.tileSize * 0.5, py + this.tileSize * 0.4, this.tileSize * 0.3, 0, Math.PI * 2);
    this.context.fill();
    this.context.fillStyle = '#7c4a20';
    this.context.fillRect(px + this.tileSize * 0.44, py + this.tileSize * 0.5, this.tileSize * 0.12, this.tileSize * 0.4);
  }

  drawBuildingInterior(building) {
    const widthTiles = Math.max(1, building.widthTiles || 2);
    const heightTiles = Math.max(1, building.heightTiles || 2);
    const px = this.offsetX + building.x * this.tileSize;
    const py = this.offsetY + building.y * this.tileSize;
    const drawWidth = this.tileSize * widthTiles;
    const drawHeight = this.tileSize * heightTiles;
    const ts = this.tileSize;
    const ctx = this.context;

    // Default interior floor — warm wood plank color
    const defaultFloor = '#d4b88c';
    ctx.fillStyle = defaultFloor;
    ctx.fillRect(px + 2, py + 2, drawWidth - 4, drawHeight - 4);

    // Zones: per-room floor tint (e.g. tile for kitchen, carpet for bedroom)
    const zones = Array.isArray(building.zones) ? building.zones : [];
    for (const z of zones) {
      ctx.fillStyle = z.floor || defaultFloor;
      const zx = px + z.x1 * ts;
      const zy = py + z.y1 * ts;
      const zw = (z.x2 - z.x1) * ts;
      const zh = (z.y2 - z.y1) * ts;
      ctx.fillRect(zx, zy, zw, zh);
    }

    // Subtle plank texture (horizontal lines only — vertical staggered seams
    // looked noisy next to our small tile size).
    ctx.strokeStyle = 'rgba(92, 74, 50, 0.18)';
    ctx.lineWidth = 1;
    const plankHeight = ts * 0.5;
    for (let ly = py + plankHeight; ly < py + drawHeight - 2; ly += plankHeight) {
      ctx.beginPath();
      ctx.moveTo(px + 3, ly);
      ctx.lineTo(px + drawWidth - 3, ly);
      ctx.stroke();
    }

    // Outer wall border
    ctx.strokeStyle = '#5c4a32';
    ctx.lineWidth = 3;
    ctx.strokeRect(px + 1, py + 1, drawWidth - 2, drawHeight - 2);

    // Interior walls (room dividers). Coords are fractional tiles relative to
    // the building. Each entry is a line segment — use multiple segments to
    // create door gaps.
    const innerWalls = Array.isArray(building.interiorWalls) ? building.interiorWalls : [];
    if (innerWalls.length > 0) {
      ctx.strokeStyle = '#7a6040';
      ctx.lineWidth = 2;
      for (const w of innerWalls) {
        ctx.beginPath();
        ctx.moveTo(px + w.x1 * ts, py + w.y1 * ts);
        ctx.lineTo(px + w.x2 * ts, py + w.y2 * ts);
        ctx.stroke();
      }
    }

    // Door at bottom center — 1 tile wide, positioned at the agent's
    // logical entry tile (dx = Math.floor(w/2)). We draw a threshold strip
    // (lighter floor) with a dark frame to make the opening legible as a
    // door, not just a gap in the wall.
    const doorDx = Math.floor(widthTiles / 2);
    const doorX = px + doorDx * ts;
    const doorY = py + drawHeight - 4;
    // Cut the wall at the threshold
    ctx.fillStyle = defaultFloor;
    ctx.fillRect(doorX + 3, doorY, ts - 6, 6);
    // Threshold mat — slightly darker strip outside the wall line
    ctx.fillStyle = '#8c6a42';
    ctx.fillRect(doorX + 4, py + drawHeight - 2, ts - 8, 3);
    // Door frame uprights
    ctx.fillStyle = '#4a3a22';
    ctx.fillRect(doorX + 2, doorY - 2, 2, 6);
    ctx.fillRect(doorX + ts - 4, doorY - 2, 2, 6);

    // Furniture: station (dx, dy) is the TOP-LEFT tile of the sprite's
    // footprint. size.w/h controls how many adjacent tiles it claims.
    const stations = Array.isArray(building.stations) ? building.stations : [];
    const inset = 2;
    for (const st of stations) {
      const key = resolveFurnitureKey(st.type);
      const resolvedType = resolveFurnitureType(st.type);
      const size = FURNITURE_RENDER_SIZE[resolvedType] || { w: 1, h: 1 };
      const fw = ts * size.w - inset * 2;
      const fh = ts * size.h - inset * 2;
      const fx = px + st.dx * ts + inset;
      const fy = py + st.dy * ts + inset;
      const flipOpt = (st.flipX || st.flipY)
        ? { flipX: Boolean(st.flipX), flipY: Boolean(st.flipY) }
        : null;
      this.drawSprite(key, fx, fy, fw, fh, flipOpt);
    }
  }

  drawBuilding(building, transparent) {
    const widthTiles = Math.max(1, building.widthTiles || 2);
    const heightTiles = Math.max(1, building.heightTiles || 2);
    const px = this.offsetX + building.x * this.tileSize;
    const py = this.offsetY + building.y * this.tileSize;
    const drawWidth = this.tileSize * widthTiles;
    const drawHeight = this.tileSize * heightTiles;

    const prevAlpha = this.context.globalAlpha;
    if (transparent) {
      this.context.globalAlpha = 0.3;
    }

    // Building sprites from RPG Maker C-series are taller than their tile footprint
    // (186×216px for a ~4×3 tile building). Draw with roof extending above the tile area.
    const spriteDrawHeight = drawHeight * 1.4;
    const roofOverhang = spriteDrawHeight - drawHeight;
    if (this.drawSprite(building.spriteKey, px, py - roofOverhang, drawWidth, spriteDrawHeight)) {
      this.context.globalAlpha = prevAlpha;
      return;
    }

    // Fallback: colored rectangle with roof
    const roofColors = {
      'building.tower': '#6b7b8a',
      'building.house.gray': '#6b7b8a',
      'building.house.green': '#3a8c4f',
      'building.house.green2': '#3a8c4f',
      'building.shop': '#d4844a',
      'building.large': '#d4844a'
    };
    const roofColor = roofColors[building.spriteKey] || '#c46030';

    this.context.fillStyle = '#c5a67a';
    this.context.fillRect(px, py + drawHeight * 0.3, drawWidth, drawHeight * 0.7);

    this.context.fillStyle = roofColor;
    this.context.fillRect(px - drawWidth * 0.05, py, drawWidth * 1.1, drawHeight * 0.4);

    this.context.fillStyle = '#2f2a26';
    this.context.fillRect(
      px + drawWidth * 0.4,
      py + drawHeight * 0.55,
      drawWidth * 0.2,
      drawHeight * 0.45
    );
    this.context.globalAlpha = prevAlpha;
  }

  drawFallbackAvatar(centerX, centerY, radius, isWorking, walkPhase) {
    this.context.beginPath();
    this.context.fillStyle = isWorking ? COLORS.workingAvatar : COLORS.idleAvatar;
    this.context.strokeStyle = COLORS.avatarOutline;
    this.context.lineWidth = 2;
    this.context.arc(centerX, centerY, radius, 0, Math.PI * 2);
    this.context.fill();
    this.context.stroke();

    if (walkPhase !== null) {
      const stride = walkPhase === 0 ? -1 : 1;
      this.context.strokeStyle = COLORS.avatarOutline;
      this.context.lineWidth = 1;
      this.context.beginPath();
      this.context.moveTo(centerX - 4, centerY + radius - 1);
      this.context.lineTo(centerX - 4 + stride, centerY + radius + 4);
      this.context.moveTo(centerX + 4, centerY + radius - 1);
      this.context.lineTo(centerX + 4 - stride, centerY + radius + 4);
      this.context.stroke();
    }
  }

  drawCharacterVariant(avatar, timestamp) {
    const sheets = this.spriteStore.characterSheetImages;
    if (!sheets || sheets.length === 0) return false;

    const variantIndex = hashString(avatar.id || '') % (sheets.length * CHARACTERS_PER_SHEET);
    const sheetIndex = Math.floor(variantIndex / CHARACTERS_PER_SHEET);
    const charInSheet = variantIndex % CHARACTERS_PER_SHEET;
    const sheet = sheets[sheetIndex];
    if (!sheet) return false;

    const direction = avatar.direction || 'down';
    const walkPhase = avatar.moving
      ? Math.floor(timestamp / WALK_FRAME_INTERVAL_MS) % 2
      : null;

    const dirRow = { down: 0, left: 1, right: 2, up: 3 }[direction] || 0;
    const frameCol = avatar.moving ? (walkPhase === 0 ? 0 : 2) : 1;

    const baseCol = (charInSheet % 4) * 3;
    const baseRow = Math.floor(charInSheet / 4) * 4;

    const cellW = Math.floor(sheet.width / 12);
    const cellH = Math.floor(sheet.height / 8);

    const sx = (baseCol + frameCol) * cellW;
    const sy = (baseRow + dirRow) * cellH;

    const centerX = this.offsetX + avatar.x * this.tileSize + this.tileSize / 2;
    const centerY = this.offsetY + avatar.y * this.tileSize + this.tileSize / 2;

    this.context.imageSmoothingEnabled = false;
    this.context.drawImage(
      sheet,
      sx, sy, cellW, cellH,
      Math.floor(centerX - this.tileSize * 0.48),
      Math.floor(centerY - this.tileSize * 0.62),
      Math.ceil(this.tileSize * 0.96),
      Math.ceil(this.tileSize * 1.24)
    );

    return true;
  }

  drawAvatar(avatar, timestamp) {
    const centerX = this.offsetX + avatar.x * this.tileSize + this.tileSize / 2;
    const centerY = this.offsetY + avatar.y * this.tileSize + this.tileSize / 2;
    const radius = Math.max(4, Math.floor(this.tileSize * 0.3));
    const walkPhase = avatar.moving
      ? Math.floor(timestamp / WALK_FRAME_INTERVAL_MS) % 2
      : null;

    // Subtle shadow under the agent for depth
    const prevAlpha = this.context.globalAlpha;
    this.context.globalAlpha = 0.25;
    this.context.fillStyle = '#000';
    this.context.beginPath();
    this.context.ellipse(
      centerX,
      centerY + this.tileSize * 0.52,
      this.tileSize * 0.3,
      this.tileSize * 0.1,
      0, 0, Math.PI * 2
    );
    this.context.fill();
    this.context.globalAlpha = prevAlpha;

    // Draw per-agent character variant
    const didDrawSprite = this.drawCharacterVariant(avatar, timestamp);

    if (!didDrawSprite) {
      this.drawFallbackAvatar(
        centerX,
        centerY,
        radius,
        avatar.state === 'working',
        walkPhase
      );
    }

    // --- Generative Agents-style labels ---
    const displayName = avatar.displayName || avatar.id;

    // Activity label above the agent (always visible, Smallville style).
    // If an ambient chat line is active, that takes priority over the
    // static activity text — keeps the world feeling lively without
    // stacking two bubbles on one agent.
    const rawBubble = (avatar.bubbleText || '').trim();
    const chatText = avatar.chat && avatar.chat.expiresAt > timestamp
      ? avatar.chat.text : '';
    const activityText = chatText || rawBubble ||
      (avatar.state === 'working' ? 'working...' : '');
    if (activityText) {
      this.drawActivityLabel(
        centerX,
        centerY - this.tileSize * 0.7 - 6,
        activityText,
        // Chat bubbles are styled like idle — the working amber only
        // applies to actual task labels.
        !chatText && avatar.state === 'working'
      );
    }

    // Name label below the agent — outlined text (no background box), so
    // the character sprite stays the visual focal point.
    const nameFontSize = Math.max(9, Math.floor(this.tileSize * 0.36));
    const isWorking = avatar.state === 'working';
    this.context.font = `600 ${nameFontSize}px "Segoe UI", "Helvetica Neue", Arial, sans-serif`;
    this.context.textAlign = 'center';
    this.context.textBaseline = 'alphabetic';
    const nameY = centerY + this.tileSize * 0.62 + 12;

    // Dark outline for legibility over any background
    this.context.strokeStyle = COLORS.nameOutline;
    this.context.lineWidth = 3;
    this.context.lineJoin = 'round';
    this.context.strokeText(displayName, centerX, nameY);

    this.context.fillStyle = isWorking ? COLORS.nameTextWorking : COLORS.nameText;
    this.context.fillText(displayName, centerX, nameY);
  }

  render(timestamp = performance.now()) {
    const context = this.context;
    const canvasWidth = Number.parseInt(this.canvas.style.width || '0', 10) || 0;
    const canvasHeight = Number.parseInt(this.canvas.style.height || '0', 10) || 0;
    context.clearRect(0, 0, canvasWidth, canvasHeight);

    context.fillStyle = COLORS.background;
    context.fillRect(0, 0, canvasWidth, canvasHeight);

    if (!this.state) {
      context.fillStyle = COLORS.label;
      context.font = '16px Menlo, monospace';
      context.fillText('Waiting for world state...', 20, 32);
      return;
    }

    const layout = this.sceneLayout || buildSceneLayout(this.state);
    const { width, height } = layout;
    const worldPixelWidth = width * this.tileSize;
    const worldPixelHeight = height * this.tileSize;

    context.fillStyle = COLORS.border;
    context.fillRect(
      this.offsetX - 2,
      this.offsetY - 2,
      worldPixelWidth + 4,
      worldPixelHeight + 4
    );

    for (let y = 0; y < height; y += 1) {
      const row = layout.tiles[y] || [];
      for (let x = 0; x < width; x += 1) {
        this.drawTerrainTile(row[x] || 'grass', x, y, timestamp);
      }
    }

    // Layer 1: Ground decorations (flowers, bushes, pebbles - non-blocking)
    if (layout.decorations) {
      layout.decorations.forEach(deco => {
        const px = this.offsetX + deco.x * this.tileSize;
        const py = this.offsetY + deco.y * this.tileSize;
        if (this.drawSprite(deco.spriteKey, px, py, this.tileSize, this.tileSize)) {
          return;
        }
        // Programmatic fallbacks for decorations without sprites
        const t = this.tileSize;
        if (deco.type === 'bush') {
          this.context.fillStyle = '#4a8c3f';
          this.context.beginPath();
          this.context.arc(px + t * 0.5, py + t * 0.6, t * 0.22, 0, Math.PI * 2);
          this.context.fill();
          this.context.fillStyle = '#5aad5e';
          this.context.beginPath();
          this.context.arc(px + t * 0.4, py + t * 0.52, t * 0.14, 0, Math.PI * 2);
          this.context.fill();
        } else if (deco.type === 'pebbles') {
          this.context.fillStyle = '#a0a5aa';
          const offsets = [[0.35, 0.55], [0.55, 0.6], [0.45, 0.7], [0.6, 0.48]];
          offsets.forEach(([ox, oy]) => {
            this.context.beginPath();
            this.context.arc(px + t * ox, py + t * oy, t * 0.06, 0, Math.PI * 2);
            this.context.fill();
          });
        }
      });
    }

    // Layer 2: Draw interior floors for all buildings (no roofs — agents must be visible)
    layout.buildings.forEach(building => {
      this.drawBuildingInterior(building);
    });

    // Layer 3: Props (trees, rocks, etc.)
    layout.props.forEach(prop => {
      this.drawProp(prop);
    });

    // Layer 4: Agents (on top of interiors but below roofs)
    this.avatarRuntime.forEach(avatar => {
      this.drawAvatar(avatar, timestamp);
    });

    // Layer 4.5: Interaction markers — 💬 between agents that are within
    // 2 tiles of each other. Visual hint that they're "meeting".
    this.drawAgentInteractions(timestamp);

    // Layer 5: Roofs intentionally omitted — interiors are always visible so
    // agents can be seen working at stations. Walls are drawn as part of
    // drawBuildingInterior (Layer 2). If a non-location building has no
    // stations[], draw the legacy sprite so fallback scenes still render.
    layout.buildings.forEach(building => {
      if (Array.isArray(building.stations) && building.stations.length > 0) {
        return; // roofless — skip sprite
      }
      this.drawBuilding(building, false);
    });

    // Layer 6: Location name signs above buildings
    this.drawLocationSigns(layout, timestamp);

    // Layer 6.5: Day/night sky tint over the world
    this.drawSkyOverlay();

    // Layer 7: UI overlays — time display and agent roster
    this.drawTimeDisplay(timestamp);
    this.drawAgentRoster(timestamp);

    // Layer 8: Selected agent profile panel
    if (this.selectedAgent) {
      this.drawAgentProfile(this.selectedAgent, timestamp);
    }

    // Layer 9: Editor overlays (only when edit mode is on)
    if (this.editor && this.editorState) {
      this.drawEditorOverlay();
    }
  }

  drawEditorOverlay() {
    const state = this.editorState;
    if (!state || !state.layout) return;
    const ctx = this.context;
    const ts = this.tileSize;
    const { layout, selection, pendingAdd } = state;
    const locations = this.state?.world?.locations || [];
    const locById = {};
    for (const l of locations) locById[l.id] = l;

    // Build marker list with world coords
    const markers = [];
    layout.trees.forEach((t, i) => markers.push({ kind: 'tree', id: String(i), x: t.x, y: t.y, color: '#16a34a' }));
    layout.outdoorStations.forEach(s => markers.push({
      kind: 'outdoor', id: s.id, x: s.x, y: s.y,
      color: s.kind === 'work' ? '#f59e0b' : '#10b981'
    }));
    layout.indoorStations.forEach(s => {
      const loc = locById[s.locationId];
      if (!loc) return;
      markers.push({
        kind: 'indoor', id: s.id, x: loc.x + s.dx, y: loc.y + s.dy,
        color: s.kind === 'work' ? '#f59e0b' : '#10b981'
      });
    });

    for (const m of markers) {
      const cx = this.offsetX + m.x * ts + ts / 2;
      const cy = this.offsetY + m.y * ts + ts / 2;
      const isSel = selection && selection.kind === m.kind && selection.id === m.id;
      ctx.strokeStyle = m.color;
      ctx.lineWidth = 1.5;
      ctx.fillStyle = m.color + '33'; // 20% alpha
      ctx.beginPath();
      ctx.rect(this.offsetX + m.x * ts + 2, this.offsetY + m.y * ts + 2, ts - 4, ts - 4);
      ctx.fill();
      ctx.stroke();
      if (isSel) {
        ctx.strokeStyle = '#fbbf24';
        ctx.lineWidth = 3;
        ctx.strokeRect(this.offsetX + m.x * ts - 1, this.offsetY + m.y * ts - 1, ts + 2, ts + 2);
      }
    }

    // Building outlines + selection ring (multi-tile rects).
    const buildings = Array.isArray(layout.buildings) ? layout.buildings : [];
    for (const b of buildings) {
      const isSel = selection && selection.kind === 'building' && selection.id === b.id;
      const x = this.offsetX + b.x * ts;
      const y = this.offsetY + b.y * ts;
      const w = b.w * ts;
      const hh = b.h * ts;
      ctx.strokeStyle = isSel ? '#fbbf24' : 'rgba(251,191,36,0.35)';
      ctx.lineWidth = isSel ? 3 : 1;
      ctx.setLineDash(isSel ? [] : [4, 3]);
      ctx.strokeRect(x, y, w, hh);
      ctx.setLineDash([]);
    }

    // Pending-add cursor hint
    if (pendingAdd) {
      ctx.fillStyle = 'rgba(15,23,42,0.85)';
      ctx.fillRect(this.offsetX, this.offsetY - 32, 280, 26);
      ctx.fillStyle = 'rgba(251,191,36,0.95)';
      ctx.font = '13px Menlo, monospace';
      ctx.textAlign = 'left';
      ctx.fillText(`Placing: ${pendingAdd.type} — click to drop, Esc to cancel`, this.offsetX + 8, this.offsetY - 14);
    }
  }

  drawActivityLabel(centerX, bottomY, text, isWorking) {
    const context = this.context;
    // Defensive: skip blank/whitespace-only text so we never draw an
    // empty brown pill.
    const safeText = typeof text === 'string' ? text.trim() : '';
    if (!safeText) return;
    const fontSize = Math.max(9, Math.floor(this.tileSize * 0.34));
    context.font = `${isWorking ? '600 ' : ''}${fontSize}px "Segoe UI", "Helvetica Neue", Arial, sans-serif`;
    context.textAlign = 'center';
    context.textBaseline = 'alphabetic';

    const displayText = safeText.length > 32 ? safeText.slice(0, 30) + '…' : safeText;
    const textWidth = context.measureText(displayText).width;
    const padX = 8;
    const padY = 5;
    const bubbleW = textWidth + padX * 2;
    const bubbleH = fontSize + padY * 2;
    const tailH = 4;
    const top = bottomY - bubbleH - tailH;
    const left = centerX - bubbleW / 2;
    const radius = Math.min(6, bubbleH / 2);
    const bodyFill = isWorking ? COLORS.bubbleBgWorking : COLORS.bubbleBg;

    // Drop shadow (slightly offset). beginPath() is required because
    // drawRoundedRect doesn't start a new path — without it, the path
    // would accumulate with whatever the caller left behind.
    context.fillStyle = COLORS.bubbleShadow;
    context.beginPath();
    drawRoundedRect(context, left + 1, top + 2, bubbleW, bubbleH, radius);
    context.fill();

    // Tail — a small circle centered below the bubble. Drawn BEFORE the
    // bubble so the bubble's bottom edge covers the top of the circle.
    const tailY = top + bubbleH;
    context.fillStyle = bodyFill;
    context.beginPath();
    context.arc(centerX - 1, tailY + 1, tailH - 0.5, 0, Math.PI * 2);
    context.fill();
    context.strokeStyle = COLORS.bubbleBorder;
    context.lineWidth = 1.5;
    context.stroke();

    // Bubble body — rounded rect on top of the tail circle's upper half.
    // Fresh beginPath() ensures the stroke doesn't re-outline the tail.
    context.fillStyle = bodyFill;
    context.beginPath();
    drawRoundedRect(context, left, top, bubbleW, bubbleH, radius);
    context.fill();
    context.strokeStyle = COLORS.bubbleBorder;
    context.lineWidth = 1.5;
    context.stroke();

    // Repaint the top strip of the tail circle where it meets the bubble,
    // so the border doesn't cross through the junction.
    context.fillStyle = bodyFill;
    context.fillRect(centerX - tailH, tailY - 0.5, tailH * 2, 2);

    // Text
    context.fillStyle = COLORS.bubbleText;
    context.fillText(displayText, centerX, top + bubbleH - padY - 1);
  }

  drawLocationSigns(layout, timestamp) {
    if (!layout.locations || layout.locations.length === 0) return;

    const context = this.context;
    for (const loc of layout.locations) {
      const bw = loc.w || 5;
      const px = this.offsetX + (loc.x + bw / 2) * this.tileSize;
      // Position just above the roof (closer to the building than before).
      const py = this.offsetY + (loc.y - 0.6) * this.tileSize;

      const fontSize = Math.max(9, Math.floor(this.tileSize * 0.36));
      context.font = `700 ${fontSize}px "Segoe UI", "Helvetica Neue", Arial, sans-serif`;
      context.textAlign = 'center';
      context.textBaseline = 'alphabetic';

      const nameWidth = context.measureText(loc.name).width;
      const padX = 9;
      const padY = 5;
      const signW = nameWidth + padX * 2;
      const signH = fontSize + padY * 2;
      const signX = px - signW / 2;
      const signY = py - signH / 2;
      const radius = 3;

      // Drop shadow under the plank
      context.fillStyle = 'rgba(20, 10, 5, 0.35)';
      context.beginPath();
      drawRoundedRect(context, signX + 1, signY + 2, signW, signH, radius);
      context.fill();

      // Wooden plank body
      context.fillStyle = COLORS.signPlank;
      context.beginPath();
      drawRoundedRect(context, signX, signY, signW, signH, radius);
      context.fill();

      // Inner bevel (darker bottom strip for wood depth)
      context.fillStyle = COLORS.signPlankDark;
      context.fillRect(signX + 2, signY + signH - 3, signW - 4, 2);

      // Plank border
      context.strokeStyle = COLORS.signPlankBorder;
      context.lineWidth = 1.5;
      context.beginPath();
      drawRoundedRect(context, signX, signY, signW, signH, radius);
      context.stroke();

      // Rivets at top corners for nailed-plank look
      const rivetR = 1.4;
      context.fillStyle = COLORS.signRivet;
      context.beginPath();
      context.arc(signX + 4, signY + 4, rivetR, 0, Math.PI * 2);
      context.arc(signX + signW - 4, signY + 4, rivetR, 0, Math.PI * 2);
      context.fill();

      // Text with subtle shadow for legibility
      const textY = py + fontSize * 0.34;
      context.fillStyle = COLORS.signTextShadow;
      context.fillText(loc.name, px + 1, textY + 1);
      context.fillStyle = COLORS.signText;
      context.fillText(loc.name, px, textY);
    }
  }

  // Render a 💬 between any pair of agents within 2 tiles of each
  // other — but only if neither agent has an active chat bubble yet.
  // When they do start exchanging dialogue, the emoji gives way to
  // the actual bubble text so the canvas stays readable.
  drawAgentInteractions(timestamp) {
    const agents = Array.from(this.avatarRuntime.values());
    if (agents.length < 2) return;
    const ts = this.tileSize;
    const NEAR = 2;
    const seen = new Set();
    const ctx = this.context;
    const bob = Math.sin(timestamp / 400) * 1.5;
    ctx.font = `${Math.max(12, Math.floor(ts * 0.55))}px "Segoe UI Emoji", "Apple Color Emoji", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let i = 0; i < agents.length; i++) {
      for (let j = i + 1; j < agents.length; j++) {
        const a = agents[i];
        const b = agents[j];
        const aChat = a.chat && a.chat.expiresAt > timestamp;
        const bChat = b.chat && b.chat.expiresAt > timestamp;
        if (aChat || bChat) continue; // real dialogue already visible
        const dx = Math.abs(a.x - b.x);
        const dy = Math.abs(a.y - b.y);
        if (dx > NEAR || dy > NEAR) continue;
        if (dx === 0 && dy === 0) continue;
        const key = `${Math.min(a.x, b.x)},${Math.min(a.y, b.y)}-${Math.max(a.x, b.x)},${Math.max(a.y, b.y)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const mx = this.offsetX + ((a.x + b.x) / 2 + 0.5) * ts;
        const my = this.offsetY + ((a.y + b.y) / 2 + 0.5) * ts - ts * 1.0 + bob;
        ctx.fillStyle = 'rgba(255,255,255,0.7)';
        ctx.beginPath();
        ctx.arc(mx, my, ts * 0.4, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillText('💬', mx, my + 1);
      }
    }
  }

  setSkyMode(mode) {
    if (mode !== 'day' && mode !== 'night' && mode !== 'clock') return;
    this.skyMode = mode;
    try { localStorage.setItem('agent-world.sky-mode', mode); } catch (_) {}
    this.render(performance.now());
  }

  // Day/night color tint. In 'clock' mode keyframes follow the real
  // clock; 'night' pins the midnight tint; 'day' renders no overlay.
  drawSkyOverlay(now = new Date()) {
    if (this.skyMode === 'day') return;
    const h = this.skyMode === 'night'
      ? 0  // pin to the midnight keyframe
      : now.getHours() + now.getMinutes() / 60;
    // RGBA keyframes at specific hours. Alpha=0 means "no tint".
    const KEYFRAMES = [
      [0,  [10, 15, 50, 0.45]],
      [5,  [40, 25, 70, 0.38]],
      [6,  [255, 140, 80, 0.22]],
      [7,  [255, 200, 150, 0.08]],
      [9,  [0, 0, 0, 0]],
      [16, [0, 0, 0, 0]],
      [17, [255, 180, 100, 0.10]],
      [18, [255, 100, 50, 0.22]],
      [19, [150, 40, 90, 0.34]],
      [20, [40, 25, 80, 0.40]],
      [22, [10, 15, 55, 0.45]],
      [24, [10, 15, 50, 0.45]]
    ];
    // Find the segment containing the current hour
    let prev = KEYFRAMES[0], next = KEYFRAMES[KEYFRAMES.length - 1];
    for (let i = 0; i < KEYFRAMES.length - 1; i++) {
      if (h >= KEYFRAMES[i][0] && h <= KEYFRAMES[i + 1][0]) {
        prev = KEYFRAMES[i];
        next = KEYFRAMES[i + 1];
        break;
      }
    }
    const span = next[0] - prev[0] || 1;
    const t = (h - prev[0]) / span;
    const lerp = (a, b) => a + (b - a) * t;
    const [r, g, b, a] = prev[1].map((v, i) => lerp(v, next[1][i]));
    if (a <= 0.002) return; // daytime — skip

    const ctx = this.context;
    const canvasWidth = Number.parseInt(this.canvas.style.width || '0', 10) || 0;
    const canvasHeight = Number.parseInt(this.canvas.style.height || '0', 10) || 0;
    ctx.fillStyle = `rgba(${r|0}, ${g|0}, ${b|0}, ${a})`;
    ctx.fillRect(0, 0, canvasWidth, canvasHeight);

    // Scatter a few stars at deep-night tints.
    if (a > 0.33 && r < 60) {
      ctx.fillStyle = 'rgba(255, 255, 255, 0.65)';
      // Deterministic "star field" based on minute so it doesn't
      // jitter every frame.
      const seed = now.getHours() * 60 + now.getMinutes();
      for (let i = 0; i < 40; i++) {
        const hash = ((seed + i * 2654435761) >>> 0);
        const sx = (hash % 1000) / 1000 * canvasWidth;
        const sy = ((hash >>> 10) % 1000) / 1000 * (canvasHeight * 0.5);
        const size = ((hash >>> 20) % 3) + 1;
        ctx.fillRect(sx, sy, size, size);
      }
    }
  }

  drawTimeDisplay(timestamp) {
    const context = this.context;
    // Real current time display
    const now = new Date();
    const hours = now.getHours();
    const minutes = now.getMinutes();
    const seconds = now.getSeconds();
    const ampm = hours >= 12 ? 'PM' : 'AM';
    const displayHour = hours % 12 || 12;
    const timeStr = `${displayHour}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')} ${ampm}`;

    context.font = 'bold 13px Menlo, monospace';
    context.textAlign = 'left';
    const textWidth = context.measureText(timeStr).width;

    const padX = 10;
    const padY = 6;
    const boxW = textWidth + padX * 2;
    const boxH = 24;
    const boxX = 12;
    const boxY = 12;

    context.fillStyle = COLORS.timeBg;
    context.beginPath();
    drawRoundedRect(context, boxX, boxY, boxW, boxH, 6);
    context.fill();

    context.fillStyle = COLORS.timeText;
    context.fillText(timeStr, boxX + padX, boxY + boxH - padY - 1);
  }

  drawAgentRoster(timestamp) {
    const agents = Array.from(this.avatarRuntime.values());
    if (agents.length === 0) return;

    const context = this.context;
    const canvasWidth = Number.parseInt(this.canvas.style.width || '0', 10) || 0;

    const panelW = Math.min(240, canvasWidth * 0.28);
    const lineH = 28;
    const headerH = 30;
    const panelH = headerH + agents.length * lineH + 8;
    const panelX = canvasWidth - panelW - 8;
    const panelY = 44;

    // Panel background
    context.fillStyle = COLORS.panelBg;
    context.beginPath();
    drawRoundedRect(context, panelX, panelY, panelW, panelH, 6);
    context.fill();

    // Panel border
    context.strokeStyle = COLORS.panelBorder;
    context.lineWidth = 1;
    context.stroke();

    // Header
    context.fillStyle = COLORS.panelHighlight;
    context.font = 'bold 12px Menlo, monospace';
    context.textAlign = 'left';
    context.fillText(`Agents (${agents.length})`, panelX + 10, panelY + 20);

    // Divider
    context.strokeStyle = COLORS.panelBorder;
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(panelX + 8, panelY + headerH);
    context.lineTo(panelX + panelW - 8, panelY + headerH);
    context.stroke();

    // Agent list with cleaner layout
    agents.forEach((agent, i) => {
      const y = panelY + headerH + 4 + i * lineH;

      // Status dot — yellow for working, green for idle/moving
      const dotColor = agent.state === 'working' ? '#fbbf24' : '#34d399';
      context.fillStyle = dotColor;
      context.beginPath();
      context.arc(panelX + 14, y + 9, 4, 0, Math.PI * 2);
      context.fill();

      // Name (bold)
      context.font = 'bold 10px Menlo, monospace';
      context.fillStyle = COLORS.panelText;
      const name = (agent.displayName || agent.id || '').slice(0, 16);
      context.fillText(name, panelX + 24, y + 12);

      // Activity on second line (lighter, smaller)
      context.font = '9px Menlo, monospace';
      const activity = (agent.bubbleText || (agent.state === 'working' ? 'working...' : '')).slice(0, 24);
      if (activity) {
        context.fillStyle = agent.state === 'working' ? 'rgba(251, 191, 36, 0.8)' : 'rgba(148, 163, 184, 0.7)';
        context.fillText(activity, panelX + 24, y + 24);
      }
    });
  }

  drawAgentProfile(agent, timestamp) {
    const context = this.context;
    const canvasWidth = Number.parseInt(this.canvas.style.width || '0', 10) || 0;
    const canvasHeight = Number.parseInt(this.canvas.style.height || '0', 10) || 0;

    // Look up the full server-side agent (tasks, tools, zone).
    const serverAgent = this.state?.agents?.[agent.id] || null;
    const recentTasks = serverAgent && Array.isArray(serverAgent.tasks)
      ? [...serverAgent.tasks].sort((a, b) => String(b.updatedAt || '').localeCompare(a.updatedAt || '')).slice(0, 3)
      : [];

    const panelW = Math.min(300, canvasWidth * 0.38);
    const taskLinesCount = recentTasks.length;
    const panelH = 170 + (taskLinesCount > 0 ? 24 + taskLinesCount * 16 : 0);
    const panelX = 12;
    const panelY = canvasHeight - panelH - 12;

    // Panel background
    context.fillStyle = COLORS.panelBg;
    context.beginPath();
    drawRoundedRect(context, panelX, panelY, panelW, panelH, 8);
    context.fill();

    // Border
    context.strokeStyle = COLORS.panelBorder;
    context.lineWidth = 1;
    context.stroke();

    // Close hint
    context.fillStyle = 'rgba(148, 163, 184, 0.5)';
    context.font = '9px Menlo, monospace';
    context.textAlign = 'right';
    context.fillText('click elsewhere to close', panelX + panelW - 10, panelY + 14);

    // Agent name
    context.textAlign = 'left';
    context.fillStyle = COLORS.panelHighlight;
    context.font = 'bold 13px Menlo, monospace';
    const name = agent.displayName || agent.id || 'Unknown';
    context.fillText(name, panelX + 12, panelY + 32);

    // Status indicator
    const statusColor = agent.state === 'working' ? '#fbbf24' : '#34d399';
    const statusText = agent.state === 'working' ? 'Working' : 'Idle';
    context.fillStyle = statusColor;
    context.beginPath();
    context.arc(panelX + 14, panelY + 50, 4, 0, Math.PI * 2);
    context.fill();
    context.fillStyle = COLORS.panelText;
    context.font = '11px Menlo, monospace';
    context.fillText(statusText, panelX + 24, panelY + 54);

    // Current activity
    context.fillStyle = 'rgba(148, 163, 184, 0.8)';
    context.font = '10px Menlo, monospace';
    context.fillText('Current Activity:', panelX + 12, panelY + 74);
    context.fillStyle = COLORS.panelText;
    const activity = agent.bubbleText || 'none';
    const activityLines = this.wrapText(activity, panelW - 24, context);
    activityLines.forEach((line, i) => {
      context.fillText(line, panelX + 12, panelY + 88 + i * 14);
    });

    // Tool + zone row
    let rowY = panelY + 88 + activityLines.length * 14 + 6;
    if (serverAgent) {
      context.fillStyle = 'rgba(148, 163, 184, 0.8)';
      context.font = '9px Menlo, monospace';
      const tool = serverAgent.lastTool || '—';
      const zone = serverAgent.zone || 'idle';
      context.fillText(`Tool: ${tool}   Zone: ${zone}`, panelX + 12, rowY);
      rowY += 14;
    }

    // Recent tasks
    if (recentTasks.length > 0) {
      context.fillStyle = 'rgba(148, 163, 184, 0.8)';
      context.font = '10px Menlo, monospace';
      context.fillText('Recent tasks:', panelX + 12, rowY + 8);
      rowY += 20;
      for (const task of recentTasks) {
        const status = task.status || '';
        const color =
          status === 'completed' ? '#34d399' :
          status === 'in_progress' || status === 'assigned' ? '#fbbf24' :
          status === 'blocked' || status === 'paused' ? '#f87171' : '#94a3b8';
        context.fillStyle = color;
        context.beginPath();
        context.arc(panelX + 16, rowY, 3, 0, Math.PI * 2);
        context.fill();
        context.fillStyle = COLORS.panelText;
        context.font = '10px Menlo, monospace';
        const label = (task.label || task.id || '').slice(0, 30);
        context.fillText(label, panelX + 24, rowY + 3);
        rowY += 16;
      }
    }

    // Position
    context.fillStyle = 'rgba(148, 163, 184, 0.6)';
    context.font = '9px Menlo, monospace';
    context.fillText(`Position: (${agent.x}, ${agent.y})`, panelX + 12, panelY + panelH - 8);

    // Highlight selected agent on map
    const ax = this.offsetX + agent.x * this.tileSize + this.tileSize / 2;
    const ay = this.offsetY + agent.y * this.tileSize + this.tileSize / 2;
    context.strokeStyle = '#7dd3fc';
    context.lineWidth = 2;
    context.setLineDash([4, 3]);
    context.beginPath();
    context.arc(ax, ay, this.tileSize * 0.6, 0, Math.PI * 2);
    context.stroke();
    context.setLineDash([]);
  }

  wrapText(text, maxWidth, context) {
    const words = text.split(' ');
    const lines = [];
    let currentLine = '';
    for (const word of words) {
      const testLine = currentLine ? `${currentLine} ${word}` : word;
      if (context.measureText(testLine).width > maxWidth && currentLine) {
        lines.push(currentLine);
        currentLine = word;
      } else {
        currentLine = testLine;
      }
    }
    if (currentLine) lines.push(currentLine);
    return lines.slice(0, 3); // max 3 lines
  }

  drawSpeechBubble(centerX, bottomY, text) {
    const context = this.context;
    context.font = '12px Menlo, monospace';
    context.textAlign = 'center';

    const paddingX = 8;
    const paddingY = 6;
    const textWidth = context.measureText(text).width;
    const bubbleWidth = textWidth + paddingX * 2;
    const bubbleHeight = 20;
    const left = centerX - bubbleWidth / 2;
    const top = bottomY - bubbleHeight;

    context.fillStyle = COLORS.bubbleBg;
    context.strokeStyle = COLORS.avatarOutline;
    context.lineWidth = 1;

    context.beginPath();
    drawRoundedRect(context, left, top, bubbleWidth, bubbleHeight, 6);
    context.fill();
    context.stroke();

    context.beginPath();
    context.moveTo(centerX - 5, bottomY);
    context.lineTo(centerX + 5, bottomY);
    context.lineTo(centerX, bottomY + 6);
    context.closePath();
    context.fill();
    context.stroke();

    context.fillStyle = COLORS.bubbleText;
    context.fillText(text, centerX, top + bubbleHeight - paddingY);
  }
}
