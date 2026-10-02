import { describe, expect, it } from "vitest";
import { autoArrange, planFor, placeOutline } from "../src/state/geometry";
import { useStore } from "../src/state/store";
import { DEFAULT_SETTINGS, type ToolItem } from "../src/state/types";
import { toDXF, toSVG } from "../src/lib/export/files";
import type { Vec2 } from "../src/lib/vision/mask";

const tool = (id: string, w: number, h: number, rotation = 0): ToolItem => ({
  id, name: id, kind: "traced", outline: [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]],
  x: 0, y: 0, rotation, depth: null, fingerSlot: false, label: "", placed: false,
});

describe("layout", () => {
  it("places outlines by position and rotation", () => {
    const p = placeOutline([[10, 0]], 5, 5, 90);
    expect(p[0][0]).toBeCloseTo(5);
    expect(p[0][1]).toBeCloseTo(15);
  });

  it("arranges tools without overlaps into a compact grid", () => {
    const tools = [tool("a", 150, 20, 30), tool("b", 90, 25), tool("c", 60, 60), tool("d", 120, 15, -70)];
    const placed = autoArrange(tools, DEFAULT_SETTINGS);
    const moved = tools.map((t) => ({ ...t, ...placed.find((p) => p.id === t.id)! }));
    const boxes = moved.map((t) => {
      const pts = placeOutline(t.outline, t.x, t.y, t.rotation);
      const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
      return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
    });
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j];
      const overlap = a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
      expect(overlap).toBe(false);
    }
    const plan = planFor(moved, DEFAULT_SETTINGS);
    expect(plan.kind).toBe("gridfinity");
    if (plan.kind === "gridfinity") expect(plan.plan.layout.cellsX * plan.plan.layout.cellsY).toBeLessThanOrEqual(15) // 5 × 3 is the best shelf packing for these four;
  });
});

describe("runaway guards", () => {
  it("reports a zero-thickness foam cut layer instead of building it", () => {
    const plan = planFor([tool("a", 50, 20)], { ...DEFAULT_SETTINGS, mode: "foam", foam: { ...DEFAULT_SETTINGS.foam, thickness: 0 } });
    expect(plan.kind).toBe("error");
  });

  it("refuses absurdly large bins", () => {
    expect(planFor([tool("a", 5000, 20)], DEFAULT_SETTINGS).kind).toBe("error");
    // 36 × 36 cells: under the per-side cap, but enough to exhaust OpenCascade's 4 GB heap.
    expect(planFor([tool("a", 1500, 1500)], DEFAULT_SETTINGS).kind).toBe("error");
    expect(planFor([tool("a", 1000, 400)], DEFAULT_SETTINGS).kind).toBe("gridfinity");
  });

  it("finishes arranging huge or broken outlines", () => {
    expect(autoArrange([tool("a", 2 ** 60, 10), tool("b", 2 ** 60, 10)], DEFAULT_SETTINGS)).toHaveLength(2);
    // One huge tool beside a small one: the span between row widths is below the float step here.
    expect(autoArrange([tool("a", 1.5e17, 10), tool("b", 40, 20)], DEFAULT_SETTINGS)).toHaveLength(2);
    expect(autoArrange([tool("a", NaN, 10)], DEFAULT_SETTINGS)).toEqual([]);
  });

  it("keeps outlines sane while a paper corner is dragged somewhere impossible", () => {
    const sheet: Vec2[] = [[550, 154], [1500, 154], [1500, 1384], [550, 1384]];
    const a = Math.PI / 3;
    // A tool across the right edge of the sheet, in photo pixels.
    const outlinePx = ([[-440, -28], [440, -28], [440, 28], [-440, 28]] as Vec2[]).map(([x, y]) => [1500 + x * Math.cos(a) - y * Math.sin(a), 760 + x * Math.sin(a) + y * Math.cos(a)] as Vec2);
    const s = useStore.getState();
    s.upsertTool({ ...tool("t", 0, 0), outline: [], outlinePx, clicks: [{ x: 1500, y: 760, positive: true }] });
    s.setCorners(sheet, false);
    const good = useStore.getState().tools[0].outline;
    expect(good.length).toBeGreaterThan(2);
    const center: Vec2 = [1025, 769];
    // Drag the top-left handle towards the centre, past it, and onto the top-right corner.
    for (const k of [0.5, 0.7, 0.85, 0.92, 1.1]) {
      const tl: Vec2 = [550 + k * (center[0] - 550), 154 + k * (center[1] - 154)];
      s.setCorners([tl, sheet[1], sheet[2], sheet[3]], true);
      const out = useStore.getState().tools[0].outline;
      expect(out.length).toBeLessThan(20_000);
      expect(out.every(([x, y]) => Math.abs(x) < 1e4 && Math.abs(y) < 1e4)).toBe(true);
    }
    s.setCorners([[1499, 155], sheet[1], sheet[2], sheet[3]], true);
    expect(useStore.getState().tools[0].outline.every(([x, y]) => Math.abs(x) < 1e4 && Math.abs(y) < 1e4)).toBe(true);
  });
});

describe("2D export", () => {
  const paths: [number, number][][] = [[[-50, -30], [50, -30], [50, 30], [-50, 30]], [[-10, -5], [10, -5], [10, 5], [-10, 5]]];
  it("writes an R12 DXF in millimetres with closed polylines", () => {
    const dxf = toDXF(paths);
    expect(dxf).toContain("AC1009");
    expect(dxf.match(/POLYLINE/g)!.length).toBe(2);
    expect(dxf.trim().endsWith("EOF")).toBe(true);
  });
  it("writes an SVG at real size", () => {
    const svg = toSVG(paths);
    expect(svg).toContain('width="100.000mm"');
    expect(svg).toContain('height="60.000mm"');
  });
});
