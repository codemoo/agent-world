import { chromium } from '@playwright/test';

const TOKEN = process.env.AGENT_WORLD_API_TOKEN || 'smoke';
const PORT = process.env.PORT || 3199;
const URL_BASE = `http://127.0.0.1:${PORT}`;

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
await ctx.addInitScript((token) => {
  window.__AGENT_WORLD_RUNTIME__ = {
    environment: 'development',
    allowDevQueryToken: true,
    authToken: token
  };
}, TOKEN);

const page = await ctx.newPage();
page.on('dialog', async d => { await d.accept(); });
const errors = [];
page.on('pageerror', e => errors.push(String(e)));

await page.goto(`${URL_BASE}/?authToken=${TOKEN}`, { waitUntil: 'networkidle', timeout: 20000 });
await page.waitForTimeout(2500);

// Force night via button cycle (☀ Day → 🌙 Night → 🕐 Clock → ☀ Day)
const skyResult = await page.evaluate(() => {
  const buttons = [...document.querySelectorAll('button')];
  const btn = buttons.find(b => /day|night|clock/i.test(b.textContent || ''));
  if (!btn) return { ok: false };
  for (let i = 0; i < 4; i++) {
    if (/night/i.test(btn.textContent || '')) break;
    btn.click();
  }
  return { ok: true, label: btn.textContent };
});
console.log('[probe-night] sky toggle:', skyResult);

await page.waitForTimeout(1500);
await page.screenshot({ path: '/tmp/probe-night-world.png', fullPage: false });
console.log('[probe-night] saved /tmp/probe-night-world.png');

// Watch for animation frames: do a burst of agent selection + wait a bit so
// we catch any tool pop / poof transitions rendering visibly.
await page.waitForTimeout(2500);
await page.screenshot({ path: '/tmp/probe-night-world-2.png', fullPage: false });
console.log('errors:', errors);
await browser.close();
