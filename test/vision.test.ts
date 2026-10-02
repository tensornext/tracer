import { describe, expect, it } from "vitest";
import { applyHomography, homographyFrom4, orderCorners, outlineToMm, paperFrame, uniformScale, type Vec2 } from "../src/lib/vision/paper";
import { resampleClosed, simplifyClosed, smoothOutline } from "../src/lib/vision/smoothing";

// Simulate a phone photo: paper-plane mm (Y-up) → image px through a tilted-camera homography.
const LETTER = { w: 215.9, h: 279.4 };
const camera = homographyFrom4(
  [[0, 0], [LETTER.w, 0], [LETTER.w, LETTER.h], [0, LETTER.h]],
  // A top edge noticeably shorter than the bottom: phone tilted back, ~20% keystone.
  [[380, 3620], [2660, 3580], [2380, 540], [640, 600]],
);
const toImage = (p: Vec2) => applyHomography(camera, p);

describe("paper homography", () => {
  const cornersPx = ([[0, 0], [LETTER.w, 0], [LETTER.w, LETTER.h], [0, LETTER.h]] as Vec2[]).map(toImage);

  it("orders corners regardless of input order", () => {
    const shuffled = [cornersPx[2], cornersPx[0], cornersPx[3], cornersPx[1]];
    const [tl, tr, br, bl] = orderCorners(shuffled);
    expect(tl[0]).toBeLessThan(tr[0]);
    expect(tl[1]).toBeLessThan(bl[1]);
    expect(br[1]).toBeGreaterThan(tr[1]);
  });

  it("recovers true millimetres anywhere on a tilted sheet", () => {
    const f = paperFrame(cornersPx, "letter");
    expect(f.orientation).toBe("portrait");
    for (const p of [[20, 30], [108, 140], [200, 260], [50, 250]] as Vec2[]) {
      const back = applyHomography(f.H, toImage(p));
      expect(back[0]).toBeCloseTo(p[0], 2);
      expect(back[1]).toBeCloseTo(p[1], 2);
    }
    expect(f.obliqueness).toBeGreaterThan(1.15);
  });

  it("beats a single uniform scale on a 150 mm tool", () => {
    const f = paperFrame(cornersPx, "letter");
    const a: Vec2 = [30, 200], b: Vec2 = [180, 200]; // near the far (short) edge
    const ia = toImage(a), ib = toImage(b);
    const truth = 150;
    const viaH = Math.hypot(...(applyHomography(f.H, ib).map((v, i) => v - applyHomography(f.H, ia)[i]) as Vec2));
    const s = uniformScale(cornersPx, "letter");
    const viaScale = Math.hypot(ib[0] - ia[0], ib[1] - ia[1]) * s;
    expect(Math.abs(viaH - truth)).toBeLessThan(0.01);
    expect(Math.abs(viaScale - truth)).toBeGreaterThan(5); // uniform scale is off by several mm here
  });

  it("detects landscape sheets", () => {
    const landscape = ([[0, 0], [279.4, 0], [279.4, 215.9], [0, 215.9]] as Vec2[]).map(([x, y]) => [x * 10 + 100, 2400 - y * 10] as Vec2);
    const f = paperFrame(landscape, "letter");
    expect(f.orientation).toBe("landscape");
    expect(f.width).toBeCloseTo(279.4);
    expect(f.mmPerPxAtCenter).toBeCloseTo(0.1, 3);
  });

  it("rejects corners that can't be a photographed sheet", () => {
    expect(() => paperFrame(cornersPx, "letter")).not.toThrow();
    // Two corners almost on top of each other (what a bad refit used to produce).
    expect(() => paperFrame([[550, 154], [1500, 154], [1500, 154.0000003], [550, 1384]], "letter")).toThrow();
    // A corner dragged inside the sheet: concave.
    expect(() => paperFrame([[550, 154], [1500, 154], [900, 700], [550, 1384]], "letter")).toThrow();
  });

  it("refuses to map outline points at the horizon", () => {
    const f = paperFrame(cornersPx, "letter");
    const [, , , , , , h6, h7, h8] = f.H;
    const onHorizon: Vec2 = [0, -h8 / h7]; // projective depth 0: millimetres go to infinity here
    expect(outlineToMm([toImage([20, 30]), toImage([200, 260])], f)).not.toBeNull();
    expect(outlineToMm([toImage([20, 30]), onHorizon, toImage([200, 260])], f)).toBeNull();
    expect(h6 * onHorizon[0] + h7 * onHorizon[1] + h8).toBeCloseTo(0, 6);
  });
});

describe("outline smoothing", () => {
  // A 40 mm circle with 0.3 mm of pixel jitter.
  const noisy: Vec2[] = Array.from({ length: 720 }, (_, i) => {
    const t = (i / 720) * Math.PI * 2;
    const r = 20 + 0.3 * Math.sin(i * 7.3) * Math.cos(i * 3.1);
    return [r * Math.cos(t), r * Math.sin(t)];
  });

  it("resamples at the requested spacing", () => {
    const out = resampleClosed(noisy, 0.5);
    const perimeter = 2 * Math.PI * 20;
    expect(out.length).toBeGreaterThan(perimeter / 0.5 * 0.9);
  });

  it("caps the sample count for a runaway outline instead of freezing", () => {
    const huge: Vec2[] = [[0, 0], [1e18, 0], [1e18, 1e18], [0, 1e18]];
    expect(resampleClosed(huge, 0.5).length).toBeLessThanOrEqual(20_000);
    expect(resampleClosed([[0, 0], [Infinity, 0], [0, 1]], 0.5)).toHaveLength(3);
  });

  it("fast mode removes jitter and simplifies; detail keeps more points", () => {
    const fast = smoothOutline(noisy, "fast");
    const detail = smoothOutline(noisy, "detail");
    const radii = fast.map(([x, y]) => Math.hypot(x, y));
    expect(Math.max(...radii) - Math.min(...radii)).toBeLessThan(0.35);
    expect(fast.length).toBeLessThan(detail.length);
  });

  it("simplifies a square to four corners", () => {
    const sq: Vec2[] = [];
    for (let i = 0; i < 40; i++) sq.push([i, 0]);
    for (let i = 0; i < 40; i++) sq.push([40, i]);
    for (let i = 40; i > 0; i--) sq.push([i, 40]);
    for (let i = 40; i > 0; i--) sq.push([0, i]);
    expect(simplifyClosed(sq, 0.1).length).toBe(4);
  });
});
