// Verify the cost tracker UI: budget badge in top-left, click reveals
// per-session popover, session detail panel shows cost breakdown.

import { chromium } from '@playwright/test';

const TOKEN = process.env.AGENT_WORLD_API_TOKEN || 'smoke';
const PORT = process.env.PORT || 3199;
const URL_BASE = `http://127.0.0.1:${PORT}`;

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
await ctx.addInitScript((token) => {
  window.__AGENT_WORLD_RUNTIME__ = {
    environment: 'development', allowDevQueryToken: true, authToken: token
  };
}, TOKEN);

const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(String(e)));

await page.goto(`${URL_BASE}/?authToken=${TOKEN}`, { waitUntil: 'networkidle', timeout: 20000 });
await page.waitForTimeout(3000);

const badge = await page.evaluate(() => {
  const el = document.getElementById('world-budget');
  if (!el) return null;
  return {
    empty: el.dataset.empty,
    visible: getComputedStyle(el).display !== 'none',
    text: el.innerText
  };
});
console.log('[cost] badge:', JSON.stringify(badge));

// Click to open popover.
await page.click('#world-budget');
await page.waitForTimeout(400);
const popover = await page.evaluate(() => {
  const el = document.getElementById('world-budget-popover');
  return el ? {
    visible: el.dataset.visible,
    rowCount: el.querySelectorAll('.wb-row').length,
    totalText: el.querySelector('.wb-total')?.innerText
  } : null;
});
console.log('[cost] popover:', JSON.stringify(popover));
await page.screenshot({ path: '/tmp/probe-cost-popover.png' });

// Close popover + select an agent to see session-level cost.
await page.mouse.click(700, 500);
await page.waitForTimeout(400);
await page.evaluate(() => {
  const row = document.querySelector('#agent-roster .roster-row');
  if (row) row.click();
});
await page.waitForTimeout(800);
const panelCost = await page.evaluate(() => {
  const panel = document.getElementById('session-detail-panel');
  const text = panel?.innerText || '';
  return {
    visible: panel ? getComputedStyle(panel).display !== 'none' : null,
    hasCost: /session cost|\$\d/.test(text),
    snippet: text.match(/session cost.*?\n[^\n]*/)?.[0] || null
  };
});
console.log('[cost] session panel:', JSON.stringify(panelCost));
await page.screenshot({ path: '/tmp/probe-cost-session.png' });

console.log('[errors]', errors);
await browser.close();
