import {
  advanceAvatarRuntimeEntries,
  syncAvatarRuntimeEntries
} from '../avatarRuntime.mjs';

const MIN_TILE_SIZE = 14;
const MAX_TILE_SIZE = 36;
const BASE_MOVE_INTERVAL_MS = 380;
const WALK_FRAME_INTERVAL_MS = 180;
const AUTHORITATIVE_DRIFT_THRESHOLD = 2;
const AUTHORITATIVE_PULL_INTERVAL_MS = 120;
const DEFAULT_ASSET_ROOT = '/assets/pixymoon/Cute RPG World';

const COLORS = {
  background: '#10200f',
  border: '#375934',
  grassA: '#4f9f52',
  grassB: '#57ab5a',
  dirt: '#8b6b4a',
  path: '#b69765',
  sand: '#c9b178',
  water: '#3a739f',
  idleAvatar: '#f2f7ff',
  workingAvatar: '#ffc857',
  avatarOutline: '#1a1f2b',
  label: '#f5ffef',
  bubbleBg: '#ffffff',
  bubbleText: '#1f2937',
  propShadow: 'rgba(0, 0, 0, 0.2)'
};

const MOVES = [
  [0, 0],
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1]
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
const CHARACTER_SHEET = 'Cute RPG World (RPG Maker)/Cute RPG World - RPG Maker MZ/characters/!Character_RM_001.png';
const CHARACTER_GRID = { mode: 'grid', columns: 12, rows: 8 };
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
    candidates: [
      { url: FIELD_B_TILESET, frame: { ...FIELD_B_GRID, column: 1, row: 8 } }
    ]
  },
  {
    key: 'terrain.path',
    candidates: [
      { url: FIELD_B_TILESET, frame: { ...FIELD_B_GRID, column: 3, row: 5 } }
    ]
  },
  {
    key: 'terrain.sand',
    candidates: [
      { url: FIELD_B_TILESET, frame: { ...FIELD_B_GRID, column: 1, row: 5 } }
    ]
  },
  {
    key: 'terrain.stone',
    candidates: [
      { url: FIELD_B_TILESET, frame: { ...FIELD_B_GRID, column: 3, row: 8 } }
    ]
  },
  {
    key: 'terrain.water',
    candidates: [
      { url: WATER_TILESET, frame: { mode: 'grid', columns: 16, rows: 12, column: 3, row: 2 } }
    ]
  },
  {
    key: 'prop.tree',
    candidates: [
      { url: FIELD_B_TILESET, frame: { ...FIELD_B_GRID, column: 5, row: 8 } }
    ]
  },
  {
    key: 'prop.rock',
    candidates: [
      { url: FIELD_B_TILESET, frame: { ...FIELD_B_GRID, column: 10, row: 2 } }
    ]
  },
  {
    key: 'prop.crate',
    candidates: [
      { url: FIELD_B_TILESET, frame: { ...FIELD_B_GRID, column: 15, row: 7 } }
    ]
  },
  {
    key: 'building.house',
    candidates: [
      {
        url: 'Cute RPG World/Tilesets/CuteRPG_Houses_A.png',
        frame: { sx: 0, sy: 0, sw: 128, sh: 96 }
      }
    ]
  },
  {
    key: 'building.tower',
    candidates: [
      {
        url: 'Cute RPG World/Tilesets/CuteRPG_Houses_A.png',
        frame: { sx: 256, sy: 128, sw: 128, sh: 96 }
      }
    ]
  },
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
    normalized[agentId] = {
      id: agentId,
      x: Number.isFinite(avatar.x) ? clamp(avatar.x, 0, width - 1) : fallback.x,
      y: Number.isFinite(avatar.y) ? clamp(avatar.y, 0, height - 1) : fallback.y,
      authoritativePosition: true,
      moving: avatar.moving !== false,
      state: avatar.state === 'working' ? 'working' : 'idle',
      bubbleText:
        typeof avatar.bubbleText === 'string' ? avatar.bubbleText.trim() : ''
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
    normalized[agentId] = {
      id: agentId,
      x: fallback.x,
      y: fallback.y,
      authoritativePosition: false,
      moving: !bubbleText,
      state: bubbleText ? 'working' : 'idle',
      bubbleText
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

  return { explicitBuildings, explicitProps };
}

function inferPropSpriteKey(type) {
  if (type.includes('rock') || type.includes('stone')) {
    return 'prop.rock';
  }

  if (type.includes('crate') || type.includes('box')) {
    return 'prop.crate';
  }

  return 'prop.tree';
}

function inferBuildingSpriteKey(type) {
  if (type.includes('tower') || type.includes('castle')) {
    return 'building.tower';
  }

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

  const generatedBuildings = [
    { x: 2, y: 2, type: 'house', widthTiles: 2, heightTiles: 2 },
    {
      x: clamp(width - 5, 1, Math.max(1, width - 2)),
      y: 2,
      type: 'house',
      widthTiles: 2,
      heightTiles: 2
    },
    {
      x: clamp(Math.floor(width * 0.52), 1, Math.max(1, width - 2)),
      y: clamp(height - 5, 1, Math.max(1, height - 2)),
      type: 'tower',
      widthTiles: 2,
      heightTiles: 2
    }
  ].map(item => normalizeSceneEntity(item, width, height, 'building'));

  const props = [];
  const maxProps = Math.max(6, Math.floor((width * height) / 18));

  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      if (props.length >= maxProps) {
        break;
      }

      if (overlapsBuilding(x, y, generatedBuildings)) {
        continue;
      }

      const value = hashCoord(seed, x, y) % 100;
      if (value >= 3) {
        continue;
      }

      const type = value === 0 ? 'rock' : value === 1 ? 'crate' : 'tree';
      props.push({ x, y, type, widthTiles: 1, heightTiles: 1 });
    }
  }

  return {
    generatedBuildings,
    generatedProps: props
  };
}

function buildSceneLayout(worldState) {
  const { width, height } = worldDimensions(worldState);
  const tiles = normalizeTiles(worldState, width, height);

  const { explicitBuildings, explicitProps } = collectExplicitEntities(
    worldState,
    width,
    height
  );

  const { generatedBuildings, generatedProps } = createGeneratedScene(
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

  return {
    width,
    height,
    tiles,
    buildings,
    props
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

    this.canvas.style.display = 'block';
    this.canvas.style.width = '100%';
    this.canvas.style.height = '100%';
    this.root.appendChild(this.canvas);

    this.handleResize = this.handleResize.bind(this);
    window.addEventListener('resize', this.handleResize);
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
      this.assetSummary = { loadedCount: 0, missingKeys: [] };
    }
  }

  destroy() {
    this.stop();
    window.removeEventListener('resize', this.handleResize);
  }

  setWorldState(nextState) {
    this.state = nextState || null;
    this.sceneLayout = this.state ? buildSceneLayout(this.state) : null;
    this.syncRuntime();
    this.handleResize();
    this.render(performance.now());
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

    advanceAvatarRuntimeEntries(
      this.avatarRuntime,
      worldDimensions(this.state),
      timestamp,
      this.random
    );
  }

  drawSprite(spriteKey, dx, dy, dw, dh) {
    const sprite = this.spriteStore.getSprite(spriteKey);
    if (!sprite) {
      return false;
    }

    this.context.imageSmoothingEnabled = false;
    this.context.drawImage(
      sprite.image,
      sprite.sx,
      sprite.sy,
      sprite.sw,
      sprite.sh,
      Math.floor(dx),
      Math.floor(dy),
      Math.ceil(dw),
      Math.ceil(dh)
    );

    return true;
  }

  drawTerrainTile(tileType, x, y) {
    const spriteKey = chooseTerrainSpriteKey(tileType, x, y);
    const px = this.offsetX + x * this.tileSize;
    const py = this.offsetY + y * this.tileSize;

    if (this.drawSprite(spriteKey, px, py, this.tileSize, this.tileSize)) {
      return;
    }

    const fallbackColorByType = {
      dirt: COLORS.dirt,
      path: COLORS.path,
      sand: COLORS.sand,
      stone: '#8d97a0',
      water: COLORS.water
    };

    this.context.fillStyle =
      fallbackColorByType[tileType] ||
      ((x + y) % 2 === 0 ? COLORS.grassA : COLORS.grassB);
    this.context.fillRect(px, py, this.tileSize, this.tileSize);
  }

  drawProp(prop) {
    const px = this.offsetX + prop.x * this.tileSize;
    const py = this.offsetY + prop.y * this.tileSize;

    this.context.fillStyle = COLORS.propShadow;
    this.context.beginPath();
    this.context.ellipse(
      px + this.tileSize * 0.5,
      py + this.tileSize * 0.86,
      this.tileSize * 0.3,
      this.tileSize * 0.12,
      0,
      0,
      Math.PI * 2
    );
    this.context.fill();

    if (
      this.drawSprite(
        prop.spriteKey,
        px,
        py - this.tileSize * 0.2,
        this.tileSize,
        this.tileSize * 1.2
      )
    ) {
      return;
    }

    if (prop.spriteKey === 'prop.rock') {
      this.context.fillStyle = '#8a8f95';
      this.context.beginPath();
      this.context.arc(
        px + this.tileSize * 0.5,
        py + this.tileSize * 0.62,
        this.tileSize * 0.24,
        0,
        Math.PI * 2
      );
      this.context.fill();
      return;
    }

    if (prop.spriteKey === 'prop.crate') {
      this.context.fillStyle = '#9f6d3d';
      this.context.fillRect(
        px + this.tileSize * 0.22,
        py + this.tileSize * 0.38,
        this.tileSize * 0.56,
        this.tileSize * 0.56
      );
      this.context.strokeStyle = '#6e4822';
      this.context.lineWidth = 1;
      this.context.strokeRect(
        px + this.tileSize * 0.22,
        py + this.tileSize * 0.38,
        this.tileSize * 0.56,
        this.tileSize * 0.56
      );
      return;
    }

    this.context.fillStyle = '#2a6b2f';
    this.context.beginPath();
    this.context.arc(
      px + this.tileSize * 0.5,
      py + this.tileSize * 0.4,
      this.tileSize * 0.3,
      0,
      Math.PI * 2
    );
    this.context.fill();

    this.context.fillStyle = '#7c4a20';
    this.context.fillRect(
      px + this.tileSize * 0.44,
      py + this.tileSize * 0.5,
      this.tileSize * 0.12,
      this.tileSize * 0.4
    );
  }

  drawBuilding(building) {
    const widthTiles = Math.max(1, building.widthTiles || 2);
    const heightTiles = Math.max(1, building.heightTiles || 2);
    const px = this.offsetX + building.x * this.tileSize;
    const py = this.offsetY + building.y * this.tileSize;
    const drawWidth = this.tileSize * widthTiles;
    const drawHeight = this.tileSize * heightTiles;

    if (this.drawSprite(building.spriteKey, px, py - this.tileSize * 0.2, drawWidth, drawHeight * 1.2)) {
      return;
    }

    this.context.fillStyle = building.spriteKey === 'building.tower' ? '#738190' : '#c5844f';
    this.context.fillRect(px, py, drawWidth, drawHeight);

    this.context.fillStyle = building.spriteKey === 'building.tower' ? '#4f5c68' : '#824329';
    this.context.fillRect(
      px,
      py - this.tileSize * 0.35,
      drawWidth,
      this.tileSize * 0.42
    );

    this.context.fillStyle = '#2f2a26';
    this.context.fillRect(
      px + drawWidth * 0.4,
      py + drawHeight * 0.5,
      drawWidth * 0.2,
      drawHeight * 0.5
    );
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

  drawAvatar(avatar, timestamp) {
    const centerX = this.offsetX + avatar.x * this.tileSize + this.tileSize / 2;
    const centerY = this.offsetY + avatar.y * this.tileSize + this.tileSize / 2;
    const radius = Math.max(4, Math.floor(this.tileSize * 0.3));
    const direction = avatar.direction || 'down';
    const walkPhase = avatar.moving
      ? Math.floor(timestamp / WALK_FRAME_INTERVAL_MS) % 2
      : null;

    const spriteKey = avatar.moving
      ? `avatar.walk.${direction}.${walkPhase || 0}`
      : `avatar.idle.${direction}`;
    const didDrawSprite = this.drawSprite(
      spriteKey,
      centerX - this.tileSize * 0.48,
      centerY - this.tileSize * 0.62,
      this.tileSize * 0.96,
      this.tileSize * 1.24
    );

    if (!didDrawSprite) {
      this.drawFallbackAvatar(
        centerX,
        centerY,
        radius,
        avatar.state === 'working',
        walkPhase
      );
    }

    this.context.fillStyle = COLORS.label;
    this.context.font = '11px Menlo, monospace';
    this.context.textAlign = 'center';
    this.context.fillText(avatar.id, centerX, centerY + radius + 12);

    if (!avatar.moving && avatar.bubbleText) {
      this.drawSpeechBubble(
        centerX,
        centerY - radius - 20,
        avatar.bubbleText.slice(0, 36)
      );
    }
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
        this.drawTerrainTile(row[x] || 'grass', x, y);
      }
    }

    layout.buildings.forEach(building => {
      this.drawBuilding(building);
    });

    layout.props.forEach(prop => {
      this.drawProp(prop);
    });

    this.avatarRuntime.forEach(avatar => {
      this.drawAvatar(avatar, timestamp);
    });
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
