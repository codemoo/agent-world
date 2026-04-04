# QA Quality Gate Plan

## 목표

- `/events` 입력 검증, 상태 반영, WebSocket 브로드캐스트를 릴리스 전 자동으로 검증합니다.
- 실패를 재현 가능한 커맨드 단위로 고정해 회귀를 조기에 차단합니다.

## 테스트 레벨과 범위

- Unit
  - 정규화/검증/상태 전이 함수의 순수 로직 + WS 티켓 저장소(만료/재사용) 가드
  - 파일: `test/paperclipAdapter.test.js`, `test/eventsPipeline.test.js`, `test/wsTicketStore.test.js`
- Request
  - HTTP 요청 계약(유효성 실패 처리, 원자성 보장, WS 티켓 발급 인증)
  - 파일: `test/eventsApi.request.test.js`
- Integration
  - `/events -> /state` 서버 경로 전체 반영 + WS 티켓 1회성/TTL 검증
  - 파일: `test/eventsApi.integration.test.js`
- E2E
  - WebSocket 클라이언트 입장에서 실시간 상태 푸시 검증(티켓 기반 접속)
  - 프론트 실브라우저 부트(main.js) 상태 전이/렌더/재연결 + 티켓 재발급 검증
  - 파일: `test/eventsApi.e2e.test.js`, `test/frontendBoot.playwright.spec.js`
- Smoke
  - 위 모든 레벨을 직렬 실행하여 배포 게이트로 사용
  - 커맨드: `npm run test:smoke`

## 실행 커맨드

```bash
npm install
npm run test:unit
npm run test:request
npm run test:integration
npm run test:e2e
npm run test:smoke
```

`npm run test:e2e:browser` 경로에서 Chromium 실행 파일이 없으면 `npx playwright install chromium`를 자동 수행합니다.

브라우저 캐시/오프라인 사전점검:

```bash
# 온라인 1회 캐시 준비
PLAYWRIGHT_BROWSERS_PATH=~/.cache/agent-world-playwright npx playwright install chromium

# 오프라인/제한망 검증
AGENT_WORLD_PLAYWRIGHT_NETWORK_MODE=offline npm run test:e2e:browser
```

## GO/NO-GO 기준

- GO
  - `npm run test:smoke` 전부 성공
  - 신규 실패 없음
  - 오프라인 모드(`AGENT_WORLD_PLAYWRIGHT_NETWORK_MODE=offline`)에서 preflight와 브라우저 E2E가 통과
- NO-GO
  - Request/Integration/E2E 중 하나라도 실패
  - `/events` 계약 위반 또는 WebSocket 미동작
  - 오프라인 캐시 miss(`PLAYWRIGHT_CACHE_MISSING_OFFLINE`) 또는 설치 실패(`PLAYWRIGHT_CHROMIUM_INSTALL_FAILED`)
