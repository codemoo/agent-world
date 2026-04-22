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
      durationMs: 11000,
      onCapture: async () => {
        await page.keyboard.press('e');
        await page.waitForTimeout(1200);
        const bldgBtn = page.locator('button').filter({ hasText: /Bldgs \(/ });
        if (await bldgBtn.count()) await bldgBtn.first().click();
        await page.waitForTimeout(1500);
        const bldgRow = page.locator('#world-editor-panel div').filter({ hasText: /Architect/ }).first();
        if (await bldgRow.count()) await bldgRow.click();
        await page.waitForTimeout(1500);
        const indoorBtn = page.locator('button').filter({ hasText: /Indoor \(/ });
        if (await indoorBtn.count()) await indoorBtn.first().click();
        await page.waitForTimeout(1500);
        const treesBtn = page.locator('button').filter({ hasText: /Trees \(/ });
        if (await treesBtn.count()) await treesBtn.first().click();
        await page.waitForTimeout(1500);
        const listRow = page.locator('#world-editor-panel div').filter({ hasText: /tree.*@/ }).first();
        if (await listRow.count()) await listRow.click();
        await page.waitForTimeout(1200);
        const flipBtn = page.locator('button[title^="F — flip"]').first();
        if (await flipBtn.count()) await flipBtn.click();
        await page.waitForTimeout(1200);
        await page.keyboard.press('e');
        await page.waitForTimeout(600);
      }
    };
  },

  async ux(page) {
    // Showcase the UX surface: roster click, hover tooltip, help overlay,
    // event log, timeline scrubber. Total ~14s.
    console.log('Warming up (2.5s)…');
    await page.waitForTimeout(2500);
    return {
      durationMs: 14000,
      onCapture: async () => {
        // 1. Click a row in the DOM roster → open SessionDetailPanel.
        const row = page.locator('#agent-roster .roster-row').first();
        if (await row.count()) {
          await row.click();
          await page.waitForTimeout(1500);
        }

        // 2. Move mouse over a sprite → trigger hover tooltip. Read a
        //    live avatar position and hover directly at its pixel center.
        const hover = await page.evaluate(() => {
          const ws = window.__agentWorldApp?.getWorldState?.();
          const canvas = document.querySelector('canvas');
          if (!ws || !canvas) return null;
          const avatars = Object.values(ws.avatars || {});
          const target = avatars[Math.min(2, avatars.length - 1)];
          if (!target) return null;
          const rect = canvas.getBoundingClientRect();
          const tile = Math.min(rect.width, rect.height) / 30;
          const ox = (rect.width - tile * 30) / 2;
          const oy = (rect.height - tile * 30) / 2;
          return {
            cx: rect.left + ox + (target.x + 0.5) * tile,
            cy: rect.top + oy + (target.y + 0.5) * tile
          };
        });
        if (hover) {
          await page.mouse.move(hover.cx, hover.cy);
          await page.waitForTimeout(1700);
        }

        // 3. Close session panel then open help overlay via the "?" button.
        await page.keyboard.press('Escape');
        await page.waitForTimeout(500);
        const helpBtn = page.locator('#help-button');
        if (await helpBtn.count()) {
          await helpBtn.click();
          await page.waitForTimeout(2200);
          await page.keyboard.press('Escape');
          await page.waitForTimeout(500);
        }

        // 4. Click an event log row → selects that agent.
        const ev = page.locator('#event-log .event-row').first();
        if (await ev.count()) {
          await ev.click();
          await page.waitForTimeout(1500);
          await page.keyboard.press('Escape');
          await page.waitForTimeout(400);
        }

        // 5. Drag the timeline scrubber thumb a few steps back, then Live.
        const thumb = page.locator('#timeline-scrubber .ts-thumb');
        if (await thumb.count()) {
          const box = await thumb.boundingBox();
          if (box) {
            const startX = box.x + box.width / 2;
            const y = box.y + box.height / 2;
            await page.mouse.move(startX, y);
            await page.mouse.down();
            await page.mouse.move(startX - 100, y, { steps: 8 });
            await page.waitForTimeout(700);
            await page.mouse.move(startX, y, { steps: 8 });
            await page.mouse.up();
            await page.waitForTimeout(400);
          }
        }
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
