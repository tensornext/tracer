// Size-check sheet: every traced outline at 1:1 with rulers, to lay the real tools on before printing a bin.
import { jsPDF } from "jspdf";
import type { Vec2 } from "../vision/mask";

export interface SheetItem { name: string; outline: Vec2[] }

export function sizeCheckPDF(items: SheetItem[], paper: "letter" | "a4", unitsLabel: "mm" | "in"): ArrayBuffer {
  const [pw, ph] = paper === "letter" ? [215.9, 279.4] : [210, 297];
  const doc = new jsPDF({ unit: "mm", format: paper === "letter" ? "letter" : "a4", orientation: "portrait" });
  const margin = 12, header = 26, gap = 8;
  const usableW = pw - 2 * margin;

  const header_ = () => {
    doc.setFont("helvetica", "bold");
    doc.setFontSize(12);
    doc.text("Size check: print at 100% (Actual size)", margin, margin + 4);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8.5);
    doc.text("Measure the rulers first. If they aren't exactly 100 mm and 2 in, turn off printer scaling and print again.", margin, margin + 9);
    // Rulers
    doc.setLineWidth(0.3);
    const y = margin + 15;
    doc.line(margin, y, margin + 100, y);
    for (let i = 0; i <= 10; i++) doc.line(margin + i * 10, y, margin + i * 10, y - (i % 5 === 0 ? 3 : 1.8));
    doc.text("100 mm", margin + 101.5, y + 0.8);
    const x2 = margin + 122;
    doc.line(x2, y, x2 + 25.4 * 2, y);
    for (let i = 0; i <= 8; i++) doc.line(x2 + i * 6.35, y, x2 + i * 6.35, y - (i % 4 === 0 ? 3 : 1.5));
    doc.text("2 in", x2 + 52, y + 0.8);
  };

  const boxes = items.map((it) => {
    const xs = it.outline.map((p) => p[0]), ys = it.outline.map((p) => p[1]);
    return { ...it, minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
  });

  let first = true;
  let x = margin, y = margin + header, rowH = 0;
  const newPage = () => {
    if (!first) doc.addPage();
    first = false;
    header_();
    x = margin; y = margin + header; rowH = 0;
  };
  newPage();
  for (const b of boxes) {
    let w = b.maxX - b.minX, h = b.maxY - b.minY;
    let rotate = false;
    if (w > usableW && h <= usableW) { rotate = true; [w, h] = [h, w]; }
    if (x > margin && x + w > pw - margin) { x = margin; y += rowH + gap + 5; rowH = 0; }
    if (y + h + 5 > ph - margin && y > margin + header) newPage();
    const fits = w <= usableW && h <= ph - margin - header - margin;
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    doc.text(`${b.name}${fits ? "" : " (too large for one page, check with a ruler)"}`, x, y + 3);
    const oy = y + 5;
    const pts = b.outline.map(([px, py]): Vec2 => {
      // Paper coords are Y-up; PDF is Y-down.
      const lx = px - b.minX, ly = b.maxY - py;
      return rotate ? [ly, lx] : [lx, ly];
    });
    doc.setLineWidth(0.25);
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], c = pts[(i + 1) % pts.length];
      doc.line(x + a[0], oy + a[1], x + c[0], oy + c[1]);
    }
    doc.setFontSize(7.5);
    const mm = `${(b.maxX - b.minX).toFixed(1)} × ${(b.maxY - b.minY).toFixed(1)} mm`;
    const inch = `${((b.maxX - b.minX) / 25.4).toFixed(2)} × ${((b.maxY - b.minY) / 25.4).toFixed(2)} in`;
    doc.text(unitsLabel === "in" ? inch : mm, x, oy + h + 4);
    x += Math.max(w, 30) + gap;
    rowH = Math.max(rowH, h + 5);
  }
  return doc.output("arraybuffer");
}
