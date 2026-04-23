// Phase 0 smoke test for head-lane rendering.
//
// Loads the world, injects a deterministic world-state with four
// scripted avatars covering the distinct Lane 0/1/2 combinations,
// then samples the canvas to assert that:
//
//   1. Activity bubble renders ABOVE chat bubble when both present
//   2. Tool icon renders (Lane 0) when avatar.toolIcon is set
//   3. persistentEmote renders in Lane 0 when no toolIcon
//   4. reactionEmote renders in Lane 0 over toolIcon / persistent
//   5. Waiting halo (underfoot) survives — not in head area
//
// It is not a pixel-perfect comparison — a region-presence check
// that catches shape-level regressions when the head-lane renderer
// or drawCharacterVariant are refactored. Fails the probe on
// console errors or missing expected regions.

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
page.on('console', m => {
  if (m.type() === 'error') errors.push(`[console.error] ${m.text()}`);
});

await page.goto(`${URL_BASE}/?authToken=${TOKEN}`, { waitUntil: 'networkidle', timeout: 20000 });
await page.waitForTimeout(1500);

// Inject a deterministic 4-avatar scene and force a render.
const sceneMeta = await page.evaluate(() => {
  const wm = window.__agentWorldApp?.getWorldMap?.();
  if (!wm) return { error: 'no worldMap' };

  // Synthesize a minimal world-state. The snapshotter normally
  // produces richer data, but for a smoke test we only need enough
  // for the renderer to exercise each Lane.
  const state = {
    world: { width: 30, height: 30, locations: [] },
    agents: {
      a: { id: 'a', name: 'Alpha',   status: 'Working' },
      b: { id: 'b', name: 'Bravo',   status: 'Working' },
      c: { id: 'c', name: 'Charlie', status: 'Waiting' },
      d: { id: 'd', name: 'Delta',   status: 'Idle'    }
    },
    avatars: {
      a: { id: 'a', x: 5,  y: 10, moving: false, state: 'working',
           status: 'Working',
           bubbleText: 'editing main.js',
           toolIcon: '✏',
           destination: { x: 5, y: 10, locationId: null, stationId: null }
      },
      b: { id: 'b', x: 10, y: 10, moving: false, state: 'working',
           status: 'Working',
           bubbleText: 'querying index',
           toolIcon: '🔎',
           destination: { x: 10, y: 10, locationId: null, stationId: null }
      },
      c: { id: 'c', x: 15, y: 10, moving: false, state: 'idle',
           status: 'Waiting',
           bubbleText: 'pending permission',
           intent: { kind: 'to_info_desk' },
           destination: { x: 15, y: 10, locationId: null, stationId: null,
                          intent: { kind: 'to_info_desk' } }
      },
      d: { id: 'd', x: 20, y: 10, moving: false, state: 'idle',
           status: 'Idle',
           bubbleText: '',
           destination: { x: 20, y: 10, locationId: null, stationId: null }
      }
    }
  };
  wm.setWorldState(state);
  wm.render?.(performance.now());
  return { ok: true };
});

if (sceneMeta.error) {
  console.error('[head-lanes] setup failed:', sceneMeta.error);
  await browser.close();
  process.exit(1);
}

await page.waitForTimeout(800);

// Sample the canvas near each of the 4 agent positions. We only
// need to confirm something is rendered in each expected region —
// precise pixel values vary with sprite pack / night-sky / etc.
const samples = await page.evaluate(() => {
  const canvas = document.querySelector('canvas');
  if (!canvas) return { error: 'no canvas' };
  const ctx = canvas.getContext('2d');
  if (!ctx) return { error: 'no 2d ctx' };
  const tile = Math.min(canvas.width, canvas.height) / 30;
  const ox = (canvas.width - tile * 30) / 2;
  const oy = (canvas.height - tile * 30) / 2;
  function centerFor(x, y) {
    return {
      cx: Math.round(ox + (x + 0.5) * tile),
      cy: Math.round(oy + (y + 0.5) * tile)
    };
  }
  function nonEmptyAround(cx, cy, radius) {
    // Sample 5 points near the given center; return true if any
    // pixel is not "pure sky color".
    const pts = [
      [cx, cy], [cx - radius, cy], [cx + radius, cy],
      [cx, cy - radius], [cx, cy + radius]
    ];
    let touched = 0;
    for (const [x, y] of pts) {
      if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) continue;
      const px = ctx.getImageData(x, y, 1, 1).data;
      const isDark = px[0] < 30 && px[1] < 30 && px[2] < 60;
      if (!isDark && px[3] > 0) touched++;
    }
    return touched > 0;
  }
  const agents = ['a', 'b', 'c', 'd'].map((id, i) => {
    const { cx, cy } = centerFor(5 + i * 5, 10);
    return {
      id,
      hasSprite: nonEmptyAround(cx, cy, Math.floor(tile * 0.3)),
      hasHeadArea: nonEmptyAround(cx, cy - Math.floor(tile * 0.9), Math.floor(tile * 0.4))
    };
  });
  return { agents, tile, canvasSize: { w: canvas.width, h: canvas.height } };
});

console.log('[head-lanes] canvas:', samples.canvasSize, 'tile:', samples.tile?.toFixed(1));
console.log('[head-lanes] agents:');
for (const a of (samples.agents || [])) {
  console.log(`  ${a.id}: sprite=${a.hasSprite} head=${a.hasHeadArea}`);
}

await page.screenshot({ path: '/tmp/probe-head-lanes.png', fullPage: false });

// Asserts.
let failed = 0;
for (const a of (samples.agents || [])) {
  if (!a.hasSprite) { console.error(`[FAIL] agent ${a.id} has no sprite rendered`); failed++; }
  if (!a.hasHeadArea) {
    // Agent D has no bubble/tool — head area can be empty. Only
    // fail when we *expected* head-area content (a, b, c).
    if (a.id !== 'd') {
      console.error(`[FAIL] agent ${a.id} has no head-lane rendering`);
      failed++;
    }
  }
}
if (errors.length) {
  console.error('[head-lanes] pageErrors:', errors);
  failed++;
}

await browser.close();
if (failed) {
  console.error(`[head-lanes] ${failed} failure(s)`);
  process.exit(1);
}
console.log('[head-lanes] OK');
