// E2E verification for the permission roundtrip UI:
//   1. browser loads → hydrates existing pending requests via
//      GET /api/permissions/pending
//   2. fake hook POST triggers a NEW request → WS push fires toast
//   3. click Allow → POST decide → resolved event clears the toast

import { chromium } from '@playwright/test';

const TOKEN = process.env.AGENT_WORLD_API_TOKEN || 'smoke';
const PORT = process.env.PORT || 3199;
const URL_BASE = `http://127.0.0.1:${PORT}`;

async function postHook(body, timeoutMs = 20000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(`${URL_BASE}/api/hooks/permission-request`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  } finally {
    clearTimeout(t);
  }
}

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
await ctx.addInitScript((token) => {
  window.__AGENT_WORLD_RUNTIME__ = {
    environment: 'development', allowDevQueryToken: true, authToken: token
  };
  // Mute desktop notifications in probe — not relevant to the assertions.
  if (typeof Notification !== 'undefined') {
    // Notification is read-only in real browsers; we just don't grant
    // permission, so .requestPermission() is a no-op.
  }
}, TOKEN);

const page = await ctx.newPage();
const errors = [];
const warnings = [];
page.on('pageerror', e => errors.push(String(e)));
page.on('console', m => {
  const t = m.type();
  if (t === 'error' || t === 'warning') {
    warnings.push(`[${t}] ${m.text().slice(0, 200)}`);
  }
});

// Clear any leftover pending requests from prior probes so our
// click-Allow lands on the one WE created.
{
  const r = await fetch(`${URL_BASE}/api/permissions/pending`, {
    headers: { authorization: `Bearer ${TOKEN}` }
  });
  const payload = await r.json();
  for (const p of (payload.pending || [])) {
    await fetch(`${URL_BASE}/api/permissions/${p.requestId}/decide`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ decision: 'ask', reason: 'probe cleanup' })
    });
  }
}

await page.goto(`${URL_BASE}/?authToken=${TOKEN}`, { waitUntil: 'networkidle', timeout: 20000 });
await page.waitForTimeout(2500);

// Fire a permission request in the background (don't await — the hook
// will block waiting for the browser click). Catch the abort explicitly
// so the probe keeps running if the click doesn't land.
let hookResult = null;
const hookPromise = postHook({
  sessionId: 'probe-sess-alpha',
  tool: 'Bash',
  toolInput: { command: 'curl -s http://example.com | head -c 20' },
  cwd: '/tmp/probe'
}, 20000)
  .then(r => { hookResult = r; return r; })
  .catch(err => { hookResult = { error: String(err) }; });

// Wait for the toast to render.
await page.waitForTimeout(1500);
const toastState = await page.evaluate(() => {
  const stack = document.getElementById('permission-toast-stack');
  const rows = stack ? stack.querySelectorAll('.pt-toast') : [];
  return {
    rows: rows.length,
    title: rows[0]?.querySelector('.pt-title')?.innerText,
    cmd: rows[0]?.querySelector('.pt-cmd')?.innerText,
    session: rows[0]?.querySelector('.pt-session')?.innerText
  };
});
console.log('[perm] toast state:', JSON.stringify(toastState));

await page.screenshot({ path: '/tmp/probe-permission.png' });

// Click Allow on the first toast.
await page.evaluate(() => {
  const btn = document.querySelector('#permission-toast-stack .pt-btn-allow');
  if (btn) btn.click();
});

// Hook should resolve quickly now.
await hookPromise;
console.log('[perm] hook response:', JSON.stringify(hookResult));

// Wait for toast to animate out.
await page.waitForTimeout(700);
const afterState = await page.evaluate(() => {
  const rows = document.querySelectorAll('#permission-toast-stack .pt-toast');
  return { remaining: rows.length };
});
console.log('[perm] after allow:', JSON.stringify(afterState));

console.log('[errors]', errors);
console.log('[warnings]', warnings.slice(0, 5));
await browser.close();
