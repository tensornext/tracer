import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from "react";
import { Check, Crosshair, Maximize, Plus, ScanLine, Undo2, X } from "lucide-react";
import { useStore } from "../state/store";
import { findPaper, getWorking, hoverPreview, onLatePreview, traceTool } from "../state/session";
import type { DecodedMask } from "../workers/sam.worker";
import type { Vec2 } from "../lib/vision/mask";

type ViewT = { k: number; tx: number; ty: number };

function maskToUrl(m: DecodedMask, rgb: [number, number, number]): string {
  const c = document.createElement("canvas");
  c.width = m.width;
  c.height = m.height;
  const ctx = c.getContext("2d")!;
  const img = ctx.createImageData(m.width, m.height);
  for (let i = 0; i < m.data.length; i++) {
    if (!m.data[i]) continue;
    img.data[i * 4] = rgb[0]; img.data[i * 4 + 1] = rgb[1]; img.data[i * 4 + 2] = rgb[2]; img.data[i * 4 + 3] = 120;
  }
  ctx.putImageData(img, 0, 0);
  return c.toDataURL();
}

const inside = (p: Vec2, poly: Vec2[]) => {
  let r = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) r = !r;
  }
  return r;
};

export function PhotoView() {
  const image = useStore((s) => s.image);
  const corners = useStore((s) => s.corners);
  const tools = useStore((s) => s.tools);
  const interaction = useStore((s) => s.interaction);
  const selected = useStore((s) => s.selected);
  const busy = useStore((s) => s.busy);
  const embedding = useStore((s) => s.embedding);
  const engine = useStore((s) => s.settings.engine);
  const { setInteraction, select, setCorners } = useStore.getState();

  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [view, setView] = useState<ViewT>({ k: 1, tx: 0, ty: 0 });
  const [hover, setHover] = useState<string | null>(null);
  const drag = useRef<{ kind: "pan" | "corner" | "click"; index?: number; x0: number; y0: number; view0: ViewT; moved: boolean } | null>(null);
  const space = useRef(false);
  const working = getWorking();
  const w = image?.width ?? 0, h = image?.height ?? 0;

  useEffect(() => {
    const c = canvasRef.current;
    if (!c || !working) return;
    c.width = working.width;
    c.height = working.height;
    c.getContext("2d")!.drawImage(working.bitmap, 0, 0);
  }, [working?.id, working]);

  const fit = useCallback(() => {
    const el = wrapRef.current;
    if (!el || !w) return;
    const r = el.getBoundingClientRect();
    const k = Math.min(r.width / w, r.height / h) * 0.94;
    setView({ k, tx: (r.width - w * k) / 2, ty: (r.height - h * k) / 2 });
  }, [w, h]);

  useEffect(() => {
    fit();
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => fit());
    ro.observe(el);
    return () => ro.disconnect();
  }, [fit]);

  // Wheel zoom around the cursor (non-passive, so it has to be attached by hand).
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const mx = e.clientX - r.left, my = e.clientY - r.top;
      setView((v) => {
        const k = Math.min(20, Math.max(0.05, v.k * Math.exp(-e.deltaY * 0.0015)));
        return { k, tx: mx - ((mx - v.tx) * k) / v.k, ty: my - ((my - v.ty) * k) / v.k };
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  useEffect(() => {
    const down = (e: KeyboardEvent) => { if (e.code === "Space") space.current = true; };
    const up = (e: KeyboardEvent) => { if (e.code === "Space") space.current = false; };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => { window.removeEventListener("keydown", down); window.removeEventListener("keyup", up); };
  }, []);

  const previewMode = interaction.kind === "paper" ? "largest" : interaction.kind === "trace" && interaction.clicks.length === 0 ? "tool" : null;
  useEffect(() => {
    setHover(null);
    const off = onLatePreview((m) => { if (previewMode) setHover(maskToUrl(m, previewMode === "largest" ? [43, 123, 214] : [242, 106, 27])); });
    return () => { off(); };
  }, [previewMode]);

  const toImage = (e: { clientX: number; clientY: number }): Vec2 => {
    const r = wrapRef.current!.getBoundingClientRect();
    return [(e.clientX - r.left - view.tx) / view.k, (e.clientY - r.top - view.ty) / view.k];
  };

  const onDown = (e: RPointerEvent) => {
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const cornerAttr = (e.target as Element).getAttribute?.("data-corner");
    if (e.button === 1 || e.button === 2 || space.current) {
      drag.current = { kind: "pan", x0: e.clientX, y0: e.clientY, view0: view, moved: false };
    } else if (cornerAttr !== null && cornerAttr !== undefined) {
      drag.current = { kind: "corner", index: Number(cornerAttr), x0: e.clientX, y0: e.clientY, view0: view, moved: false };
    } else {
      drag.current = { kind: "click", x0: e.clientX, y0: e.clientY, view0: view, moved: false };
    }
  };

  const onMove = (e: RPointerEvent) => {
    const d = drag.current;
    if (d) {
      const dx = e.clientX - d.x0, dy = e.clientY - d.y0;
      if (Math.hypot(dx, dy) > 4) d.moved = true;
      if (d.kind === "pan" || (d.kind === "click" && d.moved)) {
        d.kind = "pan";
        setView({ ...d.view0, tx: d.view0.tx + dx, ty: d.view0.ty + dy });
      } else if (d.kind === "corner" && corners) {
        const p = toImage(e);
        const next = corners.map((c, i) => (i === d.index ? p : c));
        setCorners(next, true);
      }
      return;
    }
    if (previewMode) {
      const [x, y] = toImage(e);
      if (x < 0 || y < 0 || x >= w || y >= h) { setHover(null); return; }
      void hoverPreview(x, y, previewMode).then((m) => m && setHover(maskToUrl(m, previewMode === "largest" ? [43, 123, 214] : [242, 106, 27])));
    }
  };

  const onUp = async (e: RPointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (!d || d.kind !== "click" || d.moved || busy) return;
    const [x, y] = toImage(e);
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    if (interaction.kind === "paper") {
      setHover(null);
      await findPaper(x, y);
    } else if (interaction.kind === "trace") {
      setHover(null);
      const clicks = [...interaction.clicks, { x, y, positive: !(e.shiftKey || e.altKey) }];
      setInteraction({ ...interaction, clicks });
      const id = await traceTool(clicks, interaction.toolId);
      const cur = useStore.getState().interaction;
      if (cur.kind === "trace") setInteraction({ ...cur, clicks, toolId: id });
      if (id) select(id);
    } else {
      const hit = [...tools].reverse().find((t) => t.outlinePx && inside([x, y], t.outlinePx));
      select(hit?.id ?? null);
    }
  };

  const finishTrace = () => setInteraction({ kind: "trace", clicks: [], toolId: null });
  const undoClick = async () => {
    if (interaction.kind !== "trace" || !interaction.clicks.length) return;
    const clicks = interaction.clicks.slice(0, -1);
    setInteraction({ ...interaction, clicks });
    if (clicks.some((c) => c.positive) && interaction.toolId) await traceTool(clicks, interaction.toolId);
    else if (interaction.toolId) { useStore.getState().removeTool(interaction.toolId); setInteraction({ kind: "trace", clicks: [], toolId: null }); }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest?.("input, textarea, select")) return;
      if (e.key === "Enter" && interaction.kind === "trace") finishTrace();
      if (e.key === "Escape") setInteraction({ kind: "idle" });
      if ((e.key === "n" || e.key === "N") && !e.metaKey && !e.ctrlKey) setInteraction({ kind: "trace", clicks: [], toolId: null });
      if ((e.key === "z" || e.key === "Z") && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void undoClick(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const stroke = 2 / view.k;
  const handle = 9 / view.k;
  const activeId = interaction.kind === "trace" ? interaction.toolId : null;
  const cursor = interaction.kind === "idle" ? "default" : "crosshair";

  const instruction = useMemo(() => {
    if (interaction.kind === "paper") return { title: "Click on the paper", body: "Pick an empty spot on the sheet. We use its corners to measure everything else." };
    if (interaction.kind === "trace" && interaction.clicks.length === 0) return { title: "Click a tool to trace it", body: "Hover to preview. Shift-click removes an area." };
    if (interaction.kind === "trace") return { title: "Refine the outline", body: "Click missed parts to add them, Shift-click extra bits to remove them. Press Enter when it looks right." };
    return null;
  }, [interaction]);

  if (!image || !working) return null;

  return (
    <div className="relative h-full w-full overflow-hidden mat select-none" ref={wrapRef} style={{ cursor }}
      onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerLeave={() => setHover(null)} onContextMenu={(e) => e.preventDefault()}>
      <div className="absolute left-0 top-0 origin-top-left" style={{ transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.k})`, width: w, height: h }}>
        <canvas ref={canvasRef} className="block shadow-[0_8px_30px_rgb(0_0_0/0.35)]" style={{ width: w, height: h }} />
        <svg className="absolute inset-0 overflow-visible" width={w} height={h} viewBox={`0 0 ${w} ${h}`}>
          {hover && <image href={hover} x={0} y={0} width={w} height={h} preserveAspectRatio="none" style={{ pointerEvents: "none" }} />}
          {tools.map((t) =>
            t.outlinePx && t.outlinePx.length > 2 ? (
              <polygon key={t.id} points={t.outlinePx.map((p) => p.join(",")).join(" ")}
                fill={t.id === activeId ? "rgb(242 106 27 / 0.5)" : "rgb(242 106 27 / 0.32)"}
                stroke={t.id === selected ? "#1c2126" : "#f26a1b"} strokeWidth={t.id === selected ? stroke * 1.5 : stroke} strokeLinejoin="round" />
            ) : null,
          )}
          {corners && (
            <g>
              <polygon points={corners.map((p) => p.join(",")).join(" ")} fill="none" stroke="#2b7bd6" strokeWidth={stroke} strokeDasharray={`${8 / view.k} ${5 / view.k}`} />
              {corners.map((c, i) => (
                <circle key={i} data-corner={i} cx={c[0]} cy={c[1]} r={handle} fill="white" stroke="#2b7bd6" strokeWidth={stroke * 1.2} style={{ cursor: "grab" }}>
                  <title>Drag onto the paper's corner</title>
                </circle>
              ))}
            </g>
          )}
          {interaction.kind === "trace" &&
            interaction.clicks.map((c, i) => (
              <g key={i} transform={`translate(${c.x} ${c.y})`} style={{ pointerEvents: "none" }}>
                <circle r={7 / view.k} fill={c.positive ? "#1f8a4c" : "#b3261e"} stroke="white" strokeWidth={2 / view.k} />
                <path d={c.positive ? `M${-3.5 / view.k} 0H${3.5 / view.k}M0 ${-3.5 / view.k}V${3.5 / view.k}` : `M${-3.5 / view.k} 0H${3.5 / view.k}`} stroke="white" strokeWidth={1.8 / view.k} />
              </g>
            ))}
        </svg>
      </div>

      {instruction && (
        <div className="absolute left-4 top-4 max-w-[340px] rounded-lg bg-white/95 px-4 py-3 shadow-lg" onPointerDown={(e) => e.stopPropagation()}>
          <div className="font-bold text-[15px]">{instruction.title}</div>
          <div className="hint mt-0.5">{instruction.body}</div>
          {engine === "ai" && embedding === "working" && <div className="mt-2 text-[12.5px] text-blue font-semibold">Reading the photo…</div>}
          {interaction.kind === "trace" && interaction.clicks.length > 0 && (
            <div className="mt-3 flex gap-2">
              <button className="btn btn-primary btn-sm" onClick={finishTrace}><Check size={15} /> Done</button>
              <button className="btn btn-sm" onClick={() => void undoClick()}><Undo2 size={15} /> Undo click</button>
              <button className="btn btn-ghost btn-sm" onClick={() => setInteraction({ kind: "idle" })}><X size={15} /> Stop</button>
            </div>
          )}
        </div>
      )}

      <div className="absolute bottom-4 left-4 flex gap-2" onPointerDown={(e) => e.stopPropagation()}>
        <button className="btn btn-primary" disabled={!corners} title={corners ? "Add tool (N)" : "Find the paper first"}
          onClick={() => setInteraction({ kind: "trace", clicks: [], toolId: null })}><Plus size={16} /> Add tool</button>
        <button className="btn" onClick={() => setInteraction({ kind: "paper" })}><ScanLine size={16} /> {corners ? "Find paper again" : "Find paper"}</button>
        <button className="btn btn-icon" onClick={fit} title="Fit to view" aria-label="Fit to view"><Maximize size={16} /></button>
      </div>

      {busy && (
        <div className="absolute right-4 top-4 flex items-center gap-2 rounded-full bg-ink/85 px-3.5 py-1.5 text-[13px] font-semibold text-white">
          <Crosshair size={14} className="animate-pulse" /> {busy}
        </div>
      )}
    </div>
  );
}
