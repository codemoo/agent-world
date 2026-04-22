# Agent World

A spatial, RPG-style visualizer for **live Claude Code CLI sessions on your
Mac**. Every running `claude` process becomes a sprite walking a 30×30
village; every repo becomes a building; permission prompts line up as a
literal queue at the info desk; tool invocations rain emoji overhead.

![Agent World live demo](demo/demo-world.gif)

Inspired by **Park et al., "Generative Agents: Interactive Simulacra of
Human Behavior"** ([paper](https://arxiv.org/abs/2304.03442) ·
[original repo](https://github.com/joonspk-research/generative_agents))
and by [**claude-control**](https://github.com/sverrirsig/claude-control)
(from which the discovery model — `ps` + `lsof` + hook files, no database
— is borrowed).

![status: alpha](https://img.shields.io/badge/status-alpha-yellow)

---

## What you get

### The world

- **Zero-dep start** — `npm install && npm start` and you have a working
  village. No paid asset pack required; optional PixyMoon upgrade path.
- **Live session map** — every `claude` process on this Mac renders as a
  sprite with smooth sub-tile interpolation. Repo = building; cwd = desk.
  Walks to exit and fades on `SessionEnd`.
- **Status-driven routing** — `Working` → sit at a desk; `Waiting`
  (permission prompt) → join the info-desk queue with a pulsing amber
  halo; `Errored` → wander to the tavern; `Idle` → wander near your
  building; `Finished` → walk to exit + fade.
- **Tool icons overhead** — `Bash 🖥 · Edit/Write ✏ · Read 📖 · Grep 🔎 ·
  Task 👥 · WebFetch 🌐`. A floating **pop emote** animates on every new
  tool invocation; the steady icon cross-fades underneath.
- **Productivity burst glow** — when a session fires ≥3 Edit/Write calls
  within 10 s, its shadow turns warm gold and a soft outer ring glows
  for 4 s. Makes "Claude just wrote 8 files" visually obvious.
- **Status-transition poof** — short white radial burst on meaningful
  changes (Waiting→Working, entering/leaving Errored, Idle→Working, →Finished).
- **Animated "thinking" dots** when the session is Working but has no
  tool active. Cycles `.` `..` `...` in the activity bubble — no extra layer.
- **Git branch → hat hue** — sessions on the same branch cluster visually.
- **Day / Night / Live clock** — sky overlay interpolates across real
  time. At night, **warm window glow** spills from every building
  interior (30 % flicker like wood lamps).

![Day / Night](demo/world-day.gif) ![Night](demo/world-night.gif)

### Watching + interacting

![UX overview](demo/demo-ux.gif)

- **DOM agent roster** (top-right) — clickable rows with a working
  spinner on Working sessions. Hover highlights; selection follows
  sprite + hotkey selection.
- **Sprite / building hover tooltip** — cursor-following DOM tooltip
  with status, tool, cwd, branch (for sprites) or active sessions
  inside (for buildings). Shares hit-test radius with click so the
  highlight ring and click target never diverge.
- **DOM session detail panel** — click a sprite or roster row; panel
  shows repo, branch, model, tool, last assistant message, plus buttons
  to open the transcript / Live PTY and focus the host terminal.
- **In-browser TUI** — the panel's "💬 View conversation" opens a
  full-screen xterm view. `📜 Transcript` tab tails the JSONL in 1.5 s
  polls; `🎛 Live` tab attaches a live PTY (bilingual non-blocking
  confirm before spawning a parallel `claude --resume`).
- **Event log** (bottom-left, collapsible) — streams session starts,
  status changes, tool invocations, session ends. Click a row to
  select that agent. Last 80 entries, relative timestamps (`now`,
  `12s`, `3m`).
- **Timeline scrubber** (bottom-center) — 1 Hz client-side snapshot
  ring buffer (~60 s window). Drag the thumb to freeze the world on a
  past frame, release or press Space to return to live. Shows absolute
  clock + `● LIVE` / `⏸ PAUSED` badge.
- **Permission queue as a literal line** at the plaza — depth
  visualizes approval debt.
- **Help overlay** (`?`) — bilingual (en + ko) shortcut legend. Button
  top-right, `?` or `Shift+/` toggles. ESC to close.

### Keyboard

| Key | Action |
|-----|--------|
| `?` | Open / close shortcut legend |
| `1`–`9` | Focus session #N |
| `0` | Close session panel |
| `Esc` | Close panels + modals |
| `T` | Open transcript viewer (session selected) |
| `L` | Switch to Live PTY tab |
| `N` | Toggle persistent name-tags (names always show on hover / selection) |
| `←` `→` | Scrub timeline ±1 s |
| `Space` | Play / pause timeline |
| `E` | Toggle world editor |
| `Ctrl-Z` / `Ctrl-S` / arrows / `F` | Editor undo / save / nudge / flip |

---

## Quick start

```bash
# 1) install deps
npm install

# 2) start the server
export AGENT_WORLD_API_TOKEN=$(openssl rand -hex 16)
npm start

# 3) open http://localhost:3102
```

No assets required — runs in **minimal mode** with procedural sprites
(fallback furniture, trees, flowers, hat-coloured avatars). A banner
in the bottom-right explains how to upgrade.

![Minimal mode demo](demo/demo-minimal.gif)

### Optional: upgrade to the PixyMoon look

Buy **PixyMoon Cute RPG World** from
[pixymoon.itch.io](https://pixymoon.itch.io/cute-rpg-world) and drop
the extracted pack under `assets/pixymoon/Cute RPG World/`. The
server picks it up automatically on the next reload — minimal mode
banner disappears, the Assets Manager and World Editor light up, and
all 50+ furniture sprites render as pixel art.

The PixyMoon pack is **not included** in this repo (per their license
you must purchase your own copy). See [`assets/pixymoon/README.md`](assets/pixymoon/README.md).

The server reads:

- `~/.claude/sessions/<pid>.json` — live session metadata
- `~/.claude-control/events/<pid>.json` — hook events if claude-control is installed
- `~/.claude/plugins/agent-world/events/<pid>.jsonl` — hook events from our own plugin (opt-in)
- `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl` — transcript tails on demand

If you don't have claude-control, install our hooks (additive, doesn't
touch `~/.claude/settings.json`):

```bash
npm run install-hooks            # dry-run, prints the plan
npm run install-hooks -- --apply # actually write plugin + hook script
```

---

## Routes

| Method / path | Purpose |
| --- | --- |
| `GET /state` | Full world state (authoritative snapshot on WS connect) |
| `GET /healthz` | Snapshot: sessionsObserved, buildings/tents, uptime, memMB |
| `GET /api/sessions` | List of live Claude sessions |
| `GET /api/sessions/:sessionId` | Per-session detail + transcript preview |
| `POST /api/sessions/:sessionId/focus` | Focus the terminal tab (tmux / iTerm / Terminal.app) |
| `GET /api/world/layout` · `PUT /api/world/layout` | World layout edits |
| `WS /` | State snapshot + debounced `patch` messages (JSON Merge Patch) |
| `POST /sync/paperclip*` | `410 Gone` — see `legacy/paperclip/README.md` |

---

## Project structure

| Package | Purpose |
| --- | --- |
| `adapter/worldModel.js` | Pure world geometry (buildings, stations, tiles). Shared. |
| `adapter/claudeAdapter.js` | Session snapshot → world-agent state + intent-tagged destination. |
| `server/claudeSnapshotter.js` | 1 Hz poller: `ps` + `lsof` + hook events + session JSON. |
| `server/sessionStatus.js` | Pure classifier (hook events + mtime + CPU → status). |
| `server/repoRoot.js` | `git rev-parse --show-toplevel` cache, worktree-aware. |
| `server/transcriptPreview.js` | On-demand JSONL tail reader (no permanent fd). |
| `server/buildingAssignments.js` | Repo → building mapping, persisted. |
| `server/stateDiffBroadcast.js` | Debounced WS broadcast + JSON Merge Patch. |
| `server/terminalFocus.js` | Focus terminal by pid (tmux, iTerm, Terminal.app). |
| `server/ptyServer.js` | Live PTY manager for in-browser Claude sessions (spawns `claude --resume` only; cwd-guarded, one attach per session). |
| `server/hookPluginInstaller.js` | Additive hook plugin under `~/.claude/plugins/agent-world/`. |
| `frontend/avatarRuntime.mjs` | Client-side intent-aware A* pathing, sub-tile lerp, tool-pop / poof / productivity-burst visual channels. |
| `frontend/fallbackSprites.js` | Procedural furniture / flora / avatar renderers used when the PixyMoon pack isn't installed. |
| `frontend/components/AssetsStatusBanner.js` | "Minimal mode" banner + gating for Assets link + Editor toggle when sprites are missing. |
| `frontend/components/WorldMap.js` | Canvas renderer + hover hit-test + scrub snapshot support. |
| `frontend/components/SessionDetailPanel.js` | DOM sidebar for clicked agent. |
| `frontend/components/TerminalTuiView.js` | Full-screen transcript + Live PTY viewer (xterm.js). |
| `frontend/components/AgentRoster.js` | DOM roster of live sessions — clickable, spinner on Working. |
| `frontend/components/HelpOverlay.js` | "?" button + bilingual shortcut legend. |
| `frontend/components/HistoryBuffer.js` | 1 Hz client-side snapshot ring (60 s) + derived event stream. |
| `frontend/components/EventLog.js` | Collapsible bottom-left panel streaming history events. |
| `frontend/components/TimelineScrubber.js` | Bottom-center draggable scrubber backed by HistoryBuffer. |
| `frontend/vendor/` | Vendored `@xterm/xterm` + `addon-fit` (no CDN dependency). |
| `legacy/paperclip/` | Archived Paperclip integration (see its README). |

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

### Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3102` | HTTP/WS listen port |
| `AGENT_WORLD_API_TOKEN` | _required_ | Bearer token for auth-protected endpoints |
| `AGENT_WORLD_CORS_ALLOWED_ORIGINS` | (same-origin only) | Comma-separated allowlist |
| `AGENT_WORLD_RATE_LIMIT_WINDOW_MS` | `60000` | Fixed-window rate-limit window |
| `AGENT_WORLD_RATE_LIMIT_MAX_REQUESTS` | `120` | Requests per client per window |
| `AGENT_WORLD_WS_TICKET_TTL_MS` | `15000` | WS ticket TTL |

### Behind a reverse proxy / tunnel (FRP, nginx, Cloudflare)

`app.set('trust proxy', true)` and WS heartbeats are built-in. WS URL is
derived from `window.location.origin`.

---

## Tests

```bash
npm run test:unit          # 95 tests — no network
npm run test:request       # 16 — request-level HTTP/WS
npm run test:integration   # 13 — server / snapshotter / PTY
npm run test:e2e           # 4  — playwright smoke + browser assertions
npm run test:smoke         # everything above (128 total)
npm run test:legacy        # 27 — archived Paperclip tests (gated)
```

### Headless probes

Two helper probes verify the UI end-to-end against a running server
(defaults to `PORT=3199`, `AGENT_WORLD_API_TOKEN=smoke`):

```bash
PLAYWRIGHT_BROWSERS_PATH=~/.cache/agent-world-playwright \
  PORT=3199 AGENT_WORLD_API_TOKEN=smoke \
  node test/helpers/browser-probe.mjs        # world + transcript + Live PTY

PLAYWRIGHT_BROWSERS_PATH=~/.cache/agent-world-playwright \
  PORT=3199 AGENT_WORLD_API_TOKEN=smoke \
  node test/helpers/browser-probe-ux.mjs     # roster + hover + help + log + scrubber
```

### Demo capture

GIFs in `demo/` are generated by `scripts/capture-frames.mjs`. Requires
`ffmpeg` on `PATH` (via Homebrew on macOS: `brew install ffmpeg`).

```bash
PATH="/opt/homebrew/bin:$PATH" \
  node scripts/capture-frames.mjs world http://127.0.0.1:3102
node scripts/capture-frames.mjs editor http://127.0.0.1:3102
node scripts/capture-frames.mjs ux     http://127.0.0.1:3102
node scripts/capture-frames.mjs assets http://127.0.0.1:3102
```

---

## Development daemon (macOS launchd)

```bash
npm run daemon:install
npm run daemon:restart
npm run daemon:status
npm run daemon:logs
npm run daemon:uninstall
```

Logs: `logs/agent-world.{stdout,stderr}.log`.

---

## Credits

### Assets — PixyMoon (optional)

When available, the tile sets and character sprites come from the
**2D Topdown Cute RPG World** pack by
[**PixyMoon**](https://pixymoon.itch.io/cute-rpg-world). Assets are
**not** included in this repository; buy the pack and drop it under
`assets/pixymoon/Cute RPG World/` (see
[`assets/pixymoon/README.md`](assets/pixymoon/README.md)).

Without the pack, `frontend/fallbackSprites.js` renders procedural
substitutes for furniture, flora, and avatars so the app still runs.

Per the PixyMoon license: usable in personal and commercial projects;
modification allowed; credits to PixyMoon required; cannot be resold.

### Inspiration

- Park et al., **"Generative Agents: Interactive Simulacra of Human
  Behavior"** — [arXiv:2304.03442](https://arxiv.org/abs/2304.03442),
  [code](https://github.com/joonspk-research/generative_agents).
- [**claude-control**](https://github.com/sverrirsig/claude-control) —
  session discovery model (`ps`, `lsof`, hook files, no database).

---

## License

Agent World's own code is MIT (see `LICENSE`). Third-party assets retain
their original licenses; you are responsible for complying with them.
