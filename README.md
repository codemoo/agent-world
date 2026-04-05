# Agent World

A visualization layer for multi-agent systems. Agent World connects to an
orchestration platform (such as
[Paperclip](https://paperclipai.net)) and renders agent behaviour as a
living RPG-style world — characters walk between buildings, station
themselves at desks / fishing spots / mining quarries, and carry the
labels of whatever task they are currently working on.

Inspired by **Park et al., "Generative Agents: Interactive Simulacra of
Human Behavior"** ([paper](https://arxiv.org/abs/2304.03442) ·
[original repo](https://github.com/joonspk-research/generative_agents)).

![status: early](https://img.shields.io/badge/status-early-orange)

---

## Features

- **Live world map** — canvas-rendered 30×30 tile grid with buildings,
  trees, stations and animated avatars.
- **Paperclip adapter** — translates task / run / tool events into
  on-world activity. Agents move to indoor work desks while a task is
  in flight and to outdoor rest spots (pond fishing, shady naps, garden
  strolls) when idle.
- **Client-side routing** — A\* pathfinding with per-agent jitter and
  soft-blocking so agents route around each other instead of stacking
  on the same tile.
- **Built-in world editor** — in-browser panel (toggle with `E`) to
  place, move, flip or delete trees and stations. Edits are persisted
  to `world-layout.json` via a REST API and reflected live.
- **Asset manager UI** — `/assets-manager` to browse the sprite sheets
  and curate per-cell props + groups.
- **Mobile friendly** — responsive tile sizing, full-width slide-over
  editor panel, touch drag, keyboard + tap parity.

---

## Quick start

```bash
# 1) install deps
npm install

# 2) drop your PixyMoon asset pack in place (see Credits section below)
#    assets/pixymoon/Cute RPG World/...

# 3) start the server
export AGENT_WORLD_API_TOKEN=$(openssl rand -hex 16)
npm start

# 4) open http://localhost:3102 in a browser
```

The server serves both the frontend and the API on the same port
(default `3102`). Use `PORT=…` to override.

### Try the editor

1. Click **Edit (E)** in the top-right (or press `E`).
2. Pick a category tab (trees / indoor stations / outdoor stations),
   click a sprite thumbnail, then click on the map to place it.
3. Click an existing item to select it. Drag to move. Use `↔` / `↕` to
   flip, `🗑` to delete, arrow keys to nudge.
4. `Ctrl+Z` / `Ctrl+Shift+Z` undo/redo. `Ctrl+S` saves to disk.

---

## Project structure

| Package | Purpose |
| --- | --- |
| `server/` | Express + `ws` server. Hosts the API, serves the frontend, persists `world-layout.json`, polls Paperclip, exposes the asset manager. |
| `adapter/` | Translates external agent events (Paperclip today) into the internal world model. Owns the building / station / outdoor-spot definitions. |
| `frontend/` | Browser canvas client. Renders tiles, buildings, avatars, speech bubbles, and hosts the world editor. |
| `test/` | Node test-runner + Playwright suites for the event API, avatar runtime, editor round-trips, and frontend smoke. |
| `assets/pixymoon/` | PixyMoon asset pack drop zone (not committed — see Credits). |

---

## Configuration

### Authentication

API/WebSocket auth is required by default:

```bash
export AGENT_WORLD_API_TOKEN='<strong-token>'
```

The token is passed via `Authorization: Bearer …` for HTTP and issued as
a short-lived one-shot ticket for WebSocket upgrades
(`POST /auth/ws-ticket`, 15s TTL).

Pass the token to the frontend via runtime config (recommended) — the
server injects it automatically when serving `index.html`. For dev,
you can opt in to `?authToken=` query params:

```js
window.__AGENT_WORLD_RUNTIME__ = {
  environment: 'development',
  allowDevQueryToken: true,
  authToken: '<strong-token>'
};
```

### Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3102` | HTTP/WS listen port |
| `AGENT_WORLD_API_TOKEN` | _required_ | Bearer token for all auth-protected endpoints |
| `AGENT_WORLD_CORS_ALLOWED_ORIGINS` | (same-origin only) | Comma-separated allowlist |
| `AGENT_WORLD_RATE_LIMIT_WINDOW_MS` | `60000` | Fixed-window rate-limit window |
| `AGENT_WORLD_RATE_LIMIT_MAX_REQUESTS` | `120` | Requests per client per window |
| `AGENT_WORLD_MAX_EVENT_BATCH_SIZE` | `100` | Cap on `/events` batch size |
| `AGENT_WORLD_MAX_STATE_AGENTS` | `500` | Backpressure cap on tracked agents |
| `AGENT_WORLD_MAX_STATE_RUNS` | `2000` | Backpressure cap on tracked runs |
| `AGENT_WORLD_MAX_STATE_TASKS` | `10000` | Backpressure cap on tracked tasks |
| `AGENT_WORLD_WS_TICKET_TTL_MS` | `15000` | WS ticket TTL |
| `PAPERCLIP_API_URL` | — | Enable Paperclip polling |
| `PAPERCLIP_API_KEY` | — | Paperclip bearer token |
| `PAPERCLIP_SYNC_INTERVAL_MS` | `0` | Poll cadence (0 disables) |

### Behind a reverse proxy / tunnel (FRP, nginx, Cloudflare)

Agent World sets `app.set('trust proxy', true)` and honours
`X-Forwarded-Proto` when resolving same-origin. WebSocket heartbeats
(20s ping interval) keep long-lived connections alive through idle
timeouts. When accessed via a standard port the frontend derives the
WS URL from `window.location.origin` — no hard-coded `:3102`.

---

## Paperclip sync

Poll the local Paperclip `inbox-lite` and fold events into the world:

```bash
PAPERCLIP_API_URL=http://127.0.0.1:3100 \
PAPERCLIP_API_KEY='<token>' \
PAPERCLIP_SYNC_INTERVAL_MS=5000 \
npm start
```

Manual trigger:

```bash
curl -X POST http://127.0.0.1:3102/sync/paperclip \
  -H "Authorization: Bearer $AGENT_WORLD_API_TOKEN" \
  -H 'content-type: application/json' \
  -d '{}'
```

Event ingestion contract: [`server/EVENTS.md`](server/EVENTS.md).

---

## World layout editor

The editor stores its state in `world-layout.json` at the repo root.
On first boot the server seeds the file from the in-code defaults
(`adapter/paperclipAdapter.js`, `adapter/treeGenerator.js`). After
that the JSON is the source of truth.

- `GET  /api/world/layout` — returns the current layout
- `PUT  /api/world/layout` — replaces it (validated server-side)

Schema (version 1):

```jsonc
{
  "version": 1,
  "indoorStations":  [ { "id", "locationId", "kind": "work"|"rest",
                         "type", "dx", "dy", "label",
                         "flipX?", "flipY?" } ],
  "outdoorStations": [ { "id", "kind", "type", "x", "y",
                         "label", "activity",
                         "flipX?", "flipY?" } ],
  "trees":           [ { "x", "y", "type", "flipX?", "flipY?" } ]
}
```

---

## Tests

```bash
npm run test:unit          # node test runner, no network
npm run test:integration   # ws/http integration
npm run test:e2e           # incl. playwright smoke
npm run test:smoke         # everything above
```

Playwright cache preflight / offline gating:

```bash
# prime the browser cache once
PLAYWRIGHT_BROWSERS_PATH=~/.cache/agent-world-playwright \
  npx playwright install chromium

# verify offline operation
AGENT_WORLD_PLAYWRIGHT_NETWORK_MODE=offline npm run test:e2e:browser
```

---

## Development daemon (macOS launchd)

```bash
npm run daemon:install    # install + load the launchd plist
npm run daemon:restart    # kickstart after code changes
npm run daemon:status
npm run daemon:logs       # tail stdout+stderr
npm run daemon:uninstall
```

Logs are written to `logs/agent-world.{stdout,stderr}.log`.

---

## Credits

### Assets — PixyMoon

The tile sets and character sprites come from the
**2D Topdown Cute RPG World** pack by [**PixyMoon**](https://pixymoon.itch.io/)
([Twitter](https://twitter.com/_PixyMoon_)). Assets are **not** included
in this repository; you must purchase the pack yourself and drop it
under `assets/pixymoon/Cute RPG World/` (see
[`assets/pixymoon/README.md`](assets/pixymoon/README.md)).

Per the PixyMoon license:

- Usable in personal and commercial projects.
- Can be modified and edited to fit your project.
- **Credits to PixyMoon** required.
- Cannot be resold (even modified) and cannot be claimed as your own.

### Inspiration — Generative Agents

The agent-world metaphor (characters walking between locations, station
affordances, activity labels above each character) is directly inspired
by:

> Park, J. S., O'Brien, J. C., Cai, C. J., Morris, M. R., Liang, P.,
> & Bernstein, M. S. (2023). **Generative Agents: Interactive
> Simulacra of Human Behavior.** UIST '23.

- Paper: <https://arxiv.org/abs/2304.03442>
- Code: <https://github.com/joonspk-research/generative_agents>

This project borrows the _visual language_ of Smallville (tile map +
per-agent activity bubbles + building location signs). It does **not**
reimplement the generative memory / reflection / planning pipelines
from that paper — the cognition comes from whatever agent platform you
connect (e.g. Paperclip).

---

## License

Agent World's own code is released under the **MIT License** (see
`LICENSE`). Third-party assets retain their original licenses; you are
responsible for complying with them.
