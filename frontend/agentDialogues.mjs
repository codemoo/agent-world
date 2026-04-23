// Ambient chat lines agents exchange when they meet on the map.
// Lines are grouped by category so conversations can follow a
// coherent shape (greeting → reply → optional topic → reply) instead
// of two random one-liners stuck next to each other.
//
// Phase 1 — context-aware: buildConversation(ctx, rng) selects a
// category based on the speakers' actual situation (shared repo,
// one is Errored, one is Waiting for a permission, etc.) so the
// conversations read as coherent instead of purely random.

export const GREETINGS = [
  'Hey!',
  'Morning!',
  'Hi there!',
  "What's up?",
  "How's it going?",
  'Good to see you.',
  'Oh, hi!'
];

export const GREETING_REPLIES = [
  'Hey! Good to see you.',
  'Morning!',
  'Hi!',
  'Going alright — you?',
  'All good here.',
  'Not bad, thanks.',
  "Hey, how've you been?"
];

export const WORK_OPENERS = [
  "How's the deploy?",
  'Pipeline green?',
  'Did you see the PR?',
  'Need any help?',
  'Got a sec for a review?',
  "How's the task going?",
  'Any blockers?',
  "What's on your plate?"
];

export const WORK_REPLIES = [
  'Shipping it shortly.',
  'Tests are green.',
  'Stuck on one edge case.',
  'Yeah, merging soon.',
  'Almost there.',
  "I'll take a look after this.",
  'Nothing urgent — thanks!',
  'Will ping you later.'
];

export const CASUAL_OPENERS = [
  'Coffee?',
  'Lunch?',
  'Break time?',
  "Walkin' to the lounge.",
  'Need fresh air.',
  'Thinking of taking five.',
  'Heading to the plaza.'
];

export const CASUAL_REPLIES = [
  'Sure, I could use one.',
  'Give me five minutes.',
  'Go ahead, I’ll catch up.',
  'Same, need a reset.',
  'In a bit — finishing this.',
  "I'll join you."
];

// Same-repo conversations — {repo} is replaced with the shared
// repoLabel at build time. Falls back to "it" if label is null.
export const SAME_REPO_OPENERS = [
  'Working on {repo} too?',
  'You on {repo}?',
  'Same repo — what branch?',
  'Oh nice, {repo}.',
  'Both on {repo}, huh?',
  'Didn’t know you had {repo} open.'
];

export const SAME_REPO_REPLIES = [
  'Yep — finishing a branch.',
  'Yeah, debugging something.',
  'Small world.',
  'Same here. Hope we don’t conflict.',
  'Just poking around.',
  'Getting close to a PR.'
];

// One or both agents are Errored — commiseration pool.
export const ERROR_COMMISERATE_OPENERS = [
  'Red build again?',
  'Yours broke too?',
  'Everything on fire?',
  'Rough one?',
  'Ugh, tests?',
  'What this time?'
];

export const ERROR_COMMISERATE_REPLIES = [
  'Don’t even ask.',
  'Flaky test.',
  'Rolling back.',
  'Rerunning for the third time.',
  'Yeah, nightmare.',
  'Coffee first, fix after.'
];

// Exactly one agent is Waiting on a permission prompt — the other
// one offers moral support.
export const WAITING_SUPPORT_OPENERS = [
  'Approval stuck?',
  'Waiting on a prompt?',
  'Permission wall?',
  'Want me to tap something?',
  'Is it pending?'
];

export const WAITING_SUPPORT_REPLIES = [
  'Yeah, still pending.',
  'Almost — should be soon.',
  'Checking the toast.',
  'On it.',
  'Clicking now.'
];

// Reconnect pools — used when two agents who have met before cross
// paths again. Memory is per-runtime (chatLastMetAt map). Only fires
// if they've met in the recent past (after the pair cooldown clears
// but within the memory-retention window).
export const RECONNECT_OPENERS = [
  'Back so soon?',
  'Oh, us again.',
  "Didn't we just talk?",
  'Same crew.',
  "Can't seem to get rid of me.",
  'Round two?',
  'Hey, again.'
];

export const RECONNECT_REPLIES = [
  'Guess so.',
  'Nothing wrong with it.',
  'I was thinking the same.',
  'Where were we?',
  'Small village.',
  'Might as well catch up.',
  'Happens, huh?'
];

// Time-of-day pools — used when ctx carries an `hour` signal and the
// default GREETINGS / CASUAL pools would otherwise fire. Keeps the
// village's conversations contextual to when you're watching.
export const MORNING_GREETINGS = [
  'Morning!',
  "Mornin'!",
  'Up early?',
  'Rise and shine.',
  'Coffee first?',
  'Ready for the day?'
];

export const MORNING_REPLIES = [
  'Morning. Did you sleep?',
  'Barely awake.',
  'Yeah — big day.',
  'Coffee helping already.',
  'Getting there.',
  'Let’s do this.'
];

export const LUNCH_GREETINGS = [
  'Lunch?',
  'Getting food?',
  'Break time.',
  'Starving.',
  'Anything good in the cafe?'
];

export const LUNCH_REPLIES = [
  'In a sec.',
  'Join me?',
  'Already on my way.',
  'Yeah, I need it.',
  'I\'ll grab something quick.'
];

export const EVENING_GREETINGS = [
  'Evening.',
  'Still at it?',
  'Long day?',
  'Winding down?',
  'Almost home time?'
];

export const EVENING_REPLIES = [
  'Yeah — one more thing.',
  'Just about done.',
  'Few minutes more.',
  'Tired but good.',
  'I\'ll head out soon.'
];

export const NIGHT_GREETINGS = [
  "You're here late.",
  'Night owl?',
  "Can't sleep?",
  'Everyone else is gone.',
  'Quiet hours, huh?'
];

export const NIGHT_REPLIES = [
  'On a roll.',
  'Almost out.',
  'Not for long.',
  'One more push.',
  'Yeah, crashing soon.'
];

// Map 0-23 → period tag used to pick greeting pools.
export function hourToPeriod(hour) {
  if (hour >= 5 && hour < 11)  return 'morning';
  if (hour >= 11 && hour < 14) return 'lunch';
  if (hour >= 14 && hour < 18) return 'afternoon';
  if (hour >= 18 && hour < 22) return 'evening';
  return 'night';
}

const GREETINGS_BY_PERIOD = {
  morning:   MORNING_GREETINGS,
  lunch:     LUNCH_GREETINGS,
  afternoon: GREETINGS,           // default generic
  evening:   EVENING_GREETINGS,
  night:     NIGHT_GREETINGS
};

const GREETING_REPLIES_BY_PERIOD = {
  morning:   MORNING_REPLIES,
  lunch:     LUNCH_REPLIES,
  afternoon: GREETING_REPLIES,    // default generic
  evening:   EVENING_REPLIES,
  night:     NIGHT_REPLIES
};

// Group scenes — 3+ agents at a tavern / lounge / plaza / break_area.
// No strict turn order; lines work as standalone observations so
// listeners don't need to reply-match.
export const GROUP_LINES = [
  "Anyone else's CI red this morning?",
  'Nice to see the whole crew here.',
  "I needed this break.",
  'Someone got the coffee going?',
  'Deploy window closes in an hour.',
  'Pretty quiet village today.',
  "I'll pair on whatever after this.",
  'PRs are stacking up.',
  'Pipeline finally green.',
  'We really should document this somewhere.',
  'The new model is fast, huh?',
  "Weekend is close — hang in there.",
  "Who's on call tonight?",
  'Nice afternoon.',
  "Anyone tried that new linter yet?"
];

// FNV-1a-ish quick hash for deterministic picks.
function hashToInt(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function pick(pool, rng) {
  return pool[Math.floor(rng() * pool.length)];
}

function formatLine(template, repo) {
  if (typeof template !== 'string') return template;
  return template.replace(/\{repo\}/g, repo || 'it');
}

// Context shape (all fields optional, both sides independently):
//   ctx = { a: {repoRoot?, repoLabel?, serverStatus?}, b: same }
// Priority order (first match wins):
//   1. both.repoRoot non-null AND equal         → SAME_REPO  (2 turns)
//   2. either side serverStatus === 'Errored'   → ERROR      (2 turns)
//   3. exactly one side serverStatus==='Waiting' → WAITING   (2 turns)
//   4. fallback                                  → original GREETING
//                                                   (+ optional
//                                                    work/casual topic)
//
// Back-compat: callers that pass rng as the first positional arg
// (buildConversation(Math.random)) still work.
export function buildConversation(ctx, rng = Math.random) {
  if (typeof ctx === 'function') {
    rng = ctx;
    ctx = null;
  }

  const a = (ctx && ctx.a) || null;
  const b = (ctx && ctx.b) || null;

  // 1. Same repo — most specific, highest priority. Both sides must
  //    have a non-null repoRoot AND match exactly. Same-label but
  //    different-root (e.g. two projects each named "src") must NOT
  //    qualify — that's the whole point of keying on root.
  if (a && b && a.repoRoot && b.repoRoot && a.repoRoot === b.repoRoot) {
    const repo = a.repoLabel || b.repoLabel || 'it';
    return [
      formatLine(pick(SAME_REPO_OPENERS, rng), repo),
      formatLine(pick(SAME_REPO_REPLIES, rng), repo)
    ];
  }

  // 2. Error commiseration — either side errored.
  if (
    (a && a.serverStatus === 'Errored') ||
    (b && b.serverStatus === 'Errored')
  ) {
    return [
      pick(ERROR_COMMISERATE_OPENERS, rng),
      pick(ERROR_COMMISERATE_REPLIES, rng)
    ];
  }

  // 3. Waiting support — XOR (one is, the other isn't). If both are
  //    Waiting, fall through to greeting since neither can help the
  //    other.
  const aWaiting = !!(a && a.serverStatus === 'Waiting');
  const bWaiting = !!(b && b.serverStatus === 'Waiting');
  if (aWaiting !== bWaiting) {
    return [
      pick(WAITING_SUPPORT_OPENERS, rng),
      pick(WAITING_SUPPORT_REPLIES, rng)
    ];
  }

  // 4. Reconnect — two agents who have met before cross paths again.
  //    Skipped when they've never chatted (metBeforeMsAgo unset or 0)
  //    and when their last meeting was literally moments ago (the
  //    pair cooldown would have blocked re-chat anyway, so if we're
  //    here, it's been at least CHAT_PAIR_COOLDOWN_MS).
  const metMsAgo = (ctx && typeof ctx.metBeforeMsAgo === 'number')
    ? ctx.metBeforeMsAgo : 0;
  if (metMsAgo > 0) {
    return [
      pick(RECONNECT_OPENERS, rng),
      pick(RECONNECT_REPLIES, rng)
    ];
  }

  // 5. Fallback: greeting pools, optionally time-of-day-specific
  // when ctx provides `hour`. No ctx → classic generic greetings
  // (back-compat with tests that don't pass the hour signal).
  const hour = (ctx && typeof ctx.hour === 'number') ? ctx.hour : null;
  const period = hour != null ? hourToPeriod(hour) : null;
  const greetPool = (period && GREETINGS_BY_PERIOD[period]) || GREETINGS;
  const replyPool = (period && GREETING_REPLIES_BY_PERIOD[period]) || GREETING_REPLIES;

  const isLong = rng() < 0.4;
  const lines = [pick(greetPool, rng), pick(replyPool, rng)];
  if (isLong) {
    if (rng() < 0.55) {
      lines.push(pick(WORK_OPENERS, rng), pick(WORK_REPLIES, rng));
    } else {
      lines.push(pick(CASUAL_OPENERS, rng), pick(CASUAL_REPLIES, rng));
    }
  }
  return lines;
}

// Back-compat: seeded single-line picker (unused by the new logic but
// kept in case other callers still want a deterministic one-liner).
export const DIALOGUE_LINES = [
  ...GREETINGS, ...GREETING_REPLIES,
  ...WORK_OPENERS, ...WORK_REPLIES,
  ...CASUAL_OPENERS, ...CASUAL_REPLIES
];

export function pickDialogue(seed = '', timeBucket = 0) {
  const h = hashToInt(`${seed}:${timeBucket}`);
  return DIALOGUE_LINES[h % DIALOGUE_LINES.length];
}
