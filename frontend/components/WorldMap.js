import {
  advanceAvatarRuntimeEntries,
  syncAvatarRuntimeEntries,
  setDramaLevel,
  getDramaLevel,
  DRAMA_MODES,
  VISUAL
} from '../avatarRuntime.mjs';
import {
  normalizeAvatars,
  worldDimensions
} from '../avatarNormalizer.mjs';
import { FURNITURE_SPRITES, FURNITURE_RENDER_SIZE, FURNITURE_ALIASES } from '../furnitureCatalog.mjs';
import {
  drawFallbackFurniture,
  drawFallbackDecoration,
  drawFallbackAvatarV2
} from '../fallbackSprites.js';

// Cubic easeOut — soft stop at tile center, brisk start off the previous.
// Used by sub-tile lerp so movement doesn't look mechanical.
function easeOutCubic(t) {
  const u = 1 - t;
  return 1 - u * u * u;
}

// HTML escape for hover tooltip content. We build innerHTML so coloured
// runs render properly — user-provided names/cwds must be sanitized.
function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Read the interpolated render position for an avatar. Caller should use
// these in place of (avatar.x, avatar.y) for every pixel-space computation.
// Callers that need the discrete logical tile (bubble z-ordering, hit
// tests, station ownership, etc.) should keep reading avatar.x/y.
function renderTilePos(avatar, timestamp) {
  const hasLerp = typeof avatar.prevX === 'number' && typeof avatar.prevY === 'number'
    && typeof avatar.stepStartedAt === 'number';
  // renderOffsetX/Y are visual-only nudges (e.g. group huddle toward
  // centroid). Logical x/y unchanged so hit-test + collision stay
  // keyed on the real tile.
  const ox = typeof avatar.renderOffsetX === 'number' ? avatar.renderOffsetX : 0;
  const oy = typeof avatar.renderOffsetY === 'number' ? avatar.renderOffsetY : 0;
  if (!hasLerp) return { rx: avatar.x + ox, ry: avatar.y + oy };
  const span = VISUAL.STEP_LERP_MS || 200;
  const progress = Math.max(0, Math.min(1, (timestamp - avatar.stepStartedAt) / span));
  const t = easeOutCubic(progress);
  const rx = avatar.prevX + (avatar.x - avatar.prevX) * t;
  const ry = avatar.prevY + (avatar.y - avatar.prevY) * t;
  return { rx: rx + ox, ry: ry + oy };
}

// In-place RFC 7396 JSON Merge Patch — null values delete keys.
function mergePatchMutable(target, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return patch;
  if (!target || typeof target !== 'object' || Array.isArray(target)) target = {};
  for (const k of Object.keys(patch)) {
    const v = patch[k];
    if (v === null) delete target[k];
    else if (v && typeof v === 'object' && !Array.isArray(v)) {
      target[k] = mergePatchMutable(target[k], v);
    } else {
      target[k] = v;
    }
  }
  return target;
}

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
      position: 'fixed', top: '12px', right: '212px', zIndex: 10,
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

    // Drama level cycler — cycles calm → normal → lively → calm.
    // Scales reaction cap, chat start chance, group start chance.
    // Persisted so users can dial it down without re-setting on each
    // page load.
    const savedDrama = typeof localStorage !== 'undefined'
      ? localStorage.getItem('agent-world.drama-mode') : null;
    const initialDrama = DRAMA_MODES.includes(savedDrama) ? savedDrama : 'normal';
    setDramaLevel(initialDrama);

    const dramaBtn = document.createElement('button');
    dramaBtn.id = 'drama-toggle';
    dramaBtn.title = 'Cycle drama level (calm / normal / lively) — D';
    const dramaLabels = { calm: '🧘 Calm', normal: '🎭 Normal', lively: '🎉 Lively' };
    const dramaCycle = { calm: 'normal', normal: 'lively', lively: 'calm' };
    const dramaRefresh = () => { dramaBtn.textContent = dramaLabels[getDramaLevel()]; };
    Object.assign(dramaBtn.style, {
      position: 'fixed', top: '12px', right: '336px', zIndex: 10,
      padding: '6px 10px', borderRadius: '6px',
      background: 'rgba(15,23,42,0.85)', border: '1px solid #94a3b8',
      color: '#e2e8f0', fontSize: '12px', cursor: 'pointer',
      fontFamily: 'inherit'
    });
    const cycleDrama = () => {
      const next = dramaCycle[getDramaLevel()];
      setDramaLevel(next);
      if (typeof localStorage !== 'undefined') {
        try { localStorage.setItem('agent-world.drama-mode', next); } catch (_) {}
      }
      dramaRefresh();
    };
    dramaBtn.addEventListener('click', cycleDrama);
    dramaRefresh();
    document.body.appendChild(dramaBtn);
    this.dramaBtn = dramaBtn;
    this._cycleDrama = cycleDrama;

    this.handleResize = this.handleResize.bind(this);
    this.handleClick = this.handleClick.bind(this);
    this.handleMouseDown = this.handleMouseDown.bind(this);
    this.handleTouchStart = this.handleTouchStart.bind(this);
    this.handleMouseMove = this.handleMouseMove.bind(this);
    this.handleMouseLeave = this.handleMouseLeave.bind(this);
    window.addEventListener('resize', this.handleResize);
    this.canvas.addEventListener('click', this.handleClick);
    this.canvas.addEventListener('mousedown', this.handleMouseDown);
    this.canvas.addEventListener('mousemove', this.handleMouseMove);
    this.canvas.addEventListener('mouseleave', this.handleMouseLeave);
    this.canvas.addEventListener('touchstart', this.handleTouchStart, { passive: false });

    // Hover state — id of sprite / building under the cursor. Reset on
    // mouseleave. Canvas redraws every rAF tick so we just stash the
    // last pointer position and let the render pass resolve hover.
    this.hoveredAgentId = null;
    this.hoveredBuildingId = null;
    this._pointerX = null;
    this._pointerY = null;
    // Persistent name-tag toggle (N key). Defaults to ON so the existing
    // experience is preserved; pressing N gives a clean ambient view that
    // still shows names on hover/selection.
    this.showNameTags = true;
    this._buildHoverTooltip();

    // Scrub state — when the timeline scrubber is dragged, the renderer
    // reads from a historical snapshot instead of the live runtime.
    this._scrubSnapshot = null;

    // Forced minimal mode — when true, the renderer ignores loaded
    // sprites and uses procedural fallbacks for everything. Useful as
    // a preview / demo toggle even when the PixyMoon pack IS installed.
    // Persisted to localStorage under `agent-world.minimal-mode-forced`.
    this.minimalModeForced = false;
    try {
      if (window.localStorage.getItem('agent-world.minimal-mode-forced') === '1') {
        this.minimalModeForced = true;
      }
    } catch (_) { /* ignore */ }

    this.handleResize();

    this.loadSprites();
  }

  // DOM tooltip — shared between sprite + building hover. Positioned in
  // fixed viewport coords so it doesn't need to fight canvas transforms.
  _buildHoverTooltip() {
    const tt = document.createElement('div');
    tt.id = 'world-hover-tooltip';
    tt.style.cssText = `
      position: fixed; pointer-events: none; z-index: 20;
      background: rgba(15, 23, 42, 0.95); color: #e2e8f0;
      border: 1px solid rgba(148, 163, 184, 0.35);
      border-radius: 6px;
      padding: 6px 9px;
      font: 11px/1.4 Menlo, Monaco, monospace;
      white-space: nowrap;
      box-shadow: 0 6px 18px rgba(0,0,0,0.4);
      display: none;
      max-width: 320px;
    `;
    document.body.appendChild(tt);
    this._hoverTooltip = tt;
  }

  async loadSprites() {
    if (!this.spriteStore.fetchImpl) {
      this.assetSummary = { loadedCount: 0, missingKeys: [] };
      this._broadcastAssetSummary();
      return;
    }

    try {
      this.assetSummary = await this.spriteStore.load();
      this._broadcastAssetSummary();
      this.render(performance.now());
    } catch (_error) {
      console.error('[WorldMap] sprite load failed:', _error);
      this.assetSummary = { loadedCount: 0, missingKeys: [] };
      this._broadcastAssetSummary();
    }
  }

  // Dispatches a window event so the Asset Manager link, World Editor
  // button, and minimal-mode banner can react. Called whenever the
  // asset summary changes OR the forced-minimal toggle flips.
  _broadcastAssetSummary() {
    const forced = Boolean(this.minimalModeForced);
    const loadedCount = forced ? 0 : (this.assetSummary?.loadedCount || 0);
    const loaded = !forced && loadedCount > 0;
    try {
      window.dispatchEvent(new CustomEvent('assets-status', {
        detail: {
          loaded,
          forced,
          loadedCount,
          missingKeys: this.assetSummary?.missingKeys || []
        }
      }));
    } catch (_) { /* jsdom may not have CustomEvent */ }
  }

  // M hotkey entry point. `on === undefined` → toggle; otherwise set.
  // Persists to localStorage so reloads keep the preview on.
  toggleMinimalMode(on) {
    const next = on === undefined ? !this.minimalModeForced : Boolean(on);
    this.minimalModeForced = next;
    try {
      if (next) window.localStorage.setItem('agent-world.minimal-mode-forced', '1');
      else window.localStorage.removeItem('agent-world.minimal-mode-forced');
    } catch (_) { /* ignore */ }
    this._broadcastAssetSummary();
    this.render(performance.now());
  }

  destroy() {
    this.stop();
    window.removeEventListener('resize', this.handleResize);
    this.canvas.removeEventListener('click', this.handleClick);
    this.canvas.removeEventListener('mousedown', this.handleMouseDown);
    this.canvas.removeEventListener('mousemove', this.handleMouseMove);
    this.canvas.removeEventListener('mouseleave', this.handleMouseLeave);
    this.canvas.removeEventListener('touchstart', this.handleTouchStart);
    if (this._hoverTooltip && this._hoverTooltip.parentNode) {
      this._hoverTooltip.parentNode.removeChild(this._hoverTooltip);
    }
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

  // Scrub mode — when set, the renderer draws avatars from a historical
  // snapshot (from HistoryBuffer) instead of the live runtime. Clearing
  // it (passing null) resumes live rendering. Physics advance still ticks
  // during scrub (runtime keeps evolving), but the draw pass ignores it.
  setScrubSnapshot(snap) {
    this._scrubSnapshot = snap || null;
    // Also hide the sprite hover tooltip while scrubbing to avoid stale
    // data from a frozen tile.
    if (this._hoverTooltip) this._hoverTooltip.style.display = 'none';
    this.hoveredAgentId = null;
    this.render(performance.now());
  }

  // Synthesize draw-ready avatar objects from a scrub snapshot. We fabricate
  // the minimum fields drawAvatar + drawCharacterVariant consume — prev*
  // equals current to skip lerp, toolPop/poof are zeroed so we don't
  // replay animations that never happened at the scrub timestamp.
  *_iterScrubAvatars(_timestamp) {
    const snap = this._scrubSnapshot;
    if (!snap || !snap.agents) return;
    const agents = snap.agents;
    for (const id of Object.keys(agents)) {
      const a = agents[id];
      yield {
        id,
        sessionId: a.sessionId || id,
        x: a.x == null ? 0 : a.x,
        y: a.y == null ? 0 : a.y,
        prevX: a.x == null ? 0 : a.x,
        prevY: a.y == null ? 0 : a.y,
        stepStartedAt: 0,
        direction: a.direction || 'down',
        displayName: a.name,
        state: a.status === 'Working' ? 'working' : 'idle',
        serverStatus: a.status || 'Idle',
        moving: false,
        seated: a.status === 'Working',
        talking: false,
        toolIcon: a.toolIcon || null,
        toolPopAt: 0,
        toolPopIcon: '',
        poofAt: 0,
        productiveUntil: a.productiveUntil || 0,
        fadeOpacity: typeof a.fadeOpacity === 'number' ? a.fadeOpacity : 1,
        bubbleText: a.bubble || '',
        chat: null,
        hatHue: a.hatHue,
        // Scrub silences all live-only social channels (v5 plan §5g).
        // Explicit nulls so future phases don't accidentally animate
        // reactions/emotes against historical frames.
        facingOverride: null,
        reactionEmote: null,
        persistentEmote: null,
        pose: null,
        farewellUntil: 0,
        stretchUntil: 0,
        arrivalOneShotUntil: 0,
        arrivalOneShotPose: null,
        arrivalOneShotEmote: null
      };
    }
  }

  // Shared hit-test for click + hover. Uses the same radius so the
  // hovered sprite is always clickable (no "hover highlight but click
  // misses" divergence). Walks avatarRuntime by logical tile position,
  // not the interpolated one, so a sprite mid-step is still a valid
  // target at its *next* tile center for the whole step window.
  _hitTestAgent(canvasX, canvasY) {
    let closest = null;
    let closestDist = Infinity;
    const hitRadius = this.tileSize * 0.8;
    this.avatarRuntime.forEach(avatar => {
      // Use interpolated position so the hover highlight tracks the
      // visible sprite, not the logical tile. Click uses the same.
      const rx = typeof avatar.prevX === 'number'
        ? avatar.x  // logical tile always a valid target
        : avatar.x;
      const ax = this.offsetX + rx * this.tileSize + this.tileSize / 2;
      const ay = this.offsetY + avatar.y * this.tileSize + this.tileSize / 2;
      const dist = Math.sqrt((canvasX - ax) ** 2 + (canvasY - ay) ** 2);
      if (dist < hitRadius && dist < closestDist) {
        closestDist = dist;
        closest = avatar;
      }
    });
    return closest;
  }

  // Building hit-test — simple tile bbox check.
  _hitTestBuilding(canvasX, canvasY) {
    const layout = this.sceneLayout;
    if (!layout || !Array.isArray(layout.buildings)) return null;
    const tx = Math.floor((canvasX - this.offsetX) / this.tileSize);
    const ty = Math.floor((canvasY - this.offsetY) / this.tileSize);
    for (const b of layout.buildings) {
      if (tx >= b.x && tx < b.x + (b.w || 5) && ty >= b.y && ty < b.y + (b.h || 4)) {
        return b;
      }
    }
    return null;
  }

  handleClick(event) {
    // In editor mode, mousedown already handled selection/placement;
    // suppress the subsequent click handler (which would select an agent).
    if (this.editor) return;

    const rect = this.canvas.getBoundingClientRect();
    const clickX = event.clientX - rect.left;
    const clickY = event.clientY - rect.top;

    const closestAgent = this._hitTestAgent(clickX, clickY);
    this.selectedAgent = closestAgent;
    // Emit a DOM event so DOM sidebars (SessionDetailPanel) can react.
    const sessionId = closestAgent?.id || closestAgent?.sessionId || null;
    this.canvas.dispatchEvent(new CustomEvent('agent-selected', {
      bubbles: true,
      detail: { sessionId, avatar: closestAgent }
    }));
  }

  handleMouseMove(event) {
    if (this.editor) return;
    const rect = this.canvas.getBoundingClientRect();
    this._pointerX = event.clientX - rect.left;
    this._pointerY = event.clientY - rect.top;
    const agent = this._hitTestAgent(this._pointerX, this._pointerY);
    const building = agent ? null : this._hitTestBuilding(this._pointerX, this._pointerY);
    const prevAgent = this.hoveredAgentId;
    const prevBuilding = this.hoveredBuildingId;
    this.hoveredAgentId = agent ? (agent.id || agent.sessionId) : null;
    this.hoveredBuildingId = building ? building.id : null;
    // Cursor reflects the hit: pointer over agents, help over buildings
    // (they don't navigate anywhere, just show info), default otherwise.
    if (agent) this.canvas.style.cursor = 'pointer';
    else if (building) this.canvas.style.cursor = 'help';
    else this.canvas.style.cursor = 'default';
    this._updateHoverTooltip(event.clientX, event.clientY, agent, building);
    if (prevAgent !== this.hoveredAgentId || prevBuilding !== this.hoveredBuildingId) {
      // Force a re-render now so the highlight ring appears on hover,
      // even if the render loop is temporarily paused.
      this.render(performance.now());
    }
  }

  handleMouseLeave() {
    this.hoveredAgentId = null;
    this.hoveredBuildingId = null;
    this._pointerX = null;
    this._pointerY = null;
    if (this._hoverTooltip) this._hoverTooltip.style.display = 'none';
    this.canvas.style.cursor = 'default';
    this.render(performance.now());
  }

  _updateHoverTooltip(clientX, clientY, agent, building) {
    const tt = this._hoverTooltip;
    if (!tt) return;
    if (!agent && !building) {
      tt.style.display = 'none';
      return;
    }
    const lines = [];
    if (agent) {
      const id = agent.id || agent.sessionId;
      const serverAgent = this.state?.agents?.[id] || null;
      const name = agent.displayName || serverAgent?.name || id;
      const status = agent.serverStatus || serverAgent?.status || '—';
      const tool = serverAgent?.tool;
      const toolLine = tool ? `${tool.icon || '⚙'} ${tool.name || ''}` : null;
      const cwd = serverAgent?.cwd || '';
      const branch = serverAgent?.gitBranch || '';
      const short = cwd ? cwd.split('/').slice(-2).join('/') : '';
      lines.push(`<b style="color:#fbbf24">${escapeHtml(name)}</b> <span style="color:#94a3b8">· ${escapeHtml(status)}</span>`);
      if (toolLine) lines.push(`<span style="color:#38bdf8">${escapeHtml(toolLine)}</span>`);
      if (short) lines.push(`<span style="color:#94a3b8">📁 ${escapeHtml(short)}${branch ? ' · ' + escapeHtml(branch) : ''}</span>`);
      lines.push(`<span style="color:#64748b; font-size: 10px">click · open details</span>`);
    } else if (building) {
      const label = building.label || building.name || building.id;
      // Count agents physically inside the building's tile rect — works
      // regardless of buildingKey vs locationId mismatches.
      const bx0 = building.x, by0 = building.y;
      const bx1 = bx0 + (building.w || 5), by1 = by0 + (building.h || 4);
      const inside = [];
      this.avatarRuntime.forEach(av => {
        if (av.x >= bx0 && av.x < bx1 && av.y >= by0 && av.y < by1) inside.push(av);
      });
      lines.push(`<b style="color:#fbbf24">${escapeHtml(label)}</b>`);
      lines.push(`<span style="color:#94a3b8">${inside.length} session${inside.length === 1 ? '' : 's'} here</span>`);
      if (inside.length > 0) {
        const names = inside.map(a => a.displayName || a.id).slice(0, 4).join(', ');
        lines.push(`<span style="color:#cbd5e1">${escapeHtml(names)}</span>`);
      }
    }
    tt.innerHTML = lines.join('<br>');
    // Position tooltip near cursor, staying on-screen.
    const pad = 12;
    tt.style.display = 'block';
    const w = tt.offsetWidth;
    const h = tt.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let x = clientX + pad;
    let y = clientY + pad;
    if (x + w + 4 > vw) x = clientX - w - pad;
    if (y + h + 4 > vh) y = clientY - h - pad;
    tt.style.left = `${Math.max(4, x)}px`;
    tt.style.top = `${Math.max(4, y)}px`;
  }

  // Apply a RFC 7396 JSON Merge Patch to the world state. Used by the
  // stateDiffBroadcast path; falls back to a full re-render.
  applyStatePatch(patch) {
    if (!this.state || !patch || typeof patch !== 'object') return;
    this.state = mergePatchMutable(this.state, patch);
    this._refreshSceneLayout();
    this.syncRuntime();
    this.render(performance.now());
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
    // Forced minimal-mode preview (M hotkey). All sprite lookups miss
    // so every caller routes through its procedural fallback path.
    if (this.minimalModeForced) return false;
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
      if (!this.drawSprite(key, fx, fy, fw, fh, flipOpt)) {
        // No PixyMoon pack installed — procedural furniture shape.
        drawFallbackFurniture(this.context, fx, fy, fw, fh, resolvedType);
      }
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
    if (this.minimalModeForced) return false;
    const sheets = this.spriteStore.characterSheetImages;
    if (!sheets || sheets.length === 0) return false;

    const variantIndex = hashString(avatar.id || '') % (sheets.length * CHARACTERS_PER_SHEET);
    const sheetIndex = Math.floor(variantIndex / CHARACTERS_PER_SHEET);
    const charInSheet = variantIndex % CHARACTERS_PER_SHEET;
    const sheet = sheets[sheetIndex];
    if (!sheet) return false;

    // facingOverride wins when set (used by one-tick reactions like
    // "turn to look at neighbor's error"). Cleared each tick start by
    // advanceAvatarRuntimeEntries.
    const direction = avatar.facingOverride || avatar.direction || 'down';
    // Suppress walk frames when the agent is seated (arrived at a
    // station) or talking (chat-paused). Both render the idle frame.
    const isStill = avatar.seated || avatar.talking || !avatar.moving;
    const walkPhase = isStill
      ? null
      : Math.floor(timestamp / WALK_FRAME_INTERVAL_MS) % 2;

    const dirRow = { down: 0, left: 1, right: 2, up: 3 }[direction] || 0;
    const frameCol = isStill ? 1 : (walkPhase === 0 ? 0 : 2);

    const baseCol = (charInSheet % 4) * 3;
    const baseRow = Math.floor(charInSheet / 4) * 4;

    const cellW = Math.floor(sheet.width / 12);
    const cellH = Math.floor(sheet.height / 8);

    const sx = (baseCol + frameCol) * cellW;
    const sy = (baseRow + dirRow) * cellH;

    const { rx, ry } = renderTilePos(avatar, timestamp);
    const centerX = this.offsetX + rx * this.tileSize + this.tileSize / 2;
    const centerY = this.offsetY + ry * this.tileSize + this.tileSize / 2;

    // When seated, nudge the sprite down + slightly smaller so the agent
    // visually settles into the chair / bed they're paused at.
    const baseSeatShift = avatar.seated ? this.tileSize * 0.18 : 0;
    const seatScale = avatar.seated ? 0.88 : 1;
    // Gentle breathing wobble while seated — 2s period, ±1px amplitude.
    // Per-agent phase offset so groups don't bob in sync.
    let breathShift = 0;
    if (avatar.seated) {
      const phase = (hashString(avatar.id || '') & 0xffff) / 0xffff * Math.PI * 2;
      breathShift = Math.sin(timestamp / 1100 + phase) * 1.1;
    }
    // Talking but not seated: small lean-forward bob as they speak.
    let talkShift = 0;
    if (avatar.talking && !avatar.seated) {
      const phase = (hashString((avatar.id || '') + 't') & 0xffff) / 0xffff * Math.PI * 2;
      talkShift = Math.sin(timestamp / 600 + phase) * 0.6;
    }

    // Phase 2 pose micro-animations. Additive on top of seat/talk
    // shifts; scales multiply seatScale. Each pose conveys what the
    // agent is doing at its station without needing new sprite frames.
    let poseShiftY = 0;
    let poseScale = 1;
    const pose = avatar.pose;
    if (pose === 'typing') {
      // Keyboard bob — 4 Hz, small amplitude. Visible only when
      // looking directly at the sprite; fine to be subtle.
      poseShiftY += Math.sin(timestamp / 125) * 0.5;
    } else if (pose === 'drinking') {
      // Every 1.2 s a small "raise the mug" lift.
      const cycle = timestamp % 1200;
      if (cycle < 400) {
        poseShiftY += -2 * Math.sin((cycle / 400) * Math.PI);
      }
    } else if (pose === 'stretching' &&
               avatar.stretchUntil && timestamp < avatar.stretchUntil) {
      // 800 ms: 1.0 → 1.10 at midpoint → 1.0 at end.
      const elapsed = 800 - (avatar.stretchUntil - timestamp);
      poseScale *= 1 + 0.10 * Math.sin((elapsed / 800) * Math.PI);
    } else if (pose === 'waving_goodbye' &&
               avatar.farewellUntil && timestamp < avatar.farewellUntil) {
      // Slight upscale + 4 Hz wave bounce during the 1.5 s farewell.
      poseScale *= 1.05 + 0.02 * Math.sin(timestamp / 125);
    }

    const seatShiftY = baseSeatShift + breathShift + talkShift + poseShiftY;
    const drawScale = seatScale * poseScale;

    this.context.imageSmoothingEnabled = false;
    this.context.drawImage(
      sheet,
      sx, sy, cellW, cellH,
      Math.floor(centerX - this.tileSize * 0.48 * drawScale),
      Math.floor(centerY - this.tileSize * 0.62 * drawScale + seatShiftY),
      Math.ceil(this.tileSize * 0.96 * drawScale),
      Math.ceil(this.tileSize * 1.24 * drawScale)
    );

    return true;
  }

  drawAvatar(avatar, timestamp) {
    const { rx, ry } = renderTilePos(avatar, timestamp);
    const centerX = this.offsetX + rx * this.tileSize + this.tileSize / 2;
    const centerY = this.offsetY + ry * this.tileSize + this.tileSize / 2;
    const radius = Math.max(4, Math.floor(this.tileSize * 0.3));
    const walkPhase = avatar.moving
      ? Math.floor(timestamp / WALK_FRAME_INTERVAL_MS) % 2
      : null;

    // Session-fade opacity (runtime.fadeOpacity set when intent=to_exit_fade).
    const sessionFade = typeof avatar.fadeOpacity === 'number' ? avatar.fadeOpacity : 1;
    const prevGlobalAlpha = this.context.globalAlpha;

    // Waiting halo — pulse amber ring under the feet before drawing shadow.
    if (avatar.serverStatus === 'Waiting') {
      const pulse = 0.55 + 0.35 * Math.sin(timestamp / 220);
      const prev = this.context.globalAlpha;
      this.context.globalAlpha = 0.6 * pulse * sessionFade;
      this.context.strokeStyle = '#fbbf24';
      this.context.lineWidth = Math.max(2, Math.floor(this.tileSize * 0.12));
      this.context.beginPath();
      this.context.ellipse(centerX, centerY + this.tileSize * 0.50, this.tileSize * 0.44 * pulse, this.tileSize * 0.16 * pulse, 0, 0, Math.PI * 2);
      this.context.stroke();
      this.context.globalAlpha = prev;
    }

    // Productivity burst glow — warm gold underglow while the agent is
    // on a streak (≥3 Edit/Write within 10s). Drawn under the shadow so
    // the sprite still reads cleanly on top.
    if (avatar.productiveUntil && timestamp < avatar.productiveUntil) {
      const remaining = avatar.productiveUntil - timestamp;
      // Fade in over first 400ms, out over last 800ms.
      const totalMs = VISUAL.EDIT_BURST_GLOW_MS || 4000;
      const elapsed = totalMs - remaining;
      const fadeIn = Math.min(1, elapsed / 400);
      const fadeOut = Math.min(1, remaining / 800);
      const strength = Math.min(fadeIn, fadeOut);
      // Gentle pulse so the glow feels alive.
      const pulse = 0.7 + 0.3 * Math.sin(timestamp / 260);
      const prev = this.context.globalAlpha;
      this.context.globalAlpha = 0.55 * strength * pulse * sessionFade;
      const gx = centerX;
      const gy = centerY + this.tileSize * 0.45;
      const grad = this.context.createRadialGradient(gx, gy, 0, gx, gy, this.tileSize * 0.95);
      grad.addColorStop(0, 'rgba(253, 224, 71, 0.85)');
      grad.addColorStop(0.55, 'rgba(251, 146, 60, 0.35)');
      grad.addColorStop(1, 'rgba(251, 146, 60, 0)');
      this.context.fillStyle = grad;
      this.context.beginPath();
      this.context.ellipse(gx, gy, this.tileSize * 0.95, this.tileSize * 0.55, 0, 0, Math.PI * 2);
      this.context.fill();
      this.context.globalAlpha = prev;
    }

    // Subtle shadow under the agent for depth
    const prevAlpha = this.context.globalAlpha;
    this.context.globalAlpha = 0.25 * sessionFade;
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

    // Apply session fade (if any) while drawing the sprite + labels.
    if (sessionFade < 1) this.context.globalAlpha = prevGlobalAlpha * sessionFade;

    // Draw per-agent character variant — falls back to the procedural
    // avatar (V2: direction nose, hatHue hat, branch-coloured body)
    // when the PixyMoon character sheets aren't installed.
    const didDrawSprite = this.drawCharacterVariant(avatar, timestamp);

    if (!didDrawSprite) {
      drawFallbackAvatarV2(this.context, centerX, centerY, this.tileSize, avatar, walkPhase);
    }

    // --- Generative Agents-style labels ---
    const displayName = avatar.displayName || avatar.id;

    // Head-area render (Lane 0 = tool icon/pop, Lane 1 = chat bubble,
    // Lane 2 = activity bubble muted above chat). Extracted into a
    // single method so future phases (persistent station emote,
    // reaction emote) can extend Lane 0 without scattering the logic.
    this._drawHeadLanes(avatar, centerX, centerY, timestamp, prevGlobalAlpha, sessionFade);

    // Name label below the agent — outlined text (no background box), so
    // the character sprite stays the visual focal point. Suppressed when
    // showNameTags is false AND this sprite isn't selected/hovered, so
    // the user can press N for a clean ambient view.
    const isWorking = avatar.state === 'working';
    const isSelectedOrHovered =
      (this.selectedAgent && this.selectedAgent.id === avatar.id) ||
      this.hoveredAgentId === avatar.id;
    if (this.showNameTags || isSelectedOrHovered) {
      const nameFontSize = Math.max(9, Math.floor(this.tileSize * 0.36));
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

    // (Lane 0 tool icon + tool-pop moved into _drawHeadLanes above so
    // all head-area rendering lives in one place. Future phases add
    // persistentStationEmote + reactionEmote to Lane 0.)

    // Status-transition poof — short radial ring on meaningful transitions.
    const poofMs = VISUAL.POOF_MS || 320;
    const poofAge = timestamp - (avatar.poofAt || 0);
    if (avatar.poofAt && poofAge >= 0 && poofAge < poofMs) {
      const poofT = poofAge / poofMs;
      const radius = this.tileSize * (0.22 + 0.55 * poofT);
      const width = Math.max(1.5, 4 * (1 - poofT));
      this.context.save();
      this.context.globalAlpha = prevGlobalAlpha * sessionFade * (1 - poofT) * 0.85;
      this.context.strokeStyle = '#ffffff';
      this.context.lineWidth = width;
      this.context.beginPath();
      this.context.arc(centerX, centerY, radius, 0, Math.PI * 2);
      this.context.stroke();
      this.context.restore();
      this.context.globalAlpha = prevGlobalAlpha;
    }

    // Hover highlight — drawn BEFORE selection so the selected agent's
    // cyan ring wins on z-order. Subtle gold ring + slight lift.
    if (this.hoveredAgentId && this.hoveredAgentId === avatar.id
        && (!this.selectedAgent || this.selectedAgent.id !== avatar.id)) {
      this.context.save();
      this.context.globalAlpha = 0.85 * sessionFade;
      this.context.strokeStyle = '#fde68a';
      this.context.lineWidth = 2;
      this.context.beginPath();
      this.context.arc(centerX, centerY, this.tileSize * 0.50, 0, Math.PI * 2);
      this.context.stroke();
      this.context.restore();
    }

    // Highlight the selected agent (drawn last so it sits on top).
    if (this.selectedAgent && this.selectedAgent.id === avatar.id) {
      this.context.globalAlpha = 0.85 * sessionFade;
      this.context.strokeStyle = '#38bdf8';
      this.context.lineWidth = 2;
      this.context.beginPath();
      this.context.arc(centerX, centerY, this.tileSize * 0.52, 0, Math.PI * 2);
      this.context.stroke();
    }

    this.context.globalAlpha = prevGlobalAlpha;
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
        // No PixyMoon pack — procedural decoration (bush / pebbles /
        // flower variants). Shared renderer in fallbackSprites.js.
        drawFallbackDecoration(this.context, px, py, this.tileSize, deco.type);
      });
    }

    // Layer 2: Draw interior floors for all buildings (no roofs — agents must be visible)
    layout.buildings.forEach(building => {
      this.drawBuildingInterior(building);
    });

    // Layer 2.5: Night window glow — warm lamp-light spill inside building
    // interiors once the sky overlay is dark enough. Drawn over interiors
    // but under agents so seated sprites aren't washed out.
    this.drawNightWindowGlow(timestamp);

    // Layer 3: Props (trees, rocks, etc.)
    layout.props.forEach(prop => {
      this.drawProp(prop);
    });

    // Layer 4: Agents (on top of interiors but below roofs).
    // Source: live avatarRuntime OR the scrub snapshot when the user is
    // dragging the timeline. See setScrubSnapshot().
    if (this._scrubSnapshot) {
      for (const avatar of this._iterScrubAvatars(timestamp)) {
        this.drawAvatar(avatar, timestamp);
      }
    } else {
      this.avatarRuntime.forEach(avatar => {
        this.drawAvatar(avatar, timestamp);
      });
    }

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

    // Layer 7: UI overlays — time display only.
    // Roster moved to DOM (frontend/components/AgentRoster.js) for
    // clickable rows + spinners + proper accessibility.
    this.drawTimeDisplay(timestamp);

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

  // Head-area render, extracted from drawAvatar so future phases can
  // extend Lane 0 (persistentStationEmote, reactionEmote) in one spot.
  //
  // Painter order (back → front):
  //   Lane 2 — activity bubble, muted when chat is showing
  //   Lane 1 — chat bubble
  //   Lane 0 — steady tool icon, then tool-pop overlay
  //
  // Phase 0 preserves exact current behavior: no visual diff against
  // pre-refactor WorldMap.
  _drawHeadLanes(avatar, centerX, centerY, timestamp, prevGlobalAlpha, sessionFade) {
    // --- Lane 1 + Lane 2: activity + chat bubbles ---
    const rawBubble = (avatar.bubbleText || '').trim();
    const chatText = avatar.chat && avatar.chat.expiresAt > timestamp
      ? avatar.chat.text : '';
    // Thinking indicator: working + no tool → cycling dots appended to
    // whatever activity text we already show. Avoids a 4th stacked layer.
    const thinking = avatar.serverStatus === 'Working' && !avatar.toolIcon && !avatar.toolPopIcon;
    const dotPhase = thinking
      ? ['', '.', '..', '...'][Math.floor(timestamp / 380) % 4]
      : '';
    const baseActivity = rawBubble ||
      (avatar.state === 'working' ? 'thinking' : '');
    // If baseActivity already ends with a trailing ellipsis / dots, don't
    // double-append. Strip trailing dots before adding the animated ones.
    const baseNoTail = baseActivity.replace(/[.·]+\s*$/, '').trim();
    const activityText = thinking
      ? (baseNoTail ? `${baseNoTail}${dotPhase}` : `thinking${dotPhase}`)
      : baseActivity;
    const chatBubbleY = centerY - this.tileSize * 0.7 - 6;
    if (activityText) {
      if (chatText) {
        const chatHeight = Math.max(9, Math.floor(this.tileSize * 0.34)) + 14;
        this.drawActivityLabel(
          centerX,
          chatBubbleY - chatHeight - 6,
          activityText,
          avatar.state === 'working',
          { muted: true }
        );
      } else {
        this.drawActivityLabel(
          centerX, chatBubbleY, activityText,
          avatar.state === 'working'
        );
      }
    }
    if (chatText) {
      this.drawChatLabel(centerX, chatBubbleY, chatText);
    }

    // --- Lane 0: reaction emote > tool pop > steady icon / persistent ---
    //
    // Phase 3: a live reaction (😦 on neighbor error, ✨ on burst, 🎉
    // on approval, 👋 on session-end nearby) preempts everything else
    // in Lane 0. Renders as a bright emote at the same anchor as the
    // steady tool icon. When it expires, Lane 0 reverts to the
    // tool-pop-on-steady logic.
    const reaction = avatar.reactionEmote;
    const reactionActive = reaction && reaction.expiresAt > timestamp;
    if (reactionActive) {
      const iconSize = Math.max(14, Math.floor(this.tileSize * 0.56));
      const iconY = centerY - this.tileSize * 0.95;
      this.context.save();
      this.context.font = `${iconSize}px "Segoe UI Emoji", system-ui, sans-serif`;
      this.context.textAlign = 'center';
      this.context.textBaseline = 'middle';
      this.context.shadowColor = 'rgba(0,0,0,0.35)';
      this.context.shadowBlur = 5;
      this.context.globalAlpha = prevGlobalAlpha * sessionFade;
      this.context.fillText(reaction.icon, centerX, iconY);
      this.context.restore();
      this.context.globalAlpha = prevGlobalAlpha;
      return;   // Skip the rest of Lane 0 so we don't stack icons.
    }

    const popMs = VISUAL.TOOL_POP_MS || 1100;
    const popAge = timestamp - (avatar.toolPopAt || 0);
    const popActive = avatar.toolPopIcon && popAge >= 0 && popAge < popMs;
    const popT = popActive ? popAge / popMs : 1;
    const popFade = popActive ? Math.max(0, 1 - popT) : 0;

    // Steady icon: live tool wins over ambient persistent emote — a Bash
    // tool-pop at the tavern is more interesting than the 🍺. When no
    // tool is active, the station's persistent emote (🍺/📺/💤/👋)
    // fills the slot.
    const steadyIcon = avatar.toolIcon || avatar.persistentEmote || null;
    if (steadyIcon && popFade < 0.5) {
      const iconSize = Math.max(12, Math.floor(this.tileSize * 0.5));
      const iconY = centerY - this.tileSize * 0.95;
      this.context.font = `${iconSize}px "Segoe UI Emoji", system-ui, sans-serif`;
      this.context.textAlign = 'center';
      this.context.textBaseline = 'middle';
      // When pop is fading out (popFade ∈ [0, 0.5)), cross-fade the
      // steady icon back in so the transition doesn't snap.
      const steadyAlpha = popActive
        ? prevGlobalAlpha * sessionFade * Math.max(0, 1 - popFade * 2)
        : prevGlobalAlpha * sessionFade;
      this.context.globalAlpha = steadyAlpha;
      this.context.fillText(steadyIcon, centerX, iconY);
      this.context.globalAlpha = prevGlobalAlpha;
    }

    if (popActive) {
      const baseY = centerY - this.tileSize * 0.95;
      // Ease out: starts fast, settles. rise ∈ [0, -22px tile-relative].
      const rise = this.tileSize * 0.55 * easeOutCubic(popT);
      // Slight overshoot scale for snap: 1.35 → 1.0.
      const scale = 1 + (1 - popT) * 0.35;
      const popSize = Math.max(14, Math.floor(this.tileSize * 0.56 * scale));
      this.context.save();
      this.context.globalAlpha = prevGlobalAlpha * sessionFade * (0.15 + popFade);
      this.context.font = `${popSize}px "Segoe UI Emoji", system-ui, sans-serif`;
      this.context.textAlign = 'center';
      this.context.textBaseline = 'middle';
      // Soft shadow under the pop icon for readability against bright tiles.
      this.context.shadowColor = 'rgba(0,0,0,0.35)';
      this.context.shadowBlur = 6;
      this.context.fillText(avatar.toolPopIcon, centerX, baseY - rise);
      this.context.restore();
      this.context.globalAlpha = prevGlobalAlpha;
    }
  }

  drawActivityLabel(centerX, bottomY, text, isWorking, options = null) {
    const context = this.context;
    // Defensive: skip blank/whitespace-only text so we never draw an
    // empty brown pill.
    const safeText = typeof text === 'string' ? text.trim() : '';
    if (!safeText) return;
    const muted = Boolean(options && options.muted);
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

    if (muted) context.globalAlpha = 0.55;

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

    if (muted) context.globalAlpha = 1;
  }

  // Chat speech bubble — distinct from the activity label so viewers can
  // tell what an agent is SAYING vs what they're DOING. White body,
  // navy border, bigger font, longer tail pointing at the speaker.
  drawChatLabel(centerX, bottomY, text) {
    const context = this.context;
    const safeText = typeof text === 'string' ? text.trim() : '';
    if (!safeText) return;
    const fontSize = Math.max(10, Math.floor(this.tileSize * 0.38));
    context.font = `600 ${fontSize}px "Segoe UI", "Helvetica Neue", Arial, sans-serif`;
    context.textAlign = 'center';
    context.textBaseline = 'alphabetic';

    const displayText = safeText.length > 32 ? safeText.slice(0, 30) + '…' : safeText;
    const textWidth = context.measureText(displayText).width;
    const padX = 10;
    const padY = 6;
    const bubbleW = textWidth + padX * 2;
    const bubbleH = fontSize + padY * 2;
    const tailH = 6;
    const top = bottomY - bubbleH - tailH;
    const left = centerX - bubbleW / 2;
    const radius = Math.min(9, bubbleH / 2);
    const bodyFill = '#fafdff';
    const borderColor = '#1e40af';

    // Shadow
    context.fillStyle = 'rgba(20, 25, 40, 0.32)';
    context.beginPath();
    drawRoundedRect(context, left + 2, top + 3, bubbleW, bubbleH, radius);
    context.fill();

    // Tail triangle pointing down-center
    const tailY = top + bubbleH;
    context.fillStyle = bodyFill;
    context.beginPath();
    context.moveTo(centerX - 6, tailY - 1);
    context.lineTo(centerX - 1, tailY + tailH);
    context.lineTo(centerX + 6, tailY - 1);
    context.closePath();
    context.fill();
    context.strokeStyle = borderColor;
    context.lineWidth = 1.8;
    context.stroke();

    // Bubble body
    context.fillStyle = bodyFill;
    context.beginPath();
    drawRoundedRect(context, left, top, bubbleW, bubbleH, radius);
    context.fill();
    context.strokeStyle = borderColor;
    context.lineWidth = 1.8;
    context.stroke();

    // Seam cover between bubble & tail
    context.fillStyle = bodyFill;
    context.fillRect(centerX - 5, tailY - 1.5, 11, 2);

    // Text
    context.fillStyle = '#0f172a';
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
  setSkyMode(mode) {
    if (mode !== 'day' && mode !== 'night' && mode !== 'clock') return;
    this.skyMode = mode;
    try { localStorage.setItem('agent-world.sky-mode', mode); } catch (_) {}
    this.render(performance.now());
  }

  // Day/night color tint. In 'clock' mode keyframes follow the real
  // clock; 'night' pins the midnight tint; 'day' renders no overlay.
  // Compute a 0..1 "night factor" — how dark the sky overlay currently is.
  // Mirrors drawSkyOverlay's keyframe interp, but returns only the alpha
  // channel so drawNightWindowGlow can decide whether to paint.
  skyNightFactor(now = new Date()) {
    if (this.skyMode === 'day') return 0;
    const h = this.skyMode === 'night'
      ? 0
      : now.getHours() + now.getMinutes() / 60;
    const KEYFRAMES = [
      [0,  0.45], [5,  0.38], [6,  0.22], [7,  0.08],
      [9,  0.00], [16, 0.00], [17, 0.10], [18, 0.22],
      [19, 0.34], [20, 0.40], [22, 0.45], [24, 0.45]
    ];
    let prev = KEYFRAMES[0], next = KEYFRAMES[KEYFRAMES.length - 1];
    for (let i = 0; i < KEYFRAMES.length - 1; i++) {
      if (h >= KEYFRAMES[i][0] && h <= KEYFRAMES[i + 1][0]) {
        prev = KEYFRAMES[i]; next = KEYFRAMES[i + 1]; break;
      }
    }
    const span = next[0] - prev[0] || 1;
    const t = (h - prev[0]) / span;
    return prev[1] + (next[1] - prev[1]) * t;
  }

  // Warm window-light spill inside each building interior. Only paints
  // once the sky is dark enough to notice (skyNightFactor > 0.28). ~30%
  // of buildings flicker (hash-seeded); the rest are steady for ambience.
  drawNightWindowGlow(timestamp) {
    const alpha = this.skyNightFactor();
    if (alpha < 0.28) return;
    const layout = this.sceneLayout;
    if (!layout || !Array.isArray(layout.buildings)) return;

    // Strength ramps with how dark the night is, capped at 0.28. Peak
    // night (alpha≈0.45) maps to ~0.28 strength so window light is
    // clearly visible but still ambient, not stage lighting.
    const maxA = 0.28;
    const strength = Math.min(maxA, (alpha - 0.28) * 1.6);
    if (strength <= 0.01) return;

    const ctx = this.context;
    const prevComp = ctx.globalCompositeOperation;
    const prevAlpha = ctx.globalAlpha;
    ctx.globalCompositeOperation = 'lighter';

    for (const b of layout.buildings) {
      if (!Array.isArray(b.stations) || b.stations.length === 0) continue;
      const px = this.offsetX + b.x * this.tileSize;
      const py = this.offsetY + b.y * this.tileSize;
      const w = this.tileSize * (b.w || 5);
      const h = this.tileSize * (b.h || 4);

      // ~30% of buildings flicker, seeded on building id. Others are steady.
      const seed = hashString(b.id || `${b.x},${b.y}`);
      const shouldFlicker = (seed % 10) < 3;
      const phase = ((seed & 0xffff) / 0xffff) * Math.PI * 2;
      const flick = shouldFlicker
        ? 0.82 + 0.18 * Math.sin(timestamp / 380 + phase)
        : 1;

      const cx = px + w / 2;
      const cy = py + h / 2;
      const rad = Math.max(w, h) * 0.55;
      const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, rad);
      grad.addColorStop(0, `rgba(255, 222, 140, ${strength * flick})`);
      grad.addColorStop(0.6, `rgba(255, 180, 90, ${strength * 0.45 * flick})`);
      grad.addColorStop(1, 'rgba(255, 160, 80, 0)');
      ctx.fillStyle = grad;
      ctx.fillRect(px - 4, py - 4, w + 8, h + 8);
    }

    ctx.globalCompositeOperation = prevComp;
    ctx.globalAlpha = prevAlpha;
  }

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
