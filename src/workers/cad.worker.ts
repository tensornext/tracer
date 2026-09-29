/// <reference lib="webworker" />
// CAD kernel (replicad + OpenCascade WASM) off the main thread.
import * as Comlink from "comlink";
import wasmUrl from "replicad-opencascadejs/wasm?url";
import { initKernel, loadCadFont } from "../lib/cad/init";
import { buildFoam, buildGridfinity, meshParts, stepParts, stlParts, type Part } from "../lib/cad/kernel";
import { build3MF } from "../lib/cad/threemf";
import type { Cutout, FoamParams, GridfinityParams, PartInfo } from "../lib/cad/types";

let current: Part[] = [];
let ready: Promise<void> | null = null;

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

  async buildGridfinity(cutouts: Cutout[], params: GridfinityParams): Promise<PartInfo[]> {
    await api.init();
    current = buildGridfinity(cutouts, params).parts;
    return current.map((p) => p.info);
  },

  async buildFoam(cutouts: Cutout[], params: FoamParams): Promise<PartInfo[]> {
    await api.init();
    current = buildFoam(cutouts, params).parts;
    return current.map((p) => p.info);
  },

  meshes() {
    const m = meshParts(current);
    return Comlink.transfer(m, m.flatMap((x) => [x.vertices.buffer, x.normals.buffer, x.triangles.buffer]));
  },

  async exportSTL() {
    const files = await stlParts(current);
    return Comlink.transfer(files, files.map((f) => f.data));
  },

  async exportSTEP() {
    const data = await stepParts(current);
    return Comlink.transfer(data, [data]);
  },

  export3MF() {
    const data = build3MF(meshParts(current, 0.01, 1));
    return Comlink.transfer(data, [data.buffer]);
  },
};

export type CadWorkerApi = typeof api;
Comlink.expose(api);
