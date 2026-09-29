// Derived geometry: pixels → millimetres, tool placement, and cutouts for the planner/kernel.
import { centroid, principalAngle } from "../lib/cad/geometry2d";
import { planFoam, planGridfinity } from "../lib/cad/plan";
import type { Cutout, GridfinityParams, FoamParams } from "../lib/cad/types";
import type { Vec2 } from "../lib/vision/mask";
import { outlineToMm, paperFrame, type PaperFrame } from "../lib/vision/paper";
import { smoothOutline } from "../lib/vision/smoothing";
import type { Settings, ToolItem } from "./types";

export function frameFor(corners: Vec2[] | null, paper: Settings["paper"]): PaperFrame | null {
  if (!corners || corners.length !== 4) return null;
  try {
    return paperFrame(corners, paper);
  } catch {
    return null;
  }
}

/** Pixel outline → smoothed mm outline centred on its own centroid, plus where that centroid sits on the paper. */
export function outlineFromPixels(outlinePx: Vec2[], frame: PaperFrame, detail: boolean): { local: Vec2[]; center: Vec2 } {
  const mm = smoothOutline(outlineToMm(outlinePx, frame), detail ? "detail" : "fast");
  const c = centroid(mm);
  return { local: mm.map(([x, y]) => [x - c[0], y - c[1]]), center: c };
}

export function placeOutline(local: Vec2[], x: number, y: number, rotationDeg: number): Vec2[] {
  const a = (rotationDeg * Math.PI) / 180;
  const c = Math.cos(a), s = Math.sin(a);
  return local.map(([px, py]) => [x + px * c - py * s, y + px * s + py * c]);
}

export function toolToCutout(t: ToolItem, settings: Settings): Cutout {
  const base = {
    id: t.id,
    depth: settings.mode === "gridfinity" ? (t.depth ?? settings.gridfinity.pocketDepth) : undefined,
    fingerSlot: t.fingerSlot,
    label: t.label || undefined,
  };
  if (t.kind === "circle") return { ...base, shape: { kind: "circle", center: [t.x, t.y], diameter: t.diameter ?? 20 } };
  if (t.kind === "rect") {
    return { ...base, shape: { kind: "roundedRect", center: [t.x, t.y], width: t.width ?? 40, height: t.height ?? 20, radius: t.radius ?? 2, angleDeg: t.rotation } };
  }
  return { ...base, shape: { kind: "polygon", points: placeOutline(t.outline, t.x, t.y, t.rotation) } };
}

export function usableTools(tools: ToolItem[]): ToolItem[] {
  return tools.filter((t) => t.kind !== "traced" || t.outline.length >= 3);
}

export function gridfinityParams(s: Settings): GridfinityParams {
  const g = s.gridfinity;
  return {
    cellSize: g.cellSize,
    tolerance: s.tolerance,
    pocketDepth: g.pocketDepth,
    lip: g.lip,
    magnets: g.magnets,
    fingerDiameter: s.fingerDiameter,
    contrastLayer: g.contrastLayer,
    snapToHeightUnits: g.snapHeight,
    maxPlate: g.split ? { width: g.bedWidth, height: g.bedDepth } : undefined,
  };
}

export function foamParams(s: Settings): FoamParams {
  return { tolerance: s.tolerance, thickness: s.foam.thickness, backer: s.foam.backer, margin: s.foam.margin, fingerDiameter: s.fingerDiameter };
}

export type Plan =
  | { kind: "gridfinity"; plan: ReturnType<typeof planGridfinity>; cutouts: Cutout[] }
  | { kind: "foam"; plan: ReturnType<typeof planFoam>; cutouts: Cutout[] }
  | { kind: "error"; message: string; cutouts: Cutout[] };

export function planFor(tools: ToolItem[], settings: Settings): Plan {
  const cutouts = usableTools(tools).map((t) => toolToCutout(t, settings));
  try {
    if (settings.mode === "gridfinity") return { kind: "gridfinity", plan: planGridfinity(cutouts, gridfinityParams(settings)), cutouts };
    return { kind: "foam", plan: planFoam(cutouts, foamParams(settings)), cutouts };
  } catch (e) {
    return { kind: "error", message: e instanceof Error ? e.message : String(e), cutouts };
  }
}

/**
 * Lay tools out tightly: long axis horizontal, tallest first, shelf-packed. Tries a range of
 * row widths and keeps the one needing the fewest grid cells (or least foam area).
 */
export function autoArrange(tools: ToolItem[], settings: Settings): Pick<ToolItem, "id" | "x" | "y" | "rotation">[] {
  const items = usableTools(tools).map((t) => {
    let rotation = t.rotation;
    if (t.kind === "traced") rotation = (-principalAngle(t.outline) * 180) / Math.PI;
    if (t.kind === "rect") rotation = (t.width ?? 0) >= (t.height ?? 0) ? 0 : 90;
    const pts = t.kind === "circle"
      ? ([[-(t.diameter ?? 20) / 2, -(t.diameter ?? 20) / 2], [(t.diameter ?? 20) / 2, (t.diameter ?? 20) / 2]] as Vec2[])
      : t.kind === "rect"
        ? placeOutline([[-(t.width ?? 40) / 2, -(t.height ?? 20) / 2], [(t.width ?? 40) / 2, (t.height ?? 20) / 2], [-(t.width ?? 40) / 2, (t.height ?? 20) / 2], [(t.width ?? 40) / 2, -(t.height ?? 20) / 2]], 0, 0, rotation)
        : placeOutline(t.outline, 0, 0, rotation);
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    const slotPad = t.fingerSlot ? settings.fingerDiameter / 2 : 0;
    const pad = settings.tolerance + 2;
    return {
      id: t.id,
      rotation,
      minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys),
      w: Math.max(...xs) - Math.min(...xs) + 2 * pad,
      h: Math.max(...ys) - Math.min(...ys) + 2 * pad + 2 * slotPad,
      pad, slotPad,
    };
  });
  if (!items.length) return [];
  items.sort((a, b) => b.h - a.h);
  const widest = Math.max(...items.map((i) => i.w));
  const total = items.reduce((s, i) => s + i.w, 0);
  const cell = settings.gridfinity.cellSize;
  let best: { cost: number; place: { id: string; x: number; y: number; rotation: number }[] } | null = null;
  for (let rowW = widest; rowW <= Math.max(widest, total) + 1; rowW += 10) {
    const place: { id: string; x: number; y: number; rotation: number }[] = [];
    let x = 0, y = 0, rowH = 0;
    for (const it of items) {
      if (x > 0 && x + it.w > rowW) { x = 0; y -= rowH; rowH = 0; }
      // Anchor: item's box top-left at (x, y); convert to centroid position.
      place.push({ id: it.id, rotation: it.rotation, x: x + it.pad - it.minX, y: y - it.pad - it.slotPad - it.maxY });
      x += it.w;
      rowH = Math.max(rowH, it.h);
    }
    const W = Math.max(...items.map((it, i) => place[i].x + it.maxX + it.pad)) ;
    const H = -(y - rowH);
    const wall = 8;
    const cost = settings.mode === "gridfinity"
      ? Math.ceil((W + wall) / cell) * Math.ceil((H + wall) / cell) + 0.001 * Math.abs(W - H)
      : W * H;
    if (!best || cost < best.cost) best = { cost, place };
    if (rowW >= total) break;
  }
  return best!.place;
}
