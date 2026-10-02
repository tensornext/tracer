// Fit the paper's four corners from a segmentation mask.
//
// Tools lying across the paper edge punch notches into its mask, so touching tool masks are
// merged back first, clipped to the sheet's own convex hull so the part of a tool hanging off
// the paper can't drag a side outwards. Then: convex hull → rough quadrilateral → each side
// refit as a straight line through the boundary points near it (ignoring outliers), corners =
// line intersections.
import { closeMask, masksTouch, traceOuter, unionMasks, type Mask, type Vec2 } from "./mask";

function cross(o: Vec2, a: Vec2, b: Vec2) {
  return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
}

/** Andrew's monotone chain. Returns the hull counter-clockwise in a y-up sense (clockwise on screen). */
export function convexHull(points: Vec2[]): Vec2[] {
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return pts;
  const lower: Vec2[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Vec2[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

const area2 = (pts: Vec2[]) => {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1];
  return Math.abs(a) / 2;
};

/** Reduce a convex polygon to 4 vertices by repeatedly dropping the vertex whose removal loses the least area. */
export function reduceToQuad(hull: Vec2[]): Vec2[] {
  const pts = [...hull];
  while (pts.length > 4) {
    let best = 0, bestLoss = Infinity;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[(i - 1 + pts.length) % pts.length], b = pts[i], c = pts[(i + 1) % pts.length];
      const loss = Math.abs(cross(a, b, c)) / 2;
      if (loss < bestLoss) { bestLoss = loss; best = i; }
    }
    pts.splice(best, 1);
  }
  return pts;
}

/** Order as TL, TR, BR, BL in image coordinates (y down). */
export function orderQuad(pts: Vec2[]): Vec2[] {
  const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
  const cy = pts.reduce((s, p) => s + p[1], 0) / pts.length;
  const sorted = [...pts].sort((a, b) => Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx));
  let start = 0;
  sorted.forEach((p, i) => { if (p[0] + p[1] < sorted[start][0] + sorted[start][1]) start = i; });
  return [0, 1, 2, 3].map((k) => sorted[(start + k) % 4]);
}

type Line = { p: Vec2; d: Vec2 };

/** Total-least-squares line with two rounds of outlier rejection. */
function fitLine(points: Vec2[]): Line {
  let pts = points;
  let line: Line = { p: pts[0], d: [1, 0] };
  for (let round = 0; round < 3; round++) {
    const n = pts.length;
    const mx = pts.reduce((s, p) => s + p[0], 0) / n;
    const my = pts.reduce((s, p) => s + p[1], 0) / n;
    let sxx = 0, syy = 0, sxy = 0;
    for (const [x, y] of pts) { sxx += (x - mx) ** 2; syy += (y - my) ** 2; sxy += (x - mx) * (y - my); }
    const angle = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    line = { p: [mx, my], d: [Math.cos(angle), Math.sin(angle)] };
    if (round === 2) break;
    const res = pts.map(([x, y]) => Math.abs((x - mx) * -line.d[1] + (y - my) * line.d[0]));
    const sorted = [...res].sort((a, b) => a - b);
    const mad = sorted[Math.floor(sorted.length / 2)] || 0.5;
    const keep = pts.filter((_, i) => res[i] <= Math.max(1.0, 3 * mad));
    if (keep.length < 8) break;
    pts = keep;
  }
  return line;
}

function intersect(a: Line, b: Line): Vec2 | null {
  const det = a.d[0] * -b.d[1] - a.d[1] * -b.d[0];
  if (Math.abs(det) < 1e-9) return null;
  const dx = b.p[0] - a.p[0], dy = b.p[1] - a.p[1];
  const t = (dx * -b.d[1] - dy * -b.d[0]) / det;
  return [a.p[0] + t * a.d[0], a.p[1] + t * a.d[1]];
}

/** Densify a polyline so every edge contributes evenly spaced samples to the side fits. */
function densify(pts: Vec2[], step = 2): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const n = Math.max(1, Math.round(len / step));
    for (let k = 0; k < n; k++) out.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
  }
  return out;
}

export interface PaperFit {
  /** TL, TR, BR, BL, image pixels. */
  corners: Vec2[];
  /** Share of the fitted quad the mask actually fills; below ~0.9 the fit is suspect. */
  fill: number;
}

/** Rasterise a polygon (pixel-corner coordinates), sampling pixel centres. */
function fillPolygon(poly: Vec2[], w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const py = y + 0.5, xs: number[] = [];
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i], [xj, yj] = poly[j];
      if (yi > py !== yj > py) xs.push(((xj - xi) * (py - yi)) / (yj - yi) + xi);
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      for (let x = Math.max(0, Math.ceil(xs[k] - 0.5)); x <= Math.min(w - 1, Math.floor(xs[k + 1] - 0.5)); x++) out[y * w + x] = 1;
    }
  }
  return out;
}

export function fitPaper(paper: Mask, tools: Mask[] = []): PaperFit {
  let m = paper;
  let sheet: Uint8Array | null = null;
  for (const t of tools) {
    if (!masksTouch(t, m)) continue;
    sheet ??= fillPolygon(convexHull(traceOuter(paper)), paper.width, paper.height);
    const clipped = new Uint8Array(t.data.length);
    for (let i = 0; i < clipped.length; i++) clipped[i] = t.data[i] & sheet[i];
    m = unionMasks(m, { data: clipped, width: t.width, height: t.height });
  }
  const r = Math.max(2, Math.round(Math.min(m.width, m.height) / 300));
  m = closeMask(m, r);
  const outline = traceOuter(m);
  if (outline.length < 4) throw new Error("Couldn't find the paper. Click on an empty part of the sheet.");
  const hull = convexHull(outline);
  const rough = orderQuad(reduceToQuad(hull));
  const dense = densify(outline);
  const lines: Line[] = [];
  for (let i = 0; i < 4; i++) {
    const a = rough[i], b = rough[(i + 1) % 4];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const u: Vec2 = [(b[0] - a[0]) / L, (b[1] - a[1]) / L];
    const band = Math.max(3, 0.02 * L);
    const near = dense.filter(([x, y]) => {
      const along = (x - a[0]) * u[0] + (y - a[1]) * u[1];
      const across = Math.abs((x - a[0]) * -u[1] + (y - a[1]) * u[0]);
      return along > 0.1 * L && along < 0.9 * L && across < band;
    });
    lines.push(near.length >= 10 ? fitLine(near) : { p: a, d: u });
  }
  const corners = [0, 1, 2, 3].map((i) => intersect(lines[(i + 3) % 4], lines[i]) ?? rough[i]);
  let inside = 0;
  for (let i = 0; i < m.data.length; i++) inside += m.data[i];
  return { corners, fill: inside / Math.max(1, area2(corners)) };
}
