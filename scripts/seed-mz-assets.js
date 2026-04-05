#!/usr/bin/env node
/**
 * Seed asset metadata for the "Cute RPG World - RPG Maker MZ" pack.
 *
 * Uses scripts/analyze-assets.py to:
 *  - skip fully-transparent cells (no prop emitted)
 *  - for tileset_object sheets, detect multi-cell connected components
 *    (via cross-boundary pixel linking) so multi-cell decorations stay as a
 *    single prop, while tightly-packed autotile strips are split to cells.
 *
 * Flags:
 *   --force       Overwrite existing sheet entries (default: skip sheets that
 *                 already have metadata — preserves manual edits).
 *   --grid-only   Re-apply grid/description/category/notes only; preserve
 *                 existing props/groups.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const PACK_ROOT_REL = path.join(
  'assets',
  'pixymoon',
  'Cute RPG World',
  'Cute RPG World (RPG Maker)'
);
const MZ_SUBDIR = 'Cute RPG World - RPG Maker MZ';
const PACK_ABS = path.join(PROJECT_ROOT, PACK_ROOT_REL);
const METADATA_ABS = path.join(PROJECT_ROOT, 'data', 'asset-metadata.json');
const ANALYZER_PY = path.join(PROJECT_ROOT, 'scripts', 'analyze-assets.py');
const MAX_COMPONENT_CELLS = 30; // multi-cell props up to ~5×5; larger → split to cells

const FORCE = process.argv.includes('--force');
const GRID_ONLY = process.argv.includes('--grid-only');

function sha1(s) { return crypto.createHash('sha1').update(s).digest('hex').slice(0, 16); }
function randId() { return crypto.randomBytes(6).toString('hex'); }
function pngDims(file) {
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(24);
  fs.readSync(fd, buf, 0, 24, 0);
  fs.closeSync(fd);
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}
function walk(root, rel = '') {
  const out = [];
  const here = path.join(root, rel);
  for (const entry of fs.readdirSync(here, { withFileTypes: true })) {
    const r = rel ? path.join(rel, entry.name) : entry.name;
    if (entry.isDirectory()) out.push(...walk(root, r));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.png')) out.push(r);
  }
  return out;
}
function isUnderMz(relPath) {
  return relPath.startsWith(MZ_SUBDIR + '/') || relPath.startsWith(MZ_SUBDIR + path.sep);
}

// ---------- Classification ----------

const THEME_DESCRIPTIONS = {
  Castle: '성 (Castle) 테마', Castle_New: '새 성 (Castle New) 테마',
  Dark_Castle: '어두운 성 (Dark Castle) 테마', Caves: '동굴 (Caves) 테마',
  Desert: '사막 (Desert) 테마', Dungeon: '던전 (Dungeon) 테마',
  Dungeon_Entrance: '던전 입구 테마', Field: '필드 (Field / 초원) 테마',
  Forest: '숲 (Forest) 테마', Harbor: '항구 (Harbor) 테마',
  Houses: '건물 (Houses) 테마', Interior: '실내 (Interior) 테마',
  Mountains: '산 (Mountains) 테마', Village: '마을 (Village) 테마',
  Winter: '겨울 (Winter) 테마'
};
const TILESET_ROLE = {
  A1: 'A1 — 물/폭포 등 애니메이션 오토타일', A5: 'A5 — 바닥 타일',
  B: 'B — 주 오브젝트 타일셋', C: 'C — 보조 오브젝트 타일셋',
  D: 'D — 추가 오브젝트 타일셋', E: 'E — 추가 오브젝트 타일셋'
};

function classifyTileset(filename, width, height) {
  const base = path.basename(filename, '.png').replace(/^CuteRPG_/, '');
  let theme = base, role = null, variant = '';
  const matchA = base.match(/^(.*)_(A[15])$/);
  const matchBE = base.match(/^(.*)_([BCDE])(\d*)$/);
  if (matchA) { theme = matchA[1]; role = matchA[2]; }
  else if (matchBE) { theme = matchBE[1]; role = matchBE[2]; variant = matchBE[3]; }
  theme = theme.replace(/_RPGMaker$/, '').replace(/_RPGMaker/, '');

  const themeDesc = THEME_DESCRIPTIONS[theme] || theme.replace(/_/g, ' ');
  const roleDesc = TILESET_ROLE[role] || '타일셋';
  const variantSuffix = variant ? ` (변형 ${variant})` : '';
  const cellWidth = 48, cellHeight = 48;
  const columns = Math.max(1, Math.round(width / cellWidth));
  const rows = Math.max(1, Math.round(height / cellHeight));
  const category = role === 'A1' || role === 'A5' ? 'tileset_autotile' : 'tileset_object';

  let notes = '';
  if (role === 'A1') notes = '오토타일 시트. 개별 셀은 전환(transition) 타일이 많습니다.';
  else if (role === 'A5') notes = '바닥(floor) 타일 시트. 각 셀은 반복 가능한 floor 타일.';
  else if (theme === 'Houses' && (role === 'B' || role === 'C')) {
    notes = `Houses_RPGMaker_${role}${variant} — 사전 조합된 건물 시트. 상단 행에 타이트한 바운딩 박스의 개별 집들이 있음 (C1/C2/C3: sx=3,195,387,579 / sy=24 / sw=186 / sh=216).`;
  }

  return {
    category, description: `${themeDesc} — ${roleDesc}${variantSuffix}`,
    grid: { columns, rows, cellWidth, cellHeight }, notes, namePrefix: base
  };
}

function classifyCharacter(filename, width, height) {
  const base = path.basename(filename);
  const prefix = base[0];
  const nameCore = base.replace(/^[!$]/, '').replace(/\.png$/, '');
  const isSingleChar = prefix === '$';
  let desc = nameCore, notes = '', cols, rows, cellWidth, cellHeight;
  let layout = null; // character-block layout for group generation

  if (/^Character_RM_/i.test(nameCore)) {
    desc = `일반 캐릭터 시트 (${nameCore.replace(/^Character_RM_/, '#')})`;
    if (width === 864 && height === 576) {
      notes = 'Cute RPG World RM 팩 표준 시트. 상단 4행에 4명의 캐릭터가 수평 배치됨 (각 3열 × 4행, cell 72×72). 하단 절반은 빈 영역.';
      cols = 12; rows = 4; cellWidth = 72; cellHeight = 72;
      // 4 chars arranged horizontally: each 3 cols × 4 rows
      layout = {
        kind: 'rm_horizontal',
        blocks: [
          { name: 'char1', col0: 0, row0: 0, colSpan: 3, rowSpan: 4 },
          { name: 'char2', col0: 3, row0: 0, colSpan: 3, rowSpan: 4 },
          { name: 'char3', col0: 6, row0: 0, colSpan: 3, rowSpan: 4 },
          { name: 'char4', col0: 9, row0: 0, colSpan: 3, rowSpan: 4 }
        ]
      };
    } else {
      cellWidth = 48; cellHeight = 48;
      cols = Math.max(1, Math.round(width / cellWidth));
      rows = Math.max(1, Math.round(height / cellHeight));
      notes = `비표준 크기 RM 시트 (${width}×${height}).`;
    }
  } else if (isSingleChar) {
    desc = `${nameCore} (단일 캐릭터, $ 접두사)`;
    notes = '$ 접두사 = 3프레임 × 4방향 단일 캐릭터 시트.';
    cols = 3; rows = 4;
    cellWidth = Math.round(width / 3);
    cellHeight = Math.round(height / 4);
    layout = {
      kind: 'single',
      blocks: [{ name: 'char', col0: 0, row0: 0, colSpan: 3, rowSpan: 4 }]
    };
  } else {
    // Assume standard 12×8 4-char sheet (2×2 block layout)
    cols = 12; rows = 8;
    cellWidth = Math.round(width / 12);
    cellHeight = Math.round(height / 8);
    if (/enemies/i.test(nameCore)) { desc = `적 캐릭터 시트 (${nameCore})`; notes = '적(enemies) 시트. 4캐릭터 12×8 레이아웃.'; }
    else if (/Door/i.test(nameCore)) { desc = `문 애니메이션 시트 (${nameCore})`; notes = '문 열림/닫힘 애니메이션 프레임.'; }
    else if (/Animations?/i.test(nameCore)) { desc = `애니메이션 오브젝트 시트 (${nameCore})`; notes = '환경 애니메이션.'; }
    else if (/Objects?/i.test(nameCore)) desc = `오브젝트 시트 (${nameCore})`;
    else if (/Cactuar/i.test(nameCore)) desc = `선인장 오브젝트 (${nameCore})`;
    else if (/Magical/i.test(nameCore)) desc = `매지컬 캐릭터 시트 (${nameCore})`;
    else desc = nameCore;
  }

  const prefixNote = prefix === '!' ? ' [! 접두사 = no-shift]' : '';
  return {
    category: 'character_sheet',
    description: desc + prefixNote,
    grid: { columns: cols, rows, cellWidth, cellHeight },
    notes, namePrefix: nameCore, layout
  };
}

function classifyIcons(filename, width, height) {
  const base = path.basename(filename, '.png').replace(/^CuteRPG_/, '');
  const cellWidth = 32, cellHeight = 32;
  const columns = Math.max(1, Math.floor(width / cellWidth));
  const rows = Math.max(1, Math.floor(height / cellHeight));
  return {
    category: 'icons',
    description: `아이콘 시트 (${base}) — 32×32 셀`,
    grid: { columns, rows, cellWidth, cellHeight },
    notes: '아이템/스킬/상태 아이콘 모음.', namePrefix: base
  };
}

function classifySheet(folderName, fileName, width, height) {
  if (folderName === 'tilesets') return classifyTileset(fileName, width, height);
  if (folderName === 'characters') return classifyCharacter(fileName, width, height);
  if (folderName === 'system') return classifyIcons(fileName, width, height);
  return null;
}

// ---------- Tag derivation ----------

const THEME_TAGS = {
  castle: ['castle', 'fortress'],
  castle_new: ['castle', 'castle_new'],
  dark_castle: ['castle', 'dark_castle', 'evil'],
  caves: ['cave', 'underground'],
  desert: ['desert', 'arid'],
  dungeon: ['dungeon', 'underground'],
  dungeon_entrance: ['dungeon', 'underground'],
  field: ['field', 'grassland', 'plains'],
  forest: ['forest', 'woodland', 'trees'],
  harbor: ['harbor', 'port', 'coast'],
  houses: ['house', 'building', 'dwelling'],
  interior: ['interior', 'furniture', 'room'],
  mountains: ['mountain', 'rocky'],
  village: ['village', 'town', 'settlement'],
  winter: ['winter', 'snow', 'ice', 'cold']
};

// Biome rules — use simple substring checks on the lowercased path.
const BIOME_RULES = [
  { keys: ['forest', 'field', 'mountain', 'desert', 'winter', 'harbor', 'village', 'houses'], tag: 'outdoor' },
  { keys: ['interior'], tag: 'indoor' },
  { keys: ['cave', 'dungeon'], tag: 'underground' },
  { keys: ['harbor', 'water', 'pond', 'river'], tag: 'water_adjacent' },
  { keys: ['village', 'houses', 'interior', 'castle'], tag: 'civilized' },
  { keys: ['forest', 'field', 'mountain', 'desert'], tag: 'wild' }
];

const CONTENT_HINTS = [
  { match: /door/i, tags: ['door', 'interactive'] },
  { match: /enemies?/i, tags: ['enemy', 'combatant'] },
  { match: /animations?/i, tags: ['animated', 'ambient'] },
  { match: /cactuar/i, tags: ['creature', 'cactus'] },
  { match: /magical/i, tags: ['creature', 'magical'] },
  { match: /character_rm/i, tags: ['npc', 'player_sprite'] },
  { match: /object/i, tags: ['decoration', 'placeable'] },
  { match: /icon/i, tags: ['ui', 'ui_icon'] }
];

function deriveSheetTags(cls, folderName, fileName, relativePath) {
  const tags = new Set();
  const combined = (relativePath + ' ' + fileName).toLowerCase();

  // Category → type tags
  if (cls.category === 'character_sheet') {
    tags.add('character');
    if (fileName.startsWith('$')) tags.add('single_character');
    else tags.add('multi_character');
    if (/^!?Character_RM_/i.test(fileName.replace(/^[!$]/, ''))) tags.add('rm_pack');
  }
  if (cls.category === 'tileset_object') {
    tags.add('tileset');
    tags.add('object_tileset');
  }
  if (cls.category === 'tileset_autotile') {
    tags.add('tileset');
    tags.add('autotile');
    if (/_A1/i.test(fileName)) tags.add('animated');
    if (/_A5/i.test(fileName)) tags.add('ground_tile');
  }
  if (cls.category === 'icons') {
    tags.add('icon');
    tags.add('ui');
  }

  // Theme tags (substring match on filename, longest-first to avoid
  // double-tagging — e.g. "castle_new" wins over "castle", "dungeon_entrance"
  // is checked before "dungeon").
  const themes = Object.keys(THEME_TAGS).sort((a, b) => b.length - a.length);
  const matched = new Set();
  for (const theme of themes) {
    if (combined.includes(theme)) {
      // Only take this theme if a more-specific theme hasn't already claimed it
      const conflict = [...matched].some(m => m.includes(theme) && m !== theme);
      if (!conflict) {
        matched.add(theme);
        THEME_TAGS[theme].forEach(t => tags.add(t));
      }
    }
  }

  // Biome inference
  for (const rule of BIOME_RULES) {
    if (rule.keys.some(k => combined.includes(k))) tags.add(rule.tag);
  }

  // Content hints
  for (const hint of CONTENT_HINTS) {
    if (hint.match.test(combined)) hint.tags.forEach(t => tags.add(t));
  }

  return [...tags].sort();
}

// ---------- Prop & group generation ----------

const DIRECTION_BY_ROW = ['down', 'left', 'right', 'up'];

function buildCellProp(namePrefix, r, c, cellWidth, cellHeight, extra = {}) {
  return {
    id: randId(),
    name: `${namePrefix}_r${r}_c${c}`,
    description: '',
    x: c * cellWidth, y: r * cellHeight,
    width: cellWidth, height: cellHeight,
    ...extra
  };
}

function buildPropsFromCells(cells, namePrefix, cellWidth, cellHeight) {
  return cells.map(([r, c]) => buildCellProp(namePrefix, r, c, cellWidth, cellHeight));
}

function buildPropsAndGroupsForCharacter(cls, analysis) {
  const { namePrefix, grid, layout } = cls;
  const { cellWidth, cellHeight } = grid;
  const cells = analysis.nonEmptyCells || [];
  const props = [];
  const groups = [];

  if (!layout) {
    // No block layout → per-cell props, no groups
    return {
      props: cells.map(([r, c]) => buildCellProp(namePrefix, r, c, cellWidth, cellHeight)),
      groups: []
    };
  }

  // For each block, find which cells fall within it and tag them with direction/frame.
  for (const block of layout.blocks) {
    const memberIds = [];
    for (const [r, c] of cells) {
      if (r < block.row0 || r >= block.row0 + block.rowSpan) continue;
      if (c < block.col0 || c >= block.col0 + block.colSpan) continue;
      const dir = DIRECTION_BY_ROW[r - block.row0] || null;
      const frame = c - block.col0;
      const prop = buildCellProp(
        `${namePrefix}_${block.name}`,
        r - block.row0, c - block.col0,
        cellWidth, cellHeight,
        { direction: dir, frame, role: 'character_frame' }
      );
      // Preserve absolute coords on the sheet
      prop.x = c * cellWidth; prop.y = r * cellHeight;
      props.push(prop);
      memberIds.push(prop.id);
    }
    if (memberIds.length > 0) {
      groups.push({
        id: randId(),
        name: `${namePrefix}_${block.name}`,
        description: `캐릭터 블록 (${block.colSpan}×${block.rowSpan} @ col ${block.col0},row ${block.row0})`,
        role: 'character',
        propIds: memberIds
      });
    }
  }

  // Also include cells outside any block as ungrouped props
  const claimed = new Set(props.map(p => `${p.y / cellHeight}_${p.x / cellWidth}`));
  for (const [r, c] of cells) {
    const key = `${r}_${c}`;
    if (claimed.has(key)) continue;
    props.push(buildCellProp(namePrefix, r, c, cellWidth, cellHeight));
  }

  return { props, groups };
}

function buildPropsFromComponents(components, namePrefix) {
  // components: [{ x, y, width, height, cells, cellRange }]
  return components.map((comp, idx) => {
    const [r0, c0, r1, c1] = comp.cellRange;
    const span = `${c1 - c0 + 1}x${r1 - r0 + 1}`;
    const name =
      comp.width === comp.height && comp.cells.length === 1
        ? `${namePrefix}_r${r0}_c${c0}`
        : `${namePrefix}_${span}_r${r0}_c${c0}`;
    return {
      id: randId(),
      name,
      description: comp.cells.length > 1
        ? `${span} 멀티셀 오브젝트 (${comp.cells.length}셀)`
        : '',
      x: comp.x, y: comp.y, width: comp.width, height: comp.height
    };
  });
}

// ---------- Analyzer invocation ----------

function runAnalyzer(jobs) {
  const proc = spawnSync('python3', [ANALYZER_PY], {
    input: JSON.stringify({ jobs }),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024
  });
  if (proc.status !== 0) {
    throw new Error(
      `analyzer exited with code ${proc.status}:\n${proc.stderr || proc.stdout}`
    );
  }
  return JSON.parse(proc.stdout);
}

// ---------- Main ----------

function main() {
  let metadata = { sheets: {} };
  if (fs.existsSync(METADATA_ABS)) {
    try {
      metadata = JSON.parse(fs.readFileSync(METADATA_ABS, 'utf8'));
      if (!metadata.sheets) metadata.sheets = {};
    } catch (error) {
      console.warn('Failed to parse existing metadata, starting fresh:', error.message);
      metadata = { sheets: {} };
    }
  }

  // Prune any non-MZ entries from prior runs
  const allRelPaths = walk(PACK_ABS);
  const knownIdToPath = new Map();
  for (const rel of allRelPaths) knownIdToPath.set(sha1(rel), rel);
  const prunedIds = [];
  for (const id of Object.keys(metadata.sheets)) {
    const rel = knownIdToPath.get(id);
    if (!rel || !isUnderMz(rel)) {
      prunedIds.push(id);
      delete metadata.sheets[id];
    }
  }

  const mzFiles = allRelPaths.filter(isUnderMz);
  console.log(`Scanning ${mzFiles.length} PNGs under "${MZ_SUBDIR}"...`);
  console.log(`Pruned ${prunedIds.length} non-MZ entries from metadata.`);

  // First pass: classify everything, decide which sheets to analyze
  const plans = [];
  for (const rel of mzFiles) {
    const id = sha1(rel);
    const existing = metadata.sheets[id];
    if (existing && !FORCE && !GRID_ONLY) continue;
    if (GRID_ONLY && !existing) continue;

    const absolute = path.join(PACK_ABS, rel);
    const { width, height } = pngDims(absolute);
    const parts = rel.split(path.sep);
    const folderName = parts[parts.length - 2] || '';
    const fileName = parts[parts.length - 1];
    const cls = classifySheet(folderName, fileName, width, height);
    if (!cls) continue;
    plans.push({ id, rel, absolute, width, height, cls });
  }

  // Build analyzer jobs (skip for --grid-only since we don't touch props then)
  const analysis = {};
  if (!GRID_ONLY) {
    const jobs = plans.map(p => ({
      path: p.absolute,
      cellWidth: p.cls.grid.cellWidth,
      cellHeight: p.cls.grid.cellHeight,
      mode: p.cls.category === 'tileset_object' ? 'components' : 'cells',
      maxComponentCells: MAX_COMPONENT_CELLS
    }));
    if (jobs.length > 0) {
      console.log(`Analyzing ${jobs.length} sheets with Python...`);
      Object.assign(analysis, runAnalyzer(jobs));
    }
  }

  const stats = { total: plans.length, skipped: 0, byCategory: {}, totalProps: 0, totalGroups: 0 };

  for (const p of plans) {
    const existing = metadata.sheets[p.id];
    if (GRID_ONLY && existing) {
      const parts2 = p.rel.split(path.sep);
      const folderName2 = parts2[parts2.length - 2] || '';
      const fileName2 = parts2[parts2.length - 1];
      metadata.sheets[p.id] = {
        ...existing,
        description: p.cls.description,
        category: p.cls.category,
        grid: p.cls.grid,
        notes: p.cls.notes,
        tags: deriveSheetTags(p.cls, folderName2, fileName2, p.rel)
      };
      continue;
    }

    const a = analysis[p.absolute];
    if (!a || a.error) {
      console.warn(`  skip ${p.rel}: ${a?.error || 'no analysis'}`);
      stats.skipped += 1;
      continue;
    }

    let props, groups = [];
    if (p.cls.category === 'tileset_object') {
      props = buildPropsFromComponents(a.components || [], p.cls.namePrefix);
    } else if (p.cls.category === 'character_sheet') {
      const out = buildPropsAndGroupsForCharacter(p.cls, a);
      props = out.props;
      groups = out.groups;
    } else {
      // autotile, icons: per non-empty cell
      props = buildPropsFromCells(
        a.nonEmptyCells || [],
        p.cls.namePrefix,
        p.cls.grid.cellWidth,
        p.cls.grid.cellHeight
      );
    }

    const parts = p.rel.split(path.sep);
    const folderName = parts[parts.length - 2] || '';
    const fileName = parts[parts.length - 1];
    const tags = deriveSheetTags(p.cls, folderName, fileName, p.rel);
    metadata.sheets[p.id] = {
      description: p.cls.description,
      category: p.cls.category,
      grid: p.cls.grid,
      notes: p.cls.notes,
      tags,
      props,
      groups
    };
    stats.byCategory[p.cls.category] = (stats.byCategory[p.cls.category] || 0) + 1;
    stats.totalProps += props.length;
    stats.totalGroups += groups.length;
  }

  fs.mkdirSync(path.dirname(METADATA_ABS), { recursive: true });
  fs.writeFileSync(METADATA_ABS, JSON.stringify(metadata, null, 2), 'utf8');

  console.log('');
  console.log('Done.');
  console.log(`  Planned:       ${stats.total}`);
  console.log(`  Skipped:       ${stats.skipped}`);
  console.log(`  Pruned:        ${prunedIds.length} (non-MZ entries removed)`);
  console.log(`  By category:   ${JSON.stringify(stats.byCategory)}`);
  console.log(`  Props seeded:  ${stats.totalProps}`);
  console.log(`  Groups seeded: ${stats.totalGroups}`);
  console.log(`  Total sheets in metadata: ${Object.keys(metadata.sheets).length}`);
  console.log(`  Wrote: ${METADATA_ABS}`);
}

main();
