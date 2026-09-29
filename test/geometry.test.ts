import { describe, expect, it } from "vitest";
import { autoArrange, planFor, placeOutline } from "../src/state/geometry";
import { DEFAULT_SETTINGS, type ToolItem } from "../src/state/types";
import { toDXF, toSVG } from "../src/lib/export/files";

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
