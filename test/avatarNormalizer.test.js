const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const moduleUrl = pathToFileURL(
  path.join(__dirname, '../frontend/avatarNormalizer.mjs')
).href;

async function load() {
  return import(moduleUrl);
}

// Canonical v5 §5A passthrough contract: every top-level field that
// current avatarRuntime reads from `avatar.*` must survive normalize.
const PASSTHROUGH_TOP_LEVEL = [
  'x', 'y', 'moving', 'state', 'bubbleText', 'destination',
  'authoritativePosition', 'displayName',
  'intent', 'hatHue', 'status', 'toolIcon', 'model', 'tool'
];

function baseWorldState(avatarOverrides = {}, agentOverrides = {}) {
  return {
    world: { width: 30, height: 30 },
    avatars: {
      'a-1': {
        agentId: 'a-1',
        x: 5,
        y: 7,
        moving: false,
        state: 'working',
        bubbleText: '  hi  ',
        destination: { x: 6, y: 8, intent: { kind: 'at_desk' } },
        intent: { kind: 'at_desk' },
        hatHue: 123,
        status: 'Working',
        toolIcon: '🖥',
        model: 'claude-opus-4-7',
        tool: { name: 'Bash', inputPreview: 'ls', icon: '🖥' },
        ...avatarOverrides
      }
    },
    agents: {
      'a-1': { name: 'agent-one', ...agentOverrides }
    }
  };
}

test('normalizeAvatars preserves every 14-field passthrough (v5 §5A)', async () => {
  const { normalizeAvatars } = await load();
  const out = normalizeAvatars(baseWorldState());
  const entry = out['a-1'];

  for (const field of PASSTHROUGH_TOP_LEVEL) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(entry, field),
      `missing field after normalize: ${field}`
    );
  }

  assert.equal(entry.x, 5);
  assert.equal(entry.y, 7);
  assert.equal(entry.moving, false);
  assert.equal(entry.state, 'working');
  assert.equal(entry.bubbleText, 'hi');   // trimmed
  assert.equal(entry.authoritativePosition, true);
  assert.equal(entry.displayName, 'agent-one');
  assert.equal(entry.hatHue, 123);
  assert.equal(entry.status, 'Working');
  assert.equal(entry.toolIcon, '🖥');
  assert.equal(entry.model, 'claude-opus-4-7');
});

test('destination nested shape survives: {x, y, intent.kind}', async () => {
  const { normalizeAvatars } = await load();
  const entry = normalizeAvatars(baseWorldState())['a-1'];
  assert.equal(entry.destination.x, 6);
  assert.equal(entry.destination.y, 8);
  assert.equal(entry.destination.intent.kind, 'at_desk');
});

test('tool nested shape survives: {name, inputPreview, icon}', async () => {
  const { normalizeAvatars } = await load();
  const entry = normalizeAvatars(baseWorldState())['a-1'];
  assert.equal(entry.tool.name, 'Bash');
  assert.equal(entry.tool.inputPreview, 'ls');
  assert.equal(entry.tool.icon, '🖥');
});

test('optional fields are omitted (not null) when source lacks them', async () => {
  const { normalizeAvatars } = await load();
  const entry = normalizeAvatars(baseWorldState({
    intent: undefined,
    hatHue: undefined,
    status: undefined,
    toolIcon: undefined,
    model: undefined,
    tool: undefined
  }))['a-1'];
  assert.equal(Object.prototype.hasOwnProperty.call(entry, 'intent'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(entry, 'hatHue'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(entry, 'status'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(entry, 'toolIcon'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(entry, 'model'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(entry, 'tool'), false);
});

test('invalid types on optional fields are dropped (not coerced)', async () => {
  const { normalizeAvatars } = await load();
  const entry = normalizeAvatars(baseWorldState({
    hatHue: 'not-a-number',
    status: 42,
    toolIcon: null,
    tool: 'not-an-object'
  }))['a-1'];
  assert.equal(Object.prototype.hasOwnProperty.call(entry, 'hatHue'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(entry, 'status'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(entry, 'toolIcon'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(entry, 'tool'), false);
});

test('agent-only entries (no avatar) still produce the 8-field minimum', async () => {
  const { normalizeAvatars } = await load();
  const entry = normalizeAvatars({
    world: { width: 30, height: 30 },
    avatars: {},
    agents: { 'a-2': { name: 'later' } }
  })['a-2'];
  assert.ok(entry);
  assert.equal(entry.displayName, 'later');
  assert.equal(entry.moving, true);
  assert.equal(entry.state, 'idle');
  assert.equal(entry.authoritativePosition, false);
  assert.equal(entry.destination, null);
});

test('worldDimensions defaults to 25x25 when world missing', async () => {
  const { worldDimensions } = await load();
  assert.deepEqual(worldDimensions(null), { width: 25, height: 25 });
  assert.deepEqual(worldDimensions({}), { width: 25, height: 25 });
  assert.deepEqual(worldDimensions({ world: { width: 10, height: 12 } }),
    { width: 10, height: 12 });
});

test('deriveDefaultPosition is deterministic for the same id/dims', async () => {
  const { deriveDefaultPosition } = await load();
  const a = deriveDefaultPosition('agent-xyz', 30, 30);
  const b = deriveDefaultPosition('agent-xyz', 30, 30);
  assert.deepEqual(a, b);
  assert.ok(a.x >= 0 && a.x < 30);
  assert.ok(a.y >= 0 && a.y < 30);
});
