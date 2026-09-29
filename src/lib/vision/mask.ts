// Binary mask utilities: connected components, morphology, and outline tracing.
// Masks are Uint8Array (0/1), row-major, width × height.

export type Vec2 = [number, number];

export interface Mask { data: Uint8Array; width: number; height: number }

export function maskArea(m: Mask): number {
  let n = 0;
  for (let i = 0; i < m.data.length; i++) n += m.data[i];
  return n;
}

export function maskBounds(m: Mask): { x0: number; y0: number; x1: number; y1: number } | null {
  const { data, width: w, height: h } = m;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      if (data[row + x]) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        y1 = y;
      }
    }
  }
  return x1 < 0 ? null : { x0, y0, x1: x1 + 1, y1: y1 + 1 };
}

/** Keep only the largest 4-connected component. */
export function largestComponent(m: Mask): Mask {
  const { data, width: w, height: h } = m;
  const label = new Int32Array(w * h);
  const queue = new Int32Array(w * h);
  let bestLabel = 0, bestSize = 0, next = 0;
  for (let i = 0; i < data.length; i++) {
    if (!data[i] || label[i]) continue;
    next++;
    let head = 0, tail = 0, size = 0;
    queue[tail++] = i;
    label[i] = next;
    while (head < tail) {
      const p = queue[head++];
      size++;
      const x = p % w, y = (p - x) / w;
      if (x > 0 && data[p - 1] && !label[p - 1]) { label[p - 1] = next; queue[tail++] = p - 1; }
      if (x < w - 1 && data[p + 1] && !label[p + 1]) { label[p + 1] = next; queue[tail++] = p + 1; }
      if (y > 0 && data[p - w] && !label[p - w]) { label[p - w] = next; queue[tail++] = p - w; }
      if (y < h - 1 && data[p + w] && !label[p + w]) { label[p + w] = next; queue[tail++] = p + w; }
    }
    if (size > bestSize) { bestSize = size; bestLabel = next; }
  }
  const out = new Uint8Array(w * h);
  if (bestLabel) for (let i = 0; i < out.length; i++) out[i] = label[i] === bestLabel ? 1 : 0;
  return { data: out, width: w, height: h };
}

/** Separable square max (dilate) or min (erode) filter with radius r. */
function morph(m: Mask, r: number, dilate: boolean): Mask {
  const { width: w, height: h } = m;
  const tmp = new Uint8Array(w * h);
  const out = new Uint8Array(w * h);
  const hit = dilate ? 1 : 0;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    // Running count of "hit" pixels in the window. Pixels outside the image never count, so
    // dilation doesn't grow from the border and erosion doesn't eat into it.
    let count = 0;
    for (let x = -r; x < w + r; x++) {
      const add = x + r, drop = x - r - 1;
      if (add >= 0 && add < w) count += m.data[row + add] === hit ? 1 : 0;
      if (drop >= 0 && drop < w) count -= m.data[row + drop] === hit ? 1 : 0;
      if (x >= 0 && x < w) tmp[row + x] = dilate ? (count > 0 ? 1 : 0) : count > 0 ? 0 : 1;
    }
  }
  for (let x = 0; x < w; x++) {
    let count = 0;
    for (let y = -r; y < h + r; y++) {
      const add = y + r, drop = y - r - 1;
      if (add >= 0 && add < h) count += tmp[add * w + x] === hit ? 1 : 0;
      if (drop >= 0 && drop < h) count -= tmp[drop * w + x] === hit ? 1 : 0;
      if (y >= 0 && y < h) out[y * w + x] = dilate ? (count > 0 ? 1 : 0) : count > 0 ? 0 : 1;
    }
  }
  return { data: out, width: w, height: h };
}

export const dilate = (m: Mask, r: number) => (r > 0 ? morph(m, r, true) : m);
export const erode = (m: Mask, r: number) => (r > 0 ? morph(m, r, false) : m);
export const closeMask = (m: Mask, r: number) => erode(dilate(m, r), r);

export function unionMasks(a: Mask, b: Mask): Mask {
  const out = new Uint8Array(a.data.length);
  for (let i = 0; i < out.length; i++) out[i] = a.data[i] | b.data[i];
  return { data: out, width: a.width, height: a.height };
}

export function masksTouch(a: Mask, b: Mask, r = 3): boolean {
  const grown = dilate(a, r);
  for (let i = 0; i < grown.data.length; i++) if (grown.data[i] && b.data[i]) return true;
  return false;
}

/**
 * Outer boundary of the mask's largest region, traced along pixel edges (marching squares),
 * in pixel-corner coordinates: pixel (i, j) spans [i, i+1] × [j, j+1]. Tracing edges rather
 * than pixel centres keeps the outline's size exact.
 */
export function traceOuter(m: Mask): Vec2[] {
  const comp = largestComponent(m);
  const { data, width: w, height: h } = comp;
  const at = (x: number, y: number) => (x >= 0 && y >= 0 && x < w && y < h ? data[y * w + x] : 0);
  let sx = -1, sy = -1;
  for (let i = 0; i < data.length && sx < 0; i++) if (data[i]) { sx = i % w; sy = (i - sx) / w; }
  if (sx < 0) return [];
  // Cell (x, y) looks at pixels TL (x-1,y-1), TR (x,y-1), BL (x-1,y), BR (x,y).
  const pts: Vec2[] = [];
  let x = sx, y = sy, prev = 0; // 0 none, 1 up, 2 down, 3 left, 4 right
  const limit = 4 * (w + 2) * (h + 2);
  for (let guard = 0; guard < limit; guard++) {
    const state = (at(x - 1, y - 1) ? 1 : 0) | (at(x, y - 1) ? 2 : 0) | (at(x - 1, y) ? 4 : 0) | (at(x, y) ? 8 : 0);
    let dir: number;
    switch (state) {
      case 1: case 5: case 13: dir = 1; break;
      case 2: case 3: case 7: dir = 4; break;
      case 4: case 12: case 14: dir = 3; break;
      case 8: case 10: case 11: dir = 2; break;
      case 6: dir = prev === 1 ? 3 : 4; break;
      case 9: dir = prev === 4 ? 1 : 2; break;
      default: throw new Error(`traceOuter: unexpected cell state ${state}`);
    }
    if (dir !== prev) pts.push([x, y]); // keep corners only
    if (dir === 1) y--; else if (dir === 2) y++; else if (dir === 3) x--; else x++;
    prev = dir;
    if (x === sx && y === sy) break;
  }
  return pts;
}

/** Crop a rectangular window out of a mask. */
export function cropMask(m: Mask, x0: number, y0: number, w: number, h: number): Mask {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) out.set(m.data.subarray((y0 + y) * m.width + x0, (y0 + y) * m.width + x0 + w), y * w);
  return { data: out, width: w, height: h };
}

/** Paste a small mask into a blank full-size mask at (x0, y0). */
export function placeMask(small: Mask, fullW: number, fullH: number, x0: number, y0: number): Mask {
  const out = new Uint8Array(fullW * fullH);
  for (let y = 0; y < small.height; y++) out.set(small.data.subarray(y * small.width, (y + 1) * small.width), (y0 + y) * fullW + x0);
  return { data: out, width: fullW, height: fullH };
}

/** Fraction of `a` also covered by `b`. */
export function overlapFraction(a: Mask, b: Mask): number {
  let both = 0, inA = 0;
  for (let i = 0; i < a.data.length; i++) {
    if (a.data[i]) { inA++; if (b.data[i]) both++; }
  }
  return inA ? both / inA : 0;
}
