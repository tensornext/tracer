import { strToU8, zipSync } from "fflate";
import type { MeshData } from "./kernel";

const COLORS: Record<string, string> = {
  tray: "#8A8F98FF",
  contrast: "#E4572EFF",
  foamCut: "#2F3437FF",
  foamBacker: "#555B61FF",
};

/**
 * Multi-part 3MF: one object per print tile, each made of components (tray + contrast layer).
 * PrusaSlicer, OrcaSlicer and Bambu Studio open this as a single object with separate parts,
 * so the contrast layer can be assigned its own filament.
 */
export function build3MF(meshes: MeshData[]): Uint8Array {
  const kinds = [...new Set(meshes.map((m) => m.kind))];
  const materials = kinds
    .map((k) => `<base name="${k}" displaycolor="${COLORS[k] ?? "#808080FF"}"/>`)
    .join("");
  let nextId = 2;
  const objects: string[] = [];
  const tiles = new Map<number, number[]>();
  for (const m of meshes) {
    const id = nextId++;
    const v: string[] = [];
    for (let i = 0; i < m.vertices.length; i += 3) {
      v.push(`<vertex x="${m.vertices[i].toFixed(4)}" y="${m.vertices[i + 1].toFixed(4)}" z="${m.vertices[i + 2].toFixed(4)}"/>`);
    }
    const t: string[] = [];
    for (let i = 0; i < m.triangles.length; i += 3) {
      t.push(`<triangle v1="${m.triangles[i]}" v2="${m.triangles[i + 1]}" v3="${m.triangles[i + 2]}"/>`);
    }
    objects.push(
      `<object id="${id}" name="${m.name}" type="model" pid="1" pindex="${kinds.indexOf(m.kind)}"><mesh><vertices>${v.join("")}</vertices><triangles>${t.join("")}</triangles></mesh></object>`,
    );
    tiles.set(m.tile, [...(tiles.get(m.tile) ?? []), id]);
  }
  const items: string[] = [];
  for (const [tile, ids] of [...tiles.entries()].sort((a, b) => a[0] - b[0])) {
    const id = nextId++;
    objects.push(
      `<object id="${id}" name="tile-${tile + 1}" type="model"><components>${ids.map((c) => `<component objectid="${c}"/>`).join("")}</components></object>`,
    );
    items.push(`<item objectid="${id}"/>`);
  }
  const model = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
<resources><basematerials id="1">${materials}</basematerials>${objects.join("")}</resources>
<build>${items.join("")}</build>
</model>`;
  return zipSync({
    "[Content_Types].xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>`,
    ),
    "_rels/.rels": strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>`,
    ),
    "3D/3dmodel.model": strToU8(model),
  });
}
