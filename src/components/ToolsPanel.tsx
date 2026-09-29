import { useMemo } from "react";
import { Circle, Copy, Plus, RectangleHorizontal, Sparkles, Trash2 } from "lucide-react";
import { newId, useStore } from "../state/store";
import { forgetToolMask, traceTool } from "../state/session";
import { placeOutline } from "../state/geometry";
import type { ToolItem } from "../state/types";
import { LengthInput, Toggle, fmt } from "./ui";
import type { Vec2 } from "../lib/vision/mask";

function Thumb({ t }: { t: ToolItem }) {
  const pts: Vec2[] = t.kind === "traced"
    ? placeOutline(t.outline, 0, 0, t.rotation)
    : t.kind === "circle"
      ? Array.from({ length: 24 }, (_, i) => [Math.cos((i / 24) * 2 * Math.PI) * (t.diameter ?? 20) / 2, Math.sin((i / 24) * 2 * Math.PI) * (t.diameter ?? 20) / 2])
      : placeOutline([[-(t.width ?? 40) / 2, -(t.height ?? 20) / 2], [(t.width ?? 40) / 2, -(t.height ?? 20) / 2], [(t.width ?? 40) / 2, (t.height ?? 20) / 2], [-(t.width ?? 40) / 2, (t.height ?? 20) / 2]], 0, 0, t.rotation);
  if (pts.length < 3) return <div className="h-9 w-12 rounded bg-chrome" />;
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const pad = Math.max(maxX - minX, maxY - minY) * 0.08;
  return (
    <svg className="h-9 w-12 flex-none rounded bg-mat" viewBox={`${minX - pad} ${-maxY - pad} ${maxX - minX + 2 * pad} ${maxY - minY + 2 * pad}`}>
      <path d={"M" + pts.map((p) => `${p[0]},${-p[1]}`).join("L") + "Z"} fill="#f26a1b" />
    </svg>
  );
}

function size(t: ToolItem): [number, number] {
  if (t.kind === "circle") return [t.diameter ?? 20, t.diameter ?? 20];
  if (t.kind === "rect") return [t.width ?? 40, t.height ?? 20];
  const pts = placeOutline(t.outline, 0, 0, t.rotation);
  if (!pts.length) return [0, 0];
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  return [Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)];
}

export function ToolsPanel() {
  const tools = useStore((s) => s.tools);
  const selected = useStore((s) => s.selected);
  const settings = useStore((s) => s.settings);
  const corners = useStore((s) => s.corners);
  const model = useStore((s) => s.model);
  const { select, updateTool, removeTool, duplicateTool, upsertTool, setInteraction, setView } = useStore.getState();
  const u = settings.units;

  const center = useMemo<Vec2>(() => {
    if (!tools.length) return [60, 60];
    return [tools.reduce((s, t) => s + t.x, 0) / tools.length, Math.min(...tools.map((t) => t.y)) - 40];
  }, [tools]);

  const addShape = (kind: "circle" | "rect") => {
    const t: ToolItem = {
      id: newId(),
      name: kind === "circle" ? "Round pocket" : "Rectangular pocket",
      kind,
      diameter: 25,
      width: 50,
      height: 25,
      radius: 3,
      outline: [],
      x: center[0],
      y: center[1],
      rotation: 0,
      depth: null,
      fingerSlot: false,
      label: "",
      placed: true,
    };
    upsertTool(t);
    select(t.id);
    setView("layout");
  };

  const remove = (id: string) => {
    removeTool(id);
    forgetToolMask(id);
  };

  return (
    <aside className="flex h-full min-h-0 flex-col bg-panel border-r border-line">
      <div className="flex items-center justify-between px-4 pt-4 pb-3">
        <h2 className="panel-title">Tools</h2>
        <span className="hint num">{tools.length || ""}</span>
      </div>
      <div className="flex flex-wrap gap-2 px-4 pb-3">
        <button className="btn btn-primary" disabled={!corners} onClick={() => { setView("photo"); setInteraction({ kind: "trace", clicks: [], toolId: null }); }}>
          <Plus size={16} /> Add tool
        </button>
        <button className="btn btn-icon" title="Add a round pocket" aria-label="Add a round pocket" disabled={!corners} onClick={() => addShape("circle")}><Circle size={16} /></button>
        <button className="btn btn-icon" title="Add a rectangular pocket" aria-label="Add a rectangular pocket" disabled={!corners} onClick={() => addShape("rect")}><RectangleHorizontal size={16} /></button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
        {tools.length === 0 && (
          <p className="hint px-2 py-3">{corners ? "Click Add tool, then click a tool in the photo." : "Add a photo and find the paper to start tracing."}</p>
        )}
        {tools.map((t) => {
          const open = t.id === selected;
          const [w, h] = size(t);
          return (
            <div key={t.id} className={`mb-1 rounded-lg border ${open ? "border-line bg-white shadow-sm" : "border-transparent hover:bg-white/70"}`}>
              <button className="flex w-full items-center gap-3 px-2 py-2 text-left" onClick={() => select(open ? null : t.id)} aria-expanded={open}>
                <Thumb t={t} />
                <span className="grid min-w-0">
                  <span className="truncate font-semibold">{t.name}</span>
                  <span className="hint num">{t.kind === "traced" && !t.outline.length ? "Needs the paper" : `${fmt(w, u)} × ${fmt(h, u)}`}</span>
                </span>
              </button>
              {open && (
                <div className="grid gap-3 px-3 pb-3">
                  <label className="field"><span>Name</span>
                    <input className="input" value={t.name} onChange={(e) => updateTool(t.id, { name: e.target.value })} />
                  </label>
                  {t.kind === "circle" && <LengthInput label="Diameter" mm={t.diameter ?? 25} units={u} min={2} onChange={(v) => updateTool(t.id, { diameter: v })} />}
                  {t.kind === "rect" && (
                    <div className="grid grid-cols-3 gap-2">
                      <LengthInput label="Width" mm={t.width ?? 50} units={u} min={2} onChange={(v) => updateTool(t.id, { width: v })} />
                      <LengthInput label="Height" mm={t.height ?? 25} units={u} min={2} onChange={(v) => updateTool(t.id, { height: v })} />
                      <LengthInput label="Corner" mm={t.radius ?? 3} units={u} min={0} onChange={(v) => updateTool(t.id, { radius: v })} />
                    </div>
                  )}
                  {settings.mode === "gridfinity" && (
                    <LengthInput label={`Pocket depth${t.depth === null ? " (default)" : ""}`} mm={t.depth ?? settings.gridfinity.pocketDepth} units={u} min={1} max={120}
                      onChange={(v) => updateTool(t.id, { depth: v })} />
                  )}
                  <LengthInput label="Rotation (°)" mm={Math.round(t.rotation * 10) / 10} units={u} unitless step={5} onChange={(v) => updateTool(t.id, { rotation: v, placed: true })} />
                  <Toggle label="Finger slot" hint="A scoop across the pocket to lift the tool out" checked={t.fingerSlot} onChange={(v) => updateTool(t.id, { fingerSlot: v })} />
                  <label className="field"><span>Label</span>
                    <input className="input" placeholder="Engraved next to the pocket" value={t.label} maxLength={24} onChange={(e) => updateTool(t.id, { label: e.target.value })} />
                  </label>
                  <div className="flex flex-wrap gap-2">
                    {t.kind === "traced" && t.clicks && (
                      <button className="btn btn-sm" disabled={model.status !== "ready"} title={model.status === "ready" ? "Re-trace on a zoomed-in crop of the full-resolution photo" : "Needs the AI tracer"}
                        onClick={() => void traceTool(t.clicks!, t.id, !t.detail)}>
                        <Sparkles size={14} /> {t.detail ? "Standard trace" : "Trace in detail"}
                      </button>
                    )}
                    <button className="btn btn-sm" onClick={() => duplicateTool(t.id)}><Copy size={14} /> Duplicate</button>
                    <button className="btn btn-sm btn-ghost text-error" onClick={() => remove(t.id)}><Trash2 size={14} /> Delete</button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </aside>
  );
}
