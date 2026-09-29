import type { Cutout, CutoutShape, Pt } from "./types";

export const GRIDFINITY = {
  cellSize: 42,
  clearance: 0.5,
  unitHeight: 7,
  /** Foot profile, bottom to top: 45° chamfer, vertical, 45° chamfer (total 4.75 mm). */
  footChamferLow: 0.8,
  footVertical: 1.8,
  footChamferHigh: 2.15,
  /** Outer corner radius of a bin. */
  outerRadius: 3.75,
  /** Stacking lip profile, bottom to top: 45° chamfer, vertical, 45° chamfer. */
  lipChamferLow: 0.7,
  lipVertical: 1.8,
  lipChamferHigh: 1.9,
  /** Flat land left on top of the lip so the rim has no knife edge. */
  lipTopLand: 0.5,
  /** Magnet holes sit this far from each cell centre, on both axes. */
  magnetInset: 13,
} as const;

export const FOOT_HEIGHT = GRIDFINITY.footChamferLow + GRIDFINITY.footVertical + GRIDFINITY.footChamferHigh;
export const LIP_HEIGHT = GRIDFINITY.lipChamferLow + GRIDFINITY.lipVertical + GRIDFINITY.lipChamferHigh;

export const TOLERANCE_PRESETS = { none: 0, small: 1.5, medium: 3, large: 4.5 } as const;

export function signedArea(pts: Pt[]): number {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1];
  return a / 2;
}

/** Counter-clockwise copy with consecutive duplicates and the closing point removed. */
export function normalizePolygon(pts: Pt[], minSegment = 0.05): Pt[] {
  const out: Pt[] = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) >= minSegment) out.push([p[0], p[1]]);
  }
  while (out.length > 2 && Math.hypot(out[0][0] - out[out.length - 1][0], out[0][1] - out[out.length - 1][1]) < minSegment) out.pop();
  if (out.length < 3) throw new Error("Outline needs at least 3 distinct points");
  return signedArea(out) < 0 ? out.reverse() : out;
}

export function centroid(pts: Pt[]): Pt {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const f = pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1];
    a += f;
    cx += (pts[j][0] + pts[i][0]) * f;
    cy += (pts[j][1] + pts[i][1]) * f;
  }
  if (Math.abs(a) < 1e-9) {
    const n = pts.length;
    return [pts.reduce((s, p) => s + p[0], 0) / n, pts.reduce((s, p) => s + p[1], 0) / n];
  }
  return [cx / (3 * a), cy / (3 * a)];
}

/** Angle (radians) of the polygon's long axis, from the covariance of its vertices. */
export function principalAngle(pts: Pt[]): number {
  const [mx, my] = centroid(pts);
  let sxx = 0, syy = 0, sxy = 0;
  for (const [x, y] of pts) {
    sxx += (x - mx) ** 2;
    syy += (y - my) ** 2;
    sxy += (x - mx) * (y - my);
  }
  return 0.5 * Math.atan2(2 * sxy, sxx - syy);
}

/** Half-extents of the polygon measured along a direction (radians), from `origin`. */
export function extentAlong(pts: Pt[], angle: number, origin: Pt): { min: number; max: number } {
  const ux = Math.cos(angle), uy = Math.sin(angle);
  let min = Infinity, max = -Infinity;
  for (const [x, y] of pts) {
    const d = (x - origin[0]) * ux + (y - origin[1]) * uy;
    min = Math.min(min, d);
    max = Math.max(max, d);
  }
  return { min, max };
}

export interface Bounds2 { minX: number; minY: number; maxX: number; maxY: number }

export function shapePoints(shape: CutoutShape, segments = 48): Pt[] {
  switch (shape.kind) {
    case "polygon":
      return shape.points;
    case "circle": {
      const r = shape.diameter / 2;
      return Array.from({ length: segments }, (_, i) => {
        const t = (i / segments) * Math.PI * 2;
        return [shape.center[0] + r * Math.cos(t), shape.center[1] + r * Math.sin(t)] as Pt;
      });
    }
    case "roundedRect": {
      const a = ((shape.angleDeg ?? 0) * Math.PI) / 180;
      const hw = shape.width / 2, hh = shape.height / 2;
      return ([[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]] as Pt[]).map(([x, y]) => [
        shape.center[0] + x * Math.cos(a) - y * Math.sin(a),
        shape.center[1] + x * Math.sin(a) + y * Math.cos(a),
      ]);
    }
  }
}

export function boundsOf(cutouts: Cutout[], grow = 0): Bounds2 {
  const b: Bounds2 = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const c of cutouts) {
    for (const [x, y] of shapePoints(c.shape)) {
      b.minX = Math.min(b.minX, x); b.minY = Math.min(b.minY, y);
      b.maxX = Math.max(b.maxX, x); b.maxY = Math.max(b.maxY, y);
    }
  }
  if (!Number.isFinite(b.minX)) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  return { minX: b.minX - grow, minY: b.minY - grow, maxX: b.maxX + grow, maxY: b.maxY + grow };
}

/**
 * Plan tiles along cell boundaries so each piece fits the bed. Splitting on cell
 * lines keeps every foot whole, so each tile still seats in a baseplate on its own.
 */
export function planTiles(cellsX: number, cellsY: number, cellSize: number, clearance: number, maxPlate?: { width: number; height: number }) {
  const fit = (limit: number | undefined, cells: number) => {
    if (!limit) return cells;
    const n = Math.floor((limit + clearance) / cellSize);
    if (n < 1) throw new Error(`Bed dimension ${limit} mm is smaller than one ${cellSize} mm cell`);
    return Math.min(cells, n);
  };
  const perX = fit(maxPlate?.width, cellsX);
  const perY = fit(maxPlate?.height, cellsY);
  const split = (cells: number, per: number) => {
    const count = Math.ceil(cells / per);
    const base = Math.floor(cells / count), extra = cells % count;
    const spans: [number, number][] = [];
    let at = 0;
    for (let i = 0; i < count; i++) {
      const n = base + (i < extra ? 1 : 0);
      spans.push([at, n]);
      at += n;
    }
    return spans;
  };
  const tiles: { index: number; cellX0: number; cellY0: number; cellsX: number; cellsY: number }[] = [];
  for (const [y0, ny] of split(cellsY, perY)) {
    for (const [x0, nx] of split(cellsX, perX)) {
      tiles.push({ index: tiles.length, cellX0: x0, cellY0: y0, cellsX: nx, cellsY: ny });
    }
  }
  return tiles;
}
