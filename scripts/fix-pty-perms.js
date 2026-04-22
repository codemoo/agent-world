#!/usr/bin/env node
// Some filesystems (Dropbox, iCloud) strip the execute bit on files synced
// between machines. node-pty's spawn-helper is bundled as a prebuilt
// binary that MUST be executable; without it posix_spawnp fails. This
// postinstall fixes the bits idempotently and silently.

const fs = require('node:fs');
const path = require('node:path');

const helpers = [
  'prebuilds/darwin-arm64/spawn-helper',
  'prebuilds/darwin-x64/spawn-helper',
  'prebuilds/linux-arm64/spawn-helper',
  'prebuilds/linux-x64/spawn-helper'
];

const pkgRoot = path.resolve(__dirname, '..', 'node_modules', 'node-pty');
for (const rel of helpers) {
  const full = path.join(pkgRoot, rel);
  try {
    const st = fs.statSync(full);
    if ((st.mode & 0o111) === 0) {
      fs.chmodSync(full, st.mode | 0o755);
      console.log(`[fix-pty-perms] +x ${rel}`);
    }
  } catch { /* not installed on this arch */ }
}
