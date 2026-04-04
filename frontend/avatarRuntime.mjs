const BASE_MOVE_INTERVAL_MS = 380;

const MOVES = [
  [0, 0],
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1]
];

const DIRECTION_BY_MOVE = {
  '1,0': 'right',
  '-1,0': 'left',
  '0,1': 'down',
  '0,-1': 'up'
};

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function nextMoveTime(timestamp, rng = Math.random) {
  return (
    timestamp +
    BASE_MOVE_INTERVAL_MS +
    Math.floor(rng() * BASE_MOVE_INTERVAL_MS)
  );
}

function chooseMove(rng = Math.random) {
  const index = Math.floor(rng() * MOVES.length);
  return MOVES[index] || MOVES[0];
}

function resolveDirection(deltaX, deltaY, fallback = 'down') {
  if (deltaX > 0) {
    return 'right';
  }

  if (deltaX < 0) {
    return 'left';
  }

  if (deltaY > 0) {
    return 'down';
  }

  if (deltaY < 0) {
    return 'up';
  }

  return fallback;
}

export function syncAvatarRuntimeEntries(
  avatarRuntime,
  avatars,
  now,
  rng = Math.random
) {
  const aliveIds = new Set();

  Object.entries(avatars).forEach(([avatarId, avatar]) => {
    aliveIds.add(avatarId);

    const runtime = avatarRuntime.get(avatarId);
    const authoritativePosition = avatar.authoritativePosition !== false;

    if (!runtime) {
      avatarRuntime.set(avatarId, {
        ...avatar,
        authoritativePosition,
        direction: 'down',
        nextMoveAt: nextMoveTime(now, rng)
      });
      return;
    }

    const prevX = runtime.x;
    const prevY = runtime.y;

    runtime.moving = avatar.moving;
    runtime.state = avatar.state;
    runtime.bubbleText = avatar.bubbleText;
    runtime.authoritativePosition = authoritativePosition;
    runtime.x = avatar.x;
    runtime.y = avatar.y;

    if (prevX !== avatar.x || prevY !== avatar.y) {
      runtime.direction = resolveDirection(
        avatar.x - prevX,
        avatar.y - prevY,
        runtime.direction
      );
    }

    if (!runtime.moving) {
      runtime.nextMoveAt = nextMoveTime(now, rng);
    }
  });

  Array.from(avatarRuntime.keys()).forEach(avatarId => {
    if (!aliveIds.has(avatarId)) {
      avatarRuntime.delete(avatarId);
    }
  });
}

export function advanceAvatarRuntimeEntries(
  avatarRuntime,
  dimensions,
  timestamp,
  rng = Math.random
) {
  const width = Number.isInteger(dimensions?.width) ? dimensions.width : 25;
  const height = Number.isInteger(dimensions?.height) ? dimensions.height : 25;

  avatarRuntime.forEach(runtime => {
    if (!runtime.moving || runtime.authoritativePosition) {
      return;
    }

    if (timestamp < runtime.nextMoveAt) {
      return;
    }

    const [dx, dy] = chooseMove(rng);
    const nextX = clamp(runtime.x + dx, 0, width - 1);
    const nextY = clamp(runtime.y + dy, 0, height - 1);

    if (nextX !== runtime.x || nextY !== runtime.y) {
      runtime.direction = DIRECTION_BY_MOVE[`${dx},${dy}`] || runtime.direction;
    }

    runtime.x = nextX;
    runtime.y = nextY;
    runtime.nextMoveAt = nextMoveTime(timestamp, rng);
  });
}
