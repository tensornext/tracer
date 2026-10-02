// Pure layout planning (no CAD kernel): offsets, finger slots, grid sizing, foam panel and
// 2D cut paths. The UI calls this on every edit; the kernel worker reuses it to build solids.
import { FOOT_HEIGHT, GRIDFINITY, boundsOf, centroid, extentAlong, normalizePolygon, planTiles, principalAngle, shapePoints, TOLERANCE_PRESETS } from "./geometry2d";
import { offsetPolygons, regionRings, stadium, unionPolygons, type Region } from "./polygons";
import type { Cutout, FoamParams, GridfinityLayout, GridfinityParams, Pt } from "./types";

export const GF_DEFAULTS: Required<Omit<GridfinityParams, "cellsX" | "cellsY" | "center" | "maxPlate">> = {
  cellSize: GRIDFINITY.cellSize,
  clearance: GRIDFINITY.clearance,
  wallMargin: 4,
  tolerance: TOLERANCE_PRESETS.medium,
  pocketDepth: 20,
  floor: 1.2,
  snapToHeightUnits: true,
  lip: true,
  magnets: "none",
  magnetDiameter: 6.5,
  magnetDepth: 2.4,
  fingerDiameter: 20,
  contrastLayer: 0.6,
  labelDepth: 0.6,
  labelSize: 6,
};

export const FOAM_DEFAULTS: { margin: number; tolerance: number; thickness: number; backer: number; fingerDiameter: number } = { margin: 15, tolerance: TOLERANCE_PRESETS.medium, thickness: 25.4, backer: 6.35, fingerDiameter: 20 };

export interface Slot { poly: Pt[]; center: Pt; angle: number; length: number; width: number }

export interface Planned {
  cutout: Cutout;
  depth: number;
  /** Footprint grown by the tolerance, as Clipper regions. */
  regions: Region[];
  slot: Slot | null;
}

export function planCutouts(cutouts: Cutout[], tol: number, defaultDepth: number, fingerDia: number): Planned[] {
  if (!(fingerDia >= 1) && cutouts.some((c) => c.fingerSlot)) throw new Error("Finger slot width must be at least 1 mm");
  return cutouts.map((cutout) => {
    const pts = shapePoints(cutout.shape, 96);
    const regions = offsetPolygons([normalizePolygon(pts)], tol);
    if (regions.length === 0) throw new Error(`Cutout ${cutout.id} vanished after applying tolerance`);
    let slot: Slot | null = null;
    if (cutout.fingerSlot) {
      const cfg = typeof cutout.fingerSlot === "object" ? cutout.fingerSlot : {};
      const ring = regions[0].outer;
      const c = centroid(ring);
      const angle = cfg.angleDeg !== undefined ? (cfg.angleDeg * Math.PI) / 180 : principalAngle(ring) + Math.PI / 2;
      const ext = extentAlong(ring, angle, c);
      // Centre the slot on the tool's span along the slot axis so it overhangs both sides equally.
      const mid = (ext.min + ext.max) / 2;
      const center: Pt = cfg.offset
        ? [c[0] + cfg.offset[0], c[1] + cfg.offset[1]]
        : [c[0] + Math.cos(angle) * mid, c[1] + Math.sin(angle) * mid];
      const length = cfg.length ?? ext.max - ext.min + fingerDia;
      slot = { poly: stadium(center, angle, length, fingerDia), center, angle, length, width: fingerDia };
    }
    return { cutout, depth: cutout.depth ?? defaultDepth, regions, slot };
  });
}

export function footprintBounds(planned: Planned[]) {
  const all: Cutout[] = planned.flatMap((p, i) => [
    ...regionRings(p.regions).map((ring, j) => ({ id: `${i}-${j}`, shape: { kind: "polygon" as const, points: ring } })),
    ...(p.slot ? [{ id: `${i}-slot`, shape: { kind: "polygon" as const, points: p.slot.poly } }] : []),
  ]);
  return boundsOf(all);
}

const MAX_CELLS = 40;
/** OpenCascade's peak heap grows with the cell count: about 600 cells reach 2.5 GB, 36×36 hits the 4 GB wasm32 limit. */
const MAX_AREA = 600;

export function planGridfinity(cutouts: Cutout[], params: GridfinityParams = {}): { layout: GridfinityLayout; planned: Planned[]; p: typeof GF_DEFAULTS } {
  const p = { ...GF_DEFAULTS, ...params };
  const planned = planCutouts(cutouts, p.tolerance, p.pocketDepth, p.fingerDiameter);
  const b = footprintBounds(planned);
  const has = planned.length > 0;
  const center: Pt = params.center ?? (has ? [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2] : [0, 0]);
  const needW = has ? 2 * Math.max(center[0] - b.minX, b.maxX - center[0]) + 2 * p.wallMargin : 0;
  const needD = has ? 2 * Math.max(center[1] - b.minY, b.maxY - center[1]) + 2 * p.wallMargin : 0;
  const autoX = Math.max(1, Math.ceil((needW + p.clearance) / p.cellSize));
  const autoY = Math.max(1, Math.ceil((needD + p.clearance) / p.cellSize));
  const cellsX = params.cellsX ?? autoX;
  const cellsY = params.cellsY ?? autoY;
  // Far past any drawer; usually a sign of misplaced paper corners. Building it would take forever.
  if (cellsX > MAX_CELLS || cellsY > MAX_CELLS || cellsX * cellsY > MAX_AREA) {
    throw new Error(`This bin would be ${cellsX}×${cellsY} cells. Check the paper corners and pocket sizes`);
  }
  if (cellsX < autoX || cellsY < autoY) {
    throw new Error(`Cutouts need at least ${autoX}×${autoY} cells; ${cellsX}×${cellsY} was requested`);
  }
  const maxDepth = planned.reduce((m, x) => Math.max(m, x.depth), 0);
  let height = FOOT_HEIGHT + p.floor + p.contrastLayer + maxDepth;
  if (p.snapToHeightUnits) height = Math.ceil(height / GRIDFINITY.unitHeight - 1e-9) * GRIDFINITY.unitHeight;
  const layout: GridfinityLayout = {
    cellsX,
    cellsY,
    width: cellsX * p.cellSize - p.clearance,
    depth: cellsY * p.cellSize - p.clearance,
    height,
    heightUnits: height / GRIDFINITY.unitHeight,
    center,
    tiles: planTiles(cellsX, cellsY, p.cellSize, p.clearance, params.maxPlate),
  };
  return { layout, planned, p };
}

export interface FoamPlan {
  width: number;
  height: number;
  center: Pt;
  planned: Planned[];
  p: typeof FOAM_DEFAULTS & FoamParams;
  /** Panel outline first, then the union of every cut, centred on the panel (mm, Y-up). */
  cutPaths: Pt[][];
}

export function planFoam(cutouts: Cutout[], params: FoamParams = {}): FoamPlan {
  const p = { ...FOAM_DEFAULTS, ...params };
  // A zero-height cut layer sends OpenCascade into an endless loop, so stop it here.
  if (!(p.thickness > 0)) throw new Error("Cut layer thickness must be more than 0");
  if (!(p.backer >= 0)) throw new Error("Backer thickness can't be negative");
  const planned = planCutouts(cutouts, p.tolerance, 0, p.fingerDiameter);
  const b = footprintBounds(planned);
  const has = planned.length > 0;
  const center: Pt = params.center ?? (has ? [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2] : [0, 0]);
  const width = params.width ?? (has ? b.maxX - b.minX : 100) + 2 * p.margin;
  const height = params.height ?? (has ? b.maxY - b.minY : 100) + 2 * p.margin;
  const shift = (pts: Pt[]): Pt[] => pts.map(([x, y]) => [x - center[0], y - center[1]]);
  const union = unionPolygons(planned.flatMap((x) => [...regionRings(x.regions), ...(x.slot ? [x.slot.poly] : [])]));
  const hw = width / 2, hh = height / 2;
  const cutPaths: Pt[][] = [[[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]], ...regionRings(union).map(shift)];
  return { width, height, center, planned, p, cutPaths };
}

export { FOOT_HEIGHT };
