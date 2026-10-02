// Session-only machinery (bitmaps, masks, workers) that doesn't belong in the saved project.
import * as Comlink from "comlink";
import type { SamWorkerApi, DecodedMask, Progress } from "../workers/sam.worker";
import type { CadWorkerApi } from "../workers/cad.worker";
import { floodSelect, paperSelect, toolSelectOnPaper } from "../lib/vision/floodfill";
import { cropMask, largestComponent, maskBounds, traceOuter, type Mask, type Vec2 } from "../lib/vision/mask";
import { fitPaper } from "../lib/vision/quad";
import { simplifyClosed } from "../lib/vision/smoothing";
import { frameFor, outlineFromPixels } from "./geometry";
import { newId, saveImage, useStore } from "./store";
import type { Click, ToolItem } from "./types";

const WORKING_MAX = 2048;

let sam: Comlink.Remote<SamWorkerApi> | null = null;

export function samWorker() {
  sam ??= Comlink.wrap<SamWorkerApi>(new Worker(new URL("../workers/sam.worker.ts", import.meta.url), { type: "module" }));
  return sam;
}

// ---------- CAD worker ----------

type Cad = Comlink.Remote<CadWorkerApi>;
let cad: { api: Cad; thread: Worker; busy: number; retired: boolean } | null = null;

function cadHandle() {
  if (!cad) {
    const thread = new Worker(new URL("../workers/cad.worker.ts", import.meta.url), { type: "module" });
    cad = { api: Comlink.wrap<CadWorkerApi>(thread), thread, busy: 0, retired: false };
    void cad.api.init("/fonts/label.ttf");
  }
  return cad;
}

/** wasm32 tops out at 4 GiB and OpenCascade's booleans leak a few MB each, so recycle well before that. */
const CAD_HEAP_LIMIT = 2.5e9;
/** A WASM fault leaves the OpenCascade instance corrupted: every later call fails. */
const WASM_FAULT = /out of bounds|null function|signature mismatch|unreachable|WebAssembly|Unserializable/i;

function retire(h: NonNullable<typeof cad>) {
  h.retired = true;
  if (cad === h) cad = null;
}

/**
 * Run a CAD call. A worker that faulted or whose heap passed CAD_HEAP_LIMIT is retired: later
 * calls get a fresh worker, and the old one is terminated once the calls queued on it settle.
 * A faulted call is retried once on the fresh worker.
 */
export async function withCad<T>(call: (api: Cad) => Promise<T>, retry = true): Promise<T> {
  const h = cadHandle();
  h.busy++;
  try {
    const result = await call(h.api);
    if (!h.retired && (await h.api.heapBytes().catch(() => 0)) > CAD_HEAP_LIMIT) retire(h);
    return result;
  } catch (e) {
    if (!WASM_FAULT.test(e instanceof Error ? e.message : String(e))) throw e;
    retire(h);
    if (!retry) throw e;
    return withCad(call, false);
  } finally {
    if (--h.busy === 0 && h.retired) h.thread.terminate();
  }
}

/** Preview ids only ever grow (across remounts and recycled workers), so a worker can spot obsolete builds. */
let previewId = 0;
export const nextPreviewId = () => ++previewId;

/** Let a queued preview skip, without starting a worker just to say so. */
export function supersedeCadPreviews() {
  if (cad) void cad.api.supersede(nextPreviewId());
}

interface Working {
  id: string;
  original: ImageBitmap;
  bitmap: ImageBitmap;
  rgba: Uint8ClampedArray;
  width: number;
  height: number;
  scale: number;
}

let working: Working | null = null;
let paperMask: Mask | null = null;
/** Tool masks in working pixels, cropped to their bounds, for seeing through tools on the paper edge. */
const toolMasks = new Map<string, { mask: Mask; x0: number; y0: number }>();

export const getWorking = () => working;

const hashBlob = async (blob: Blob) => {
  const head = await blob.slice(0, 2_000_000).arrayBuffer();
  let hex: string;
  if (globalThis.crypto?.subtle) {
    hex = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", head)).slice(0, 8)).map((b) => b.toString(16).padStart(2, "0")).join("");
  } else {
    // crypto.subtle only exists on https and localhost (not http://<LAN IP>); FNV-1a is plenty to key the embedding cache.
    let h = 0x811c9dc5;
    for (const b of new Uint8Array(head)) h = Math.imul(h ^ b, 0x01000193);
    hex = (h >>> 0).toString(16).padStart(8, "0");
  }
  return hex + blob.size.toString(36);
};

/** Decode a photo (EXIF rotation applied), build the working copy, and start the model. */
export async function openImage(blob: Blob, name: string, keepProject = false) {
  const store = useStore.getState();
  const original = await createImageBitmap(blob, { imageOrientation: "from-image" });
  const scale = Math.min(1, WORKING_MAX / Math.max(original.width, original.height));
  const width = Math.round(original.width * scale), height = Math.round(original.height * scale);
  const bitmap = await createImageBitmap(original, { resizeWidth: width, resizeHeight: height, resizeQuality: "high" });
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(bitmap, 0, 0);
  const rgba = ctx.getImageData(0, 0, width, height).data;
  working?.original.close();
  working = { id: await hashBlob(blob), original, bitmap, rgba, width, height, scale };
  paperMask = null;
  toolMasks.clear();
  if (!keepProject) {
    store.resetProject();
    void saveImage(blob);
  }
  store.setImageInfo({ name, width, height, scale });
  store.setEmbedding("none");
  // Read corners fresh: `store` is the snapshot from before resetProject.
  store.setInteraction(useStore.getState().corners ? { kind: "idle" } : { kind: "paper" });
  store.setView("photo");
  if (store.settings.engine === "ai") void prepareModel();
}

export async function prepareModel() {
  const store = useStore.getState();
  if (store.settings.engine !== "ai") return;
  const w = samWorker();
  try {
    if (store.model.status !== "ready") {
      store.setModel({ status: "loading", loaded: 0, total: 0 });
      const files = new Map<string, { loaded: number; total: number }>();
      const info = await w.load(
        store.settings.quality,
        Comlink.proxy((p: Progress) => {
          files.set(p.file, { loaded: p.loaded, total: p.total });
          let loaded = 0, total = 0;
          for (const f of files.values()) { loaded += f.loaded; total += f.total; }
          useStore.getState().setModel({ status: "loading", loaded, total });
        }),
      );
      useStore.getState().setModel({ status: "ready", device: info.device });
    }
    await ensureEmbedding();
  } catch (e) {
    useStore.getState().setModel({ status: "error", message: e instanceof Error ? e.message : String(e) });
    useStore.getState().notify({ tone: "warn", text: "The AI tracer couldn't load, so clicks use simple colour selection instead." });
  }
}

/** In-flight embeddings by photo id, so a new photo never waits on (or is mistaken for) the previous one's. */
const embeddings = new Map<string, Promise<void>>();
async function ensureEmbedding() {
  const cur = working;
  if (!cur) return;
  // Only the photo still on screen may update the store; a superseded one finishes quietly.
  const isCurrent = () => working === cur;
  const w = samWorker();
  if (await w.has(cur.id)) {
    if (isCurrent()) useStore.getState().setEmbedding("ready");
    return;
  }
  // Replaced meanwhile: don't spend seconds of encoder time on a photo nobody sees.
  if (!isCurrent()) return;
  useStore.getState().setEmbedding("working");
  let job = embeddings.get(cur.id);
  if (!job) {
    job = (async () => {
      const copy = await createImageBitmap(cur.bitmap);
      await w.embed(cur.id, Comlink.transfer(copy, [copy]));
    })();
    embeddings.set(cur.id, job);
    const done = () => embeddings.delete(cur.id);
    job.then(done, done);
  }
  try {
    await job;
    if (isCurrent()) useStore.getState().setEmbedding("ready");
  } catch (e) {
    if (!isCurrent()) return;
    useStore.getState().setEmbedding("error");
    throw e;
  }
}

const aiReady = () => {
  const s = useStore.getState();
  return s.settings.engine === "ai" && s.model.status === "ready" && s.embedding === "ready";
};

// ---------- hover preview ----------

let previewBusy = false;
let previewNext: { x: number; y: number; choose: "tool" | "largest" } | null = null;

/** Throttled low-res mask under the cursor. Resolves null when nothing's ready or superseded. */
export async function hoverPreview(x: number, y: number, choose: "tool" | "largest" = "tool"): Promise<DecodedMask | null> {
  if (!working || !aiReady()) return null;
  if (previewBusy) {
    previewNext = { x, y, choose };
    return null;
  }
  previewBusy = true;
  try {
    return await samWorker().preview(working.id, { x, y, positive: true }, choose);
  } catch {
    return null;
  } finally {
    previewBusy = false;
    const n = previewNext;
    previewNext = null;
    if (n) void hoverPreview(n.x, n.y, n.choose).then((m) => m && previewListeners.forEach((f) => f(m)));
  }
}
const previewListeners = new Set<(m: DecodedMask) => void>();
export const onLatePreview = (f: (m: DecodedMask) => void) => {
  previewListeners.add(f);
  return () => previewListeners.delete(f);
};

// ---------- segmentation ----------

async function segment(clicks: Click[], choose: "tool" | "largest"): Promise<Mask> {
  const cur = working;
  if (!cur) throw new Error("Add a photo first");
  if (aiReady()) {
    await ensureEmbedding(); // re-embeds if the worker's cache evicted this photo
    const m = await samWorker().decode(cur.id, clicks, choose);
    return largestComponent({ data: m.data, width: m.width, height: m.height });
  }
  // Simple mode (no model): brightness for the sheet, "not paper" for tools.
  const { rgba, width: w, height: h } = cur;
  if (choose === "largest") return largestComponent(paperSelect(rgba, w, h, clicks[0].x, clicks[0].y));
  const corners = useStore.getState().corners;
  const pick = (c: Click) => {
    if (!corners) return floodSelect(rgba, w, h, c.x, c.y).data;
    const sel = toolSelectOnPaper(rgba, w, h, c.x, c.y, corners);
    if (sel.touchesEdge && c.positive) {
      useStore.getState().notify({ tone: "warn", text: "Part of this tool is off the paper. Simple mode only traces what's on the sheet; the AI tracer handles the rest." });
    }
    return sel.mask.data;
  };
  const out = new Uint8Array(w * h);
  for (const c of clicks.filter((c) => c.positive)) {
    const m = pick(c);
    for (let i = 0; i < out.length; i++) out[i] |= m[i];
  }
  for (const c of clicks.filter((c) => !c.positive)) {
    const m = pick(c);
    for (let i = 0; i < out.length; i++) if (m[i]) out[i] = 0;
  }
  return largestComponent({ data: out, width: w, height: h });
}

/** Re-run the model on a tight crop of the full-resolution photo so the tool fills its input. */
async function detailOutline(coarse: Mask, clicks: Click[]): Promise<Vec2[] | null> {
  if (!working || !aiReady()) return null;
  const b = maskBounds(coarse);
  if (!b) return null;
  const s = working.scale;
  const pad = 0.12 * Math.max(b.x1 - b.x0, b.y1 - b.y0) + 12;
  const sx = Math.max(0, Math.floor((b.x0 - pad) / s)), sy = Math.max(0, Math.floor((b.y0 - pad) / s));
  const ex = Math.min(working.original.width, Math.ceil((b.x1 + pad) / s)), ey = Math.min(working.original.height, Math.ceil((b.y1 + pad) / s));
  const crop = await createImageBitmap(working.original, sx, sy, ex - sx, ey - sy);
  const id = `${working.id}:${sx},${sy},${ex},${ey}`;
  const w = samWorker();
  if (!(await w.has(id))) await w.embed(id, Comlink.transfer(crop, [crop]));
  const local = clicks.map((c) => ({ ...c, x: c.x / s - sx, y: c.y / s - sy }));
  const box: [number, number, number, number] = [b.x0 / s - sx, b.y0 / s - sy, b.x1 / s - sx, b.y1 / s - sy];
  const fine = await w.decode(id, local, "tool", box);
  const fineMask = largestComponent({ data: fine.data, width: fine.width, height: fine.height });
  // Sanity check: most of the coarse mask should be inside the fine one.
  let inCoarse = 0, both = 0;
  for (let y = b.y0; y < b.y1; y += 2) {
    for (let x = b.x0; x < b.x1; x += 2) {
      if (!coarse.data[y * coarse.width + x]) continue;
      inCoarse++;
      const fx = Math.floor(x / s - sx), fy = Math.floor(y / s - sy);
      if (fx >= 0 && fy >= 0 && fx < fine.width && fy < fine.height && fineMask.data[fy * fine.width + fx]) both++;
    }
  }
  if (!inCoarse || both / inCoarse < 0.85) return null;
  return traceOuter(fineMask).map(([x, y]) => [(x + sx) * s, (y + sy) * s]);
}

function keepToolMask(id: string, m: Mask) {
  const b = maskBounds(m);
  if (!b) return;
  toolMasks.set(id, { mask: cropMask(m, b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0), x0: b.x0, y0: b.y0 });
}

function fullToolMasks(): Mask[] {
  if (!working) return [];
  return [...toolMasks.values()].map(({ mask, x0, y0 }) => {
    const out = new Uint8Array(working!.width * working!.height);
    for (let y = 0; y < mask.height; y++) out.set(mask.data.subarray(y * mask.width, (y + 1) * mask.width), (y0 + y) * working!.width + x0);
    return { data: out, width: working!.width, height: working!.height };
  });
}

/** Trace (or re-trace) a tool from its clicks, and add or update it in the project. */
export async function traceTool(clicks: Click[], toolId: string | null, detail = false): Promise<string | null> {
  const store = useStore.getState();
  const cur = working;
  if (!cur || !clicks.some((c) => c.positive)) return toolId;
  store.setBusy(detail ? "Tracing in detail…" : "Tracing…");
  try {
    const mask = await segment(clicks, "tool");
    if (working !== cur) return toolId; // another photo was opened meanwhile
    let outlinePx = traceOuter(mask);
    if (outlinePx.length < 3) {
      store.notify({ tone: "warn", text: "Nothing found at that spot. Click directly on the tool." });
      return toolId;
    }
    const area = mask.data.reduce((a, v) => a + v, 0);
    if (area > 0.45 * mask.data.length) {
      store.notify({ tone: "warn", text: "That selected most of the photo. Click on the tool itself, or add a negative click on the background." });
    }
    if (detail) {
      const fine = await detailOutline(mask, clicks).catch(() => null);
      if (working !== cur) return toolId;
      if (fine) outlinePx = fine;
      else store.notify({ tone: "info", text: "Detail pass didn't improve this outline, so the standard trace was kept." });
    }
    outlinePx = simplifyClosed(outlinePx, 0.35);
    const id = toolId ?? newId();
    keepToolMask(id, mask);
    const s = useStore.getState();
    const existing = s.tools.find((t) => t.id === id);
    const frame = frameFor(s.corners, s.settings.paper);
    const derived = frame ? outlineFromPixels(outlinePx, frame, detail) : null;
    if (frame && !derived) store.notify({ tone: "warn", text: "This tool can't be measured with the current paper corners. Check that they sit on the sheet's corners." });
    const tool: ToolItem = {
      ...(existing ?? {
        id,
        name: `Tool ${s.tools.filter((t) => t.kind === "traced").length + 1}`,
        kind: "traced" as const,
        x: 0,
        y: 0,
        rotation: 0,
        depth: null,
        fingerSlot: true,
        label: "",
        placed: false,
      }),
      clicks,
      detail,
      outlinePx,
      outline: derived?.local ?? existing?.outline ?? [],
    };
    if (derived && !tool.placed) { tool.x = derived.center[0]; tool.y = derived.center[1]; }
    s.upsertTool(tool);
    void refitPaper();
    return id;
  } catch (e) {
    store.notify({ tone: "error", text: e instanceof Error ? e.message : String(e) });
    return toolId;
  } finally {
    useStore.getState().setBusy(null);
  }
}

export function forgetToolMask(id: string) {
  toolMasks.delete(id);
  void refitPaper();
}

/** Click on the sheet: segment it and fit its four corners. */
export async function findPaper(x: number, y: number) {
  const store = useStore.getState();
  const cur = working;
  if (!cur) return;
  store.setBusy("Finding the paper…");
  try {
    const mask = await segment([{ x, y, positive: true }], "largest");
    if (working !== cur) return; // another photo was opened meanwhile
    paperMask = mask;
    const fit = fitPaper(paperMask, fullToolMasks());
    const sane = !!frameFor(fit.corners, useStore.getState().settings.paper) && fit.fill <= MAX_FILL;
    if (!sane || fit.fill < 0.85) store.notify({ tone: "warn", text: "The paper outline looks uneven. Drag the corner handles onto the sheet's corners." });
    else store.notify(null);
    store.setCorners(fit.corners, false);
    store.setInteraction({ kind: "trace", clicks: [], toolId: null });
  } catch (e) {
    store.notify({ tone: "error", text: e instanceof Error ? e.message : String(e) });
  } finally {
    useStore.getState().setBusy(null);
  }
}

/** A mask filling clearly more than its quad means the quad leaves part of the sheet out, i.e. it's wrong. */
const MAX_FILL = 1.05;

/**
 * A refit must be a valid sheet. It may move the corners far only if it fills its quad almost
 * exactly (a clean sheet correcting a first fit skewed by tools on the edge) or if the current
 * corners aren't a valid sheet; otherwise it may only nudge them.
 */
function refitAcceptable(prev: Vec2[] | null, fit: { corners: Vec2[]; fill: number }, paper: Mask): boolean {
  const kind = useStore.getState().settings.paper;
  if (fit.fill > MAX_FILL || !frameFor(fit.corners, kind)) return false;
  if (!prev || prev.length !== 4 || !frameFor(prev, kind)) return true;
  if (fit.fill >= 0.95 && fit.fill <= 1.02) return true;
  const limit = 0.05 * Math.hypot(paper.width, paper.height);
  return fit.corners.every((c, i) => Math.hypot(c[0] - prev[i][0], c[1] - prev[i][1]) <= limit);
}

let refitTimer: ReturnType<typeof setTimeout> | undefined;
async function refitPaper() {
  clearTimeout(refitTimer);
  refitTimer = setTimeout(() => {
    const s = useStore.getState();
    if (!paperMask || s.cornersManual) return;
    try {
      const fit = fitPaper(paperMask, fullToolMasks());
      if (refitAcceptable(s.corners, fit, paperMask)) s.setCorners(fit.corners, false);
    } catch {
      /* keep the previous corners */
    }
  }, 400);
}

/** Drop the photo but keep settings (used by "New project"). */
export function closeImage() {
  working?.original.close();
  working = null;
  paperMask = null;
  toolMasks.clear();
}
