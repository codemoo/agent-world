#!/usr/bin/env python3
"""
Analyze CuteRPG_Interior_B.png tileset to find standalone furniture sprites.

The tileset is 768x768, with a 16x16 grid of 48px cells.
Classification:
  - autotile: < 15% transparent pixels (solid fills, not standalone objects)
  - standalone: 15-90% transparent (usable furniture/object sprites)
  - empty: > 90% transparent
"""

from PIL import Image
from collections import Counter

TILESET_PATH = (
    "/Users/hwanmooy/Dropbox/dev/agent-world/assets/pixymoon/"
    "Cute RPG World/Cute RPG World (RPG Maker)/"
    "Cute RPG World - RPG Maker MZ/tilesets/CuteRPG_Interior_B.png"
)
OUTPUT_PATH = "/Users/hwanmooy/Dropbox/dev/agent-world/scripts/interior_b_analysis.txt"

CELL_SIZE = 48
GRID_SIZE = 16  # 16x16 grid


def get_dominant_colors(cell_img, top_n=3):
    """Get the top N dominant non-transparent colors in a cell."""
    pixels = list(cell_img.getdata())
    opaque_pixels = [(r, g, b) for r, g, b, a in pixels if a > 128]
    if not opaque_pixels:
        return []
    
    counter = Counter(opaque_pixels)
    top_colors = counter.most_common(top_n)
    
    results = []
    total_opaque = len(opaque_pixels)
    for (r, g, b), count in top_colors:
        pct = count / total_opaque * 100
        name = color_name(r, g, b)
        results.append(f"#{r:02x}{g:02x}{b:02x} ({name}, {pct:.0f}%)")
    return results


def color_name(r, g, b):
    """Rough color name based on RGB values."""
    brightness = (r + g + b) / 3
    
    if brightness < 40:
        return "black"
    if brightness > 220 and max(r, g, b) - min(r, g, b) < 30:
        return "white"
    if max(r, g, b) - min(r, g, b) < 25:
        if brightness < 100:
            return "dark gray"
        elif brightness < 170:
            return "gray"
        else:
            return "light gray"
    
    if r > g and r > b:
        if g > b + 30:
            if g > r * 0.7:
                return "yellow" if brightness > 150 else "olive"
            return "orange" if brightness > 100 else "brown"
        return "red" if brightness > 80 else "dark red"
    elif g > r and g > b:
        if r > b + 20:
            return "yellow-green"
        return "green" if brightness > 80 else "dark green"
    elif b > r and b > g:
        if r > g + 20:
            return "purple" if brightness > 80 else "dark purple"
        return "blue" if brightness > 80 else "dark blue"
    elif r > 200 and g > 200 and b < 100:
        return "yellow"
    elif r > 200 and g < 100 and b > 200:
        return "magenta"
    elif r < 100 and g > 200 and b > 200:
        return "cyan"
    else:
        return "mixed"


def analyze_tileset():
    img = Image.open(TILESET_PATH).convert("RGBA")
    
    lines = []
    lines.append("=" * 100)
    lines.append("CuteRPG_Interior_B.png Analysis")
    lines.append(f"Image size: {img.size}, Grid: {GRID_SIZE}x{GRID_SIZE}, Cell size: {CELL_SIZE}px")
    lines.append("=" * 100)
    lines.append("")
    
    header = f"{'Col':>3} {'Row':>3} | {'Transp%':>8} | {'Class':>12} | Dominant Colors"
    lines.append(header)
    lines.append("-" * 100)
    
    standalone_cells = []
    autotile_cells = []
    empty_cells = []
    
    for row in range(GRID_SIZE):
        for col in range(GRID_SIZE):
            x = col * CELL_SIZE
            y = row * CELL_SIZE
            cell = img.crop((x, y, x + CELL_SIZE, y + CELL_SIZE))
            pixels = list(cell.getdata())
            total = len(pixels)
            transparent = sum(1 for r, g, b, a in pixels if a < 10)
            transp_pct = transparent / total * 100
            
            if transp_pct > 90:
                classification = "empty"
                empty_cells.append((col, row))
                line = f"{col:>3} {row:>3} | {transp_pct:>7.1f}% | {'empty':>12} |"
            elif transp_pct < 15:
                classification = "autotile"
                autotile_cells.append((col, row))
                line = f"{col:>3} {row:>3} | {transp_pct:>7.1f}% | {'autotile':>12} |"
            else:
                classification = "standalone"
                standalone_cells.append((col, row, transp_pct))
                colors = get_dominant_colors(cell)
                color_str = ", ".join(colors) if colors else "n/a"
                line = f"{col:>3} {row:>3} | {transp_pct:>7.1f}% | {'STANDALONE':>12} | {color_str}"
            
            lines.append(line)
        
        lines.append("")
    
    lines.append("=" * 100)
    lines.append("SUMMARY")
    lines.append("=" * 100)
    lines.append(f"Total cells: {GRID_SIZE * GRID_SIZE}")
    lines.append(f"Autotile cells: {len(autotile_cells)}")
    lines.append(f"Standalone cells: {len(standalone_cells)}")
    lines.append(f"Empty cells: {len(empty_cells)}")
    lines.append("")
    
    lines.append("STANDALONE SPRITES (usable furniture/objects):")
    lines.append("-" * 60)
    for col, row, tp in standalone_cells:
        lines.append(f"  col={col:>2}, row={row:>2}  (sx={col*CELL_SIZE}, sy={row*CELL_SIZE})  transp={tp:.1f}%")
    
    lines.append("")
    lines.append("VISUAL GRID (A=autotile, S=STANDALONE, .=empty):")
    lines.append("     " + "".join(f"{c:>3}" for c in range(GRID_SIZE)))
    lines.append("    " + "-" * 49)
    for row in range(GRID_SIZE):
        row_str = f"{row:>3} |"
        for col in range(GRID_SIZE):
            if (col, row) in empty_cells:
                row_str += "  ."
            elif (col, row) in autotile_cells:
                row_str += "  A"
            else:
                row_str += "  S"
        lines.append(row_str)
    
    output = "\n".join(lines)
    print(output)
    
    with open(OUTPUT_PATH, "w") as f:
        f.write(output + "\n")
    
    print(f"\nOutput saved to: {OUTPUT_PATH}")


if __name__ == "__main__":
    analyze_tileset()
