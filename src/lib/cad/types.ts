/** 2D point in millimetres. Panel coordinates are Y-up (CAD convention). */
export type Pt = [number, number];

/** A cutout. Outlines come from the tracer; circles and rounded rectangles are user-added shapes. */
export type CutoutShape =
  | { kind: "polygon"; points: Pt[] }
  | { kind: "circle"; center: Pt; diameter: number }
  | { kind: "roundedRect"; center: Pt; width: number; height: number; radius?: number; angleDeg?: number };

export interface FingerSlot {
  /** Slot direction in degrees. Defaults to perpendicular to the tool's long axis. */
  angleDeg?: number;
  /** Slot length in mm. Defaults to the tool's width across that direction plus one finger diameter. */
  length?: number;
  /** Shift from the tool's centroid, in mm. */
  offset?: Pt;
}

export interface Cutout {
  id: string;
  shape: CutoutShape;
  /** Pocket depth in mm, measured from the tray top (Gridfinity only; foam cuts through). */
  depth?: number;
  /** `true` for the default slot, or a configured slot. */
  fingerSlot?: boolean | FingerSlot;
  /** Engraved label text, placed at `labelAt` (defaults to below the shape). */
  label?: string;
  labelAt?: Pt;
}

export type MagnetPattern = "none" | "corners" | "all";

export interface GridfinityParams {
  /** Grid pitch. Gridfinity standard is 42 mm. */
  cellSize?: number;
  /** Total clearance per axis; the outer size is `cells * cellSize - clearance`. Standard 0.5 mm. */
  clearance?: number;
  /** Force a grid size. When omitted, the smallest grid that fits every cutout is used. */
  cellsX?: number;
  cellsY?: number;
  /** Panel centre in the same frame as the cutouts. Defaults to the cutouts' bounding-box centre. */
  center?: Pt;
  /** Minimum solid wall between any pocket and the outer edge. */
  wallMargin?: number;
  /** Outline offset applied to every cutout (the "tolerance" setting). */
  tolerance?: number;
  /** Default pocket depth for cutouts without their own. */
  pocketDepth?: number;
  /** Minimum solid floor under the deepest pocket. */
  floor?: number;
  /** Round the bin height up to whole 7 mm Gridfinity units (the extra goes into the floor). */
  snapToHeightUnits?: boolean;
  /** Add the stacking lip. */
  lip?: boolean;
  magnets?: MagnetPattern;
  magnetDiameter?: number;
  magnetDepth?: number;
  fingerDiameter?: number;
  /**
   * Thickness of the pocket-floor layer exported as a separate body, so it can be
   * printed in a contrasting colour (shadow-board effect). 0 disables it.
   */
  contrastLayer?: number;
  /** Engraving depth for labels. */
  labelDepth?: number;
  labelSize?: number;
  /** Split into printable tiles along cell boundaries when the bin exceeds this bed size. */
  maxPlate?: { width: number; height: number };
}

export interface FoamParams {
  /** Explicit panel size. When omitted, the cutouts' bounds plus `margin`. */
  width?: number;
  height?: number;
  center?: Pt;
  margin?: number;
  tolerance?: number;
  /** Thickness of the layer the tools sit in (cut through). */
  thickness?: number;
  /** Solid backer layer under the cut layer. 0 disables it. Default 6.35 mm (1/4"). */
  backer?: number;
  fingerDiameter?: number;
}

export type PartKind = "tray" | "contrast" | "foamCut" | "foamBacker";

/** Serialisable description of what the kernel produced, without the kernel objects. */
export interface PartInfo {
  name: string;
  kind: PartKind;
  /** Tile index when a bin is split for printing, else 0. */
  tile: number;
  bounds: [[number, number, number], [number, number, number]];
}

export interface GridfinityLayout {
  cellsX: number;
  cellsY: number;
  width: number;
  depth: number;
  /** Height of the tray top above the bottom of the feet (excludes the lip). */
  height: number;
  heightUnits: number;
  center: Pt;
  tiles: { index: number; cellX0: number; cellY0: number; cellsX: number; cellsY: number }[];
}
