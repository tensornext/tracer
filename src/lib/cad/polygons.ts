// 2D polygon operations (offset, union, difference) done in integer space with Clipper,
// so the CAD kernel only ever receives clean, non-self-intersecting outlines.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
import ClipperLibImport from "clipper-lib";
import type { Pt } from "./types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const C: any = (ClipperLibImport as any).default ?? ClipperLibImport;

const SCALE = 1000; // 1 µm resolution

/** A region: one outer ring (CCW) plus any holes (CW). */
export interface Region { outer: Pt[]; holes: Pt[][] }

const toPath = (pts: Pt[]) => pts.map(([x, y]) => ({ X: Math.round(x * SCALE), Y: Math.round(y * SCALE) }));
const fromPath = (path: { X: number; Y: number }[]): Pt[] => path.map((p) => [p.X / SCALE, p.Y / SCALE]);

function treeToRegions(tree: any): Region[] {
  const out: Region[] = [];
  const walk = (node: any) => {
    for (const child of node.Childs()) {
      // Child of the root (or of a hole) is an outer ring; its children are holes.
      const outer = fromPath(child.Contour());
      const holes: Pt[][] = [];
      for (const hole of child.Childs()) {
        holes.push(fromPath(hole.Contour()));
        walk(hole); // islands inside holes
      }
      out.push({ outer, holes });
    }
  };
  walk(tree);
  return out;
}

/** Grow (or shrink, for negative `delta`) polygons with rounded corners. */
export function offsetPolygons(polys: Pt[][], delta: number, arcTolerance = 0.02): Region[] {
  const co = new C.ClipperOffset(2, arcTolerance * SCALE);
  co.AddPaths(polys.map(toPath), C.JoinType.jtRound, C.EndType.etClosedPolygon);
  const tree = new C.PolyTree();
  co.Execute(tree, delta * SCALE);
  return treeToRegions(tree);
}

function run(clipType: number, subject: Pt[][], clip: Pt[][]): Region[] {
  const c = new C.Clipper();
  c.AddPaths(subject.map(toPath), C.PolyType.ptSubject, true);
  if (clip.length) c.AddPaths(clip.map(toPath), C.PolyType.ptClip, true);
  const tree = new C.PolyTree();
  c.Execute(clipType, tree, C.PolyFillType.pftNonZero, C.PolyFillType.pftNonZero);
  return treeToRegions(tree);
}

export const regionRings = (regions: Region[]): Pt[][] => regions.flatMap((r) => [r.outer, ...r.holes]);

export function unionPolygons(polys: Pt[][]): Region[] {
  return run(C.ClipType.ctUnion, polys, []);
}

export function differencePolygons(subject: Pt[][], clip: Pt[][]): Region[] {
  return run(C.ClipType.ctDifference, subject, clip);
}

/** A stadium (slot with semicircular ends) as a polygon. */
export function stadium(center: Pt, angle: number, length: number, width: number, segments = 24): Pt[] {
  const r = width / 2;
  const half = Math.max(0, length / 2 - r);
  const ux = Math.cos(angle), uy = Math.sin(angle);
  const pts: Pt[] = [];
  for (const [end, start] of [[half, -Math.PI / 2], [-half, Math.PI / 2]] as const) {
    for (let i = 0; i <= segments; i++) {
      const t = start + (i / segments) * Math.PI;
      const lx = end + r * Math.cos(t), ly = r * Math.sin(t);
      pts.push([center[0] + lx * ux - ly * uy, center[1] + lx * uy + ly * ux]);
    }
  }
  return pts;
}
