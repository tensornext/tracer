import { create } from "zustand";
import { del, get, set } from "idb-keyval";
import { DEFAULT_SETTINGS, type Click, type ProjectData, type Settings, type ToolItem, type View } from "./types";
import type { Vec2 } from "../lib/vision/mask";
import { frameFor, outlineFromPixels } from "./geometry";

export type Interaction =
  | { kind: "idle" }
  | { kind: "paper" }
  /** Tracing a tool: clicks so far; `toolId` is set once the first mask exists. */
  | { kind: "trace"; clicks: Click[]; toolId: string | null };

export type ModelState =
  | { status: "idle" }
  | { status: "loading"; loaded: number; total: number }
  | { status: "ready"; device: "webgpu" | "wasm" }
  | { status: "error"; message: string };

interface State extends ProjectData {
  view: View;
  selected: string | null;
  interaction: Interaction;
  model: ModelState;
  embedding: "none" | "working" | "ready" | "error";
  busy: string | null;
  notice: { tone: "info" | "warn" | "error"; text: string } | null;

  setView(v: View): void;
  select(id: string | null): void;
  setInteraction(i: Interaction): void;
  setModel(m: ModelState): void;
  setEmbedding(e: State["embedding"]): void;
  setBusy(b: string | null): void;
  notify(n: State["notice"]): void;

  loadProject(p: ProjectData): void;
  resetProject(): void;
  setImageInfo(i: ProjectData["image"]): void;
  setCorners(c: Vec2[] | null, manual: boolean): void;
  updateSettings(patch: Partial<Settings> | ((s: Settings) => Settings)): void;
  upsertTool(t: ToolItem): void;
  updateTool(id: string, patch: Partial<ToolItem>): void;
  removeTool(id: string): void;
  duplicateTool(id: string): void;
  applyPlacements(p: Pick<ToolItem, "id" | "x" | "y" | "rotation">[]): void;
}

const EMPTY: ProjectData = { version: 1, image: null, corners: null, cornersManual: false, tools: [], settings: DEFAULT_SETTINGS };

let counter = 0;
export const newId = () => `${Date.now().toString(36)}${(counter++).toString(36)}`;

/** Re-derive every traced tool's mm outline from its pixels (after paper corners or paper size change). */
function rederive(tools: ToolItem[], corners: Vec2[] | null, settings: Settings): ToolItem[] {
  const frame = frameFor(corners, settings.paper);
  if (!frame) return tools;
  return tools.map((t) => {
    if (t.kind !== "traced" || !t.outlinePx || t.outlinePx.length < 3) return t;
    const derived = outlineFromPixels(t.outlinePx, frame, !!t.detail);
    if (!derived) return t;
    const { local, center } = derived;
    return t.placed ? { ...t, outline: local } : { ...t, outline: local, x: center[0], y: center[1] };
  });
}

export const useStore = create<State>((setState, getState) => ({
  ...EMPTY,
  view: "photo",
  selected: null,
  interaction: { kind: "idle" },
  model: { status: "idle" },
  embedding: "none",
  busy: null,
  notice: null,

  setView: (view) => setState({ view }),
  select: (selected) => setState({ selected }),
  setInteraction: (interaction) => setState({ interaction }),
  setModel: (model) => setState({ model }),
  setEmbedding: (embedding) => setState({ embedding }),
  setBusy: (busy) => setState({ busy }),
  notify: (notice) => setState({ notice }),

  loadProject: (p) => setState({ ...EMPTY, ...p, settings: { ...DEFAULT_SETTINGS, ...p.settings, gridfinity: { ...DEFAULT_SETTINGS.gridfinity, ...p.settings?.gridfinity }, foam: { ...DEFAULT_SETTINGS.foam, ...p.settings?.foam } }, selected: null, interaction: { kind: "idle" } }),
  resetProject: () => setState({ ...EMPTY, settings: getState().settings, selected: null, interaction: { kind: "idle" }, view: "photo", embedding: "none" }),
  setImageInfo: (image) => setState({ image }),
  setCorners: (corners, cornersManual) => {
    const { tools, settings } = getState();
    setState({ corners, cornersManual, tools: rederive(tools, corners, settings) });
  },
  updateSettings: (patch) => {
    const prev = getState().settings;
    const settings = typeof patch === "function" ? patch(prev) : { ...prev, ...patch };
    const paperChanged = settings.paper !== prev.paper;
    setState({ settings, tools: paperChanged ? rederive(getState().tools, getState().corners, settings) : getState().tools });
  },
  upsertTool: (t) => {
    const tools = getState().tools;
    const i = tools.findIndex((x) => x.id === t.id);
    setState({ tools: i < 0 ? [...tools, t] : tools.map((x) => (x.id === t.id ? t : x)) });
  },
  updateTool: (id, patch) => setState({ tools: getState().tools.map((t) => (t.id === id ? { ...t, ...patch } : t)) }),
  removeTool: (id) => setState({ tools: getState().tools.filter((t) => t.id !== id), selected: getState().selected === id ? null : getState().selected }),
  duplicateTool: (id) => {
    const t = getState().tools.find((x) => x.id === id);
    if (!t) return;
    const copy: ToolItem = { ...t, id: newId(), name: `${t.name} copy`, x: t.x + 15, y: t.y - 15, placed: true };
    setState({ tools: [...getState().tools, copy], selected: copy.id });
  },
  applyPlacements: (p) => {
    const byId = new Map(p.map((x) => [x.id, x]));
    setState({ tools: getState().tools.map((t) => (byId.has(t.id) ? { ...t, ...byId.get(t.id)!, placed: true } : t)) });
  },
}));

// ---------- autosave (IndexedDB) ----------

const KEY = "toolbed:project";
const IMAGE_KEY = "toolbed:image";

export function snapshot(): ProjectData {
  const s = useStore.getState();
  return { version: 1, image: s.image, corners: s.corners, cornersManual: s.cornersManual, tools: s.tools, settings: s.settings };
}

/** Saving is best-effort. idb-keyval opens the database synchronously, so blocked storage throws rather than rejects. */
const quietly = async (f: () => Promise<unknown>) => {
  try {
    await f();
  } catch {
    // Storage unavailable (private mode, blocked site data): keep working without it.
  }
};

let timer: ReturnType<typeof setTimeout> | undefined;
export function startAutosave() {
  return useStore.subscribe((s, prev) => {
    if (s.tools === prev.tools && s.settings === prev.settings && s.corners === prev.corners && s.image === prev.image) return;
    clearTimeout(timer);
    timer = setTimeout(() => void quietly(() => set(KEY, snapshot())), 600);
  });
}

export const saveImage = (blob: Blob) => quietly(() => set(IMAGE_KEY, blob));
export const loadSaved = async (): Promise<{ project: ProjectData; image: Blob } | null> => {
  try {
    const [project, image] = await Promise.all([get<ProjectData>(KEY), get<Blob>(IMAGE_KEY)]);
    return project && image ? { project, image } : null;
  } catch {
    return null;
  }
};
export const clearSaved = () => quietly(() => Promise.all([del(KEY), del(IMAGE_KEY)]));
