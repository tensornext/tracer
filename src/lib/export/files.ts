// 2D exports for foam cutting (laser, waterjet, CNC) and a 1:1 size-check sheet.
import type { Vec2 } from "../vision/mask";

/** ASCII DXF R12 (widest compatibility), millimetres, closed POLYLINEs. First path is the panel outline. */
export function toDXF(paths: Vec2[][]): string {
  const out: string[] = [];
  const push = (...kv: (string | number)[]) => {
    for (let i = 0; i < kv.length; i += 2) out.push(String(kv[i]), typeof kv[i + 1] === "number" ? (kv[i + 1] as number).toFixed(4).replace(/\.?0+$/, "") || "0" : String(kv[i + 1]));
  };
  push(0, "SECTION", 2, "HEADER", 9, "$ACADVER", 1, "AC1009", 9, "$INSUNITS", 70, 4, 9, "$MEASUREMENT", 70, 1, 0, "ENDSEC");
  push(0, "SECTION", 2, "TABLES", 0, "TABLE", 2, "LAYER", 70, 2);
  push(0, "LAYER", 2, "OUTLINE", 70, 0, 62, 7, 6, "CONTINUOUS");
  push(0, "LAYER", 2, "CUTS", 70, 0, 62, 1, 6, "CONTINUOUS");
  push(0, "ENDTAB", 0, "ENDSEC", 0, "SECTION", 2, "ENTITIES");
  paths.forEach((path, i) => {
    push(0, "POLYLINE", 8, i === 0 ? "OUTLINE" : "CUTS", 66, 1, 70, 1);
    for (const [x, y] of path) push(0, "VERTEX", 8, i === 0 ? "OUTLINE" : "CUTS", 10, x, 20, y, 30, 0);
    push(0, "SEQEND");
  });
  push(0, "ENDSEC", 0, "EOF");
  return out.join("\n") + "\n";
}

/** SVG in real millimetres (Y flipped for screen coordinates). Red hairlines for laser cutters. */
export function toSVG(paths: Vec2[][]): string {
  const xs = paths.flat().map((p) => p[0]), ys = paths.flat().map((p) => p[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const w = maxX - minX, h = maxY - minY;
  const d = (path: Vec2[]) => "M" + path.map(([x, y]) => `${(x - minX).toFixed(3)},${(maxY - y).toFixed(3)}`).join("L") + "Z";
  const body = paths
    .map((p, i) => `<path d="${d(p)}" fill="none" stroke="${i === 0 ? "#000" : "#f00"}" stroke-width="0.1"/>`)
    .join("\n  ");
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${w.toFixed(3)}mm" height="${h.toFixed(3)}mm" viewBox="0 0 ${w.toFixed(3)} ${h.toFixed(3)}">
  ${body}
</svg>
`;
}

export function download(data: BlobPart | Uint8Array | ArrayBuffer, filename: string, type = "application/octet-stream") {
  const url = URL.createObjectURL(new Blob([data as BlobPart], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
