const test = require('node:test');
const assert = require('node:assert/strict');

const {
  detectTerminalKind,
  focusSessionTerminal
} = require('../server/terminalFocus');

test('detectTerminalKind identifies tmux via command substring', () => {
  const chain = [{ command: 'node claude' }, { command: '-zsh' }, { command: 'tmux server' }];
  assert.equal(detectTerminalKind(chain), 'tmux');
});

test('detectTerminalKind identifies iTerm from ancestors', () => {
  const chain = [{ command: 'node claude' }, { command: '/Applications/iTerm.app/Contents/MacOS/iTerm2' }];
  assert.equal(detectTerminalKind(chain), 'iterm');
});

test('detectTerminalKind falls back to unknown for unfamiliar terminals', () => {
  const chain = [{ command: 'claude' }, { command: 'unknown-launcher' }];
  assert.equal(detectTerminalKind(chain), 'unknown');
});

test('focusSessionTerminal gracefully degrades when pid missing', async () => {
  const result = await focusSessionTerminal({ pid: null });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no-pid');
});
