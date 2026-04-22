// Verify DOM overlay positions at multiple viewport sizes.
//   1400×900 — full desktop
//   1024×768 — small laptop (must not overlap)
//   800×600  — narrow
// Prints element bounding boxes so human review is quick.

import { chromium } from '@playwright/test';

const TOKEN = process.env.AGENT_WORLD_API_TOKEN || 'smoke';
const PORT = process.env.PORT || 3199;
const URL_BASE = `http://127.0.0.1:${PORT}`;

const viewports = [
  { w: 1400, h: 900, label: 'desktop' },
  { w: 1024, h: 768, label: 'laptop' },
  { w: 800,  h: 600, label: 'narrow' }
];

function rectsOverlap(a, b) {
  return !(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top);
}

for (const vp of viewports) {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: vp.w, height: vp.h } });
  await ctx.addInitScript((token) => {
    window.__AGENT_WORLD_RUNTIME__ = {
      environment: 'development', allowDevQueryToken: true, authToken: token
    };
    try { localStorage.removeItem('agent-world.minimal-banner-dismissed'); } catch (_) {}
    try { localStorage.removeItem('agent-world.minimal-mode-forced'); } catch (_) {}
  }, TOKEN);
  const page = await ctx.newPage();
  await page.goto(`${URL_BASE}/?authToken=${TOKEN}`, { waitUntil: 'networkidle', timeout: 20000 });
  await page.waitForTimeout(2200);

  // Open session panel too — worst-case overlap scenario.
  await page.evaluate(() => {
    const row = document.querySelector('#agent-roster .roster-row');
    row?.click();
  });
  await page.waitForTimeout(600);

  const ids = [
    '#connection-status', '#assets-link', '#sky-mode-toggle', '#world-editor-toggle',
    '#help-button', '#agent-roster', '#session-detail-panel', '#event-log',
    '#timeline-scrubber', '#assets-minimal-banner'
  ];

  const rects = await page.evaluate((ids) => {
    const out = {};
    for (const sel of ids) {
      const el = document.querySelector(sel);
      if (!el) { out[sel] = null; continue; }
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') { out[sel] = null; continue; }
      const r = el.getBoundingClientRect();
      out[sel] = { top: r.top, left: r.left, right: r.right, bottom: r.bottom, w: r.width, h: r.height };
    }
    return out;
  }, ids);

  const visible = Object.entries(rects).filter(([_, r]) => r);
  const collisions = [];
  for (let i = 0; i < visible.length; i++) {
    for (let j = i + 1; j < visible.length; j++) {
      const [k1, r1] = visible[i];
      const [k2, r2] = visible[j];
      if (rectsOverlap(r1, r2)) {
        // Modals like help-overlay / tui-overlay deliberately cover everything.
        // Skip pairs where one is a modal.
        if (k1 === '#help-button' || k2 === '#help-button') continue;
        collisions.push({ a: k1, b: k2 });
      }
    }
  }

  console.log(`\n[${vp.label} ${vp.w}x${vp.h}]`);
  for (const [k, r] of visible) {
    console.log(`  ${k.padEnd(28)} ${r.left.toFixed(0).padStart(5)},${r.top.toFixed(0).padStart(4)} → ${r.right.toFixed(0).padStart(5)},${r.bottom.toFixed(0).padStart(4)} (${r.w.toFixed(0)}×${r.h.toFixed(0)})`);
  }
  console.log('  collisions:', collisions.length ? collisions : '(none)');

  await page.screenshot({ path: `/tmp/probe-overlap-${vp.label}.png`, fullPage: false });
  await browser.close();
}

console.log('\n[done]');
