// Outline clean-up after segmentation, done in millimetres (after the paper homography) so the
// settings mean the same thing at any photo resolution.
//
// Two presets mirror the product's modes: "fast" smooths harder and simplifies, "detail"
// keeps small features (teeth, notches) and skips simplification.

export type Vec2 = [number, number];

export interface SmoothOptions {
  /** Resampling step along the outline, mm. */
  step?: number;
  /** Gaussian smoothing radius, mm. 0 disables. */
  sigma?: number;
  /** Douglas–Peucker tolerance, mm. 0 disables. */
  epsilon?: number;
}

export const SMOOTH_PRESETS: Record<"fast" | "detail", Required<SmoothOptions>> = {
  fast: { step: 0.5, sigma: 1.2, epsilon: 0.15 },
  detail: { step: 0.25, sigma: 0.4, epsilon: 0 },
};

/** Evenly resample a closed polyline every `step` mm. */
export function resampleClosed(pts: Vec2[], step: number): Vec2[] {
  const n = pts.length;
  const seg: number[] = [];
  let total = 0;
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
    seg.push(d);
    total += d;
  }
  if (total === 0) return pts.slice();
  const count = Math.max(8, Math.round(total / step));
  const spacing = total / count;
  const out: Vec2[] = [];
  let i = 0, acc = 0;
  for (let k = 0; k < count; k++) {
    const target = k * spacing;
    while (acc + seg[i] < target && i < n - 1) { acc += seg[i]; i++; }
    const t = seg[i] > 0 ? (target - acc) / seg[i] : 0;
    const a = pts[i], b = pts[(i + 1) % n];
    out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
  }
  return out;
}

/** Circular Gaussian smoothing of an evenly spaced closed polyline. */
export function gaussianClosed(pts: Vec2[], sigmaSamples: number): Vec2[] {
  if (sigmaSamples <= 0) return pts.slice();
  const r = Math.ceil(sigmaSamples * 3);
  const w: number[] = [];
  let sum = 0;
  for (let k = -r; k <= r; k++) { const v = Math.exp(-(k * k) / (2 * sigmaSamples * sigmaSamples)); w.push(v); sum += v; }
  const n = pts.length;
  return pts.map((_, i) => {
    let x = 0, y = 0;
    for (let k = -r; k <= r; k++) {
      const p = pts[(((i + k) % n) + n) % n];
      const f = w[k + r] / sum;
      x += p[0] * f;
      y += p[1] * f;
    }
    return [x, y] as Vec2;
  });
}

function perpDist(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  if (len === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  return Math.abs(dy * p[0] - dx * p[1] + b[0] * a[1] - b[1] * a[0]) / len;
}

function rdp(pts: Vec2[], eps: number): Vec2[] {
  if (pts.length < 3) return pts;
  let idx = 0, max = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = perpDist(pts[i], pts[0], pts[pts.length - 1]);
    if (d > max) { max = d; idx = i; }
  }
  if (max <= eps) return [pts[0], pts[pts.length - 1]];
  const left = rdp(pts.slice(0, idx + 1), eps);
  const right = rdp(pts.slice(idx), eps);
  return [...left.slice(0, -1), ...right];
}

/** Douglas–Peucker for a closed ring, split at the two mutually farthest-apart points. */
export function simplifyClosed(pts: Vec2[], eps: number): Vec2[] {
  if (eps <= 0 || pts.length < 4) return pts.slice();
  let far = 0, best = 0;
  for (let i = 1; i < pts.length; i++) {
    const d = Math.hypot(pts[i][0] - pts[0][0], pts[i][1] - pts[0][1]);
    if (d > best) { best = d; far = i; }
  }
  const a = rdp(pts.slice(0, far + 1), eps);
  const b = rdp([...pts.slice(far), pts[0]], eps);
  return [...a.slice(0, -1), ...b.slice(0, -1)];
}

export function smoothOutline(ptsMm: Vec2[], opts: SmoothOptions | keyof typeof SMOOTH_PRESETS = "fast"): Vec2[] {
  const o = typeof opts === "string" ? SMOOTH_PRESETS[opts] : { ...SMOOTH_PRESETS.fast, ...opts };
  const even = resampleClosed(ptsMm, o.step);
  const smooth = gaussianClosed(even, o.sigma / o.step);
  return simplifyClosed(smooth, o.epsilon);
}
