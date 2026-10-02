/// <reference lib="webworker" />
// CAD kernel (replicad + OpenCascade WASM) off the main thread.
import * as Comlink from "comlink";
import wasmUrl from "replicad-opencascadejs/wasm?url";
import { getOC } from "replicad";
import { initKernel, loadCadFont } from "../lib/cad/init";
import { buildFoam, buildGridfinity, meshParts, stepParts, stlParts, type MeshData, type Part } from "../lib/cad/kernel";
import { build3MF } from "../lib/cad/threemf";
import type { Cutout, FoamParams, GridfinityParams } from "../lib/cad/types";

export type BuildRequest =
  | { mode: "gridfinity"; cutouts: Cutout[]; params: GridfinityParams }
  | { mode: "foam"; cutouts: Cutout[]; params: FoamParams };

let ready: Promise<void> | null = null;
/** Highest preview id requested so far; previews with a lower id are obsolete. */
let latest = 0;

const build = (r: BuildRequest): Part[] => (r.mode === "gridfinity" ? buildGridfinity(r.cutouts, r.params) : buildFoam(r.cutouts, r.params)).parts;

const api = {
  init(fontUrl?: string) {
    ready ??= (async () => {
      await initKernel(wasmUrl);
      if (fontUrl) {
        try {
          await loadCadFont(await (await fetch(fontUrl)).arrayBuffer());
        } catch {
          // Labels are optional; the rest still works without a font.
        }
      }
    })();
    return ready;
  },

  /** OpenCascade's WASM heap in bytes. It only grows: every boolean leaks a little. */
  heapBytes(): number {
    try {
      return (getOC() as unknown as { wasmMemory: WebAssembly.Memory }).wasmMemory.buffer.byteLength;
    } catch {
      return 0;
    }
  },

  /** Marks every preview below `id` obsolete, e.g. when the 3D view closes. */
  supersede(id: number) {
    latest = Math.max(latest, id);
  },

  /**
   * Build and mesh for the 3D view, or resolve null without building once a newer preview was
   * requested. A build blocks the worker, so requests made meanwhile queue up behind it; yielding
   * to that queue before starting lets every queued request register its id first, and all but
   * the newest then return straight away.
   */
  async preview(id: number, req: BuildRequest): Promise<MeshData[] | null> {
    latest = Math.max(latest, id);
    await api.init();
    await new Promise((r) => setTimeout(r, 0));
    if (id < latest) return null;
    const m = meshParts(build(req));
    return Comlink.transfer(m, m.flatMap((x) => [x.vertices.buffer, x.normals.buffer, x.triangles.buffer]));
  },

  // Exports build their own parts in the same call, so nothing can swap the model in between.
  async exportSTL(req: BuildRequest) {
    await api.init();
    const files = await stlParts(build(req));
    return Comlink.transfer(files, files.map((f) => f.data));
  },

  async exportSTEP(req: BuildRequest) {
    await api.init();
    const data = await stepParts(build(req));
    return Comlink.transfer(data, [data]);
  },

  async export3MF(req: BuildRequest) {
    await api.init();
    const data = build3MF(meshParts(build(req), 0.01, 1));
    return Comlink.transfer(data, [data.buffer]);
  },
};

export type CadWorkerApi = typeof api;
Comlink.expose(api);
