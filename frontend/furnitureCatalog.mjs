// Curated furniture sprite catalog for CuteRPG Interior_B/Interior_C.
// All coordinates verified by rendering each cell with a grid overlay
// against the source PNG and visually inspecting the output (scripts/
// audit-interior-sprites.py). 48px cells, 16×16 grid.
//
// Semantic keys follow the pattern `furniture.<group>.<variant>`. Multi-cell
// items use {sw, sh} that match their footprint (e.g. beds are 1×2 tall,
// wide beds are 2×1, etc.).

const INTERIOR_B =
  'Cute RPG World (RPG Maker)/Cute RPG World - RPG Maker MZ/tilesets/CuteRPG_Interior_B.png';

function cell(col, row, w = 1, h = 1) {
  return { sx: col * 48, sy: row * 48, sw: w * 48, sh: h * 48 };
}

export const FURNITURE_SPRITES = [
  // -------- BEDS (verified r9) --------
  { key: 'furniture.bed.gray',       url: INTERIOR_B, frame: cell(0, 9, 1, 2) },
  { key: 'furniture.bed.pink',       url: INTERIOR_B, frame: cell(1, 9, 1, 2) },
  { key: 'furniture.bed.blue',       url: INTERIOR_B, frame: cell(2, 9, 1, 2) },
  { key: 'furniture.bed.wide.pink',  url: INTERIOR_B, frame: cell(3, 9, 2, 1) },
  { key: 'furniture.bed.wide.blue',  url: INTERIOR_B, frame: cell(5, 9, 2, 1) },

  // -------- TABLES (verified r5, r6) --------
  { key: 'furniture.table',          url: INTERIOR_B, frame: cell(1, 5) },        // small wood
  { key: 'furniture.table.mid',      url: INTERIOR_B, frame: cell(3, 6) },        // medium wood
  { key: 'furniture.table.tiny',     url: INTERIOR_B, frame: cell(2, 6) },        // tiny stool
  { key: 'furniture.table.wide',     url: INTERIOR_B, frame: cell(2, 5, 2, 1) },  // 2×1 dining
  { key: 'furniture.table.dining',   url: INTERIOR_B, frame: cell(0, 6, 2, 1) },  // 2×1 dining alt
  { key: 'furniture.table.large',    url: INTERIOR_B, frame: cell(0, 5) },        // big 1×1

  // -------- CHAIRS (only 2 sprites — identical pair) --------
  { key: 'furniture.chair',          url: INTERIOR_B, frame: cell(4, 5) },        // wood chair L
  { key: 'furniture.chair.alt',      url: INTERIOR_B, frame: cell(5, 5) },        // wood chair L alt

  // -------- NIGHTSTANDS (r6 cols 4-5) --------
  { key: 'furniture.nightstand',     url: INTERIOR_B, frame: cell(4, 6) },
  { key: 'furniture.nightstand.alt', url: INTERIOR_B, frame: cell(5, 6) },

  // -------- SOFAS / STOOLS (r11 cols 0-2) --------
  { key: 'furniture.sofa',           url: INTERIOR_B, frame: cell(0, 11) },
  { key: 'furniture.sofa.alt',       url: INTERIOR_B, frame: cell(1, 11) },
  { key: 'furniture.sofa.alt2',      url: INTERIOR_B, frame: cell(2, 11) },

  // -------- DRESSERS (r11 cols 3-6) --------
  { key: 'furniture.dresser',        url: INTERIOR_B, frame: cell(3, 11) },
  { key: 'furniture.dresser.alt',    url: INTERIOR_B, frame: cell(4, 11) },
  { key: 'furniture.dresser.plain',  url: INTERIOR_B, frame: cell(5, 11) },
  { key: 'furniture.dresser.beer',   url: INTERIOR_B, frame: cell(6, 11) },

  // -------- BOOKSHELVES / COUNTERS (r11) --------
  { key: 'furniture.bookshelf',      url: INTERIOR_B, frame: cell(7, 11) },
  { key: 'furniture.bookshelf.scroll', url: INTERIOR_B, frame: cell(8, 11) },
  { key: 'furniture.counter',        url: INTERIOR_B, frame: cell(9, 11) },
  { key: 'furniture.shelf.wood',     url: INTERIOR_B, frame: cell(10, 11) },

  // -------- STOVES (r12 cols 0-3) --------
  { key: 'furniture.stove',          url: INTERIOR_B, frame: cell(0, 12) },
  { key: 'furniture.stove.alt',      url: INTERIOR_B, frame: cell(1, 12) },
  { key: 'furniture.stove.empty',    url: INTERIOR_B, frame: cell(2, 12) },
  { key: 'furniture.stove.blue',     url: INTERIOR_B, frame: cell(3, 12) },

  // -------- CABINETS (r13) --------
  { key: 'furniture.cabinet.metal',  url: INTERIOR_B, frame: cell(0, 13) },
  { key: 'furniture.cabinet.metal.alt', url: INTERIOR_B, frame: cell(1, 13) },
  { key: 'furniture.cabinet.glass',  url: INTERIOR_B, frame: cell(4, 13) },
  { key: 'furniture.cabinet.glass.alt', url: INTERIOR_B, frame: cell(5, 13) },
  { key: 'furniture.cabinet.wood',   url: INTERIOR_B, frame: cell(9, 13) },
  { key: 'furniture.cabinet.wood.alt', url: INTERIOR_B, frame: cell(10, 13) },
  { key: 'furniture.cabinet.books',  url: INTERIOR_B, frame: cell(12, 13) },
  { key: 'furniture.bookshelf.full', url: INTERIOR_B, frame: cell(13, 13) },

  // -------- WARDROBES (r13) --------
  { key: 'furniture.wardrobe',       url: INTERIOR_B, frame: cell(8, 13) },
  { key: 'furniture.wardrobe.alt',   url: INTERIOR_B, frame: cell(11, 13) },

  // -------- DISPLAY CASES / SAFES (r14, r15) --------
  { key: 'furniture.display',        url: INTERIOR_B, frame: cell(0, 15) }, // cyan display
  { key: 'furniture.display.alt',    url: INTERIOR_B, frame: cell(1, 15) },
  { key: 'furniture.safe',           url: INTERIOR_B, frame: cell(4, 15) },
  { key: 'furniture.cabinet.drawer', url: INTERIOR_B, frame: cell(10, 15) },

  // -------- POTTED PLANTS (r0-r5 cols 8, 12 — verified by composite audit) --------
  { key: 'furniture.plant.purple',   url: INTERIOR_B, frame: cell(8, 0, 1, 2) },
  { key: 'furniture.plant.pink',     url: INTERIOR_B, frame: cell(8, 2, 1, 2) },
  { key: 'furniture.plant.purple.alt', url: INTERIOR_B, frame: cell(12, 0, 1, 2) },
  { key: 'furniture.plant.pink.alt', url: INTERIOR_B, frame: cell(12, 2, 1, 2) },

  // -------- WOOD CURTAINS / BLINDS (r9 cols 11-14, 1×2 tall) --------
  { key: 'furniture.curtain.v',      url: INTERIOR_B, frame: cell(11, 9, 1, 2) },
  { key: 'furniture.curtain.h',      url: INTERIOR_B, frame: cell(13, 9, 1, 2) }
];

// Render-size hints, in tile units. Defaults to {w:1,h:1} when missing.
export const FURNITURE_RENDER_SIZE = {};
for (const def of FURNITURE_SPRITES) {
  const type = def.key.replace(/^furniture\./, '');
  FURNITURE_RENDER_SIZE[type] = {
    w: def.frame.sw / 48,
    h: def.frame.sh / 48
  };
}

// Compatibility shim: historical keys that must keep working.
// Maps old (possibly misleading) key → correct current key.
export const FURNITURE_ALIASES = {
  // Legacy names that now point to verified sprites.
  'furniture.chair.red':    'furniture.bed.wide.pink',
  'furniture.chair.blue':   'furniture.bed.wide.blue',
  'furniture.chair.wood':   'furniture.chair.alt',
  'furniture.chair.arm':    'furniture.nightstand',
  'furniture.chair.side':   'furniture.nightstand.alt',
  'furniture.table.alt':    'furniture.table.mid',
  'furniture.table.round':  'furniture.table.tiny',
  'furniture.desk':         'furniture.table.mid',
  'furniture.desk.wood':    'furniture.dresser.alt',
  'furniture.drawer':       'furniture.dresser.alt',
  'furniture.drawer.alt':   'furniture.dresser.plain',
  'furniture.drawer.plain': 'furniture.dresser.beer',
  'furniture.counter.alt':  'furniture.shelf.wood',
  'furniture.rack':         'furniture.cabinet.metal',
  'furniture.rack.alt':     'furniture.cabinet.metal.alt',
  'furniture.bookshelf.alt':'furniture.shelf.wood',
  'furniture.plant.yellow': 'furniture.plant.purple.alt',
  'furniture.curtain':      'furniture.curtain.v',
  'furniture.curtain.alt':  'furniture.curtain.h',
  // The raw wardrobe sprites at (8,13) and (11,13) look like doors, which
  // makes interiors read as "why is there a door mid-room?". Redirect to
  // the 4-drawer chest so wardrobe stations render as clothing storage.
  'furniture.wardrobe':     'furniture.cabinet.wood.alt',
  'furniture.wardrobe.alt': 'furniture.cabinet.wood.alt',
  // The raw sprite at (3,11) catches the right edge of the 2×1 sofa at
  // cols 2-3 — renders as wooden strips. Redirect to the clean dresser.
  'furniture.dresser':      'furniture.dresser.alt'
};
