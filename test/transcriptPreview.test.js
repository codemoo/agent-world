const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  getTail,
  getSlice,
  normalizeRecord,
  sanitize,
  PROJECTS_ROOT
} = require('../server/transcriptPreview');

function mkProject(name) {
  const dir = path.join(PROJECTS_ROOT, `-tmp-test-${process.pid}-${name}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeJsonl(filePath, records) {
  const lines = records.map(r => JSON.stringify(r)).join('\n') + '\n';
  fs.writeFileSync(filePath, lines, 'utf8');
}

test('parses last user/assistant/tool_use records', async () => {
  const dir = mkProject('parse');
  const file = path.join(dir, `${crypto.randomUUID?.() || 'a'}.jsonl`);
  try {
    writeJsonl(file, [
      { type: 'user', uuid: 'u1', gitBranch: 'main' },
      { type: 'assistant', uuid: 'a1', message: { model: 'claude-opus-4-7' } },
      { type: 'tool_use', uuid: 't1', name: 'Bash' },
      { type: 'assistant', uuid: 'a2', message: { model: 'claude-opus-4-7' } },
      { type: 'user', uuid: 'u2' }
    ]);
    const tail = await getTail(file);
    assert.equal(tail.lastUserMessage.uuid, 'u2');
    assert.equal(tail.lastAssistantMessage.uuid, 'a2');
    assert.equal(tail.lastToolUse.uuid, 't1');
    assert.equal(tail.lastModel, 'claude-opus-4-7');
    assert.equal(tail.gitBranch, 'main');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('tolerates a mid-write partial final line', async () => {
  const dir = mkProject('partial');
  const file = path.join(dir, 'b.jsonl');
  try {
    const complete = JSON.stringify({ type: 'user', uuid: 'u1' }) + '\n';
    const partial = '{"type":"assistant","uuid":"a1","message":{"model":"claude';
    fs.writeFileSync(file, complete + partial, 'utf8');
    const tail = await getTail(file);
    assert.equal(tail.lastUserMessage.uuid, 'u1');
    assert.equal(tail.lastAssistantMessage, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('refuses to read outside ~/.claude/projects', async () => {
  const tmp = path.join(os.tmpdir(), `outside-${process.pid}.jsonl`);
  fs.writeFileSync(tmp, JSON.stringify({ type: 'user' }) + '\n');
  try {
    await assert.rejects(() => getTail(tmp), /refusing to read outside/);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
});

test('empty file returns empty tail structure', async () => {
  const dir = mkProject('empty');
  const file = path.join(dir, 'c.jsonl');
  try {
    fs.writeFileSync(file, '');
    const tail = await getTail(file);
    assert.equal(tail.lines.length, 0);
    assert.equal(tail.lastUserMessage, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('sanitize strips ANSI escapes and control chars', () => {
  assert.equal(sanitize('hi\x1b[31mred\x1b[0mworld'), 'hiredworld');
  assert.equal(sanitize('\x1b[1;2mhello\x07'), 'hello');
  assert.equal(sanitize('hello\nworld'), 'hello\nworld'); // newline preserved
});

test('normalizeRecord flattens user prompt', () => {
  const rec = {
    type: 'user', uuid: 'u1', parentUuid: null,
    timestamp: '2026-04-22T10:00:00.000Z',
    message: { content: 'hi' }
  };
  const entries = normalizeRecord(rec, 0, new Map());
  assert.equal(entries.length, 1);
  assert.equal(entries[0].kind, 'user');
  assert.equal(entries[0].text, 'hi');
});

test('normalizeRecord splits assistant record into text + thinking + tool_use with turnId', () => {
  const rec = {
    type: 'assistant', uuid: 'a1',
    timestamp: '2026-04-22T10:00:01.000Z',
    message: {
      id: 'msg_123', model: 'claude-opus-4-7',
      content: [
        { type: 'thinking', thinking: 'considering options' },
        { type: 'text', text: 'I will run a command.' },
        { type: 'tool_use', id: 'toolu_123', name: 'Bash', input: { command: 'ls' } }
      ]
    }
  };
  const entries = normalizeRecord(rec, 0, new Map());
  assert.equal(entries.length, 3);
  assert.equal(entries[0].kind, 'thinking');
  assert.equal(entries[1].kind, 'assistant_text');
  assert.equal(entries[2].kind, 'tool_use');
  assert.equal(entries[2].tool, 'Bash');
  assert.match(entries[2].inputPreview, /"command": "ls"/);
  assert.equal(entries[0].turnId, 'msg_123');
  assert.equal(entries[2].turnId, 'msg_123');
  assert.equal(entries[2].id, 'toolu_123');
  // Monotonic seq.
  assert.deepEqual(entries.map(e => e.seq), [0, 1, 2]);
});

test('normalizeRecord extracts tool_result blocks from user records and links turnId', () => {
  const turnMap = new Map([['toolu_123', 'msg_parent']]);
  const rec = {
    type: 'user', uuid: 'u2',
    message: {
      content: [
        { type: 'tool_result', tool_use_id: 'toolu_123', content: [{ type: 'text', text: 'stdout' }], is_error: false }
      ]
    }
  };
  const entries = normalizeRecord(rec, 0, turnMap);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].kind, 'tool_result');
  assert.equal(entries[0].toolUseId, 'toolu_123');
  assert.equal(entries[0].turnId, 'msg_parent');
  assert.equal(entries[0].text, 'stdout');
});

test('getSlice cursor advances only past complete lines', async () => {
  const dir = mkProject('cursor');
  const file = path.join(dir, 'cursor.jsonl');
  try {
    const records = [
      { type: 'user',      uuid: 'u1', timestamp: '2026-04-22T10:00:00.000Z', message: { content: 'one' } },
      { type: 'assistant', uuid: 'a1', timestamp: '2026-04-22T10:00:01.000Z', message: { id: 'msg_a', model: 'claude-opus-4-7', content: [{ type: 'text', text: 'ack' }] } }
    ];
    fs.writeFileSync(file, records.map(r => JSON.stringify(r)).join('\n') + '\n');

    const full = await getSlice(file);
    assert.equal(full.entries.length, 2);
    assert.equal(full.model, 'claude-opus-4-7');
    assert.ok(full.cursor);

    // Appending a record: incremental read should surface only the new one.
    const next = { type: 'user', uuid: 'u2', timestamp: '2026-04-22T10:00:02.000Z', message: { content: 'two' } };
    fs.appendFileSync(file, JSON.stringify(next) + '\n');

    const delta = await getSlice(file, { cursor: full.cursor });
    assert.equal(delta.entries.length, 1);
    assert.equal(delta.entries[0].kind, 'user');
    assert.equal(delta.entries[0].text, 'two');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('getSlice resyncs when cursor inode no longer matches', async () => {
  const dir = mkProject('resync');
  const file = path.join(dir, 'resync.jsonl');
  try {
    fs.writeFileSync(file, JSON.stringify({ type: 'user', uuid: 'x1', message: { content: 'before' } }) + '\n');
    const snap1 = await getSlice(file);
    // Rotate by rewriting file — different inode likely.
    fs.rmSync(file);
    fs.writeFileSync(file, JSON.stringify({ type: 'user', uuid: 'x2', message: { content: 'after' } }) + '\n');
    const snap2 = await getSlice(file, { cursor: snap1.cursor });
    assert.ok(snap2.entries.length >= 1);
    assert.equal(snap2.entries[snap2.entries.length - 1].text, 'after');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('getSlice caps per-entry text at MAX_TEXT_LEN', async () => {
  const dir = mkProject('cap');
  const file = path.join(dir, 'cap.jsonl');
  try {
    const giant = 'A'.repeat(50 * 1024);
    fs.writeFileSync(file, JSON.stringify({ type: 'user', uuid: 'u1', message: { content: giant } }) + '\n');
    const s = await getSlice(file);
    assert.equal(s.entries.length, 1);
    assert.ok(s.entries[0].truncated, 'expected truncated flag');
    assert.ok(s.entries[0].text.length <= 8 * 1024 + 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('sanitize strips OSC sequences', () => {
  const s = sanitize('a\x1b]0;title\x07b');
  assert.equal(s, 'ab');
});
