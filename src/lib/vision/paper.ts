// Paper-based scale and perspective correction.
//
// Tooltrace measures the paper's average side lengths and applies one uniform mm-per-pixel
// scale, which is only right when the camera is square to the paper. Here the four corners
// define a full homography, so a tilted phone photo still maps to true millimetres on the
// paper plane.

export type Vec2 = [number, number];
/** Row-major 3×3 matrix. */
export type Mat3 = [number, number, number, number, number, number, number, number, number];

export const PAPER_SIZES = {
  letter: { width: 215.9, height: 279.4 },
  a4: { width: 210, height: 297 },
} as const;
export type PaperType = keyof typeof PAPER_SIZES;

/** Order four points as top-left, top-right, bottom-right, bottom-left (image coordinates, y down). */
export function orderCorners(pts: Vec2[]): [Vec2, Vec2, Vec2, Vec2] {
  if (pts.length !== 4) throw new Error("Need exactly 4 corners");
  const cx = pts.reduce((s, p) => s + p[0], 0) / 4;
  const cy = pts.reduce((s, p) => s + p[1], 0) / 4;
  const sorted = [...pts].sort((a, b) => Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx));
  // atan2 order in y-down images runs TL(-135°) → TR(-45°) → BR(45°) → BL(135°).
  let start = 0;
  let best = Infinity;
  sorted.forEach((p, i) => {
    const s = p[0] + p[1];
    if (s < best) { best = s; start = i; }
  });
  const o = [0, 1, 2, 3].map((k) => sorted[(start + k) % 4]);
  return [o[0], o[1], o[2], o[3]];
}

/** Solve the homography mapping four `src` points onto four `dst` points (DLT, h33 = 1). */
export function homographyFrom4(src: Vec2[], dst: Vec2[]): Mat3 {
  const A: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i];
    const [u, v] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    b.push(v);
  }
  const h = solve(A, b);
  return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
}

function solve(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    if (Math.abs(M[piv][c]) < 1e-12) throw new Error("Degenerate corners: three of them are collinear");
    [M[c], M[piv]] = [M[piv], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

export function applyHomography(H: Mat3, [x, y]: Vec2): Vec2 {
  const w = H[6] * x + H[7] * y + H[8];
  return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
}

export interface PaperFrame {
  /** Image pixels → paper millimetres, Y-up, origin at the paper's bottom-left corner. */
  H: Mat3;
  orientation: "portrait" | "landscape";
  width: number;
  height: number;
  /** Local scale (mm per px) at the paper centre, for UI readouts and tolerance hints. */
  mmPerPxAtCenter: number;
  /**
   * How far the photo is from square-on: the ratio of the paper's longest to shortest
   * opposite-side pair, 1.0 when shot straight down. Above ~1.15 the tools' own height
   * starts to show (parallax), so warn the user.
   */
  obliqueness: number;
}

const dist = (a: Vec2, b: Vec2) => Math.hypot(a[0] - b[0], a[1] - b[1]);

export function paperFrame(cornersPx: Vec2[], paper: PaperType): PaperFrame {
  const [tl, tr, br, bl] = orderCorners(cornersPx);
  const top = dist(tl, tr), bottom = dist(bl, br), left = dist(tl, bl), right = dist(tr, br);
  const orientation = (top + bottom) / 2 > (left + right) / 2 ? "landscape" : "portrait";
  const size = PAPER_SIZES[paper];
  const width = orientation === "portrait" ? size.width : size.height;
  const height = orientation === "portrait" ? size.height : size.width;
  // Y-up output so outlines drop straight into the CAD kernel.
  const H = homographyFrom4([tl, tr, br, bl], [[0, height], [width, height], [width, 0], [0, 0]]);
  const c: Vec2 = [(tl[0] + tr[0] + br[0] + bl[0]) / 4, (tl[1] + tr[1] + br[1] + bl[1]) / 4];
  const a = applyHomography(H, [c[0] - 0.5, c[1]]);
  const b = applyHomography(H, [c[0] + 0.5, c[1]]);
  const obliqueness = Math.max(top / bottom, bottom / top, left / right, right / left);
  return { H, orientation, width, height, mmPerPxAtCenter: dist(a, b), obliqueness };
}

/** Map a traced outline (image px) to paper millimetres. */
export function outlineToMm(outlinePx: Vec2[], frame: PaperFrame): Vec2[] {
  return outlinePx.map((p) => applyHomography(frame.H, p));
}

/** The uniform-scale approach (average side lengths), kept for comparison and tests. */
export function uniformScale(cornersPx: Vec2[], paper: PaperType): number {
  const [tl, tr, br, bl] = orderCorners(cornersPx);
  let w = (dist(tl, tr) + dist(bl, br)) / 2;
  let h = (dist(tl, bl) + dist(tr, br)) / 2;
  if (w > h) [w, h] = [h, w];
  const s = PAPER_SIZES[paper];
  return (s.width / w + s.height / h) / 2;
}
