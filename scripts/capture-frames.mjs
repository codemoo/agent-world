// Playwright-based frame capture for README demos.
//
// Usage:
//   node scripts/capture-frames.mjs world   [baseUrl]
//   node scripts/capture-frames.mjs editor  [baseUrl]
//   node scripts/capture-frames.mjs assets  [baseUrl]
//
// Each scenario writes PNG frames to /tmp/agent-world-frames and then
// stitches them into demo/demo-{scenario}.gif via ffmpeg.

import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const FRAMES_DIR = '/tmp/agent-world-frames';
const OUT_DIR = path.join(REPO_ROOT, 'demo');
const FPS = 10;

const SCENARIOS = {
  async world(page) {
    // Let the world run for 30s so agents roam and find stations.
    console.log('Warming up (30s)…');
    await page.waitForTimeout(30_000);
    return { durationMs: 6000 };
  },

  async editor(page) {
    // Open the editor panel, navigate tabs, poke around.
    console.log('Settling world (3s)…');
    await page.waitForTimeout(3000);
    return {
      durationMs: 10000,
      onCapture: async () => {
        await page.keyboard.press('e');
        await page.waitForTimeout(1200);
        const indoorBtn = page.locator('button').filter({ hasText: /Indoor \(/ });
        if (await indoorBtn.count()) await indoorBtn.first().click();
        await page.waitForTimeout(1500);
        const outdoorBtn = page.locator('button').filter({ hasText: /Outdoor \(/ });
        if (await outdoorBtn.count()) await outdoorBtn.first().click();
        await page.waitForTimeout(1500);
        const treesBtn = page.locator('button').filter({ hasText: /Trees \(/ });
        if (await treesBtn.count()) await treesBtn.first().click();
        await page.waitForTimeout(1500);
        const listRow = page.locator('#world-editor-panel div').filter({ hasText: /tree.*@/ }).first();
        if (await listRow.count()) await listRow.click();
        await page.waitForTimeout(1500);
        const flipBtn = page.locator('button[title^="F — flip"]').first();
        if (await flipBtn.count()) await flipBtn.click();
        await page.waitForTimeout(1200);
        await page.keyboard.press('e');
        await page.waitForTimeout(1000);
      }
    };
  },

  async assets(page, baseUrl) {
    await page.goto(`${baseUrl}/assets-manager`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1500);
    return {
      durationMs: 8000,
      onCapture: async () => {
        const rows = page.locator('#sheetListItems li');
        const count = await rows.count();
        if (count > 3) {
          await rows.nth(3).click();
          await page.waitForTimeout(2500);
        }
        await page.evaluate(() => {
          const el = document.querySelector('#details');
          if (el) el.scrollTop = 120;
        });
        await page.waitForTimeout(1500);
        if (count > 10) {
          await rows.nth(10).click();
          await page.waitForTimeout(2500);
        }
      }
    };
  }
};

async function captureFrames(page, durationMs, onCapture) {
  const total = Math.floor((durationMs * FPS) / 1000);
  fs.rmSync(FRAMES_DIR, { recursive: true, force: true });
  fs.mkdirSync(FRAMES_DIR, { recursive: true });
  const frameInterval = 1000 / FPS;
  let ticking = true;
  const loop = (async () => {
    for (let i = 0; i < total && ticking; i++) {
      const framePath = path.join(FRAMES_DIR, `frame-${String(i).padStart(4, '0')}.png`);
      try {
        await page.screenshot({ path: framePath, type: 'png' });
      } catch (_) { /* page closed */ }
      await page.waitForTimeout(frameInterval);
      if (i % 10 === 0) process.stdout.write('.');
    }
  })();
  if (onCapture) await onCapture();
  await loop;
  ticking = false;
  process.stdout.write('\n');
  return total;
}

function makeGif(name) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const outGif = path.join(OUT_DIR, `demo-${name}.gif`);
  const args = [
    '-y',
    '-framerate', String(FPS),
    '-i', path.join(FRAMES_DIR, 'frame-%04d.png'),
    '-vf',
    `fps=${FPS},scale=720:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128[p];[s1][p]paletteuse=dither=bayer:bayer_scale=5`,
    outGif
  ];
  const res = spawnSync('ffmpeg', args, { stdio: 'inherit' });
  if (res.status !== 0) throw new Error('ffmpeg failed');
  const size = fs.statSync(outGif).size;
  console.log(`→ ${outGif}  (${(size / 1024).toFixed(1)} KB)`);
  return outGif;
}

async function main() {
  const scenario = process.argv[2] || 'world';
  const baseUrl = process.argv[3] || 'http://localhost:3102';
  if (!SCENARIOS[scenario]) {
    console.error(`unknown scenario: ${scenario}. available: ${Object.keys(SCENARIOS).join(', ')}`);
    process.exit(2);
  }

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    viewport: { width: 960, height: 720 },
    deviceScaleFactor: 1
  });
  const page = await ctx.newPage();
  page.on('console', m => {
    const t = m.text();
    if (!t.includes('404')) console.log('[browser]', t.slice(0, 100));
  });
  page.on('pageerror', e => console.log('[pageerror]', e.message));

  console.log(`[${scenario}] loading ${baseUrl}…`);
  await page.goto(baseUrl, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);

  const { durationMs, onCapture } = await SCENARIOS[scenario](page, baseUrl);
  console.log(`[${scenario}] capturing ${durationMs}ms @ ${FPS}fps…`);
  await captureFrames(page, durationMs, onCapture);

  await browser.close();
  makeGif(scenario);
}

main().catch(err => { console.error(err); process.exit(1); });
