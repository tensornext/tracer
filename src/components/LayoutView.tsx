import { useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from "react";
import { LayoutGrid, RotateCcw, RotateCw } from "lucide-react";
import { useStore } from "../state/store";
import { autoArrange, planFor, placeOutline } from "../state/geometry";
import { regionRings } from "../lib/cad/polygons";
import { fmt } from "./ui";
import type { Vec2 } from "../lib/vision/mask";

const path = (pts: Vec2[]) => "M" + pts.map((p) => `${p[0].toFixed(2)},${p[1].toFixed(2)}`).join("L") + "Z";

export function LayoutView() {
  const tools = useStore((s) => s.tools);
  const settings = useStore((s) => s.settings);
  const selected = useStore((s) => s.selected);
  const corners = useStore((s) => s.corners);
  const { updateTool, select, applyPlacements } = useStore.getState();
  const plan = useMemo(() => planFor(tools, settings), [tools, settings]);
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<{ id: string; start: Vec2; x0: number; y0: number } | null>(null);
  const [frozenBox, setFrozenBox] = useState<{ x: number; y: number; w: number; h: number } | null>(null);

  // Panel rectangle in mm (panel centre is plan.center).
  const panel = useMemo(() => {
    if (plan.kind === "gridfinity") {
      const L = plan.plan.layout;
      return { cx: L.center[0], cy: L.center[1], w: L.width, h: L.depth, r: 3.75 };
    }
    if (plan.kind === "foam") return { cx: plan.plan.center[0], cy: plan.plan.center[1], w: plan.plan.width, h: plan.plan.height, r: 0 };
    return null;
  }, [plan]);

  // View box around the panel (frozen while dragging so the page doesn't swim under the cursor).
  const box = useMemo(() => {
    if (frozenBox) return frozenBox;
    const p = panel ?? { cx: 108, cy: 140, w: 216, h: 280 };
    const m = Math.max(p.w, p.h) * 0.12 + 20;
    return { x: p.cx - p.w / 2 - m, y: p.cy - p.h / 2 - m, w: p.w + 2 * m, h: p.h + 2 * m };
  }, [panel, frozenBox]);

  const toMm = (e: { clientX: number; clientY: number }): Vec2 => {
    const svg = svgRef.current!;
    const pt = svg.createSVGPoint();
    pt.x = e.clientX; pt.y = e.clientY;
    const m = svg.getScreenCTM()!.inverse();
    const q = pt.matrixTransform(m);
    return [q.x, -q.y]; // the content group flips Y
  };

  const onDown = (e: RPointerEvent, id: string) => {
    e.stopPropagation();
    (e.target as Element).setPointerCapture(e.pointerId);
    const t = tools.find((x) => x.id === id)!;
    select(id);
    setFrozenBox(box);
    drag.current = { id, start: toMm(e), x0: t.x, y0: t.y };
  };
  const onMove = (e: RPointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const p = toMm(e);
    updateTool(d.id, { x: d.x0 + p[0] - d.start[0], y: d.y0 + p[1] - d.start[1], placed: true });
  };
  const onUp = () => { drag.current = null; setFrozenBox(null); };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!selected || (e.target as HTMLElement)?.closest?.("input, textarea, select")) return;
      const t = useStore.getState().tools.find((x) => x.id === selected);
      if (!t) return;
      const step = e.shiftKey ? 10 : 1;
      const moves: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
      if (moves[e.key]) { e.preventDefault(); updateTool(t.id, { x: t.x + moves[e.key][0], y: t.y + moves[e.key][1], placed: true }); }
      // Rotation is counter-clockwise-positive (Y-up), so R turns clockwise.
      if (e.key === "r" || e.key === "R") updateTool(t.id, { rotation: t.rotation + (e.shiftKey ? 15 : -15), placed: true });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected, updateTool]);

  const planned = plan.kind === "error" ? [] : plan.plan.planned;
  const u = settings.units;
  const cell = settings.gridfinity.cellSize;
  const sel = tools.find((t) => t.id === selected);

  const summary = (() => {
    if (plan.kind === "gridfinity") {
      const L = plan.plan.layout;
      const tiles = L.tiles.length > 1 ? `, printed as ${L.tiles.length} pieces` : "";
      return `${L.cellsX} × ${L.cellsY} cells (${fmt(L.width, u)} × ${fmt(L.depth, u)}), ${fmt(L.height, u)} tall = ${L.heightUnits}u${tiles}`;
    }
    if (plan.kind === "foam") return `Foam ${fmt(plan.plan.width, u)} × ${fmt(plan.plan.height, u)}, ${fmt(settings.foam.thickness, u)} cut layer`;
    return plan.message;
  })();

  if (!corners) {
    return (
      <div className="mat h-full grid place-items-center text-mat-ink p-8 text-center">
        <p className="max-w-sm">Find the paper in your photo first. Its corners set the scale for everything on this page.</p>
      </div>
    );
  }

  return (
    <div className="relative h-full w-full mat">
      <svg ref={svgRef} className="h-full w-full touch-none" viewBox={`${box.x} ${-box.y - box.h} ${box.w} ${box.h}`}
        onPointerMove={onMove} onPointerUp={onUp} onPointerDown={() => select(null)} role="img" aria-label="Bin layout">
        <g transform="scale(1,-1)">
          {panel && (
            <g>
              <rect x={panel.cx - panel.w / 2} y={panel.cy - panel.h / 2} width={panel.w} height={panel.h} rx={panel.r}
                fill={settings.mode === "foam" ? "#2f3437" : "#8a8f98"} stroke="#e9ecee" strokeWidth={0.6} />
              {plan.kind === "gridfinity" && (
                <g stroke="#e9ecee" strokeOpacity={0.35} strokeWidth={0.4} strokeDasharray="3 3">
                  {Array.from({ length: plan.plan.layout.cellsX - 1 }, (_, i) => {
                    const x = panel.cx - (plan.plan.layout.cellsX * cell) / 2 + (i + 1) * cell;
                    return <line key={`x${i}`} x1={x} x2={x} y1={panel.cy - panel.h / 2} y2={panel.cy + panel.h / 2} />;
                  })}
                  {Array.from({ length: plan.plan.layout.cellsY - 1 }, (_, i) => {
                    const y = panel.cy - (plan.plan.layout.cellsY * cell) / 2 + (i + 1) * cell;
                    return <line key={`y${i}`} y1={y} y2={y} x1={panel.cx - panel.w / 2} x2={panel.cx + panel.w / 2} />;
                  })}
                </g>
              )}
              {plan.kind === "gridfinity" && plan.plan.layout.tiles.length > 1 && (
                <g stroke="#f2c230" strokeWidth={0.9}>
                  {plan.plan.layout.tiles.filter((t) => t.cellX0 > 0).map((t) => {
                    const x = panel.cx - (plan.plan.layout.cellsX * cell) / 2 + t.cellX0 * cell;
                    return <line key={`sx${t.index}`} x1={x} x2={x} y1={panel.cy - panel.h / 2} y2={panel.cy + panel.h / 2} />;
                  })}
                  {plan.plan.layout.tiles.filter((t) => t.cellY0 > 0).map((t) => {
                    const y = panel.cy - (plan.plan.layout.cellsY * cell) / 2 + t.cellY0 * cell;
                    return <line key={`sy${t.index}`} y1={y} y2={y} x1={panel.cx - panel.w / 2} x2={panel.cx + panel.w / 2} />;
                  })}
                </g>
              )}
            </g>
          )}
          {planned.map((p) => {
            const t = tools.find((x) => x.id === p.cutout.id);
            if (!t) return null;
            const isSel = t.id === selected;
            const raw = t.kind === "traced" ? placeOutline(t.outline, t.x, t.y, t.rotation) : null;
            return (
              <g key={t.id} onPointerDown={(e) => onDown(e, t.id)} style={{ cursor: "move" }}>
                {p.slot && <path d={path(p.slot.poly)} fill="#f7a36e" />}
                {regionRings(p.regions).map((ring, i) => <path key={i} d={path(ring)} fill="#f26a1b" />)}
                {raw && <path d={path(raw)} fill="none" stroke="#7a3206" strokeWidth={0.35} strokeOpacity={0.8} />}
                {isSel && regionRings(p.regions).map((ring, i) => <path key={`s${i}`} d={path(ring)} fill="none" stroke="white" strokeWidth={0.9} />)}
                {t.label && (
                  <text x={t.x} y={-(t.y - 10)} transform="scale(1,-1)" textAnchor="middle" fontSize={5} fill="white" fontWeight={700} style={{ pointerEvents: "none" }}>{t.label}</text>
                )}
              </g>
            );
          })}
        </g>
      </svg>

      <div className="absolute left-4 top-4 rounded-lg bg-white/95 px-4 py-2.5 shadow-lg max-w-[min(560px,calc(100%-2rem))]">
        <div className={`num text-[15px] font-semibold ${plan.kind === "error" ? "text-error" : ""}`}>{summary}</div>
        <div className="hint">Drag tools to arrange. Arrow keys nudge, R rotates.</div>
      </div>

      <div className="absolute bottom-4 left-4 flex gap-2">
        <button className="btn" disabled={!tools.length} onClick={() => applyPlacements(autoArrange(tools, settings))}><LayoutGrid size={16} /> Arrange tightly</button>
        {sel && (
          <>
            <button className="btn btn-icon" title="Rotate left 15° (Shift+R)" aria-label="Rotate left" onClick={() => updateTool(sel.id, { rotation: sel.rotation + 15, placed: true })}><RotateCcw size={16} /></button>
            <button className="btn btn-icon" title="Rotate right 15° (R)" aria-label="Rotate right" onClick={() => updateTool(sel.id, { rotation: sel.rotation - 15, placed: true })}><RotateCw size={16} /></button>
          </>
        )}
      </div>
    </div>
  );
}
