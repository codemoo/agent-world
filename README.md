# Agent World

Agent World is a visualization layer for multi‑agent systems. It connects to an underlying orchestration platform (such as [Paperclip](https://paperclipai.net)) and renders the behaviour of your agents as a living, breathing world.

## Project structure

This repository is organised into several packages:

- **server** – a lightweight Node/Express process that ingests events from your agent runtime (e.g. Paperclip) and maintains an in‑memory world state. It also exposes a WebSocket endpoint to broadcast state updates to connected clients.
- **adapter** – code responsible for translating your specific agent platform’s events into the normalised format used by Agent World. A `paperclipAdapter.js` is included as a starting point. Additional adapters (e.g. for OpenClaw, Claude Code) can be added here later.
- **frontend** – a browser Canvas client that draws terrain, props, buildings, and walking avatars on top of the 25x25 world grid. It supports PixyMoon sprite loading (with fallback rendering) and receives live updates over WebSockets.
- **assets/pixymoon** – a placeholder for your purchased PixyMoon tile set and sprite assets. These files are not tracked in git; see below.

## Getting started

1. Purchase the **2D Topdown Cute RPG World** pack from PixyMoon (or another compatible tile set).
2. Extract the entire **Cute RPG World** directory into `assets/pixymoon/`. Your tile sheet images should live at `assets/pixymoon/Cute RPG World/...`.
3. Install dependencies and start the server:

```bash
cd <repo-root>
npm install
AGENT_WORLD_API_TOKEN=<strong-token> node server/index.js
```

4. Open another terminal and serve the repository root (so `/assets/...` is reachable):

```bash
python3 -m http.server 4173 --directory .
```

5. Open `http://127.0.0.1:4173/frontend/` in your browser.

The frontend connects to `ws://localhost:3000` and `http://localhost:3000` by default.
If needed, override ports with query params:

- `?apiPort=3100`
- `?wsPort=3100`
- `?assetRoot=/assets/pixymoon/Cute%20RPG%20World` (default)

인증 토큰은 기본적으로 URL 쿼리에서 읽지 않습니다. `frontend/index.html`에서 런타임 설정 객체로 전달하세요:

```html
<script>
  window.__AGENT_WORLD_RUNTIME__ = {
    environment: 'production',
    authToken: '<strong-token>'
  };
</script>
```

개발 환경에서만 명시 플래그를 켜면 `?authToken=`/`?token=` 쿼리 토큰 입력을 임시 허용할 수 있습니다.

### Browser render checkpoints (T2 handoff)

- Terrain, props, buildings, avatars are rendered in separate layers.
- Avatars animate walking frames while moving; when working they stop and show a speech bubble.
- If sprite files are missing/unmatched, deterministic fallback shapes are rendered instead of a blank screen.

### Optional asset manifest

If your PixyMoon file names differ, add `asset-manifest.json` under `assets/pixymoon/Cute RPG World/` and map sprite keys to file+frame definitions.

```json
{
  "assetRoot": "/assets/pixymoon/Cute RPG World",
  "sprites": [
    {
      "key": "terrain.grassA",
      "url": "Cute RPG World/Tilesets/Outside_A2.png",
      "frame": { "mode": "grid", "columns": 8, "rows": 6, "column": 0, "row": 0 }
    },
    {
      "key": "avatar.walk.down.0",
      "url": "Cute RPG World/Characters/Actor/Actor 01.png",
      "frame": { "mode": "grid", "columns": 3, "rows": 4, "column": 0, "row": 0 }
    }
  ]
}
```

### Security defaults

- API/WS 인증은 기본 활성화이며 `AGENT_WORLD_API_TOKEN`이 필수입니다.
- `AGENT_WORLD_API_TOKEN`은 시작 시 trim 정규화되며, 공백만 입력되면 서버가 부팅을 거부합니다.
- `/events`, `/state`, `/sync/paperclip`, `/auth/ws-ticket`는 Bearer 토큰이 필요합니다.
- WebSocket 연결은 장기 토큰 대신 `POST /auth/ws-ticket`로 발급한 단기 1회성 `?ticket=`만 허용합니다.
- CORS는 same-origin 기본 정책이며, 교차 출처 허용이 필요하면 allowlist를 명시해야 합니다.
- 프론트 런타임 기본 정책: `production`에서는 `?authToken=`/`?token=` 입력을 인증 경로에서 사용하지 않습니다.
- 개발 모드(`environment: 'development'`)에서만 `allowDevQueryToken: true`를 명시했을 때 쿼리 토큰 입력을 허용합니다.
- 기본 DoS 완화 정책:
  - JSON body limit: `256kb`
  - fixed-window rate limit: `120 req / 60s` (경로·클라이언트 기준)
  - 이벤트 배치 상한: `100`
  - 상태 저장소 상한: agents `500`, runs `2000`, tasks `10000`
- 환경변수로 조정 가능합니다:
  - `AGENT_WORLD_RATE_LIMIT_WINDOW_MS`
  - `AGENT_WORLD_RATE_LIMIT_MAX_REQUESTS`
  - `AGENT_WORLD_MAX_EVENT_BATCH_SIZE`
  - `AGENT_WORLD_MAX_STATE_AGENTS`
  - `AGENT_WORLD_MAX_STATE_RUNS`
  - `AGENT_WORLD_MAX_STATE_TASKS`
  - `AGENT_WORLD_WS_TICKET_TTL_MS`
  - `AGENT_WORLD_MAX_WS_TICKET_ENTRIES`
  - `AGENT_WORLD_CORS_ALLOWED_ORIGINS` (comma-separated, 예: `https://app.example.com,https://admin.example.com`)

## Optional Paperclip polling sync

The server can poll local Paperclip `inbox-lite` and normalize it into world events.

```bash
PAPERCLIP_API_URL=http://127.0.0.1:3100 \
PAPERCLIP_API_KEY=<token> \
PAPERCLIP_SYNC_INTERVAL_MS=5000 \
node server/index.js
```

You can also trigger sync manually:

```bash
curl -X POST http://127.0.0.1:3000/sync/paperclip \
  -H 'authorization: Bearer <strong-token>' \
  -H 'content-type: application/json' \
  -d '{}'
```

## Event API and tests

- Event ingestion contract: `server/EVENTS.md`
- T0 functional scope: `docs/T0-functional-scope.md`
- T0 non-functional requirements: `docs/T0-nonfunctional-requirements.md`
- T0 temporary backlog: `docs/T0-temp-backlog.md`
- Quality gate plan: `test/TEST_PLAN.md`
- Install dependencies and run regression guards:

```bash
npm install
npm run test:smoke
```

`npm run test:e2e:browser`는 Chromium 실행 파일이 없는 환경에서 자동으로 `npx playwright install chromium`를 수행한 뒤 테스트를 실행합니다.

### Playwright 캐시/오프라인 운영 가드

- 브라우저 캐시 기본 경로: `~/.cache/agent-world-playwright`
- 경로 표준화: `PLAYWRIGHT_BROWSERS_PATH`를 지정하지 않으면 자동으로 위 기본 경로를 사용합니다.
- 네트워크 모드 제어: `AGENT_WORLD_PLAYWRIGHT_NETWORK_MODE`
  - `auto`(기본): 캐시 miss 시 설치 시도
  - `online`: 캐시 miss 시 설치 강제
  - `offline`: 캐시 miss 시 설치 금지 + 즉시 실패(`PLAYWRIGHT_CACHE_MISSING_OFFLINE`)

사전 캐시 준비(온라인 환경 1회):

```bash
PLAYWRIGHT_BROWSERS_PATH=~/.cache/agent-world-playwright npx playwright install chromium
```

오프라인 게이트 점검:

```bash
AGENT_WORLD_PLAYWRIGHT_NETWORK_MODE=offline npm run test:e2e:browser
```

오프라인 GO/NO-GO 기준:

- GO: 오프라인 모드에서도 preflight 통과 + `test:e2e:browser` 성공
- NO-GO: preflight가 `PLAYWRIGHT_CACHE_MISSING_OFFLINE` 또는 설치 실패 코드로 종료

## PixyMoon assets

The files under `assets/pixymoon/` are intentionally ignored by git. You must purchase the asset pack yourself and place the files here. See `assets/pixymoon/README.md` for details.

## License

This project is provided under the MIT License. You are responsible for ensuring you have the appropriate rights to any third‑party assets used (such as tile sets and sprites).
