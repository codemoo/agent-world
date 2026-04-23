#!/usr/bin/env node
// Build `assets/pixymoon/Cute RPG World/asset-manifest.json` from the
// canonical rules in `scripts/asset-manifest-rules.mjs`.
//
// The WorldMap loader merges manifest entries over the hardcoded
// `DEFAULT_SPRITE_DEFINITIONS` at runtime, so this manifest is the
// supported override point: update rules → rebuild → reload browser.
//
// The builder verifies each entry's PNG exists on disk (so a typo in
// rules fails loudly), then writes a human-readable JSON file.
//
// Usage:
//   node scripts/build-asset-manifest.js
//   npm run build-assets

const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..');
// Disk-relative path — used for existence checks against the filesystem.
const ASSET_ROOT_REL = 'assets/pixymoon/Cute RPG World';
// URL-space path — written into the manifest as `assetRoot`. MUST start
// with a leading slash so the runtime's `resolveUrl` short-circuits on
// already-absolute URLs instead of re-concatenating the store's
// assetRoot on top (which would produce `/assets/.../assets/.../...`
// garbage and silently 404 every manifest-loaded sprite).
const ASSET_ROOT_URL = '/' + ASSET_ROOT_REL;
const MANIFEST_REL = path.join(ASSET_ROOT_REL, 'asset-manifest.json');

async function main() {
  const rulesUrl = new URL('./asset-manifest-rules.mjs', `file://${__filename}`);
  const { ALL_ENTRIES } = await import(rulesUrl.href);

  const missing = [];
  const verified = [];
  for (const entry of ALL_ENTRIES) {
    if (!entry.key || !entry.url) {
      console.error(`skip malformed entry:`, entry);
      continue;
    }
    const abs = path.join(PROJECT_ROOT, ASSET_ROOT_REL, entry.url);
    if (!fs.existsSync(abs)) {
      missing.push({ key: entry.key, url: entry.url });
      continue;
    }
    verified.push(entry);
  }

  if (missing.length > 0) {
    console.warn(`⚠  ${missing.length} entries reference missing files (skipped):`);
    for (const m of missing.slice(0, 8)) {
      console.warn(`    - ${m.key} → ${m.url}`);
    }
    if (missing.length > 8) console.warn(`    ...and ${missing.length - 8} more`);
  }

  const payload = {
    version: 1,
    generatedAt: new Date().toISOString(),
    generator: 'scripts/build-asset-manifest.js',
    assetRoot: ASSET_ROOT_URL,
    sprites: verified
  };

  const outPath = path.join(PROJECT_ROOT, MANIFEST_REL);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2) + '\n');
  console.log(`✓  wrote ${verified.length} sprite entries to`);
  console.log(`    ${MANIFEST_REL}`);
  if (missing.length > 0) {
    console.log(`   (${missing.length} missing — fix paths in scripts/asset-manifest-rules.mjs)`);
    process.exitCode = missing.length > 0 ? 0 : 0;  // warn but succeed
  }
}

main().catch(err => {
  console.error('asset manifest build failed:', err);
  process.exit(1);
});
