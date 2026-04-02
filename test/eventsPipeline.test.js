const test = require('node:test');
const assert = require('node:assert/strict');

const {
  EventValidationError,
  processIncomingEvents
} = require('../server/eventsPipeline');
const { applyPaperclipEvent } = require('../adapter/paperclipAdapter');

function createWorldState() {
  return {
    agents: {},
    zones: {},
    runs: {}
  };
}

test('단일 이벤트 객체를 받아 정상 처리한다', () => {
  const worldState = createWorldState();
  const processed = processIncomingEvents(
    {
      event_type: 'task_created',
      agent_id: 'agent-1',
      task_id: 'task-1',
      payload: { label: 'API' }
    },
    worldState
  );

  assert.equal(processed.length, 1);
  assert.equal(worldState.agents['agent-1'].tasks.length, 1);
});

test('배치 내 하나라도 유효하지 않으면 전체를 거부한다(원자성)', () => {
  const worldState = createWorldState();

  assert.throws(
    () =>
      processIncomingEvents(
        [
          {
            event_type: 'task_created',
            agent_id: 'agent-1',
            task_id: 'task-1'
          },
          {
            event_type: 'task_completed',
            agent_id: 'agent-1'
          }
        ],
        worldState
      ),
    error => {
      assert(error instanceof EventValidationError);
      assert.equal(error.details[0].index, 1);
      return true;
    }
  );

  assert.deepEqual(worldState, createWorldState());
});

test('빈 배열 이벤트 요청은 거부한다', () => {
  const worldState = createWorldState();

  assert.throws(
    () => processIncomingEvents([], worldState),
    /Event array must not be empty/
  );
});

test('apply 단계 예외가 발생하면 worldState를 롤백한다', () => {
  const worldState = createWorldState();
  processIncomingEvents(
    {
      event_type: 'run_started',
      agent_id: 'agent-rollback',
      run_id: 'run-rollback'
    },
    worldState
  );
  const baseline = JSON.parse(JSON.stringify(worldState));

  assert.throws(
    () =>
      processIncomingEvents(
        [
          {
            event_type: 'task_created',
            agent_id: 'agent-rollback',
            task_id: 'task-rollback-1',
            run_id: 'run-rollback'
          },
          {
            event_type: 'task_assigned',
            agent_id: 'agent-rollback',
            task_id: 'task-rollback-1',
            run_id: 'run-rollback'
          }
        ],
        worldState,
        {
          applyEvent: (event, state) => {
            if (event.eventType === 'task_assigned') {
              throw new Error('Injected apply failure for rollback test');
            }
            return applyPaperclipEvent(event, state);
          }
        }
      ),
    /Injected apply failure for rollback test/
  );

  assert.deepEqual(worldState, baseline);
});
