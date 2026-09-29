import type { Vec2 } from "../lib/vision/mask";

export type Mode = "gridfinity" | "foam";
export type Units = "mm" | "in";
export type PaperType = "letter" | "a4";
export type View = "photo" | "layout" | "3d";
export type Engine = "ai" | "simple";

export interface Click { x: number; y: number; positive: boolean }

export interface ToolItem {
  id: string;
  name: string;
  kind: "traced" | "circle" | "rect";
  /** Traced tools: clicks and outline in working-image pixels (the source of truth). */
  clicks?: Click[];
  outlinePx?: Vec2[];
  detail?: boolean;
  /** Shapes: size in mm. */
  diameter?: number;
  width?: number;
  height?: number;
  radius?: number;
  /** Outline in mm around its own centroid (derived for traced tools). */
  outline: Vec2[];
  /** Placement on the bin/foam in mm (Y-up), rotation in degrees. */
  x: number;
  y: number;
  rotation: number;
  /** Pocket depth in mm; null uses the default. */
  depth: number | null;
  fingerSlot: boolean;
  label: string;
  /** True once the user has moved it, so re-tracing keeps their placement. */
  placed: boolean;
}

export interface Settings {
  mode: Mode;
  units: Units;
  paper: PaperType;
  engine: Engine;
  quality: "standard" | "high";
  tolerance: number;
  fingerDiameter: number;
  gridfinity: {
    pocketDepth: number;
    lip: boolean;
    magnets: "none" | "corners" | "all";
    contrastLayer: number;
    cellSize: number;
    snapHeight: boolean;
    split: boolean;
    bedWidth: number;
    bedDepth: number;
  };
  foam: {
    thickness: number;
    backer: number;
    margin: number;
  };
}

export const DEFAULT_SETTINGS: Settings = {
  mode: "gridfinity",
  units: "mm",
  paper: "letter",
  engine: "ai",
  quality: "standard",
  tolerance: 1.5,
  fingerDiameter: 20,
  gridfinity: {
    pocketDepth: 18,
    lip: true,
    magnets: "none",
    contrastLayer: 0.6,
    cellSize: 42,
    snapHeight: true,
    split: false,
    bedWidth: 256,
    bedDepth: 256,
  },
  foam: { thickness: 25.4, backer: 6.35, margin: 15 },
};

export interface ImageInfo {
  name: string;
  /** Working image size (the one shown, traced and stored). */
  width: number;
  height: number;
  /** working / original. */
  scale: number;
}

export interface ProjectData {
  version: 1;
  image: ImageInfo | null;
  corners: Vec2[] | null;
  cornersManual: boolean;
  tools: ToolItem[];
  settings: Settings;
}
