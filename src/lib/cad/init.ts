import { loadFont, setOC } from "replicad";
import opencascade from "replicad-opencascadejs";

let ready: Promise<void> | undefined;

/**
 * Load OpenCascade (WASM) once. In the browser pass the bundler's URL for
 * `replicad-opencascadejs/wasm` (Vite: `import wasmUrl from "replicad-opencascadejs/wasm?url"`);
 * in Node pass the file path.
 */
export function initKernel(wasmLocation?: string): Promise<void> {
  ready ??= (async () => {
    const OC = await (opencascade as unknown as (o: object) => Promise<unknown>)({
      locateFile: (file: string) => (file.endsWith(".wasm") && wasmLocation ? wasmLocation : file),
    });
    setOC(OC as never);
  })();
  return ready;
}

/** Labels need a font. Any TTF/OTF works (URL, or bytes). */
export async function loadCadFont(source: string | ArrayBuffer): Promise<void> {
  await loadFont(source);
}
