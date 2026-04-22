// Verifies minimal-mode rendering (no PixyMoon pack installed).
// Checks that the banner appears, the assets link + editor toggle are
// hidden, and the world still renders without console errors.

import { chromium } from '@playwright/test';

const TOKEN = process.env.AGENT_WORLD_API_TOKEN || 'smoke';
const PORT = process.env.PORT || 3199;
const URL_BASE = `http://127.0.0.1:${PORT}`;

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
await ctx.addInitScript((token) => {
  window.__AGENT_WORLD_RUNTIME__ = {
    environment: 'development', allowDevQueryToken: true, authToken: token
  };
  // Clear any previous dismissal of the banner so tests see it fresh.
  try { localStorage.removeItem('agent-world.minimal-banner-dismissed'); } catch (_) {}
}, TOKEN);

const page = await ctx.newPage();
const errors = [];
const consoleIssues = [];
page.on('pageerror', e => errors.push(String(e)));
page.on('console', msg => {
  if (msg.type() === 'error' || msg.type() === 'warning') {
    consoleIssues.push(`${msg.type()}: ${msg.text().slice(0, 200)}`);
  }
});

await page.goto(`${URL_BASE}/?authToken=${TOKEN}`, { waitUntil: 'networkidle', timeout: 20000 });
await page.waitForTimeout(2500);

const state = await page.evaluate(() => {
  const banner = document.getElementById('assets-minimal-banner');
  const assetsLink = document.getElementById('assets-link');
  const editorToggle = document.getElementById('world-editor-toggle');
  return {
    bannerVisible: banner ? banner.dataset.visible : null,
    bannerText: banner ? banner.innerText.slice(0, 160) : null,
    assetsLinkDisplay: assetsLink ? getComputedStyle(assetsLink).display : null,
    editorToggleDisplay: editorToggle ? getComputedStyle(editorToggle).display : null,
    rosterRowCount: document.querySelectorAll('#agent-roster .roster-row').length,
    agentCount: Object.keys(window.__agentWorldApp?.getWorldState?.()?.agents || {}).length
  };
});
console.log('[minimal] state:', JSON.stringify(state, null, 2));

await page.screenshot({ path: '/tmp/probe-minimal.png', fullPage: false });
console.log('[minimal] saved /tmp/probe-minimal.png');

console.log('[minimal] pageErrors:', errors);
console.log('[minimal] consoleIssues:', consoleIssues.slice(0, 6));
await browser.close();
