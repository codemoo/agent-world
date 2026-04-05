// Ambient chat lines agents randomly exchange when they pass close to
// each other on the map. Pure flavour — no logic behind them. Mix of
// greetings, dev-team banter, task updates, and casual asides.

export const DIALOGUE_LINES = [
  // Greetings
  'Morning!',
  'Hey!',
  "What's up?",
  "How's it going?",
  'Hi there!',
  'Good to see you.',

  // Work status
  "How's the deploy?",
  'Tests are green.',
  'CI is flaky today.',
  'Merge conflict again…',
  'Let me rebase real quick.',
  'Just shipped it.',
  'Almost there.',
  'Stuck on a bug.',
  'Found the root cause!',
  'The pipeline is clear.',
  'Rollback in progress.',
  'Traffic looks stable.',
  'Cache is hot.',

  // Collaboration
  'Need any help?',
  'Got a sec?',
  'Can you review mine?',
  'On it.',
  'Pair on this?',
  'Take the lead here.',
  "I'll grab that ticket.",
  'Thanks!',
  'No problem.',
  "Let's sync later.",
  'Will ping you after.',

  // Breaks & casual
  'Coffee?',
  'Taking a break.',
  'Walking to the lounge.',
  'Lunch?',
  "I'll grab some water.",
  'Back in five.',
  'Need fresh air.',

  // Reactions
  'Nice work!',
  'Clever fix.',
  'Hmm, interesting…',
  'That was tricky.',
  'Big release coming.',
  'The CEO is happy.',
  "Let's refactor that later.",
  'Good catch.',
  'Ship it!',
  "That's a rabbit hole.",
  'Looks good to me.',

  // Meetings
  'Standup in 5.',
  'Demo ready.',
  'Retro at 4pm.',
  'Room booked.',
  'Joining the call.'
];

// FNV-1a-ish quick hash for deterministic picks when we want them.
function hashToInt(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// Pick a dialogue line. `seed` (any string) gives a bit of per-agent
// variety without making it fully predictable — we mix in a time bucket.
export function pickDialogue(seed = '', timeBucket = 0) {
  const h = hashToInt(`${seed}:${timeBucket}`);
  return DIALOGUE_LINES[h % DIALOGUE_LINES.length];
}
