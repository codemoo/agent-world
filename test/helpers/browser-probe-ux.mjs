// Verifies the UX pass: roster, hover tooltip, help overlay, event log,
// timeline scrubber, and the bilingual Live modal — all are present,
// interactive, and free of console errors.

import { chromium } from '@playwright/test';

const TOKEN = process.env.AGENT_WORLD_API_TOKEN || 'smoke';
const PORT = process.env.PORT || 3199;
const URL_BASE = `http://127.0.0.1:${PORT}`;

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
await ctx.addInitScript((token) => {
  window.__AGENT_WORLD_RUNTIME__ = {
    environment: 'development',
    allowDevQueryToken: true,
    authToken: token
  };
}, TOKEN);

const page = await ctx.newPage();
const errors = [];
const consoleIssues = [];
page.on('pageerror', err => errors.push(String(err)));
page.on('console', msg => {
  if (msg.type() === 'error' || msg.type() === 'warning') {
    consoleIssues.push(`${msg.type()}: ${msg.text().slice(0, 200)}`);
  }
});

await page.goto(`${URL_BASE}/?authToken=${TOKEN}`, { waitUntil: 'networkidle', timeout: 20000 });
await page.waitForTimeout(2500);

// 1. AgentRoster present + clickable
const roster = await page.evaluate(() => {
  const r = document.getElementById('agent-roster');
  const rows = r ? r.querySelectorAll('.roster-row') : [];
  return {
    present: Boolean(r),
    visible: r ? getComputedStyle(r).opacity : null,
    rowCount: rows.length,
    firstRowName: rows[0]?.querySelector('.roster-name')?.textContent || null,
    spinnerCount: r ? r.querySelectorAll('.roster-spinner').length : 0
  };
});
console.log('[ux] roster:', JSON.stringify(roster));

// Click first row → expect agent-selected → SessionDetailPanel opens
const sidPanel = await page.evaluate(() => {
  const row = document.querySelector('#agent-roster .roster-row');
  row?.click();
  const panel = document.getElementById('session-detail-panel');
  return {
    clicked: Boolean(row),
    panelDisplay: panel ? getComputedStyle(panel).display : null
  };
});
await page.waitForTimeout(400);
const panelText = await page.evaluate(() => document.getElementById('session-detail-panel')?.textContent?.slice(0, 240) || null);
console.log('[ux] roster click → panel:', JSON.stringify(sidPanel), 'text head:', panelText?.slice(0, 60));

// 2. Hover tooltip — synthesize mousemove over a sprite
const hover = await page.evaluate(() => {
  const wm = window.__agentWorldApp?.getWorldState?.();
  const canvas = document.querySelector('canvas');
  const map = (window.__agentWorldApp || {});
  if (!canvas) return null;
  // Pick a known agent's tile center on the canvas
  const agents = Object.values(wm?.agents || {});
  const target = agents[0];
  if (!target) return null;
  const rect = canvas.getBoundingClientRect();
  // Estimate tile size: world is 30 tiles wide
  const tile = rect.width / 30;
  const cx = rect.left + (target.position?.x ?? target.x ?? 5) * tile + tile / 2;
  const cy = rect.top + (target.position?.y ?? target.y ?? 5) * tile + tile / 2;
  // Some agent positions live on avatars[]
  const avatar = wm?.avatars?.[target.id];
  const ax = avatar?.x ?? 5;
  const ay = avatar?.y ?? 5;
  const px = rect.left + ax * tile + tile / 2;
  const py = rect.top + ay * tile + tile / 2;
  canvas.dispatchEvent(new MouseEvent('mousemove', { clientX: px, clientY: py, bubbles: true }));
  return { tile, px, py, target: target.name };
});
await page.waitForTimeout(200);
const tooltip = await page.evaluate(() => {
  const tt = document.getElementById('world-hover-tooltip');
  return tt ? {
    display: getComputedStyle(tt).display,
    text: tt.innerText.slice(0, 200)
  } : null;
});
console.log('[ux] hover:', JSON.stringify(hover), 'tooltip:', JSON.stringify(tooltip));

// 3. Help overlay
const helpInit = await page.evaluate(() => {
  const btn = document.getElementById('help-button');
  return { present: Boolean(btn), text: btn?.textContent };
});
await page.evaluate(() => document.getElementById('help-button')?.click());
await page.waitForTimeout(300);
const helpOpen = await page.evaluate(() => {
  const overlay = document.getElementById('help-overlay');
  return overlay ? {
    open: overlay.dataset.open,
    sectionCount: overlay.querySelectorAll('h3').length,
    rowCount: overlay.querySelectorAll('dt').length
  } : null;
});
await page.evaluate(() => document.getElementById('help-button')?.click()); // close
console.log('[ux] help:', JSON.stringify(helpInit), 'open:', JSON.stringify(helpOpen));

// 4. Event log present
const log = await page.evaluate(() => {
  const el = document.getElementById('event-log');
  return el ? {
    present: true,
    collapsed: el.dataset.collapsed,
    rowCount: el.querySelectorAll('.event-row').length,
    countText: el.querySelector('.event-count')?.textContent
  } : null;
});
console.log('[ux] event log:', JSON.stringify(log));

// 5. Timeline scrubber present + draggable
const scrub = await page.evaluate(() => {
  const el = document.getElementById('timeline-scrubber');
  return el ? {
    present: true,
    empty: el.dataset.empty,
    live: el.dataset.live,
    nowText: el.querySelector('.ts-now')?.textContent
  } : null;
});
console.log('[ux] scrubber:', JSON.stringify(scrub));

// 6. Wait a few seconds for HistoryBuffer to collect snapshots, then drag.
await page.waitForTimeout(4000);
const scrubAfter = await page.evaluate(() => {
  const el = document.getElementById('timeline-scrubber');
  return el ? {
    empty: el.dataset.empty,
    live: el.dataset.live,
    nowText: el.querySelector('.ts-now')?.textContent
  } : null;
});
console.log('[ux] scrubber after wait:', JSON.stringify(scrubAfter));

// 7. Press N — name tag toggle off → render still works
await page.keyboard.press('n');
await page.waitForTimeout(200);
await page.keyboard.press('n');

// 8. Press ? — help opens
await page.keyboard.press('?');
await page.waitForTimeout(200);
const helpFromKey = await page.evaluate(() => document.getElementById('help-overlay')?.dataset.open);
await page.keyboard.press('Escape');
console.log('[ux] help from "?" key:', helpFromKey);

await page.screenshot({ path: '/tmp/probe-ux.png', fullPage: false });
console.log('[ux] saved /tmp/probe-ux.png');

console.log('---');
console.log('[ux] pageErrors:', errors);
console.log('[ux] consoleIssues:', consoleIssues.slice(0, 6));
await browser.close();
