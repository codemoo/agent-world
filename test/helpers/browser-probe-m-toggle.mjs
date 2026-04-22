// Verifies the M-key minimal-mode toggle. Assumes server has the
// PixyMoon pack installed so we can flip between "full" and
// "forced-minimal preview" and see the difference.

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
  // Clear persisted state from previous runs.
  try { localStorage.removeItem('agent-world.minimal-banner-dismissed'); } catch (_) {}
  try { localStorage.removeItem('agent-world.minimal-mode-forced'); } catch (_) {}
}, TOKEN);

const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(String(e)));

await page.goto(`${URL_BASE}/?authToken=${TOKEN}`, { waitUntil: 'networkidle', timeout: 20000 });
await page.waitForTimeout(2500);

// Initial state — pack is installed, so banner should be hidden.
const before = await page.evaluate(() => {
  const banner = document.getElementById('assets-minimal-banner');
  const assetsLink = document.getElementById('assets-link');
  const editorToggle = document.getElementById('world-editor-toggle');
  return {
    bannerVisible: banner?.dataset.visible,
    assetsLinkDisplay: assetsLink ? getComputedStyle(assetsLink).display : null,
    editorDisplay: editorToggle ? getComputedStyle(editorToggle).display : null
  };
});
console.log('[before M] ', JSON.stringify(before));
await page.screenshot({ path: '/tmp/probe-m-before.png' });

// Press M — minimal preview on.
await page.keyboard.press('m');
await page.waitForTimeout(400);
const afterOn = await page.evaluate(() => {
  const banner = document.getElementById('assets-minimal-banner');
  const assetsLink = document.getElementById('assets-link');
  return {
    bannerVisible: banner?.dataset.visible,
    bannerTitle: banner?.querySelector('.banner-title')?.textContent,
    bannerText: banner?.querySelector('.banner-body')?.innerText?.slice(0, 140),
    assetsLinkDisplay: assetsLink ? getComputedStyle(assetsLink).display : null,
    forcedLS: localStorage.getItem('agent-world.minimal-mode-forced')
  };
});
console.log('[after M → on]', JSON.stringify(afterOn));
await page.screenshot({ path: '/tmp/probe-m-on.png' });

// Press M again — minimal preview off.
await page.keyboard.press('m');
await page.waitForTimeout(400);
const afterOff = await page.evaluate(() => {
  const banner = document.getElementById('assets-minimal-banner');
  const assetsLink = document.getElementById('assets-link');
  return {
    bannerVisible: banner?.dataset.visible,
    assetsLinkDisplay: assetsLink ? getComputedStyle(assetsLink).display : null,
    forcedLS: localStorage.getItem('agent-world.minimal-mode-forced')
  };
});
console.log('[after M → off]', JSON.stringify(afterOff));
await page.screenshot({ path: '/tmp/probe-m-off.png' });

console.log('[errors]', errors);
await browser.close();
