#!/usr/bin/env node
/**
 * Generate LLM-friendly asset catalog from data/asset-metadata.json.
 *
 * Outputs:
 *   data/asset-catalog.md   — human+LLM readable markdown
 *   data/asset-index.json   — compact machine index (stable across reads)
 *
 * Run after any change to asset-metadata.json:
 *   node scripts/generate-asset-catalog.js
 */
const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const METADATA_ABS = path.join(PROJECT_ROOT, 'data', 'asset-metadata.json');
const PACK_ROOT_REL = path.join(
  'assets', 'pixymoon', 'Cute RPG World', 'Cute RPG World (RPG Maker)'
);
const PACK_ABS = path.join(PROJECT_ROOT, PACK_ROOT_REL);
const CATALOG_MD = path.join(PROJECT_ROOT, 'data', 'asset-catalog.md');
const INDEX_JSON = path.join(PROJECT_ROOT, 'data', 'asset-index.json');
const crypto = require('crypto');

function sha1(s) { return crypto.createHash('sha1').update(s).digest('hex').slice(0, 16); }

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

function pngDims(file) {
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(24);
  fs.readSync(fd, buf, 0, 24, 0);
  fs.closeSync(fd);
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function main() {
  const metadata = JSON.parse(fs.readFileSync(METADATA_ABS, 'utf8'));
  // Build id → path map by rescanning
  const idToPath = new Map();
  for (const rel of walk(PACK_ABS)) idToPath.set(sha1(rel), rel);

  // Build enriched list
  const entries = [];
  for (const [id, sheet] of Object.entries(metadata.sheets)) {
    const relPath = idToPath.get(id);
    if (!relPath) continue;
    const abs = path.join(PACK_ABS, relPath);
    let dims = { width: 0, height: 0 };
    try { dims = pngDims(abs); } catch (_) {}
    const multi = (sheet.props || []).filter(
      p => p.width > sheet.grid.cellWidth || p.height > sheet.grid.cellHeight
    );
    entries.push({
      id,
      relPath,
      category: sheet.category,
      description: sheet.description,
      tags: sheet.tags || [],
      width: dims.width,
      height: dims.height,
      grid: sheet.grid,
      notes: sheet.notes || '',
      propCount: (sheet.props || []).length,
      multiCellPropCount: multi.length,
      groups: (sheet.groups || []).map(g => ({
        name: g.name, role: g.role || null, members: g.propIds.length,
        description: g.description || ''
      }))
    });
  }
  entries.sort((a, b) => a.relPath.localeCompare(b.relPath));

  // --- Write compact index JSON ---
  const index = {
    version: '1.0',
    generatedAt: new Date().toISOString(),
    assetRoot: PACK_ROOT_REL.split(path.sep).join('/'),
    counts: {
      sheets: entries.length,
      props: entries.reduce((s, e) => s + e.propCount, 0),
      multiCellProps: entries.reduce((s, e) => s + e.multiCellPropCount, 0),
      groups: entries.reduce((s, e) => s + e.groups.length, 0)
    },
    categories: aggregateBy(entries, 'category'),
    tags: aggregateTags(entries),
    sheets: entries
  };
  fs.writeFileSync(INDEX_JSON, JSON.stringify(index, null, 2));
  console.log('Wrote', INDEX_JSON);

  // --- Write markdown catalog ---
  const md = renderMarkdown(index);
  fs.writeFileSync(CATALOG_MD, md);
  console.log('Wrote', CATALOG_MD);
}

function aggregateBy(entries, key) {
  const out = {};
  for (const e of entries) out[e[key]] = (out[e[key]] || 0) + 1;
  return out;
}
function aggregateTags(entries) {
  const out = {};
  for (const e of entries) for (const t of e.tags) out[t] = (out[t] || 0) + 1;
  return Object.fromEntries(
    Object.entries(out).sort((a, b) => b[1] - a[1])
  );
}

function renderMarkdown(index) {
  const lines = [];
  lines.push('# Asset Catalog — Cute RPG World (RPG Maker MZ)');
  lines.push('');
  lines.push('> Auto-generated from `data/asset-metadata.json` by ' +
    '`scripts/generate-asset-catalog.js`. Do not hand-edit.');
  lines.push('');
  lines.push(`**Generated**: ${index.generatedAt}`);
  lines.push(`**Asset root**: \`${index.assetRoot}\``);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(`- **Sheets**: ${index.counts.sheets}`);
  lines.push(`- **Props** (individual placeable units): ${index.counts.props}`);
  lines.push(`- **Multi-cell props** (pre-composed objects): ${index.counts.multiCellProps}`);
  lines.push(`- **Groups** (logical collections, e.g. 4-direction characters): ${index.counts.groups}`);
  lines.push('');
  lines.push('### Categories');
  lines.push('');
  lines.push('| Category | Sheets |');
  lines.push('|---|---|');
  for (const [cat, n] of Object.entries(index.categories)) {
    lines.push(`| \`${cat}\` | ${n} |`);
  }
  lines.push('');
  lines.push('### Top Tags');
  lines.push('');
  const topTags = Object.entries(index.tags).slice(0, 30);
  lines.push(topTags.map(([t, n]) => `\`${t}\`(${n})`).join(' · '));
  lines.push('');

  // Group by category
  const byCategory = {};
  for (const s of index.sheets) {
    (byCategory[s.category] = byCategory[s.category] || []).push(s);
  }
  const categoryTitles = {
    character_sheet: 'Character Sheets',
    tileset_object: 'Object Tilesets (B/C/D/E — placeable decorations, structures)',
    tileset_autotile: 'Autotile Tilesets (A1/A5 — ground tiles, water, etc.)',
    icons: 'Icon Sheets (UI / items / skills)'
  };
  for (const cat of ['tileset_object', 'tileset_autotile', 'character_sheet', 'icons']) {
    const sheets = byCategory[cat] || [];
    if (!sheets.length) continue;
    lines.push(`## ${categoryTitles[cat] || cat} (${sheets.length})`);
    lines.push('');
    for (const s of sheets) {
      renderSheet(lines, s);
    }
  }

  return lines.join('\n');
}

function renderSheet(lines, s) {
  const fileName = s.relPath.split(/[\\/]/).pop();
  lines.push(`### \`${fileName}\``);
  lines.push('');
  lines.push(`- **Description**: ${s.description}`);
  lines.push(`- **Path**: \`${s.relPath}\``);
  lines.push(`- **Sheet ID**: \`${s.id}\``);
  lines.push(`- **Size**: ${s.width}×${s.height}px · grid ${s.grid.columns}×${s.grid.rows} @ ${s.grid.cellWidth}×${s.grid.cellHeight}px`);
  lines.push(`- **Props**: ${s.propCount} (${s.multiCellPropCount} multi-cell)`);
  if (s.tags.length) lines.push(`- **Tags**: ${s.tags.map(t => '`' + t + '`').join(' · ')}`);
  if (s.notes) lines.push(`- **Notes**: ${s.notes}`);
  if (s.groups.length) {
    lines.push(`- **Groups**:`);
    for (const g of s.groups) {
      lines.push(`  - \`${g.name}\` (${g.role || '—'}, ${g.members} props)${g.description ? ' — ' + g.description : ''}`);
    }
  }
  lines.push('');
}

main();
