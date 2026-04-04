# Event Ingestion Contract

## 보안 게이트 (기본 활성화)

- 서버는 기본적으로 인증을 강제합니다.
- 필수 환경변수: `AGENT_WORLD_API_TOKEN`
- `AGENT_WORLD_API_TOKEN`은 trim 정규화되며, 공백 문자열은 유효하지 않습니다(부팅 실패).
- 보호 경로:
  - `POST /events` (write)
  - `GET /state` (read)
  - `POST /sync/paperclip` (write)
  - `POST /auth/ws-ticket` (write, WS 단기 티켓 발급)
  - `WS /` (read stream, `?ticket=` 1회성 티켓 필수)
- 프론트 런타임 기본 가드:
  - `production`에서는 URL 쿼리 `authToken/token` 입력을 인증 토큰으로 사용하지 않음
  - `development` + `allowDevQueryToken=true`에서만 쿼리 토큰 입력 허용
- 인증 실패 응답:
  - 토큰 누락: `401` + `AUTH_REQUIRED`
  - 토큰 불일치: `403` + `INVALID_TOKEN`
- CORS 정책:
  - 기본값: same-origin만 허용
  - 추가 허용 Origin은 `AGENT_WORLD_CORS_ALLOWED_ORIGINS`(콤마 구분)로 명시
  - 비허용 Origin은 `403` + `CORS_ORIGIN_FORBIDDEN`
- WS 티켓 보안 규칙:
  - 티켓은 기본 TTL `15000ms`(환경변수 `AGENT_WORLD_WS_TICKET_TTL_MS`로 조정)
  - 티켓은 1회만 사용 가능(재사용 시 연결 거부)
  - 활성 티켓 저장소 상한 기본 `10000`(`AGENT_WORLD_MAX_WS_TICKET_ENTRIES`로 조정)
  - 티켓 충돌 고갈 시 `503` + `WS_TICKET_COLLISION_LIMIT_EXCEEDED`

## `/events` 요청 형식

- 단일 이벤트 객체 또는 이벤트 배열을 받습니다.
- 배열인 경우, 모든 이벤트가 유효할 때만 반영합니다(원자성 보장).
- 유효성 실패 시 HTTP `400`과 함께 실패 인덱스/에러 메시지를 반환합니다.
- 배치 상한 초과 시 HTTP `413` + `EVENT_BATCH_LIMIT_EXCEEDED`를 반환합니다.

## 정규화 규칙

- 이벤트 타입: `event_type` 또는 `eventType` 또는 `type`
- 에이전트 ID: `agent_id` 또는 `agentId`
- 태스크 ID: `task_id` 또는 `taskId`
- 런 ID: `run_id` 또는 `runId`
- payload가 객체가 아니면 빈 객체로 정규화

## 지원 이벤트 타입

- `task_created`
- `task_assigned`
- `task_paused`
- `tool_called`
- `task_completed`
- `run_started`
- `run_completed`

## 검증 규칙

- `event_type`, `agent_id`는 필수
- `task_created/task_assigned/task_paused/tool_called/task_completed`는 `task_id` 필수
- `run_started/run_completed`는 `run_id` 필수

## DoS 완화/안정성 규칙

- 고정 윈도우 rate limit 적용(기본: `120 req / 60s`) — 초과 시 `429` + `RATE_LIMITED`
- JSON body size 상한 적용(기본: `256kb`)
- 상태 저장소 상한 초과 시 반영 거부 + 롤백:
  - agents `500`, runs `2000`, tasks `10000` (기본값)
  - 초과 시 `429` + `STATE_*_LIMIT_EXCEEDED`
- 내부 예외는 외부 응답에서 마스킹되어 `500 Internal server error.`로 반환

## 실사용 시나리오 (과업 생성 -> 완료)

1. `task_created` 수신 시 task 생성, agent zone=`intake`
2. `task_assigned` 수신 시 task 상태=`assigned`, agent zone=`planning`
3. `task_paused` 수신 시 task 상태=`paused/blocked`, agent zone=`blocked`
4. `tool_called` 수신 시 task 상태=`in_progress`, agent zone=`tools`
5. `task_completed` 수신 시 task 상태=`completed`, agent zone=`done`
6. `run_completed` 수신 시 run 상태=`completed`, agent zone=`idle`

## 테스트

```bash
npm run test:smoke
```
