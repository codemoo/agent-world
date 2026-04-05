const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_ASSET_ROOT_REL = path.join(
  'assets',
  'pixymoon',
  'Cute RPG World',
  'Cute RPG World (RPG Maker)'
);

// Only expose files under this sub-folder. Keeping the asset root at
// "Cute RPG World (RPG Maker)" preserves the path→sha1 mapping used by
// already-seeded metadata, while restricting visibility to the MZ pack.
const DEFAULT_PATH_FILTER = 'Cute RPG World - RPG Maker MZ';

const DEFAULT_METADATA_REL = path.join('data', 'asset-metadata.json');

function makeSheetId(relativePath) {
  return crypto
    .createHash('sha1')
    .update(relativePath)
    .digest('hex')
    .slice(0, 16);
}

function makePropId() {
  return crypto.randomBytes(6).toString('hex');
}

/**
 * Read width/height from a PNG file by parsing the IHDR chunk. Returns null on failure.
 */
function readPngDimensions(absolutePath) {
  let fd = null;
  try {
    fd = fs.openSync(absolutePath, 'r');
    const buffer = Buffer.alloc(24);
    const bytesRead = fs.readSync(fd, buffer, 0, 24, 0);
    if (bytesRead < 24) {
      return null;
    }
    // PNG signature: 89 50 4E 47 0D 0A 1A 0A
    if (
      buffer[0] !== 0x89 ||
      buffer[1] !== 0x50 ||
      buffer[2] !== 0x4e ||
      buffer[3] !== 0x47
    ) {
      return null;
    }
    const width = buffer.readUInt32BE(16);
    const height = buffer.readUInt32BE(20);
    return { width, height };
  } catch (error) {
    return null;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch (_) {
        /* ignore */
      }
    }
  }
}

/**
 * Recursively walk a directory collecting PNG files.
 * Returns entries with relative paths from `rootDir`.
 */
function walkPngFiles(rootDir, currentDir = rootDir) {
  const entries = [];
  let dirents;
  try {
    dirents = fs.readdirSync(currentDir, { withFileTypes: true });
  } catch (error) {
    return entries;
  }

  for (const dirent of dirents) {
    const absolute = path.join(currentDir, dirent.name);
    if (dirent.isDirectory()) {
      entries.push(...walkPngFiles(rootDir, absolute));
    } else if (dirent.isFile() && /\.png$/i.test(dirent.name)) {
      const relative = path.relative(rootDir, absolute);
      entries.push({ relativePath: relative, absolutePath: absolute });
    }
  }

  return entries;
}

/**
 * Heuristically infer the sheet category and default grid from filename and dimensions.
 */
function inferSheetMetadata(filename, dimensions) {
  const base = path.basename(filename, path.extname(filename));
  const lower = base.toLowerCase();
  const width = dimensions?.width || 0;
  const height = dimensions?.height || 0;

  // Characters: filenames like "Character_RM_001.png" or "!Character_RM_001.png"
  if (/character/i.test(lower)) {
    // RPG Maker MZ character sheets: 4 chars × 3 cols × 4 rows of 48px frames
    // Standard sheet: 576×384 (12×8 grid @ 48px), but top 4 rows only
    // However, these MZ sheets are often 576×384.
    // Use filename hint; leave grid default as 12×8 @ 48px.
    return {
      category: 'character_sheet',
      grid: { columns: 12, rows: 8, cellWidth: 48, cellHeight: 48 },
      notes:
        'RPG Maker character sheet. Typically 4 characters (top rows). Each character = 3 cols × 4 rows of 48px frames.'
    };
  }

  // Autotile A1/A5 tilesets
  if (/_a[125]\b/i.test(base) || /_a[125]$/i.test(base)) {
    return {
      category: 'tileset_autotile',
      grid: { columns: 16, rows: 16, cellWidth: 48, cellHeight: 48 },
      notes:
        'RPG Maker autotile sheet. Cells are part of autotile patterns; individual grid cells may be transition tiles.'
    };
  }

  // Object tilesets B/C/D/E
  if (/_(b|c|d|e)\d*\b/i.test(base)) {
    return {
      category: 'tileset_object',
      grid: { columns: 16, rows: 16, cellWidth: 48, cellHeight: 48 },
      notes:
        'RPG Maker object tileset (B/C/D/E). 16×16 grid of 48px cells. Individual props may span multiple cells.'
    };
  }

  // Icons
  if (/icon/i.test(lower)) {
    return {
      category: 'icons',
      grid: { columns: 16, rows: 20, cellWidth: 32, cellHeight: 32 },
      notes: 'Icon sheet. Typically 32×32 cells.'
    };
  }

  // Fallback grid based on dimensions (48px default)
  const inferredCols = width && width % 48 === 0 ? width / 48 : 16;
  const inferredRows = height && height % 48 === 0 ? height / 48 : 16;

  return {
    category: 'unknown',
    grid: {
      columns: inferredCols,
      rows: inferredRows,
      cellWidth: 48,
      cellHeight: 48
    },
    notes: ''
  };
}

function defaultDescriptionFor(relativePath, category) {
  const base = path.basename(relativePath, path.extname(relativePath));
  switch (category) {
    case 'character_sheet':
      return `Character sprite sheet: ${base}`;
    case 'tileset_autotile':
      return `Autotile tileset: ${base}`;
    case 'tileset_object':
      return `Object tileset: ${base}`;
    case 'icons':
      return `Icon sheet: ${base}`;
    default:
      return base;
  }
}

/**
 * Load persisted metadata from disk.
 */
function loadMetadata(metadataPath) {
  try {
    const raw = fs.readFileSync(metadataPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      return { sheets: {} };
    }
    if (!parsed.sheets || typeof parsed.sheets !== 'object') {
      parsed.sheets = {};
    }
    return parsed;
  } catch (error) {
    return { sheets: {} };
  }
}

function saveMetadata(metadataPath, metadata) {
  const dir = path.dirname(metadataPath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2), 'utf8');
}

/**
 * Generate prop rectangles by slicing the sheet into a uniform grid.
 * Returns array of { id, name, description, x, y, width, height }.
 */
function buildGridProps(grid, namePrefix = 'tile') {
  const { columns, rows, cellWidth, cellHeight } = grid;
  const props = [];
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < columns; c += 1) {
      props.push({
        id: makePropId(),
        name: `${namePrefix}_${r}_${c}`,
        description: '',
        x: c * cellWidth,
        y: r * cellHeight,
        width: cellWidth,
        height: cellHeight
      });
    }
  }
  return props;
}

function sanitizePropInput(input = {}) {
  const out = {};
  if (typeof input.name === 'string') out.name = input.name.trim().slice(0, 200);
  if (typeof input.description === 'string')
    out.description = input.description.slice(0, 2000);
  for (const key of ['x', 'y', 'width', 'height']) {
    if (input[key] !== undefined) {
      const n = Number(input[key]);
      if (Number.isFinite(n) && n >= 0) {
        out[key] = Math.round(n);
      }
    }
  }
  return out;
}

/**
 * Factory for an asset manager bound to an asset root directory and metadata file.
 */
function createAssetManager({
  projectRoot,
  assetRootRel = DEFAULT_ASSET_ROOT_REL,
  metadataPathRel = DEFAULT_METADATA_REL,
  pathFilter = DEFAULT_PATH_FILTER
} = {}) {
  if (!projectRoot) {
    throw new Error('createAssetManager requires projectRoot');
  }

  const assetRootAbs = path.join(projectRoot, assetRootRel);
  const metadataPathAbs = path.join(projectRoot, metadataPathRel);

  function isAllowed(relativePath) {
    if (!pathFilter) return true;
    const prefixSlash = pathFilter + '/';
    const prefixSep = pathFilter + path.sep;
    return (
      relativePath === pathFilter ||
      relativePath.startsWith(prefixSlash) ||
      relativePath.startsWith(prefixSep)
    );
  }
  function listAllowedFiles() {
    return walkPngFiles(assetRootAbs).filter(f => isAllowed(f.relativePath));
  }

  function listSheets() {
    const metadata = loadMetadata(metadataPathAbs);
    const files = listAllowedFiles();

    const sheets = files.map(file => {
      const id = makeSheetId(file.relativePath);
      const dims = readPngDimensions(file.absolutePath) || { width: 0, height: 0 };
      const existing = metadata.sheets[id] || null;
      const inferred = inferSheetMetadata(file.relativePath, dims);

      return {
        id,
        relativePath: file.relativePath,
        urlPath: toUrlPath(assetRootRel, file.relativePath),
        width: dims.width,
        height: dims.height,
        category: existing?.category || inferred.category,
        description:
          existing?.description ||
          defaultDescriptionFor(file.relativePath, inferred.category),
        grid: existing?.grid || inferred.grid,
        notes: existing?.notes ?? inferred.notes,
        propCount: Array.isArray(existing?.props) ? existing.props.length : 0,
        hasCustomMetadata: Boolean(existing)
      };
    });

    sheets.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
    return { assetRoot: assetRootRel, sheets };
  }

  function getSheet(sheetId) {
    const files = listAllowedFiles();
    const match = files.find(file => makeSheetId(file.relativePath) === sheetId);
    if (!match) {
      return null;
    }
    const dims = readPngDimensions(match.absolutePath) || { width: 0, height: 0 };
    const inferred = inferSheetMetadata(match.relativePath, dims);
    const metadata = loadMetadata(metadataPathAbs);
    const existing = metadata.sheets[sheetId] || null;

    return {
      id: sheetId,
      relativePath: match.relativePath,
      urlPath: toUrlPath(assetRootRel, match.relativePath),
      width: dims.width,
      height: dims.height,
      category: existing?.category || inferred.category,
      description:
        existing?.description ||
        defaultDescriptionFor(match.relativePath, inferred.category),
      grid: existing?.grid || inferred.grid,
      notes: existing?.notes ?? inferred.notes,
      props: Array.isArray(existing?.props) ? existing.props : [],
      groups: Array.isArray(existing?.groups) ? existing.groups : []
    };
  }

  function updateSheet(sheetId, updates = {}) {
    const current = getSheet(sheetId);
    if (!current) return null;
    const metadata = loadMetadata(metadataPathAbs);
    const existing = metadata.sheets[sheetId] || {};
    const next = {
      ...existing,
      description: current.description,
      category: current.category,
      grid: current.grid,
      notes: current.notes,
      props: Array.isArray(existing.props) ? existing.props : []
    };

    if (typeof updates.description === 'string') {
      next.description = updates.description.slice(0, 2000);
    }
    if (typeof updates.category === 'string') {
      next.category = updates.category.slice(0, 100);
    }
    if (typeof updates.notes === 'string') {
      next.notes = updates.notes.slice(0, 4000);
    }
    if (updates.grid && typeof updates.grid === 'object') {
      const g = updates.grid;
      next.grid = {
        columns: clampInt(g.columns, 1, 512, current.grid.columns),
        rows: clampInt(g.rows, 1, 512, current.grid.rows),
        cellWidth: clampInt(g.cellWidth, 1, 4096, current.grid.cellWidth),
        cellHeight: clampInt(g.cellHeight, 1, 4096, current.grid.cellHeight)
      };
    }

    metadata.sheets[sheetId] = next;
    saveMetadata(metadataPathAbs, metadata);
    return getSheet(sheetId);
  }

  function addProp(sheetId, propInput) {
    const current = getSheet(sheetId);
    if (!current) return null;
    const metadata = loadMetadata(metadataPathAbs);
    const existing = metadata.sheets[sheetId] || {
      description: current.description,
      category: current.category,
      grid: current.grid,
      notes: current.notes,
      props: [],
      groups: []
    };
    const sanitized = sanitizePropInput(propInput);
    const prop = {
      id: makePropId(),
      name: sanitized.name || 'prop',
      description: sanitized.description || '',
      x: sanitized.x ?? 0,
      y: sanitized.y ?? 0,
      width: sanitized.width ?? current.grid.cellWidth,
      height: sanitized.height ?? current.grid.cellHeight
    };
    existing.props = [...(existing.props || []), prop];
    metadata.sheets[sheetId] = existing;
    saveMetadata(metadataPathAbs, metadata);
    return prop;
  }

  function updateProp(sheetId, propId, updates) {
    const metadata = loadMetadata(metadataPathAbs);
    const entry = metadata.sheets[sheetId];
    if (!entry || !Array.isArray(entry.props)) return null;
    const index = entry.props.findIndex(p => p.id === propId);
    if (index === -1) return null;
    const sanitized = sanitizePropInput(updates);
    entry.props[index] = { ...entry.props[index], ...sanitized };
    metadata.sheets[sheetId] = entry;
    saveMetadata(metadataPathAbs, metadata);
    return entry.props[index];
  }

  function deleteProp(sheetId, propId) {
    const metadata = loadMetadata(metadataPathAbs);
    const entry = metadata.sheets[sheetId];
    if (!entry || !Array.isArray(entry.props)) return false;
    const before = entry.props.length;
    entry.props = entry.props.filter(p => p.id !== propId);
    if (entry.props.length === before) return false;
    // Remove this propId from any group, drop groups that become empty.
    if (Array.isArray(entry.groups)) {
      entry.groups = entry.groups
        .map(g => ({ ...g, propIds: (g.propIds || []).filter(id => id !== propId) }))
        .filter(g => g.propIds.length > 0);
    }
    metadata.sheets[sheetId] = entry;
    saveMetadata(metadataPathAbs, metadata);
    return true;
  }

  function autoSlice(sheetId, { replace = true, namePrefix } = {}) {
    const current = getSheet(sheetId);
    if (!current) return null;
    const metadata = loadMetadata(metadataPathAbs);
    const existing = metadata.sheets[sheetId] || {
      description: current.description,
      category: current.category,
      grid: current.grid,
      notes: current.notes,
      props: [],
      groups: []
    };
    const prefix =
      namePrefix ||
      path.basename(current.relativePath, path.extname(current.relativePath));
    const generated = buildGridProps(current.grid, prefix);
    if (replace) {
      existing.props = generated;
      existing.groups = []; // Old groups reference stale prop IDs
    } else {
      existing.props = [...(existing.props || []), ...generated];
    }
    metadata.sheets[sheetId] = existing;
    saveMetadata(metadataPathAbs, metadata);
    return getSheet(sheetId);
  }

  function search({ q = '', category = null, tags = [], scope = 'sheets', limit = 50 } = {}) {
    const metadata = loadMetadata(metadataPathAbs);
    const files = listAllowedFiles();
    const idToFile = new Map(files.map(f => [makeSheetId(f.relativePath), f]));

    const sheetMatches = [];
    const groupMatches = [];
    const propMatches = [];

    for (const [id, sheet] of Object.entries(metadata.sheets)) {
      const file = idToFile.get(id);
      if (!file) continue;
      if (category && sheet.category !== category) continue;
      if (tags.length) {
        const sheetTags = (sheet.tags || []).map(t => t.toLowerCase());
        if (!tags.every(t => sheetTags.includes(t))) continue;
      }

      const haystack = [
        file.relativePath, sheet.description, sheet.notes,
        (sheet.tags || []).join(' ')
      ].join(' ').toLowerCase();

      const sheetScore = scoreText(q, haystack);
      if (!q || sheetScore > 0) {
        sheetMatches.push({ score: sheetScore, id, relativePath: file.relativePath,
          category: sheet.category, description: sheet.description,
          tags: sheet.tags || [], propCount: (sheet.props || []).length,
          groupCount: (sheet.groups || []).length });
      }

      if (scope === 'groups' || scope === 'all') {
        for (const g of sheet.groups || []) {
          const text = [g.name, g.description || '', g.role || ''].join(' ').toLowerCase();
          const score = scoreText(q, text + ' ' + haystack);
          if (!q || score > 0) {
            groupMatches.push({ score, sheetId: id, relativePath: file.relativePath,
              id: g.id, name: g.name, role: g.role || null,
              description: g.description || '', memberCount: g.propIds.length });
          }
        }
      }

      if (scope === 'props' || scope === 'all') {
        for (const p of sheet.props || []) {
          const text = [p.name, p.description || '', p.role || '',
            p.direction || ''].join(' ').toLowerCase();
          const score = scoreText(q, text + ' ' + haystack);
          if (!q || score > 0) {
            propMatches.push({ score, sheetId: id, relativePath: file.relativePath,
              id: p.id, name: p.name, x: p.x, y: p.y, width: p.width, height: p.height,
              direction: p.direction || null, frame: p.frame ?? null,
              description: p.description || '' });
          }
        }
      }
    }

    sheetMatches.sort((a, b) => b.score - a.score);
    groupMatches.sort((a, b) => b.score - a.score);
    propMatches.sort((a, b) => b.score - a.score);

    const result = { query: { q, category, tags, scope, limit } };
    if (scope === 'sheets' || scope === 'all') {
      result.sheets = sheetMatches.slice(0, limit);
    }
    if (scope === 'groups' || scope === 'all') {
      result.groups = groupMatches.slice(0, limit);
    }
    if (scope === 'props' || scope === 'all') {
      result.props = propMatches.slice(0, limit);
    }
    return result;
  }

  function catalog() {
    const metadata = loadMetadata(metadataPathAbs);
    const files = listAllowedFiles();
    const idToFile = new Map(files.map(f => [makeSheetId(f.relativePath), f]));

    let totalProps = 0, totalMultiCell = 0, totalGroups = 0;
    const categoryCounts = {};
    const tagCounts = {};
    for (const [id, sheet] of Object.entries(metadata.sheets)) {
      if (!idToFile.has(id)) continue;
      totalProps += (sheet.props || []).length;
      totalMultiCell += (sheet.props || []).filter(
        p => p.width > sheet.grid.cellWidth || p.height > sheet.grid.cellHeight
      ).length;
      totalGroups += (sheet.groups || []).length;
      categoryCounts[sheet.category] = (categoryCounts[sheet.category] || 0) + 1;
      for (const t of sheet.tags || []) tagCounts[t] = (tagCounts[t] || 0) + 1;
    }
    const topTags = Object.entries(tagCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 50)
      .map(([tag, count]) => ({ tag, count }));

    return {
      counts: {
        sheets: Object.keys(metadata.sheets).filter(id => idToFile.has(id)).length,
        props: totalProps, multiCellProps: totalMultiCell, groups: totalGroups
      },
      categories: categoryCounts,
      topTags
    };
  }

  return {
    listSheets,
    getSheet,
    updateSheet,
    addProp,
    updateProp,
    deleteProp,
    autoSlice,
    search,
    catalog,
    assetRootAbs,
    metadataPathAbs
  };
}

function scoreText(query, haystack) {
  if (!query) return 1;
  const terms = query.split(/\s+/).filter(Boolean);
  if (!terms.length) return 1;
  let score = 0;
  for (const term of terms) {
    if (haystack.includes(term)) score += 1;
    // Bonus for word-start match
    if (new RegExp('(^|[^a-z0-9])' + escapeRegExp(term)).test(haystack)) score += 0.5;
  }
  return score;
}
function escapeRegExp(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function toUrlPath(assetRootRel, relativePath) {
  // e.g. assets/pixymoon/... + Cute RPG World.../CuteRPG_Field_B.png
  const joined = [assetRootRel, relativePath].join('/').split(path.sep).join('/');
  const segments = joined.split('/').filter(Boolean).map(encodeURIComponent);
  return '/' + segments.join('/');
}

module.exports = {
  DEFAULT_ASSET_ROOT_REL,
  DEFAULT_METADATA_REL,
  createAssetManager,
  // Exposed helpers for testing
  readPngDimensions,
  inferSheetMetadata,
  makeSheetId,
  walkPngFiles
};
