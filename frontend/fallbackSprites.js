// Procedural fallback renderers. Used when the PixyMoon asset pack is
// not installed (or not in the load path). The goal isn't visual parity
// — it's "recognizable enough to know what each station does" so the
// app remains useful without paid assets.
//
// Every renderer takes (ctx, x, y, w, h) where (x, y) is the top-left
// and (w, h) is the footprint in pixels. Caller handles z-order +
// clipping; fallbacks just fill their rect.

// ---- shared primitives ---------------------------------------------------

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function fillRoundRect(ctx, x, y, w, h, r, fill, stroke = null) {
  roundRect(ctx, x, y, w, h, r);
  ctx.fillStyle = fill;
  ctx.fill();
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}

// ---- furniture categories -----------------------------------------------

// `type` here is the post-`furniture.` stripped key (e.g. `bed.pink`).
// We bucket the 50+ keys into ~10 rendering primitives. The `variant`
// portion is only used for hue tinting.
function classifyFurniture(type) {
  if (!type) return 'object';
  if (type.startsWith('bed')) return 'bed';
  if (type.startsWith('table')) return 'table';
  if (type.startsWith('chair')) return 'chair';
  if (type.startsWith('nightstand')) return 'nightstand';
  if (type.startsWith('sofa')) return 'sofa';
  if (type.startsWith('dresser')) return 'dresser';
  if (type.startsWith('bookshelf')) return 'bookshelf';
  if (type.startsWith('cabinet.books')) return 'bookshelf';
  if (type.startsWith('cabinet.glass')) return 'cabinet.glass';
  if (type.startsWith('cabinet.metal')) return 'cabinet.metal';
  if (type.startsWith('cabinet.wood')) return 'cabinet.wood';
  if (type.startsWith('cabinet')) return 'cabinet.wood';
  if (type.startsWith('wardrobe')) return 'cabinet.wood';
  if (type.startsWith('stove')) return 'stove';
  if (type.startsWith('counter') || type.startsWith('shelf')) return 'counter';
  if (type.startsWith('safe')) return 'safe';
  if (type.startsWith('display')) return 'display';
  if (type.startsWith('plant')) return 'plant';
  if (type.startsWith('curtain')) return 'curtain';
  return 'object';
}

// Pull a hint of colour out of a type string. Keeps beds pink and stoves
// blue when the type asks for it, without coupling to the full variant
// matrix.
function hintColor(type, defaultHex) {
  if (!type) return defaultHex;
  if (type.includes('pink')) return '#f472b6';
  if (type.includes('blue')) return '#60a5fa';
  if (type.includes('green')) return '#4ade80';
  if (type.includes('purple')) return '#a78bfa';
  if (type.includes('red')) return '#f87171';
  if (type.includes('yellow')) return '#facc15';
  if (type.includes('metal')) return '#94a3b8';
  if (type.includes('glass')) return '#7dd3fc';
  if (type.includes('wood')) return '#b08968';
  if (type.includes('gray')) return '#9ca3af';
  return defaultHex;
}

const FURNITURE_RENDERERS = {
  bed(ctx, x, y, w, h, { type }) {
    // Mattress + pillow stripe.
    const pad = Math.max(2, w * 0.08);
    const frameColor = '#8b5a3c';
    const sheetColor = hintColor(type, '#fff7ed');
    fillRoundRect(ctx, x + pad, y + pad, w - pad * 2, h - pad * 2, 4, sheetColor, frameColor);
    // Pillow
    const pillowW = (w - pad * 2) * 0.35;
    const pillowH = (h - pad * 2) * 0.22;
    fillRoundRect(ctx, x + pad + 3, y + pad + 3, pillowW, pillowH, 2, '#fff', '#d6d3d1');
    // Frame band at the foot for depth
    ctx.fillStyle = frameColor;
    ctx.fillRect(x + pad, y + h - pad - 3, w - pad * 2, 2);
  },

  table(ctx, x, y, w, h) {
    // Top + two legs.
    const topH = Math.max(4, h * 0.35);
    fillRoundRect(ctx, x + 2, y + h - topH, w - 4, topH, 3, '#b08968', '#7c5a3f');
    ctx.fillStyle = '#7c5a3f';
    ctx.fillRect(x + 4, y + h - 2, 3, 3);
    ctx.fillRect(x + w - 7, y + h - 2, 3, 3);
  },

  chair(ctx, x, y, w, h) {
    // Seat + backrest.
    const seatH = Math.max(4, h * 0.35);
    const backH = h - seatH - 2;
    ctx.fillStyle = '#7c5a3f';
    ctx.fillRect(x + w * 0.22, y + 2, w * 0.56, backH);
    fillRoundRect(ctx, x + 3, y + backH + 2, w - 6, seatH, 3, '#b08968', '#7c5a3f');
  },

  nightstand(ctx, x, y, w, h) {
    fillRoundRect(ctx, x + 3, y + 3, w - 6, h - 6, 2, '#8b5a3c', '#5c3a26');
    // Drawer line.
    ctx.strokeStyle = '#5c3a26';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x + 5, y + h * 0.5);
    ctx.lineTo(x + w - 5, y + h * 0.5);
    ctx.stroke();
    // Handle dots.
    ctx.fillStyle = '#fde68a';
    ctx.fillRect(x + w * 0.35, y + h * 0.5 + 2, 2, 1);
    ctx.fillRect(x + w * 0.6, y + h * 0.5 + 2, 2, 1);
  },

  sofa(ctx, x, y, w, h, { type }) {
    const color = hintColor(type, '#c084fc');
    // Base cushion.
    fillRoundRect(ctx, x + 2, y + h * 0.4, w - 4, h * 0.55, 5, color, '#6b4a25');
    // Backrest.
    fillRoundRect(ctx, x + 2, y + 2, w - 4, h * 0.5, 5, color, '#6b4a25');
    // Armrests.
    const arm = w * 0.15;
    fillRoundRect(ctx, x + 2, y + h * 0.4, arm, h * 0.55, 3, color, '#6b4a25');
    fillRoundRect(ctx, x + w - 2 - arm, y + h * 0.4, arm, h * 0.55, 3, color, '#6b4a25');
  },

  dresser(ctx, x, y, w, h) {
    fillRoundRect(ctx, x + 3, y + 3, w - 6, h - 6, 2, '#a67c52', '#6b4a25');
    // 3 drawer lines.
    ctx.strokeStyle = '#6b4a25';
    ctx.lineWidth = 1;
    ctx.fillStyle = '#fde68a';
    for (let i = 1; i < 4; i++) {
      const yy = y + 3 + ((h - 6) * i) / 4;
      ctx.beginPath();
      ctx.moveTo(x + 5, yy);
      ctx.lineTo(x + w - 5, yy);
      ctx.stroke();
      // handle
      ctx.fillRect(x + w * 0.45, yy - 2, w * 0.1, 1.5);
    }
  },

  bookshelf(ctx, x, y, w, h) {
    fillRoundRect(ctx, x + 2, y + 2, w - 4, h - 4, 2, '#7c5a3f', '#4b3828');
    // 3 shelves with colored spines.
    const spineColors = ['#f87171', '#fbbf24', '#34d399', '#60a5fa', '#a78bfa'];
    for (let shelf = 0; shelf < 3; shelf++) {
      const yy = y + 4 + shelf * ((h - 8) / 3);
      const shelfH = (h - 8) / 3 - 2;
      // Spines.
      for (let i = 0; i < 5; i++) {
        ctx.fillStyle = spineColors[(shelf * 5 + i) % spineColors.length];
        const bx = x + 4 + i * ((w - 8) / 5);
        ctx.fillRect(bx, yy, (w - 8) / 5 - 1, shelfH);
      }
    }
  },

  'cabinet.glass'(ctx, x, y, w, h) {
    // Frame + glass pane + contents dots.
    fillRoundRect(ctx, x + 2, y + 2, w - 4, h - 4, 2, '#7dd3fc', '#0c4a6e');
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.fillRect(x + 4, y + 4, w - 8, h - 8);
    // Items inside
    ctx.fillStyle = '#f59e0b';
    ctx.beginPath();
    ctx.arc(x + w * 0.35, y + h * 0.55, 3, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#ef4444';
    ctx.beginPath();
    ctx.arc(x + w * 0.65, y + h * 0.55, 3, 0, Math.PI * 2); ctx.fill();
    // Frame line
    ctx.strokeStyle = '#0c4a6e';
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 2.5, y + 2.5, w - 5, h - 5);
  },

  'cabinet.metal'(ctx, x, y, w, h) {
    fillRoundRect(ctx, x + 2, y + 2, w - 4, h - 4, 2, '#94a3b8', '#475569');
    // Vertical door split
    ctx.strokeStyle = '#475569';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x + w * 0.5, y + 4);
    ctx.lineTo(x + w * 0.5, y + h - 4);
    ctx.stroke();
    // Handles
    ctx.fillStyle = '#1e293b';
    ctx.fillRect(x + w * 0.5 - 3, y + h * 0.45, 2, 4);
    ctx.fillRect(x + w * 0.5 + 1, y + h * 0.45, 2, 4);
  },

  'cabinet.wood'(ctx, x, y, w, h) {
    fillRoundRect(ctx, x + 2, y + 2, w - 4, h - 4, 2, '#b08968', '#6b4a25');
    ctx.strokeStyle = '#6b4a25';
    ctx.lineWidth = 1;
    // Vertical door split + horizontal cross
    ctx.beginPath();
    ctx.moveTo(x + w * 0.5, y + 3);
    ctx.lineTo(x + w * 0.5, y + h - 3);
    ctx.moveTo(x + 4, y + h * 0.55);
    ctx.lineTo(x + w - 4, y + h * 0.55);
    ctx.stroke();
    ctx.fillStyle = '#fde68a';
    ctx.fillRect(x + w * 0.5 - 2, y + h * 0.35, 1.5, 3);
    ctx.fillRect(x + w * 0.5 + 1, y + h * 0.35, 1.5, 3);
  },

  stove(ctx, x, y, w, h, { type }) {
    const color = hintColor(type, '#64748b');
    fillRoundRect(ctx, x + 2, y + 2, w - 4, h - 4, 2, color, '#1e293b');
    // Four burners.
    const br = Math.min(w, h) * 0.12;
    const positions = [[0.3, 0.4], [0.7, 0.4], [0.3, 0.75], [0.7, 0.75]];
    for (const [fx, fy] of positions) {
      ctx.fillStyle = '#1e293b';
      ctx.beginPath();
      ctx.arc(x + w * fx, y + h * fy, br, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#fbbf24';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(x + w * fx, y + h * fy, br * 0.6, 0, Math.PI * 2);
      ctx.stroke();
    }
  },

  counter(ctx, x, y, w, h) {
    // Top counter + shelf below.
    fillRoundRect(ctx, x + 2, y + 2, w - 4, h * 0.3, 2, '#e5e7eb', '#6b7280');
    ctx.fillStyle = '#b08968';
    ctx.fillRect(x + 3, y + h * 0.35, w - 6, h * 0.55);
    ctx.strokeStyle = '#6b4a25';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x + 3, y + h * 0.65);
    ctx.lineTo(x + w - 3, y + h * 0.65);
    ctx.stroke();
  },

  safe(ctx, x, y, w, h) {
    fillRoundRect(ctx, x + 2, y + 2, w - 4, h - 4, 3, '#374151', '#111827');
    // Dial.
    ctx.fillStyle = '#9ca3af';
    ctx.beginPath();
    ctx.arc(x + w * 0.5, y + h * 0.5, Math.min(w, h) * 0.25, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#fbbf24';
    ctx.fillRect(x + w * 0.5 - 1, y + h * 0.3, 2, 6);
  },

  display(ctx, x, y, w, h) {
    // Screen-on-stand.
    fillRoundRect(ctx, x + 3, y + 2, w - 6, h * 0.65, 2, '#0ea5e9', '#0c4a6e');
    ctx.fillStyle = 'rgba(255,255,255,0.4)';
    ctx.fillRect(x + 5, y + 4, w - 10, h * 0.55);
    // Stand.
    ctx.fillStyle = '#334155';
    ctx.fillRect(x + w * 0.42, y + h * 0.68, w * 0.16, h * 0.18);
    ctx.fillRect(x + w * 0.25, y + h * 0.88, w * 0.5, 3);
  },

  plant(ctx, x, y, w, h, { type }) {
    const leafColor = hintColor(type, '#22c55e');
    // Pot.
    const potH = h * 0.28;
    fillRoundRect(ctx, x + w * 0.25, y + h - potH - 2, w * 0.5, potH, 2, '#a16207', '#78350f');
    // Foliage cluster.
    const foliageR = w * 0.26;
    const cy = y + h - potH - foliageR;
    ctx.fillStyle = leafColor;
    ctx.beginPath();
    ctx.arc(x + w * 0.5, cy, foliageR, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(x + w * 0.32, cy + 2, foliageR * 0.7, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(x + w * 0.68, cy + 2, foliageR * 0.7, 0, Math.PI * 2);
    ctx.fill();
  },

  curtain(ctx, x, y, w, h) {
    // Rod + draped fabric with pleats.
    ctx.fillStyle = '#7c5a3f';
    ctx.fillRect(x + 1, y + 1, w - 2, 3);
    const fabricX = x + 2;
    const fabricY = y + 4;
    const fabricW = w - 4;
    const fabricH = h - 6;
    ctx.fillStyle = '#f472b6';
    ctx.fillRect(fabricX, fabricY, fabricW, fabricH);
    ctx.strokeStyle = 'rgba(0,0,0,0.15)';
    ctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      const xx = fabricX + (fabricW * i) / 4;
      ctx.beginPath();
      ctx.moveTo(xx, fabricY);
      ctx.lineTo(xx, fabricY + fabricH);
      ctx.stroke();
    }
  },

  object(ctx, x, y, w, h, { type }) {
    // Unknown furniture type — gentle grey crate with a label tick.
    fillRoundRect(ctx, x + 3, y + 3, w - 6, h - 6, 2, '#9ca3af', '#4b5563');
    ctx.strokeStyle = '#4b5563';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x + 3, y + h * 0.5);
    ctx.lineTo(x + w - 3, y + h * 0.5);
    ctx.stroke();
    // Tiny type tag for debugging.
    if (type && w > 28) {
      ctx.fillStyle = 'rgba(255,255,255,0.7)';
      ctx.font = `${Math.floor(w * 0.14)}px Menlo, monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(type.slice(0, 6), x + w / 2, y + h / 2);
    }
  }
};

export function drawFallbackFurniture(ctx, x, y, w, h, type) {
  const cat = classifyFurniture(type);
  const renderer = FURNITURE_RENDERERS[cat] || FURNITURE_RENDERERS.object;
  renderer(ctx, x, y, w, h, { type });
}

// ---- flowers / ground decorations ---------------------------------------

const FLOWER_COLORS = {
  'flower.pink':   ['#f472b6', '#f9a8d4'],
  'flower.purple': ['#c084fc', '#ddd6fe'],
  'flower.red':    ['#ef4444', '#fca5a5'],
  'flower.mixed':  ['#fbbf24', '#f472b6', '#60a5fa']
};

export function drawFallbackDecoration(ctx, x, y, size, type) {
  const t = size;
  if (type === 'bush') {
    ctx.fillStyle = '#4a8c3f';
    ctx.beginPath();
    ctx.arc(x + t * 0.5, y + t * 0.6, t * 0.22, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#5aad5e';
    ctx.beginPath();
    ctx.arc(x + t * 0.4, y + t * 0.52, t * 0.14, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  if (type === 'pebbles') {
    ctx.fillStyle = '#a0a5aa';
    const offsets = [[0.35, 0.55], [0.55, 0.6], [0.45, 0.7], [0.6, 0.48]];
    for (const [ox, oy] of offsets) {
      ctx.beginPath();
      ctx.arc(x + t * ox, y + t * oy, t * 0.06, 0, Math.PI * 2);
      ctx.fill();
    }
    return;
  }
  if (type && type.startsWith('flower')) {
    // Stem + blossom cluster in the requested palette.
    const palette = FLOWER_COLORS[type] || FLOWER_COLORS['flower.pink'];
    // Stem.
    ctx.strokeStyle = '#16a34a';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x + t * 0.5, y + t * 0.8);
    ctx.lineTo(x + t * 0.5, y + t * 0.55);
    ctx.stroke();
    // Leaf.
    ctx.fillStyle = '#16a34a';
    ctx.beginPath();
    ctx.ellipse(x + t * 0.62, y + t * 0.68, t * 0.08, t * 0.05, Math.PI / 6, 0, Math.PI * 2);
    ctx.fill();
    // Petals around a centre.
    const cx = x + t * 0.5, cy = y + t * 0.45;
    const petalR = t * 0.10;
    const centre = palette[0];
    const petal = palette[1] || palette[0];
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      const px = cx + Math.cos(a) * petalR;
      const py = cy + Math.sin(a) * petalR;
      ctx.fillStyle = palette[(i + 1) % palette.length] || petal;
      ctx.beginPath();
      ctx.arc(px, py, petalR * 0.9, 0, Math.PI * 2);
      ctx.fill();
    }
    // Centre.
    ctx.fillStyle = centre;
    ctx.beginPath();
    ctx.arc(cx, cy, petalR * 0.7, 0, Math.PI * 2);
    ctx.fill();
  }
}

// ---- character (avatar) fallback -----------------------------------------

const DIRECTION_ANGLE = { down: Math.PI / 2, up: -Math.PI / 2, left: Math.PI, right: 0 };

// Drop-in replacement for the WorldMap's drawFallbackAvatar. Takes an
// `avatar` runtime object so we can colour by hatHue, direction, and
// seated state.
export function drawFallbackAvatarV2(ctx, centerX, centerY, tileSize, avatar, walkPhase) {
  const radius = Math.max(5, Math.floor(tileSize * 0.28));
  const bodyColor = avatar && avatar.state === 'working' ? '#facc15' : '#a3e635';
  // Body.
  ctx.strokeStyle = '#1e293b';
  ctx.lineWidth = 2;
  ctx.fillStyle = bodyColor;
  ctx.beginPath();
  ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  // Hat — hue from branch hash, sits on top of the head.
  const hue = typeof avatar?.hatHue === 'number' ? avatar.hatHue : 200;
  ctx.fillStyle = `hsl(${hue}, 70%, 55%)`;
  ctx.beginPath();
  ctx.ellipse(centerX, centerY - radius * 0.7, radius * 0.9, radius * 0.45, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillRect(centerX - radius * 1.1, centerY - radius * 0.7, radius * 2.2, 2);
  // Eye + direction nose.
  const dir = avatar?.direction || 'down';
  const angle = DIRECTION_ANGLE[dir] ?? Math.PI / 2;
  const nx = Math.cos(angle) * radius * 0.85;
  const ny = Math.sin(angle) * radius * 0.35;
  ctx.fillStyle = '#1e293b';
  ctx.beginPath();
  ctx.arc(centerX + nx * 0.6 - 3, centerY + ny, 1.5, 0, Math.PI * 2);
  ctx.arc(centerX + nx * 0.6 + 3, centerY + ny, 1.5, 0, Math.PI * 2);
  ctx.fill();
  // Legs with walk phase.
  if (walkPhase !== null && walkPhase !== undefined) {
    const stride = walkPhase === 0 ? -2 : 2;
    ctx.strokeStyle = '#1e293b';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(centerX - 3, centerY + radius - 1);
    ctx.lineTo(centerX - 3 + stride, centerY + radius + 4);
    ctx.moveTo(centerX + 3, centerY + radius - 1);
    ctx.lineTo(centerX + 3 - stride, centerY + radius + 4);
    ctx.stroke();
  }
}
