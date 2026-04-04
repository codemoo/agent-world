const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createWsTicketStore,
  getWsTicketFromUrl
} = require('../server/wsTicketStore');

test('ws ticket store는 티켓을 1회만 허용한다', () => {
  const store = createWsTicketStore({
    randomBytes: () => Buffer.from('123456789012345678901234'),
    now: (() => {
      let now = 1000;
      return () => now;
    })()
  });
  const issued = store.issue('api-token');

  const firstUse = store.consume(issued.ticket);
  assert.equal(firstUse.ok, true);
  assert.equal(firstUse.subject, 'api-token');

  const secondUse = store.consume(issued.ticket);
  assert.equal(secondUse.ok, false);
  assert.equal(secondUse.code, 'WS_TICKET_REPLAYED');
});

test('ws ticket store는 만료된 티켓을 거부한다', () => {
  let now = 1000;
  const store = createWsTicketStore({
    ttlMs: 10,
    now: () => now,
    randomBytes: () => Buffer.from('abcdefghijklmnopqrstuvwx')
  });
  const issued = store.issue('api-token');
  now = 1020;

  const consumed = store.consume(issued.ticket);
  assert.equal(consumed.ok, false);
  assert.equal(consumed.code, 'WS_TICKET_INVALID');
});

test('ws ticket store는 충돌 한계 초과 시 명시적 예외를 던진다', () => {
  const fixedBytes = () => Buffer.alloc(24, 7);
  const store = createWsTicketStore({
    randomBytes: fixedBytes,
    now: () => 1000
  });

  store.issue('api-token');

  assert.throws(
    () => store.issue('api-token'),
    error =>
      error &&
      error.name === 'WsTicketIssueError' &&
      error.code === 'WS_TICKET_COLLISION_LIMIT_EXCEEDED'
  );
});

test('ws ticket url 파서는 ticket/ws_ticket 파라미터를 파싱한다', () => {
  assert.equal(
    getWsTicketFromUrl('ws://localhost:3000/?ticket=abc123'),
    'abc123'
  );
  assert.equal(
    getWsTicketFromUrl('ws://localhost:3000/?ws_ticket=xyz'),
    'xyz'
  );
  assert.equal(getWsTicketFromUrl('ws://localhost:3000/'), null);
});
