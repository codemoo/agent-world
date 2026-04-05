// Procedural tree placement — mirror of the frontend border/interior tree
// scatter so the backend can seed world-layout.json on first run.
//
// Output: array of { x, y, type } where type is one of the tree sprite
// variants handled by frontend/components/WorldMap.js (tree, tree.alt,
// tree.alt2, tree.alt3, tree.conifer, tree.big, tree.big.alt).

const SMALL_TREE_TYPES = ['tree', 'tree.alt', 'tree.alt2', 'tree.alt3', 'tree.conifer'];
const BIG_TREE_TYPES = ['tree.big', 'tree.big.alt'];

function hashString(input) {
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash * 31 + input.charCodeAt(i)) >>> 0;
  }
  return hash;
}

function hashCoord(seed, x, y) {
  return (seed ^ (x * 73856093) ^ (y * 19349663)) >>> 0;
}

function pickTree(h, bigFreq) {
  if (h % bigFreq === 0) {
    return BIG_TREE_TYPES[(h >>> 3) % BIG_TREE_TYPES.length];
  }
  return SMALL_TREE_TYPES[(h >>> 3) % SMALL_TREE_TYPES.length];
}

function overlapsLocation(x, y, locations) {
  return locations.some(loc => {
    const x2 = loc.x + (loc.w || 5) - 1;
    const y2 = loc.y + (loc.h || 4) - 1;
    return x >= loc.x && x <= x2 && y >= loc.y && y <= y2;
  });
}

function getTileType(tiles, x, y) {
  const row = Array.isArray(tiles[y]) ? tiles[y] : [];
  const cell = row[x];
  if (typeof cell === 'string') return cell;
  if (cell && typeof cell.type === 'string') return cell.type;
  return 'grass';
}

// `locations` is the list of buildings (with {x,y,w,h}).
// `tiles` is the grid from createVillageGrid.
function generateTrees(width, height, locations = [], tiles = []) {
  const seed = hashString(`${width}:${height}`);
  const midX = Math.floor(width / 2);
  const midY = Math.floor(height / 2);
  const trees = [];

  const isBlocked = (x, y) => {
    if (overlapsLocation(x, y, locations)) return true;
    return trees.some(t => t.x === x && t.y === y);
  };

  // Border: top row at y=1 (not y=0, to avoid viewport clipping)
  const topY = 1;
  const bottomY = height - 2;
  for (let x = 0; x < width; x++) {
    if (isBlocked(x, topY)) continue;
    const h = hashCoord(seed, x, topY);
    if (h % 3 !== 2) trees.push({ x, y: topY, type: pickTree(h, 5) });
  }
  for (let x = 0; x < width; x++) {
    if (isBlocked(x, bottomY)) continue;
    const h = hashCoord(seed, x, bottomY);
    if (h % 3 !== 2) trees.push({ x, y: bottomY, type: pickTree(h, 4) });
  }
  for (let y = 2; y < height - 2; y++) {
    if (!isBlocked(0, y)) {
      const h = hashCoord(seed, 0, y);
      if (h % 3 !== 2) trees.push({ x: 0, y, type: pickTree(h, 6) });
    }
    if (!isBlocked(width - 1, y)) {
      const h = hashCoord(seed, width - 1, y);
      if (h % 3 !== 2) trees.push({ x: width - 1, y, type: pickTree(h, 6) });
    }
  }
  // Second row (sparse) for thicker border
  for (let y = 2; y < height - 2; y++) {
    if (!isBlocked(1, y)) {
      const h = hashCoord(seed + 1, 1, y);
      if (h % 4 === 0) trees.push({ x: 1, y, type: pickTree(h, 8) });
    }
    if (!isBlocked(width - 2, y)) {
      const h = hashCoord(seed + 1, width - 2, y);
      if (h % 4 === 0) trees.push({ x: width - 2, y, type: pickTree(h, 8) });
    }
  }

  // Interior charm trees (skip paths/water/sand)
  const interiorSpots = [
    [midX - 5, midY - 3], [midX + 5, midY - 3],
    [midX - 5, midY + 3], [midX + 5, midY + 3],
    [7, midY], [width - 8, midY],
    [midX - 3, midY + 6], [midX + 3, midY - 6],
    [4, midY - 2], [width - 5, midY + 2]
  ];
  for (const [tx, ty] of interiorSpots) {
    if (tx < 2 || tx >= width - 2 || ty < 2 || ty >= height - 2) continue;
    if (isBlocked(tx, ty)) continue;
    const tt = getTileType(tiles, tx, ty);
    if (tt === 'path' || tt === 'water' || tt === 'sand') continue;
    const h = hashCoord(seed + 7, tx, ty);
    trees.push({ x: tx, y: ty, type: pickTree(h, 3) });
  }

  return trees;
}

module.exports = { generateTrees };
