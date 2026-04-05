const test = require('node:test');
const assert = require('node:assert/strict');
const { cleanupWorldState } = require('../server/index');

test('cleanupWorldState: run 개수가 90%를 넘으면 오래된 20%를 삭제한다', () => {
  const worldState = {
    runs: {},
    agents: {}
  };

  const maxRuns = 100;
  const stateLimits = { maxRuns };

  // 95개의 run 생성
  for (let i = 0; i < 95; i++) {
    const id = `run-${i}`;
    worldState.runs[id] = {
      id,
      updatedAt: new Date(2026, 3, 5, 10, i).toISOString()
    };
  }

  assert.equal(Object.keys(worldState.runs).length, 95);

  cleanupWorldState(worldState, stateLimits);

  // 20% 삭제되므로 95 - 20 = 75개여야 함 (Math.ceil(100 * 0.2) = 20)
  assert.equal(Object.keys(worldState.runs).length, 75);

  // 오래된 것들이 삭제되었는지 확인 (run-0 ~ run-19)
  assert.equal(worldState.runs['run-0'], undefined);
  assert.equal(worldState.runs['run-19'], undefined);
  assert.notEqual(worldState.runs['run-20'], undefined);
});

test('cleanupWorldState: 에이전트당 task가 100개를 넘으면 50개로 줄인다', () => {
  const worldState = {
    runs: {},
    agents: {
      'agent-1': {
        id: 'agent-1',
        tasks: []
      }
    }
  };

  const stateLimits = { maxRuns: 1000 };

  // 120개의 task 생성
  for (let i = 0; i < 120; i++) {
    worldState.agents['agent-1'].tasks.push({
      id: `task-${i}`,
      updatedAt: new Date(2026, 3, 5, 11, i).toISOString()
    });
  }

  assert.equal(worldState.agents['agent-1'].tasks.length, 120);

  cleanupWorldState(worldState, stateLimits);

  assert.equal(worldState.agents['agent-1'].tasks.length, 50);
  // 최근 50개만 남아야 함 (task-70 ~ task-119)
  assert.equal(worldState.agents['agent-1'].tasks[0].id, 'task-70');
});
