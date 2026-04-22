// Playwright probe for the live agent-world frontend.
// Usage:  PLAYWRIGHT_BROWSERS_PATH=~/.cache/agent-world-playwright node test/helpers/browser-probe.mjs
// Preconditions: server running on $PORT with AGENT_WORLD_API_TOKEN=$TOKEN.

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
page.on('dialog', async dialog => { await dialog.accept(); });
const pageErrors = [];
const failures = [];
const consoleIssues = [];
const http404s = [];

page.on('console', msg => {
  const type = msg.type();
  if (type === 'error' || type === 'warning') {
    consoleIssues.push({ type, text: msg.text() });
  }
});
page.on('pageerror', err => pageErrors.push(String(err)));
page.on('requestfailed', req => failures.push(`${req.method()} ${req.url()} — ${req.failure()?.errorText}`));
page.on('response', res => {
  if (res.status() === 404) http404s.push(`${res.request().method()} ${res.url()}`);
});

console.log('[probe] navigating to', `${URL_BASE}/?authToken=${TOKEN}`);
await page.goto(`${URL_BASE}/?authToken=${TOKEN}`, { waitUntil: 'networkidle', timeout: 20000 });
await page.waitForTimeout(3000);

// Clean world shot BEFORE any interaction.
await page.screenshot({ path: '/tmp/probe-world.png', fullPage: false });
console.log('[probe] saved /tmp/probe-world.png');

const state = await page.evaluate(() => {
  const app = window.__agentWorldApp;
  const ws = app?.getWorldState?.();
  const agents = ws?.agents || {};
  const avatars = ws?.avatars || {};
  const list = Object.values(agents).map(a => ({
    id: a.id, name: a.name, status: a.status,
    tool: a.tool ? { name: a.tool.name, inputPreview: a.tool.inputPreview } : null,
    repoLabel: a.repoLabel || null,
    gitBranch: a.gitBranch, cwd: a.cwd,
    lastAssistantSnippet: a.lastAssistantSnippet ? a.lastAssistantSnippet.slice(0, 60) : null,
    bubble: avatars[a.id]?.bubbleText || null
  }));
  return {
    status: document.getElementById('connection-status')?.textContent,
    agentCount: list.length,
    agents: list
  };
});
console.log('[probe] state:', JSON.stringify(state, null, 2));
console.log('[probe] 404 responses (first 8):', http404s.slice(0, 8));

const clickTarget = await page.evaluate(() => {
  const ws = window.__agentWorldApp?.getWorldState?.();
  const canvas = document.querySelector('canvas');
  if (!canvas || !ws) return null;
  const aif = Object.values(ws.agents || {}).find(a => a.name === 'aif');
  const target = aif || Object.values(ws.agents || {})[0];
  if (!target) return null;
  canvas.dispatchEvent(new CustomEvent('agent-selected', {
    bubbles: true,
    detail: { sessionId: target.id, avatar: target }
  }));
  return { id: target.id, name: target.name };
});
console.log('[probe] dispatched agent-selected:', clickTarget);

await page.waitForTimeout(800);
const sidebar = await page.evaluate(() => {
  const el = document.getElementById('session-detail-panel');
  return {
    display: el ? getComputedStyle(el).display : null,
    text: el?.innerText?.slice(0, 600)
  };
});
console.log('[probe] sidebar:', JSON.stringify(sidebar, null, 2));

await page.keyboard.press('t');
await page.waitForTimeout(2500);
const tui = await page.evaluate(() => {
  const el = document.getElementById('tui-overlay');
  return {
    display: el ? getComputedStyle(el).display : null,
    entryCount: document.querySelectorAll('.tui-entry').length
  };
});
console.log('[probe] tui (aif transcript):', JSON.stringify(tui, null, 2));

// Switch to Live mode.
await page.evaluate(() => {
  const btns = [...document.querySelectorAll('#tui-container button')];
  const liveBtn = btns.find(b => /Live/.test(b.textContent));
  liveBtn?.click();
});
// The new bilingual confirm modal is a DOM dialog (not window.confirm),
// so page.on('dialog') doesn't fire. Click "Open Live" to proceed.
await page.waitForTimeout(400);
await page.evaluate(() => {
  const ok = document.querySelector('button[data-action="ok"]');
  if (ok) ok.click();
});
await page.waitForTimeout(3500);
const live = await page.evaluate(() => {
  const overlay = document.getElementById('tui-overlay');
  const host = document.querySelector('#tui-container > div[style*="0a0e1a"]');
  const xtermNode = document.querySelector('.xterm');
  return {
    overlayVisible: overlay ? getComputedStyle(overlay).display : null,
    hostDisplay: host ? getComputedStyle(host).display : null,
    xtermPresent: Boolean(xtermNode),
    bodyText: document.querySelector('.xterm-rows')?.innerText?.slice(0, 500)
  };
});
console.log('[probe] live (aif):', JSON.stringify(live, null, 2));
await page.screenshot({ path: '/tmp/probe-live.png', fullPage: false });

// Close TUI, then test a session WITHOUT claude-control hooks (fingerbell).
await page.keyboard.press('Escape');
await page.waitForTimeout(400);

const finger = await page.evaluate(() => {
  const ws = window.__agentWorldApp?.getWorldState?.();
  const canvas = document.querySelector('canvas');
  const target = Object.values(ws?.agents || {}).find(a => a.name === 'fingerbell');
  if (!target || !canvas) return null;
  canvas.dispatchEvent(new CustomEvent('agent-selected', {
    bubbles: true,
    detail: { sessionId: target.id, avatar: target }
  }));
  return { id: target.id, name: target.name, gitBranch: target.gitBranch };
});
console.log('[probe] dispatched fingerbell-selected:', finger);
await page.waitForTimeout(600);
await page.keyboard.press('t');
await page.waitForTimeout(2500);
const fingerTui = await page.evaluate(() => {
  const el = document.getElementById('tui-overlay');
  return {
    display: el ? getComputedStyle(el).display : null,
    chip: document.querySelector('#tui-container span:nth-of-type(2)')?.innerText,
    entryCount: document.querySelectorAll('.tui-entry').length
  };
});
console.log('[probe] tui (fingerbell — no hooks):', JSON.stringify(fingerTui, null, 2));

console.log('---');
console.log('[probe] pageErrors:', pageErrors);
console.log('[probe] requestFailures:', failures);
console.log('[probe] console issues (first 10):');
for (const e of consoleIssues.slice(0, 10)) console.log(' ', e.type, '::', e.text.slice(0, 240));

await page.screenshot({ path: '/tmp/probe-final.png', fullPage: false });
console.log('[probe] saved /tmp/probe-final.png');
await browser.close();
