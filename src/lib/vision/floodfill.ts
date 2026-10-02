// No-AI fallback segmentation, used when the model can't load or the user picks "Simple".
//
// Paper: the bright region under the click (Otsu threshold on brightness), which copes with the
// shading a phone photo puts across a white sheet.
// Tools: everything under the click that doesn't look like paper, compared with the paper's
// local brightness so soft shadows stay out, clipped to the sheet so it can't run off into the table.
import type { Mask, Vec2 } from "./mask";

const lumAt = (rgba: Uint8ClampedArray, i: number) => 0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2];

function otsu(values: Uint8Array): number {
  const hist = new Float64Array(256);
  for (const v of values) hist[v]++;
  const total = values.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 0, thr = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > best) { best = between; thr = t; }
  }
  return thr;
}

/** 4-connected component of `mask` containing (x, y). */
function componentAt(mask: Uint8Array, w: number, h: number, x: number, y: number): Uint8Array {
  const out = new Uint8Array(w * h);
  // Clamp: a click in the last half-pixel would otherwise round onto the next row.
  const seed = Math.min(h - 1, Math.max(0, Math.round(y))) * w + Math.min(w - 1, Math.max(0, Math.round(x)));
  if (!mask[seed]) return out;
  const q = new Int32Array(w * h);
  let head = 0, tail = 0;
  q[tail++] = seed;
  out[seed] = 1;
  while (head < tail) {
    const p = q[head++];
    const px = p % w;
    if (px > 0 && mask[p - 1] && !out[p - 1]) { out[p - 1] = 1; q[tail++] = p - 1; }
    if (px < w - 1 && mask[p + 1] && !out[p + 1]) { out[p + 1] = 1; q[tail++] = p + 1; }
    if (p >= w && mask[p - w] && !out[p - w]) { out[p - w] = 1; q[tail++] = p - w; }
    if (p < w * (h - 1) && mask[p + w] && !out[p + w]) { out[p + w] = 1; q[tail++] = p + w; }
  }
  return out;
}

/** Fill enclosed holes (a wrench's ring, a socket's hex) so the outline is the outer edge. */
function fillHoles(mask: Uint8Array, w: number, h: number): Uint8Array {
  const outside = new Uint8Array(w * h);
  const q = new Int32Array(w * h);
  let head = 0, tail = 0;
  const push = (p: number) => { if (!mask[p] && !outside[p]) { outside[p] = 1; q[tail++] = p; } };
  for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
  while (head < tail) {
    const p = q[head++];
    const px = p % w;
    if (px > 0) push(p - 1);
    if (px < w - 1) push(p + 1);
    if (p >= w) push(p - w);
    if (p < w * (h - 1)) push(p + w);
  }
  const out = new Uint8Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = outside[i] ? 0 : 1;
  return out;
}

export function paperSelect(rgba: Uint8ClampedArray, w: number, h: number, x: number, y: number): Mask {
  const lum = new Uint8Array(w * h);
  for (let i = 0; i < lum.length; i++) lum[i] = lumAt(rgba, i);
  const t = otsu(lum);
  const bright = new Uint8Array(w * h);
  for (let i = 0; i < lum.length; i++) bright[i] = lum[i] > t ? 1 : 0;
  return { data: componentAt(bright, w, h, x, y), width: w, height: h };
}

/**
 * Smooth estimate of the paper's local brightness: block maxima on a coarse grid, a wide max
 * filter (so tools up to ~R cells across read as "on paper", not as paper), then a blur.
 * Shading from the lens or a lamp varies slowly, so the coarse grid is enough.
 */
function localPaperBrightness(lum: Float32Array, w: number, h: number): (x: number, y: number) => number {
  const B = 8;
  const gw = Math.ceil(w / B), gh = Math.ceil(h / B);
  const grid = new Float32Array(gw * gh);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const g = ((y / B) | 0) * gw + ((x / B) | 0);
    if (lum[y * w + x] > grid[g]) grid[g] = lum[y * w + x];
  }
  const R = Math.max(6, Math.round(Math.min(gw, gh) / 10));
  const pass = (src: Float32Array, horizontal: boolean, op: "max" | "mean", r: number) => {
    const out = new Float32Array(gw * gh);
    for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
      let acc = op === "max" ? 0 : 0, n = 0;
      for (let k = -r; k <= r; k++) {
        const xx = horizontal ? x + k : x, yy = horizontal ? y : y + k;
        if (xx < 0 || yy < 0 || xx >= gw || yy >= gh) continue;
        const v = src[yy * gw + xx];
        if (op === "max") acc = Math.max(acc, v); else { acc += v; n++; }
      }
      out[y * gw + x] = op === "max" ? acc : acc / n;
    }
    return out;
  };
  let m = pass(pass(grid, true, "max", R), false, "max", R);
  m = pass(pass(m, true, "mean", 3), false, "mean", 3);
  return (x, y) => m[Math.min(gh - 1, (y / B) | 0) * gw + Math.min(gw - 1, (x / B) | 0)];
}

function insideQuad(quad: Vec2[], w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const py = y + 0.5;
    const xs: number[] = [];
    for (let i = 0, j = quad.length - 1; i < quad.length; j = i++) {
      const [xi, yi] = quad[i], [xj, yj] = quad[j];
      if (yi > py !== yj > py) xs.push(((xj - xi) * (py - yi)) / (yj - yi) + xi);
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      for (let x = Math.max(0, Math.ceil(xs[k] - 0.5)); x <= Math.min(w - 1, Math.floor(xs[k + 1] - 0.5)); x++) out[y * w + x] = 1;
    }
  }
  return out;
}

export interface ToolSelection { mask: Mask; touchesEdge: boolean }

/** Everything connected to the click that isn't paper, within the sheet. */
export function toolSelectOnPaper(rgba: Uint8ClampedArray, w: number, h: number, x: number, y: number, quad: Vec2[]): ToolSelection {
  // Work at reduced resolution for the brightness model, full resolution for the mask.
  const lum = new Float32Array(w * h);
  for (let i = 0; i < lum.length; i++) lum[i] = lumAt(rgba, i);
  const bg = localPaperBrightness(lum, w, h);
  const sheet = insideQuad(quad, w, h);
  const notPaper = new Uint8Array(w * h);
  for (let i = 0; i < notPaper.length; i++) {
    if (!sheet[i]) continue;
    const R = rgba[i * 4], G = rgba[i * 4 + 1], B = rgba[i * 4 + 2];
    const chroma = Math.max(R, G, B) - Math.min(R, G, B);
    notPaper[i] = lum[i] < 0.72 * bg(i % w, (i / w) | 0) || chroma > 60 ? 1 : 0;
  }
  // If the click landed on a highlight, start from the nearest non-paper pixel instead.
  const sx = Math.min(w - 1, Math.max(0, Math.round(x))), sy = Math.min(h - 1, Math.max(0, Math.round(y)));
  if (!notPaper[sy * w + sx]) {
    let best = Infinity;
    for (let dy = -15; dy <= 15; dy++) for (let dx = -15; dx <= 15; dx++) {
      const px = sx + dx, py = sy + dy;
      if (px < 0 || py < 0 || px >= w || py >= h || !notPaper[py * w + px]) continue;
      const d = dx * dx + dy * dy;
      if (d < best) { best = d; x = px; y = py; }
    }
  }
  const comp = componentAt(notPaper, w, h, x, y);
  // Does the selection run into the sheet's edge? Then part of the tool may be off the paper.
  let touchesEdge = false;
  for (let i = 0; i < comp.length && !touchesEdge; i++) {
    if (!comp[i]) continue;
    const px = i % w, py = (i - px) / w;
    if ((px > 0 && !sheet[i - 1]) || (px < w - 1 && !sheet[i + 1]) || (py > 0 && !sheet[i - w]) || (py < h - 1 && !sheet[i + w])) touchesEdge = true;
  }
  return { mask: { data: fillHoles(comp, w, h), width: w, height: h }, touchesEdge };
}

/** Plain colour flood from the click; the last resort before the sheet has been found. */
export function floodSelect(rgba: Uint8ClampedArray, width: number, height: number, x: number, y: number, tolerance = 28): Mask {
  const out = new Uint8Array(width * height);
  const sx = Math.min(width - 1, Math.max(0, Math.round(x)));
  const sy = Math.min(height - 1, Math.max(0, Math.round(y)));
  let r = 0, g = 0, b = 0, n = 0;
  for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
    const px = sx + dx, py = sy + dy;
    if (px < 0 || py < 0 || px >= width || py >= height) continue;
    const i = (py * width + px) * 4;
    r += rgba[i]; g += rgba[i + 1]; b += rgba[i + 2]; n++;
  }
  r /= n; g /= n; b /= n;
  const t2 = tolerance * tolerance * 3;
  const queue = new Int32Array(width * height);
  let head = 0, tail = 0;
  const seed = sy * width + sx;
  queue[tail++] = seed;
  out[seed] = 1;
  while (head < tail) {
    const p = queue[head++];
    const px = p % width, py = (p - px) / width;
    const nbrs = [px > 0 ? p - 1 : -1, px < width - 1 ? p + 1 : -1, py > 0 ? p - width : -1, py < height - 1 ? p + width : -1];
    for (const q of nbrs) {
      if (q < 0 || out[q]) continue;
      const i = q * 4;
      const d = (rgba[i] - r) ** 2 + (rgba[i + 1] - g) ** 2 + (rgba[i + 2] - b) ** 2;
      if (d <= t2) { out[q] = 1; queue[tail++] = q; }
    }
  }
  return { data: out, width, height };
}
