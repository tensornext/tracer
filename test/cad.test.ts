import { createRequire } from "node:module";
import { beforeAll, describe, expect, it } from "vitest";
import { planTiles } from "../src/lib/cad/geometry2d";
import { initKernel } from "../src/lib/cad/init";
import { buildFoam, buildGridfinity, meshParts, stepParts, stlParts } from "../src/lib/cad/kernel";
import { planGridfinity as layoutGridfinity } from "../src/lib/cad/plan";
import { build3MF } from "../src/lib/cad/threemf";
import type { Cutout, Pt } from "../src/lib/cad/types";

const require = createRequire(import.meta.url);
const bar = (x: number, y: number, w: number, h: number): Pt[] => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];

beforeAll(async () => {
  await initKernel(require.resolve("replicad-opencascadejs/wasm"));
}, 60_000);

describe("layout (no kernel)", () => {
  it("fits the smallest grid and snaps height to 7 mm units", () => {
    const { layout } = layoutGridfinity([{ id: "a", shape: { kind: "polygon", points: bar(0, 0, 70, 20) }, depth: 12 }], { tolerance: 1.5 });
    // 70 + 2×1.5 tolerance + 2×4 wall = 81 mm → 2 cells; 20 + 3 + 8 = 31 mm → 1 cell.
    expect([layout.cellsX, layout.cellsY]).toEqual([2, 1]);
    expect(layout.width).toBeCloseTo(83.5);
    expect(layout.height % 7).toBe(0);
    expect(layout.height).toBeGreaterThanOrEqual(4.75 + 1.2 + 0.6 + 12);
  });

  it("rejects a forced grid that's too small", () => {
    expect(() => layoutGridfinity([{ id: "a", shape: { kind: "polygon", points: bar(0, 0, 200, 20) } }], { cellsX: 2 })).toThrow(/at least/);
  });

  it("splits along cell lines to fit the bed", () => {
    expect(planTiles(7, 3, 42, 0.5, { width: 180, height: 180 }).map((t) => t.cellsX)).toEqual([4, 3]);
    expect(planTiles(3, 3, 42, 0.5).length).toBe(1);
  });
});

describe("gridfinity solid", () => {
  const cutouts: Cutout[] = [
    { id: "deep", shape: { kind: "polygon", points: bar(0, 0, 60, 18) }, depth: 16, fingerSlot: true },
    { id: "shallow", shape: { kind: "roundedRect", center: [30, 35], width: 50, height: 14, radius: 3 }, depth: 8 },
    { id: "round", shape: { kind: "circle", center: [75, 20], diameter: 16 }, depth: 12 },
  ];

  it("builds tray + contrast layer with correct outer dims", async () => {
    const { layout, parts } = buildGridfinity(cutouts, { magnets: "corners" });
    const tray = parts.find((p) => p.info.kind === "tray")!;
    const [[x0, y0, z0], [x1, y1, z1]] = tray.info.bounds;
    expect(x1 - x0).toBeCloseTo(layout.width, 1);
    expect(y1 - y0).toBeCloseTo(layout.depth, 1);
    expect(z0).toBeCloseTo(0, 2);
    expect(z1).toBeCloseTo(layout.height + 4.4, 1); // stacking lip on top
    const contrast = parts.find((p) => p.info.kind === "contrast")!;
    // Deepest pocket floor: top − 16 − 0.6.
    expect(contrast.info.bounds[0][2]).toBeCloseTo(layout.height - 16.6, 2);
  }, 120_000);

  it("exports STL, STEP and a multi-part 3MF", async () => {
    const { parts } = buildGridfinity(cutouts, { lip: false });
    const stl = await stlParts(parts);
    expect(stl.map((f) => f.name)).toEqual(["tray.stl", "contrast.stl"]);
    for (const f of stl) expect(f.data.byteLength).toBeGreaterThan(84);
    const step = new TextDecoder().decode(await stepParts(parts));
    expect(step.startsWith("ISO-10303-21")).toBe(true);
    const zip = build3MF(meshParts(parts));
    expect(zip[0]).toBe(0x50); // "PK"
    // Parts stay usable after export (STEP must not consume them).
    expect(meshParts(parts)[0].triangles.length).toBeGreaterThan(0);
  }, 120_000);

  it("splits a wide bin into tiles", () => {
    const wide: Cutout[] = [{ id: "long", shape: { kind: "polygon", points: bar(0, 0, 250, 20) }, depth: 10 }];
    const { layout, parts } = buildGridfinity(wide, { lip: false, maxPlate: { width: 180, height: 180 } });
    expect(layout.tiles.length).toBe(2);
    expect(new Set(parts.map((p) => p.info.tile))).toEqual(new Set([0, 1]));
  }, 120_000);
});

describe("foam", () => {
  it("builds a cut layer on a 1/4 in backer and returns 2D paths", () => {
    const r = buildFoam([{ id: "a", shape: { kind: "polygon", points: bar(0, 0, 80, 20) }, fingerSlot: true }], { thickness: 25.4, tolerance: 1.5 });
    expect(r.parts.map((p) => p.info.kind)).toEqual(["foamCut", "foamBacker"]);
    expect(r.parts[1].info.bounds[1][2]).toBeCloseTo(6.35, 2);
    expect(r.cutPaths.length).toBe(2); // panel outline + one merged cut
    expect(r.width).toBeCloseTo(80 + 3 + 30, 0);
  }, 60_000);
});
