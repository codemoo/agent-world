# Event Ingestion Contract

## `/events` 요청 형식

- 단일 이벤트 객체 또는 이벤트 배열을 받습니다.
- 배열인 경우, 모든 이벤트가 유효할 때만 반영합니다(원자성 보장).
- 유효성 실패 시 HTTP `400`과 함께 실패 인덱스/에러 메시지를 반환합니다.

## 정규화 규칙

- 이벤트 타입: `event_type` 또는 `eventType` 또는 `type`
- 에이전트 ID: `agent_id` 또는 `agentId`
- 태스크 ID: `task_id` 또는 `taskId`
- 런 ID: `run_id` 또는 `runId`
- payload가 객체가 아니면 빈 객체로 정규화

## 지원 이벤트 타입

- `task_created`
- `task_assigned`
- `tool_called`
- `task_completed`
- `run_started`
- `run_completed`

## 검증 규칙

- `event_type`, `agent_id`는 필수
- `task_created/task_assigned/tool_called/task_completed`는 `task_id` 필수
- `run_started/run_completed`는 `run_id` 필수

## 실사용 시나리오 (과업 생성 -> 완료)

1. `task_created` 수신 시 task 생성, agent zone=`intake`
2. `task_assigned` 수신 시 task 상태=`assigned`, agent zone=`planning`
3. `tool_called` 수신 시 task 상태=`in_progress`, agent zone=`tools`
4. `task_completed` 수신 시 task 상태=`completed`, agent zone=`done`
5. `run_completed` 수신 시 run 상태=`completed`, agent zone=`idle`

## 테스트

```bash
node --test test/*.test.js
```
