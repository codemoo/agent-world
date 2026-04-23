// Canonical sprite definitions for the PixyMoon "Cute RPG World" pack.
//
// Paired with `scripts/build-asset-manifest.js`: running the builder
// reads this module and emits `assets/pixymoon/Cute RPG World/asset-
// manifest.json`, which the WorldMap loader then merges OVER the
// baseline `DEFAULT_SPRITE_DEFINITIONS` in frontend/components/WorldMap.js.
//
// Editing this file + `npm run build-assets` is the supported way to
// add sprite variations (e.g. new tree/flower skins) without a code
// push. Every entry has:
//   key    — the sprite key used by the renderer (must match
//            `drawSprite(key, ...)` call sites)
//   url    — path relative to assetRoot
//   frame  — cell spec. Either
//              { mode:'grid', columns, rows, column, row } (regular sheet)
//            or { sx, sy, sw, sh } (pixel-exact patch)
//
// When adding new keys that don't yet have draw sites, wire them in
// WorldMap.js too — otherwise the loader will download them but
// nothing will render.

// Path constants mirror WorldMap.js. Keep both in sync on rename.
const MZ = 'Cute RPG World (RPG Maker)/Cute RPG World - RPG Maker MZ/tilesets';
const FIELD_B    = `${MZ}/CuteRPG_Field_B.png`;
const FIELD_C    = `${MZ}/CuteRPG_Field_C.png`;
const FOREST_B   = `${MZ}/CuteRPG_Forest_B.png`;
const VILLAGE_B  = `${MZ}/CuteRPG_Village_B.png`;
const INTERIOR_B = `${MZ}/CuteRPG_Interior_B.png`;
const HOUSES_C1  = `${MZ}/CuteRPG_Houses_RPGMaker_C1.png`;
const HOUSES_C2  = `${MZ}/CuteRPG_Houses_RPGMaker_C2.png`;
const HOUSES_C3  = `${MZ}/CuteRPG_Houses_RPGMaker_C3.png`;

const GRID_16 = { mode: 'grid', columns: 16, rows: 16 };

// Terrain. These entries are currently commented-out on purpose: the
// in-code `DEFAULT_SPRITE_DEFINITIONS` keeps dirt/path/sand/stone/water
// as empty-candidate keys so the procedural texture path runs. If you
// later find clean autotile cells that render as flat fills, add them
// here and the loader will pick them up.
export const TERRAIN = [
  { key: 'terrain.grassA',
    url: FIELD_B, frame: { ...GRID_16, column: 1, row: 2 } },
  { key: 'terrain.grassB',
    url: FIELD_B, frame: { ...GRID_16, column: 3, row: 2 } }
];

// Props — trees and rocks. Trees use pixel-exact patches because each
// tree is a 1×2 or 2×2 block within a grid of other decorations.
export const PROPS = [
  { key: 'prop.tree',
    url: FIELD_B, frame: { sx: 576, sy: 576, sw: 48, sh: 96 } },
  { key: 'prop.tree.alt',
    url: FIELD_B, frame: { sx: 624, sy: 576, sw: 48, sh: 96 } },
  { key: 'prop.tree.alt2',
    url: FIELD_B, frame: { sx: 672, sy: 576, sw: 48, sh: 96 } },
  { key: 'prop.tree.alt3',
    url: FIELD_B, frame: { sx: 720, sy: 576, sw: 48, sh: 96 } },
  { key: 'prop.tree.conifer',
    url: FIELD_B, frame: { sx: 528, sy: 576, sw: 48, sh: 96 } },
  { key: 'prop.tree.big',
    url: FIELD_B, frame: { sx: 240, sy: 384, sw: 96, sh: 96 } },
  { key: 'prop.tree.big.alt',
    url: FIELD_B, frame: { sx: 240, sy: 576, sw: 96, sh: 96 } }
];

// Ground decorations — flowers and related low decorations.
export const DECORATIONS = [
  { key: 'deco.flower.pink',
    url: FOREST_B, frame: { ...GRID_16, column: 5, row: 4 } },
  { key: 'deco.flower.purple',
    url: FOREST_B, frame: { ...GRID_16, column: 6, row: 5 } },
  { key: 'deco.flower.mixed',
    url: FIELD_C, frame: { ...GRID_16, column: 2, row: 9 } },
  { key: 'deco.flower.red',
    url: FIELD_B, frame: { ...GRID_16, column: 10, row: 5 } }
];

// Buildings — pre-composed house sprites (186×216 px at top row, 237×216
// at middle rows) from the Houses_C[1|2|3] sheets. C1=orange, C2=green,
// C3=gray roofs.
export const BUILDINGS = [
  { key: 'building.house',
    url: HOUSES_C1, frame: { sx: 3, sy: 24, sw: 186, sh: 216 } },
  { key: 'building.house2',
    url: HOUSES_C1, frame: { sx: 195, sy: 24, sw: 186, sh: 216 } },
  { key: 'building.house.green',
    url: HOUSES_C2, frame: { sx: 3, sy: 24, sw: 186, sh: 216 } },
  { key: 'building.house.green2',
    url: HOUSES_C2, frame: { sx: 195, sy: 24, sw: 186, sh: 216 } },
  { key: 'building.house.gray',
    url: HOUSES_C3, frame: { sx: 3, sy: 24, sw: 186, sh: 216 } },
  { key: 'building.tower',
    url: HOUSES_C3, frame: { sx: 387, sy: 24, sw: 186, sh: 216 } },
  { key: 'building.large',
    url: HOUSES_C1, frame: { sx: 3, sy: 552, sw: 237, sh: 216 } },
  { key: 'building.shop',
    url: HOUSES_C1, frame: { sx: 243, sy: 552, sw: 237, sh: 216 } }
];

export const ALL_ENTRIES = [
  ...TERRAIN,
  ...PROPS,
  ...DECORATIONS,
  ...BUILDINGS
];
