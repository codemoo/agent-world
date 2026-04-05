#!/usr/bin/env python3
"""
Analyze PNG asset sheets for non-empty cells and cell-level connected
components.

Input (stdin, JSON):
  {
    "jobs": [
      { "path": "/abs/path/to.png",
        "cellWidth": 48, "cellHeight": 48,
        "mode": "cells" | "components",
        "maxComponentCells": 9 }
    ]
  }

Output (stdout, JSON):
  {
    "/abs/path/to.png": {
      "cols": int, "rows": int,
      "nonEmptyCells": [[r, c], ...],       # per-cell non-empty list
      "components": [                        # only when mode=="components"
        { "x":..,"y":..,"width":..,"height":..,
          "cells":[[r,c],...],
          "cellRange":[r0,c0,r1,c1] }
      ]
    }
  }

Components are built from 4-connected regions of non-empty cells (not pixels).
Components larger than maxComponentCells are split into individual 1-cell props
(this keeps autotile strips atomic while preserving small multi-cell objects).
"""
import json
import sys
from PIL import Image
import numpy as np
from scipy import ndimage

ALPHA_THRESHOLD = 8  # treat alpha > 8 as content


def analyze(job):
    img = Image.open(job['path']).convert('RGBA')
    W, H = img.size
    cw = int(job['cellWidth'])
    ch = int(job['cellHeight'])
    cols = W // cw
    rows = H // ch
    mode = job.get('mode', 'cells')
    max_cells = int(job.get('maxComponentCells', 9))

    arr = np.array(img)
    alpha = arr[:, :, 3]
    mask = alpha > ALPHA_THRESHOLD

    # Build cell-level mask: cell_mask[r, c] = True if any pixel in that cell is solid.
    cell_mask = np.zeros((rows, cols), dtype=bool)
    non_empty_cells = []
    for r in range(rows):
        for c in range(cols):
            cell = mask[r * ch:(r + 1) * ch, c * cw:(c + 1) * cw]
            if cell.any():
                cell_mask[r, c] = True
                non_empty_cells.append([int(r), int(c)])

    result = {
        'cols': int(cols),
        'rows': int(rows),
        'nonEmptyCells': non_empty_cells,
        'components': [],
    }

    if mode != 'components':
        return result

    # Build cell-boundary-crossing adjacency: two adjacent non-empty cells are
    # linked only if solid pixels actually straddle the shared boundary.
    # This separates tightly-packed-but-distinct objects, while joining
    # multi-cell objects (tree, house) whose art crosses the cell boundary.
    cross = np.zeros((rows, cols, 2), dtype=bool)  # [r, c, 0]=right, [r, c, 1]=down

    # Horizontal boundaries (cell (r,c) | (r,c+1)): boundary is at pixel col (c+1)*cw
    for r in range(rows):
        for c in range(cols - 1):
            if not (cell_mask[r, c] and cell_mask[r, c + 1]):
                continue
            x = (c + 1) * cw
            col_a = mask[r * ch:(r + 1) * ch, x - 1]
            col_b = mask[r * ch:(r + 1) * ch, x]
            if (col_a & col_b).any():
                cross[r, c, 0] = True
    # Vertical boundaries (cell (r,c) | (r+1,c)): boundary is at pixel row (r+1)*ch
    for r in range(rows - 1):
        for c in range(cols):
            if not (cell_mask[r, c] and cell_mask[r + 1, c]):
                continue
            y = (r + 1) * ch
            row_a = mask[y - 1, c * cw:(c + 1) * cw]
            row_b = mask[y, c * cw:(c + 1) * cw]
            if (row_a & row_b).any():
                cross[r, c, 1] = True

    # Union-find over cells using the crossing edges
    parent = list(range(rows * cols))
    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i
    def union(i, j):
        ri, rj = find(i), find(j)
        if ri != rj:
            parent[rj] = ri
    for r in range(rows):
        for c in range(cols):
            if not cell_mask[r, c]:
                continue
            if c + 1 < cols and cross[r, c, 0]:
                union(r * cols + c, r * cols + c + 1)
            if r + 1 < rows and cross[r, c, 1]:
                union(r * cols + c, (r + 1) * cols + c)

    # Collect components
    groups = {}
    for r in range(rows):
        for c in range(cols):
            if not cell_mask[r, c]:
                continue
            root = find(r * cols + c)
            groups.setdefault(root, []).append((r, c))

    # Build labeled-like structure from groups so downstream code is unchanged
    labeled = np.zeros((rows, cols), dtype=np.int32)
    for i, cells in enumerate(groups.values(), start=1):
        for (r, c) in cells:
            labeled[r, c] = i
    n = len(groups)

    for label_id in range(1, n + 1):
        ys, xs = np.where(labeled == label_id)
        cell_count = len(ys)
        if cell_count == 0:
            continue

        cells = [[int(r), int(c)] for r, c in zip(ys, xs)]
        if cell_count > max_cells:
            # Too big — probably an autotile/transition strip. Emit each cell
            # as its own single-cell component.
            for r, c in cells:
                result['components'].append(make_rect(r, c, r, c, cw, ch, [[r, c]]))
            continue

        r0, r1 = int(ys.min()), int(ys.max())
        c0, c1 = int(xs.min()), int(xs.max())
        # If the bbox is mostly-filled (sparse single cells arranged in an L etc.),
        # the bbox is still usable as a single multi-cell prop.
        result['components'].append(make_rect(r0, c0, r1, c1, cw, ch, cells))

    # Sort by top-left for stable output
    result['components'].sort(key=lambda r: (r['y'], r['x']))
    return result


def make_rect(r0, c0, r1, c1, cw, ch, cells):
    return {
        'x': int(c0 * cw),
        'y': int(r0 * ch),
        'width': int((c1 - c0 + 1) * cw),
        'height': int((r1 - r0 + 1) * ch),
        'cells': cells,
        'cellRange': [int(r0), int(c0), int(r1), int(c1)],
    }


def main():
    payload = json.load(sys.stdin)
    jobs = payload.get('jobs', [])
    out = {}
    for job in jobs:
        try:
            out[job['path']] = analyze(job)
        except Exception as e:
            out[job['path']] = {'error': str(e)}
    json.dump(out, sys.stdout)


if __name__ == '__main__':
    main()
