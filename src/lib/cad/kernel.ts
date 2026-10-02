import {
  draw,
  drawCircle,
  drawRectangle,
  drawRoundedRectangle,
  drawText,
  getFont,
  makeCylinder,
  makeBox,
  measureVolume,
  compoundShapes,
  type Drawing,
  type Shape3D,
} from "replicad";
import { FOOT_HEIGHT, GRIDFINITY, LIP_HEIGHT, centroid, extentAlong, normalizePolygon, TOLERANCE_PRESETS } from "./geometry2d";
import { planFoam, planGridfinity, type Planned, type Slot } from "./plan";
import { differencePolygons, regionRings, unionPolygons, type Region } from "./polygons";
import type { Cutout, CutoutShape, FoamParams, GridfinityLayout, GridfinityParams, PartInfo, PartKind, Pt } from "./types";

export interface Part { info: PartInfo; solid: Shape3D }

// ---------- 2D → kernel ----------

function polygonDrawing(pts: Pt[]): Drawing {
  const p = normalizePolygon(pts);
  let pen = draw(p[0]);
  for (let i = 1; i < p.length; i++) pen = pen.lineTo(p[i]);
  return pen.close();
}

function regionDrawing(r: Region): Drawing {
  let d = polygonDrawing(r.outer);
  for (const h of r.holes) d = d.cut(polygonDrawing(h));
  return d;
}

/** Exact drawing for circles and rectangles (so STEP keeps true arcs); polygons go through Clipper. */
function cutoutDrawing(shape: CutoutShape, tol: number, polygonRegions: Region[]): Drawing[] {
  switch (shape.kind) {
    case "circle":
      return [drawCircle(shape.diameter / 2 + tol).translate(shape.center[0], shape.center[1])];
    case "roundedRect": {
      const w = shape.width + 2 * tol, h = shape.height + 2 * tol;
      const r = Math.min((shape.radius ?? 0) + tol, w / 2 - 0.01, h / 2 - 0.01);
      const base = r > 0.01 ? drawRoundedRectangle(w, h, r) : drawRectangle(w, h);
      return [base.rotate(shape.angleDeg ?? 0, [0, 0]).translate(shape.center[0], shape.center[1])];
    }
    case "polygon":
      return polygonRegions.map(regionDrawing);
  }
}

function prism(d: Drawing, z0: number, height: number): Shape3D {
  // A zero-height solid makes OpenCascade spin forever in a later boolean, so refuse it here.
  if (!(Math.abs(height) > 1e-6)) throw new Error(`Can't make a solid ${height} mm thick: thicknesses and depths must be more than 0`);
  return (d.sketchOnPlane("XY", z0) as { extrude(h: number): Shape3D }).extrude(height);
}

type Box = [[number, number, number], [number, number, number]];
const apart = (a: Box, b: Box, gap = 0.01) => [0, 1, 2].some((k) => a[1][k] + gap < b[0][k] || b[1][k] + gap < a[0][k]);

/** Greedy split into groups whose members' bounding boxes don't even touch. */
function disjointGroups(tools: Shape3D[]): Shape3D[][] {
  const groups: { tools: Shape3D[]; boxes: Box[] }[] = [];
  for (const t of tools) {
    const box = t.boundingBox.bounds as Box;
    const g = groups.find((x) => x.boxes.every((b) => apart(box, b)));
    if (g) { g.tools.push(t); g.boxes.push(box); } else groups.push({ tools: [t], boxes: [box] });
  }
  return groups.map((g) => g.tools);
}

/**
 * Cutting tools one at a time re-intersects an ever-growing solid, which goes quadratic (four
 * magnet holes per cell made big bins take minutes). Instead cut each group of well-separated
 * tools as one compound. Tools that overlap or touch go in different groups: inside one
 * boolean they give silently wrong results. `tools` stay usable afterwards.
 */
function cutAll(base: Shape3D, tools: Shape3D[]): Shape3D {
  for (const group of disjointGroups(tools)) {
    if (group.length === 1) {
      base = base.cut(group[0]);
      continue;
    }
    const all = compoundShapes(group.map((t) => t.clone())) as unknown as Shape3D; // consumes its inputs
    try {
      base = base.cut(all);
    } catch (e) {
      console.warn("Combined cut failed, cutting one tool at a time:", e);
      base = group.reduce((acc, t) => acc.cut(t), base);
    } finally {
      all.delete();
    }
  }
  return base;
}

function friendlyError(e: unknown): Error {
  const msg = e instanceof Error ? e.message : String(e);
  if (/BRepAlgoAPI|boolean/i.test(msg)) return new Error("Boolean operation failed: two cutouts may be overlapping in a way the kernel can't resolve");
  if (/self-intersect/i.test(msg)) return new Error("An outline intersects itself");
  return e instanceof Error ? e : new Error(msg);
}

function info(name: string, kind: PartKind, tile: number, solid: Shape3D): PartInfo {
  return { name, kind, tile, bounds: solid.boundingBox.bounds as Box };
}

// ---------- planned cutouts → kernel drawings ----------

interface Prepared extends Planned {
  drawings: Drawing[];
}

function withDrawings(planned: Planned[], tol: number): Prepared[] {
  // A degenerate stadium crashes (or stalls) OpenCascade, so catch it before any kernel work.
  if (planned.some((x) => x.slot && !(x.slot.width > 0.5))) throw new Error("Finger slots need a finger diameter of more than 0.5 mm");
  return planned.map((x) => ({ ...x, drawings: cutoutDrawing(x.cutout.shape, tol, x.regions) }));
}

/** Exact stadium (true arcs) in panel coordinates. */
function slotDrawing(s: Slot, panelCenter: Pt): Drawing {
  const len = Math.max(s.length, s.width + 0.02);
  return drawRoundedRectangle(len, s.width, s.width / 2 - 0.01)
    .rotate((s.angle * 180) / Math.PI, [0, 0])
    .translate(s.center[0] - panelCenter[0], s.center[1] - panelCenter[1]);
}

// ---------- Gridfinity ----------

function roundedSection(size: [number, number], r: number, z: number) {
  return drawRoundedRectangle(size[0], size[1], Math.max(r, 0.05)).sketchOnPlane("XY", z);
}

/** One foot, from the public Gridfinity profile: 0.8 chamfer, 1.8 vertical, 2.15 chamfer. */
function makeFoot(cell: number, clearance: number): Shape3D {
  const g = GRIDFINITY;
  const top = cell - clearance;
  const bottom = top - 2 * (g.footChamferLow + g.footChamferHigh);
  const rTop = g.outerRadius;
  const rBottom = rTop - g.footChamferLow - g.footChamferHigh;
  const mid = bottom + 2 * g.footChamferLow;
  const rMid = rBottom + g.footChamferLow;
  const s0 = roundedSection([bottom, bottom], rBottom, 0) as any;
  return s0.loftWith(
    [
      roundedSection([mid, mid], rMid, g.footChamferLow),
      roundedSection([mid, mid], rMid, g.footChamferLow + g.footVertical),
      roundedSection([top, top], rTop, FOOT_HEIGHT),
    ],
    { ruled: true },
  ) as Shape3D;
}

/** Stacking lip ring sitting on the tray top; its cavity accepts another bin's feet. */
function makeLip(width: number, depth: number, zTop: number): Shape3D {
  const g = GRIDFINITY;
  const r = g.outerRadius;
  const ring = prism(drawRoundedRectangle(width, depth, r), zTop, LIP_HEIGHT);
  const land = g.lipTopLand;
  const s = (inset: number, z: number) => roundedSection([width - 2 * inset, depth - 2 * inset], r - inset, z);
  const insetTop = land;
  const insetMid = land + g.lipChamferHigh;
  const insetLow = insetMid + g.lipChamferLow;
  const eps = 0.02;
  const cavity = (s(insetLow, zTop - eps) as any).loftWith(
    [
      s(insetLow, zTop),
      s(insetMid, zTop + g.lipChamferLow),
      s(insetMid, zTop + g.lipChamferLow + g.lipVertical),
      s(insetTop, zTop + LIP_HEIGHT),
      s(insetTop, zTop + LIP_HEIGHT + eps),
    ],
    { ruled: true },
  ) as Shape3D;
  return ring.cut(cavity);
}

function magnetHoles(cellsX: number, cellsY: number, cell: number, pattern: string, dia: number, depth: number): Shape3D[] {
  if (pattern === "none") return [];
  const holes: Pt[] = [];
  const inset = GRIDFINITY.magnetInset;
  for (let i = 0; i < cellsX; i++) {
    for (let j = 0; j < cellsY; j++) {
      const cx = (i - (cellsX - 1) / 2) * cell;
      const cy = (j - (cellsY - 1) / 2) * cell;
      for (const sx of [-1, 1]) {
        for (const sy of [-1, 1]) {
          const outerX = (sx < 0 && i === 0) || (sx > 0 && i === cellsX - 1);
          const outerY = (sy < 0 && j === 0) || (sy > 0 && j === cellsY - 1);
          if (pattern === "all" || (outerX && outerY)) holes.push([cx + sx * inset, cy + sy * inset]);
        }
      }
    }
  }
  return holes.map(([x, y]) => makeCylinder(dia / 2, depth + 0.01, [x, y, -0.01], [0, 0, 1]));
}

export function buildGridfinity(cutouts: Cutout[], params: GridfinityParams = {}): { layout: GridfinityLayout; parts: Part[] } {
  try {
    const { layout, planned, p } = planGridfinity(cutouts, params);
    const prepared = withDrawings(planned, p.tolerance);
    const { cellsX, cellsY, width, depth, height: zTop, center } = layout;
    const cell = p.cellSize;
    // Work in panel coordinates: cutouts shifted so the panel centre is the origin.
    const shift = (d: Drawing) => d.translate(-center[0], -center[1]);
    const shiftPts = (pts: Pt[]): Pt[] => pts.map(([x, y]) => [x - center[0], y - center[1]]);

    let tray = prism(drawRoundedRectangle(width, depth, GRIDFINITY.outerRadius), FOOT_HEIGHT, zTop - FOOT_HEIGHT);

    const foot = makeFoot(cell, p.clearance);
    const feet: Shape3D[] = [];
    for (let i = 0; i < cellsX; i++) {
      for (let j = 0; j < cellsY; j++) {
        feet.push(foot.clone().translate((i - (cellsX - 1) / 2) * cell, (j - (cellsY - 1) / 2) * cell, 0));
      }
    }
    tray = tray.fuse(compoundShapes(feet) as unknown as Shape3D);

    // Finger slots first, so the pocket walls cut cleanly through the scoop afterwards.
    // Stadium down to the pocket floor, bottom edges rounded into a scoop.
    const c = p.contrastLayer;
    const slotSolids: Shape3D[] = [];
    for (const x of prepared) {
      if (!x.slot) continue;
      const z0 = zTop - x.depth;
      let s = prism(slotDrawing(x.slot, center), z0, x.depth + 0.05);
      const r = Math.min(p.fingerDiameter * 0.4, x.depth * 0.8);
      try {
        s = s.fillet(r, (e: any) => e.inPlane("XY", z0));
      } catch {
        // Keep the square-bottomed slot if the fillet fails on an odd outline.
      }
      slotSolids.push(s);
    }
    tray = cutAll(tray, slotSolids);

    // Pockets: each cut to its own depth, plus the contrast layer that gets filled back in.
    tray = cutAll(tray, prepared.flatMap((x) => x.drawings.map((d) => prism(shift(d), zTop - x.depth - c, x.depth + c + 0.05))));

    // Engraved labels (needs a font loaded with loadCadFont).
    if (getFont()) {
      for (const x of prepared) {
        if (!x.cutout.label) continue;
        // Default spot: just outside the pocket and its finger slot, below if it fits, else above.
        const ring = [...x.regions[0].outer, ...(x.slot?.poly ?? [])];
        const cen = centroid(x.regions[0].outer);
        const ext = extentAlong(ring, Math.PI / 2, cen);
        const below = cen[1] + ext.min - p.labelSize;
        const fitsBelow = below - p.labelSize / 2 > center[1] - depth / 2 + GRIDFINITY.lipChamferLow + GRIDFINITY.lipChamferHigh + 1;
        const at: Pt = x.cutout.labelAt ?? [cen[0], fitsBelow ? below : cen[1] + ext.max + p.labelSize];
        try {
          const text = drawText(x.cutout.label, { fontSize: p.labelSize });
          const bb = text.boundingBox;
          const placed = text.translate(at[0] - bb.center[0] - center[0], at[1] - bb.center[1] - center[1]);
          tray = tray.cut(prism(placed, zTop - p.labelDepth, p.labelDepth + 0.05));
        } catch (e) {
          console.warn(`Label for ${x.cutout.id} skipped:`, e);
        }
      }
    }

    if (p.lip) tray = tray.fuse(makeLip(width, depth, zTop));
    tray = cutAll(tray, magnetHoles(cellsX, cellsY, cell, p.magnets, p.magnetDiameter, p.magnetDepth));

    // Contrast inserts: per depth level, footprint minus anything deeper, so nothing floats.
    let contrast: Shape3D | null = null;
    if (c > 0) {
      const levels = [...new Set(prepared.map((x) => x.depth))].sort((a, b) => a - b);
      const pieces: Shape3D[] = [];
      for (const level of levels) {
        const here = prepared.filter((x) => x.depth === level).flatMap((x) => regionRings(x.regions));
        const deeper = prepared.filter((x) => x.depth > level).flatMap((x) => regionRings(x.regions));
        const merged = regionRings(unionPolygons(here));
        const regions = deeper.length ? differencePolygons(merged, regionRings(unionPolygons(deeper))) : unionPolygons(here);
        for (const r of regions) {
          const shifted: Region = { outer: shiftPts(r.outer), holes: r.holes.map(shiftPts) };
          pieces.push(prism(regionDrawing(shifted), zTop - level - c, c));
        }
      }
      if (pieces.length) {
        let all = pieces[0];
        for (const s of pieces.slice(1)) all = all.fuse(s);
        contrast = cutAll(all, slotSolids);
      }
    }

    const whole: Part[] = [{ info: info("tray", "tray", 0, tray), solid: tray }];
    if (contrast) whole.push({ info: info("contrast", "contrast", 0, contrast), solid: contrast });
    if (layout.tiles.length <= 1) return { layout, parts: whole };

    // Split along cell lines for beds smaller than the bin.
    const bx = (k: number) => -(cellsX * cell) / 2 + k * cell;
    const by = (k: number) => -(cellsY * cell) / 2 + k * cell;
    const BIG = 1e4;
    const parts: Part[] = [];
    for (const t of layout.tiles) {
      const x0 = t.cellX0 === 0 ? -BIG : bx(t.cellX0);
      const x1 = t.cellX0 + t.cellsX === cellsX ? BIG : bx(t.cellX0 + t.cellsX);
      const y0 = t.cellY0 === 0 ? -BIG : by(t.cellY0);
      const y1 = t.cellY0 + t.cellsY === cellsY ? BIG : by(t.cellY0 + t.cellsY);
      const clip = () => makeBox([x0, y0, -10], [x1, y1, zTop + LIP_HEIGHT + 10]);
      for (const w of whole) {
        const piece = w.solid.clone().intersect(clip());
        if (measureVolume(piece) < 1e-6) continue; // e.g. a tile with no pockets has no contrast layer
        parts.push({ info: info(`${w.info.name}-${t.index + 1}`, w.info.kind, t.index, piece), solid: piece });
      }
    }
    return { layout, parts };
  } catch (e) {
    throw friendlyError(e);
  }
}

// ---------- Foam ----------

export function buildFoam(cutouts: Cutout[], params: FoamParams = {}): { width: number; height: number; center: Pt; parts: Part[]; cutPaths: Pt[][] } {
  try {
    const { width, height, center, planned, p, cutPaths } = planFoam(cutouts, params);
    const prepared = withDrawings(planned, p.tolerance);
    const shift = (d: Drawing) => d.translate(-center[0], -center[1]);
    let cut = prism(drawRectangle(width, height), p.backer, p.thickness);
    const through = (d: Drawing) => prism(d, p.backer - 0.05, p.thickness + 0.1);
    // Slots before pockets, as for Gridfinity: the other order can lose half a slot.
    cut = cutAll(cut, prepared.flatMap((x) => (x.slot ? [through(slotDrawing(x.slot, center))] : [])));
    cut = cutAll(cut, prepared.flatMap((x) => x.drawings.map((d) => through(shift(d)))));
    const parts: Part[] = [{ info: info("foam-cut", "foamCut", 0, cut), solid: cut }];
    if (p.backer > 0) {
      const backer = prism(drawRectangle(width, height), 0, p.backer);
      parts.push({ info: info("foam-backer", "foamBacker", 0, backer), solid: backer });
    }
    return { width, height, center, parts, cutPaths };
  } catch (e) {
    throw friendlyError(e);
  }
}

// ---------- export ----------

export interface MeshData {
  name: string;
  kind: PartKind;
  tile: number;
  vertices: Float32Array;
  normals: Float32Array;
  triangles: Uint32Array;
}

export function meshParts(parts: Part[], tolerance = 0.05, angularTolerance = 10): MeshData[] {
  return parts.map(({ info: i, solid }) => {
    const m = solid.mesh({ tolerance, angularTolerance }) as { vertices: number[]; normals: number[]; triangles: number[] };
    return {
      name: i.name,
      kind: i.kind,
      tile: i.tile,
      vertices: Float32Array.from(m.vertices),
      normals: Float32Array.from(m.normals),
      triangles: Uint32Array.from(m.triangles),
    };
  });
}

export async function stlParts(parts: Part[]): Promise<{ name: string; data: ArrayBuffer }[]> {
  return Promise.all(
    parts.map(async ({ info: i, solid }) => ({
      name: `${i.name}.stl`,
      data: await solid.blobSTL({ binary: true, tolerance: 0.01, angularTolerance: 1 } as any).arrayBuffer(),
    })),
  );
}

export async function stepParts(parts: Part[]): Promise<ArrayBuffer> {
  // compoundShapes consumes its inputs, so hand it clones and keep the cached parts alive.
  const shape = parts.length === 1 ? parts[0].solid : (compoundShapes(parts.map((x) => x.solid.clone())) as unknown as Shape3D);
  return shape.blobSTEP().arrayBuffer();
}

/** Resolve a named tolerance preset or pass a number through. */
export function tolerance(v: keyof typeof TOLERANCE_PRESETS | number): number {
  return typeof v === "number" ? v : TOLERANCE_PRESETS[v];
}
