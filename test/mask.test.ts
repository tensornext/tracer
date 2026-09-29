import { describe, expect, it } from "vitest";
import { floodSelect, paperSelect, toolSelectOnPaper } from "../src/lib/vision/floodfill";
import { dilate, erode, largestComponent, maskArea, traceOuter, type Mask, type Vec2 } from "../src/lib/vision/mask";
import { fitPaper } from "../src/lib/vision/quad";

function blank(w: number, h: number): Mask {
  return { data: new Uint8Array(w * h), width: w, height: h };
}

/** Rasterise a polygon by pixel-centre inside test. */
function fillPoly(m: Mask, poly: Vec2[]) {
  for (let y = 0; y < m.height; y++) {
    for (let x = 0; x < m.width; x++) {
      const px = x + 0.5, py = y + 0.5;
      let inside = false;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const [xi, yi] = poly[i], [xj, yj] = poly[j];
        if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
      }
      if (inside) m.data[y * m.width + x] = 1;
    }
  }
}

const shoelace = (p: Vec2[]) => Math.abs(p.reduce((s, a, i) => s + a[0] * p[(i + 1) % p.length][1] - p[(i + 1) % p.length][0] * a[1], 0)) / 2;

describe("mask tracing", () => {
  it("traces a rectangle along its pixel edges (exact size)", () => {
    const m = blank(60, 80);
    for (let y = 20; y < 50; y++) for (let x = 10; x < 30; x++) m.data[y * 60 + x] = 1;
    const pts = traceOuter(m);
    expect(pts.length).toBe(4);
    expect(shoelace(pts)).toBe(20 * 30);
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    expect([Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]).toEqual([10, 30, 20, 50]);
  });

  it("keeps only the largest region and handles concave shapes", () => {
    const m = blank(100, 100);
    fillPoly(m, [[10, 10], [60, 10], [60, 60], [40, 60], [40, 30], [10, 30]]); // L-shape
    fillPoly(m, [[80, 80], [85, 80], [85, 85], [80, 85]]); // speck
    const lc = largestComponent(m);
    expect(maskArea(lc)).toBeLessThan(maskArea(m));
    const pts = traceOuter(m);
    expect(Math.abs(shoelace(pts) - maskArea(lc))).toBeLessThan(1);
  });

  it("dilate then erode restores a solid block", () => {
    const m = blank(50, 50);
    for (let y = 10; y < 40; y++) for (let x = 10; x < 40; x++) m.data[y * 50 + x] = 1;
    expect(maskArea(erode(dilate(m, 3), 3))).toBe(maskArea(m));
    expect(maskArea(erode(m, 2))).toBe(26 * 26);
  });
});

describe("paper fit", () => {
  const W = 800, H = 600;
  const truth: Vec2[] = [[210, 75], [615, 95], [590, 540], [190, 515]];

  it("recovers corners through a notch left by a tool on the edge", () => {
    const paper = blank(W, H);
    fillPoly(paper, truth);
    const tool = blank(W, H);
    fillPoly(tool, [[150, 260], [350, 250], [350, 290], [150, 300]]);
    for (let i = 0; i < paper.data.length; i++) if (tool.data[i]) paper.data[i] = 0; // tool hides that part of the sheet
    const fit = fitPaper(paper, [tool]);
    const err = fit.corners.map((c, i) => Math.hypot(c[0] - truth[i][0], c[1] - truth[i][1]));
    expect(Math.max(...err)).toBeLessThan(1.5);
    expect(fit.fill).toBeGreaterThan(0.95);
  });

  it("still fits well with the notch and no tool mask", () => {
    const paper = blank(W, H);
    fillPoly(paper, truth);
    fillPoly(paper, [[190, 280], [260, 280], [260, 300], [190, 300]].map(([x, y]) => [x, y]) as Vec2[]);
    const fit = fitPaper(paper);
    const err = fit.corners.map((c, i) => Math.hypot(c[0] - truth[i][0], c[1] - truth[i][1]));
    expect(Math.max(...err)).toBeLessThan(2);
  });
});

describe("flood select", () => {
  it("selects the clicked dark tool on light paper", () => {
    const w = 120, h = 80;
    const rgba = new Uint8ClampedArray(w * h * 4).fill(235);
    for (let y = 30; y < 50; y++) for (let x = 20; x < 90; x++) {
      const i = (y * w + x) * 4;
      rgba[i] = 30; rgba[i + 1] = 32; rgba[i + 2] = 35;
    }
    const m = floodSelect(rgba, w, h, 50, 40);
    expect(maskArea(m)).toBe(70 * 20);
  });
});

describe("simple-mode selection on a shaded photo", () => {
  // 600×450 photo: wood table, a tilted sheet with strong vignette, a dark bar with a soft shadow,
  // a red handle joined to a grey shaft, and nothing else.
  const W = 600, H = 450;
  const quad: Vec2[] = [[150, 40], [455, 55], [440, 430], [135, 415]];
  const rgba = new Uint8ClampedArray(W * H * 4);
  const inQuad = (x: number, y: number) => {
    let r = false;
    for (let i = 0, j = 3; i < 4; j = i++) {
      const [xi, yi] = quad[i], [xj, yj] = quad[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) r = !r;
    }
    return r;
  };
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    const v = 1 - 0.35 * (((x - W / 2) / (W / 2)) ** 2 + ((y - H / 2) / (H / 2)) ** 2); // strong vignette
    let c = inQuad(x + 0.5, y + 0.5) ? [242 * v, 240 * v, 235 * v] : [150 * v, 104 * v, 66 * v];
    // soft shadow down-right of the bar
    if (x >= 206 && x < 346 && y >= 106 && y < 136) c = c.map((k) => k * 0.86);
    if (x >= 200 && x < 340 && y >= 100 && y < 130) c = [55, 58, 62];
    if (x >= 220 && x < 300 && y >= 300 && y < 330) c = [180, 40, 32]; // red handle
    if (x >= 300 && x < 380 && y >= 310 && y < 320) c = [95, 99, 105]; // grey shaft
    rgba[i] = c[0]; rgba[i + 1] = c[1]; rgba[i + 2] = c[2]; rgba[i + 3] = 255;
  }

  it("finds the whole sheet despite the vignette", () => {
    const m = paperSelect(rgba, W, H, 400, 250);
    const fit = fitPaper(m);
    const err = fit.corners.map((c, i) => Math.hypot(c[0] - quad[i][0], c[1] - quad[i][1]));
    expect(Math.max(...err)).toBeLessThan(2.5);
  });

  it("selects the bar without its shadow", () => {
    const { mask, touchesEdge } = toolSelectOnPaper(rgba, W, H, 270, 115, quad);
    expect(maskArea(mask)).toBe(140 * 30);
    expect(touchesEdge).toBe(false);
  });

  it("joins a two-colour tool and ignores the table", () => {
    const { mask } = toolSelectOnPaper(rgba, W, H, 260, 315, quad);
    expect(maskArea(mask)).toBe(80 * 30 + 80 * 10);
  });
});
