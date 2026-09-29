/// <reference lib="webworker" />
// Segment Anything 2.1 (tiny) running in the browser: WebGPU when available, WASM otherwise.
// The image encoder runs once per photo (or crop); each click only runs the small decoder.
import * as Comlink from "comlink";
import { AutoProcessor, env, RawImage, Sam2Model, type Tensor } from "@huggingface/transformers";

env.allowLocalModels = false;

export const MODEL_ID = "onnx-community/sam2.1-hiera-tiny-ONNX";

export type Quality = "standard" | "high";
export interface LoadInfo { device: "webgpu" | "wasm"; quality: Quality }
export interface Progress { file: string; loaded: number; total: number }
export interface Click { x: number; y: number; positive: boolean }
export type Choose = "tool" | "largest";

export interface DecodedMask {
  data: Uint8Array;
  width: number;
  height: number;
  score: number;
}

interface Embedded {
  width: number;
  height: number;
  inputs: { original_sizes: [number, number][]; reshaped_input_sizes: [number, number][] };
  embeddings: Record<string, Tensor>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let model: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let processor: any = null;
let loading: Promise<LoadInfo> | null = null;
const cache = new Map<string, Embedded>();
const CACHE_LIMIT = 3;

async function hasWebGPU(): Promise<boolean> {
  try {
    const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
    return !!gpu && !!(await gpu.requestAdapter());
  } catch {
    return false;
  }
}

async function loadModel(quality: Quality, onProgress?: (p: Progress) => void): Promise<LoadInfo> {
  // Only float32-IO variants: quantised weights, but tensors between encoder and decoder stay fp32.
  const progress_callback = (e: { status: string; file?: string; loaded?: number; total?: number }) => {
    if (e.status === "progress" && e.file && onProgress) onProgress({ file: e.file, loaded: e.loaded ?? 0, total: e.total ?? 0 });
  };
  const gpu = await hasWebGPU();
  const attempts: { device: "webgpu" | "wasm"; dtype: Record<string, string> }[] = [];
  if (gpu) attempts.push({ device: "webgpu", dtype: { vision_encoder: quality === "high" ? "fp32" : "q4", prompt_encoder_mask_decoder: "fp32" } });
  attempts.push({ device: "wasm", dtype: { vision_encoder: "q8", prompt_encoder_mask_decoder: "fp32" } });
  let lastError: unknown;
  for (const a of attempts) {
    try {
      model = await Sam2Model.from_pretrained(MODEL_ID, { device: a.device, dtype: a.dtype as never, progress_callback } as never);
      processor = await AutoProcessor.from_pretrained(MODEL_ID);
      return { device: a.device, quality };
    } catch (e) {
      lastError = e;
      model = null;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function toRaw(bitmap: ImageBitmap): RawImage {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(bitmap, 0, 0);
  const { data } = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
  bitmap.close();
  return new RawImage(data, canvas.width, canvas.height, 4);
}

function pickIndex(scores: number[], areas: number[], total: number, choose: Choose): number {
  if (choose === "largest") return areas.indexOf(Math.max(...areas));
  // A single click on a tool offers part / tool / everything; skip "everything" (sheet, table).
  const sane = scores.map((s, i) => ({ s, i })).filter(({ i }) => areas[i] > 0 && areas[i] < 0.45 * total);
  const pool = sane.length ? sane : scores.map((s, i) => ({ s, i }));
  return pool.reduce((a, b) => (b.s > a.s ? b : a)).i;
}

async function runDecoder(id: string, clicks: Click[], box?: [number, number, number, number]) {
  const e = cache.get(id);
  if (!e) throw new Error("Image is not ready yet");
  const { original_sizes, reshaped_input_sizes } = e.inputs;
  const input: Record<string, Tensor> = { ...e.embeddings };
  if (clicks.length) {
    input.input_points = processor.reshape_input_points([[clicks.map((c) => [c.x, c.y])]], original_sizes, reshaped_input_sizes);
    input.input_labels = processor.image_processor.add_input_labels([[clicks.map((c) => (c.positive ? 1 : 0))]], input.input_points);
  }
  if (box) input.input_boxes = processor.reshape_input_points([[box]], original_sizes, reshaped_input_sizes, true);
  const out = await model(input);
  return { e, out };
}

/** Area of each of the 3 low-res masks, restricted to the un-padded region. */
function lowResAreas(pred: Tensor, e: Embedded) {
  const [, , c, h, w] = pred.dims as number[];
  const pad = processor.image_processor.pad_size ?? processor.image_processor.size ?? { height: 1024, width: 1024 };
  const [rh, rw] = e.inputs.reshaped_input_sizes[0];
  const vh = Math.max(1, Math.round((h * rh) / pad.height)), vw = Math.max(1, Math.round((w * rw) / pad.width));
  const data = pred.data as Float32Array;
  const areas: number[] = [];
  for (let k = 0; k < c; k++) {
    let n = 0;
    const base = k * h * w;
    for (let y = 0; y < vh; y++) for (let x = 0; x < vw; x++) if (data[base + y * w + x] > 0) n++;
    areas.push(n);
  }
  return { areas, vw, vh, w, h, total: vw * vh };
}

const api = {
  async load(quality: Quality, onProgress?: (p: Progress) => void): Promise<LoadInfo> {
    loading ??= loadModel(quality, onProgress).catch((e) => {
      loading = null;
      throw e;
    });
    return loading;
  },

  /** Compute and cache the image embedding. Returns milliseconds taken. */
  async embed(id: string, bitmap: ImageBitmap): Promise<number> {
    if (!model) throw new Error("Model not loaded");
    const t0 = performance.now();
    const raw = toRaw(bitmap);
    const inputs = await processor(raw);
    const embeddings = await model.get_image_embeddings(inputs);
    cache.set(id, { width: raw.width, height: raw.height, inputs, embeddings });
    while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
    return performance.now() - t0;
  },

  has(id: string) {
    return cache.has(id);
  },

  /** Fast low-resolution mask for hover previews (about 256 px across). */
  async preview(id: string, click: Click, choose: Choose = "tool"): Promise<DecodedMask> {
    const { e, out } = await runDecoder(id, [click]);
    const pred = out.pred_masks as Tensor;
    const { areas, vw, vh, w, h, total } = lowResAreas(pred, e);
    const k = pickIndex(Array.from(out.iou_scores.data as Float32Array), areas, total, choose);
    const src = pred.data as Float32Array;
    const data = new Uint8Array(vw * vh);
    for (let y = 0; y < vh; y++) for (let x = 0; x < vw; x++) data[y * vw + x] = src[k * h * w + y * w + x] > 0 ? 1 : 0;
    return Comlink.transfer({ data, width: vw, height: vh, score: (out.iou_scores.data as Float32Array)[k] }, [data.buffer]);
  },

  /** Full-resolution mask for the clicks (and optional box), in the embedded image's pixels. */
  async decode(id: string, clicks: Click[], choose: Choose = "tool", box?: [number, number, number, number]): Promise<DecodedMask> {
    const { e, out } = await runDecoder(id, clicks, box);
    const pred = out.pred_masks as Tensor;
    const { areas, total } = lowResAreas(pred, e);
    const scores = Array.from(out.iou_scores.data as Float32Array);
    const k = pickIndex(scores, areas, total, choose);
    let chosen: Tensor;
    try {
      chosen = pred.slice(null, null, [k, k + 1]);
    } catch {
      chosen = pred;
    }
    const [full] = await processor.post_process_masks(chosen, e.inputs.original_sizes, e.inputs.reshaped_input_sizes);
    const channels = full.dims[1] as number;
    const plane = e.width * e.height;
    const offset = channels === 1 ? 0 : k * plane;
    const data = new Uint8Array((full.data as Uint8Array).subarray(offset, offset + plane));
    return Comlink.transfer({ data, width: e.width, height: e.height, score: scores[k] }, [data.buffer]);
  },

  drop(id: string) {
    cache.delete(id);
  },
};

export type SamWorkerApi = typeof api;
Comlink.expose(api);
