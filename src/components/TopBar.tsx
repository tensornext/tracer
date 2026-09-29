import { useEffect, useRef, useState } from "react";
import { ChevronDown, Download, FilePlus2, FolderOpen, ListTree, Save, SlidersHorizontal } from "lucide-react";
import { zipSync } from "fflate";
import { snapshot, useStore } from "../state/store";
import { cadWorker, getWorking } from "../state/session";
import { foamParams, gridfinityParams, placeOutline, planFor, usableTools } from "../state/geometry";
import { download, toDXF, toSVG } from "../lib/export/files";
import { APP_NAME, Seg } from "./ui";
import type { View } from "../state/types";

function Logo() {
  return (
    <svg width="26" height="26" viewBox="0 0 32 32" aria-hidden>
      <rect width="32" height="32" rx="7" fill="#1f5c4f" />
      <path d="M9 7h4v10a3 3 0 0 0 6 0V7h4v10a7 7 0 0 1-14 0z" fill="#f26a1b" />
      <path d="M6 25h20" stroke="#cfe3dc" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

export function TopBar({ onNew, onOpenProject, onPanel }: { onNew(): void; onOpenProject(): void; onPanel(p: "tools" | "settings"): void }) {
  const view = useStore((s) => s.view);
  const mode = useStore((s) => s.settings.mode);
  const image = useStore((s) => s.image);
  const { setView, updateSettings } = useStore.getState();

  return (
    <header className="flex h-[52px] items-center gap-2 sm:gap-4 border-b border-line bg-panel px-3 sm:px-4 overflow-x-auto">
      <button className="btn btn-icon lg:hidden" aria-label="Tools" onClick={() => onPanel("tools")}><ListTree size={16} /></button>
      <div className="flex items-center gap-2">
        <Logo />
        <span className="hidden text-[17px] font-bold tracking-tight sm:inline">{APP_NAME}</span>
      </div>
      {image && (
        <nav className="flex items-center gap-1" aria-label="Views">
          {(["photo", "layout", "3d"] as View[]).map((v) => (
            <button key={v} className={`btn btn-sm ${view === v ? "" : "btn-ghost text-ink-2"}`} aria-current={view === v ? "page" : undefined} onClick={() => setView(v)}>
              {v === "photo" ? "Photo" : v === "layout" ? "Layout" : "3D"}
            </button>
          ))}
        </nav>
      )}
      <div className="flex-1" />
      <Seg label="What to make" value={mode} onChange={(m) => updateSettings({ mode: m })} options={[{ value: "gridfinity", label: "Gridfinity bin" }, { value: "foam", label: "Foam insert" }]} />
      <ProjectMenu onNew={onNew} onOpenProject={onOpenProject} />
      <ExportMenu />
      <button className="btn btn-icon lg:hidden" aria-label="Settings" onClick={() => onPanel("settings")}><SlidersHorizontal size={16} /></button>
    </header>
  );
}

function ProjectMenu({ onNew, onOpenProject }: { onNew(): void; onOpenProject(): void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useOutside(ref, () => setOpen(false));
  const saveProject = async () => {
    setOpen(false);
    const w = getWorking();
    let imageData: string | null = null;
    if (w) {
      const c = new OffscreenCanvas(w.width, w.height);
      c.getContext("2d")!.drawImage(w.bitmap, 0, 0);
      const blob = await c.convertToBlob({ type: "image/jpeg", quality: 0.92 });
      imageData = await new Promise<string>((res) => { const r = new FileReader(); r.onload = () => res(r.result as string); r.readAsDataURL(blob); });
    }
    download(JSON.stringify({ ...snapshot(), imageData }), `${(snapshot().image?.name ?? "toolbed").replace(/\.[^.]+$/, "")}.toolbed.json`, "application/json");
  };
  return (
    <div className="relative" ref={ref}>
      <button className="btn" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>Project <ChevronDown size={14} /></button>
      {open && (
        <div role="menu" className="absolute right-0 top-10 z-20 w-56 rounded-lg border border-line bg-white p-1 shadow-xl">
          <MenuItem icon={<FilePlus2 size={15} />} onClick={() => { setOpen(false); onNew(); }}>New project</MenuItem>
          <MenuItem icon={<FolderOpen size={15} />} onClick={() => { setOpen(false); onOpenProject(); }}>Open project file…</MenuItem>
          <MenuItem icon={<Save size={15} />} onClick={() => void saveProject()}>Save project file</MenuItem>
        </div>
      )}
    </div>
  );
}

function ExportMenu() {
  const [open, setOpen] = useState(false);
  const [working, setWorking] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useOutside(ref, () => setOpen(false));
  const tools = useStore((s) => s.tools);
  const settings = useStore((s) => s.settings);
  const notify = useStore((s) => s.notify);
  const name = (useStore.getState().image?.name ?? "toolbed").replace(/\.[^.]+$/, "");
  const ready = usableTools(tools).length > 0;

  const build = async () => {
    const plan = planFor(tools, settings);
    if (plan.kind === "error") throw new Error(plan.message);
    const cad = cadWorker();
    if (settings.mode === "gridfinity") await cad.buildGridfinity(plan.cutouts, { ...gridfinityParams(settings), center: plan.kind === "gridfinity" ? plan.plan.layout.center : undefined });
    else await cad.buildFoam(plan.cutouts, foamParams(settings));
    return { cad, plan };
  };

  const run = async (label: string, f: () => Promise<void>) => {
    setOpen(false);
    setWorking(label);
    try {
      await f();
    } catch (e) {
      notify({ tone: "error", text: `Export failed: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setWorking(null);
    }
  };

  const items =
    settings.mode === "gridfinity"
      ? [
          { label: "3MF for your slicer", hint: "Bin and contrast floors as separate parts", f: async () => { const { cad } = await build(); download(await cad.export3MF(), `${name}.3mf`, "model/3mf"); } },
          { label: "STL", hint: "One file per part, zipped if more than one", f: async () => stl(await build()) },
          { label: "STEP", hint: "Editable solid for CAD", f: async () => { const { cad } = await build(); download(await cad.exportSTEP(), `${name}.step`, "model/step"); } },
        ]
      : [
          { label: "DXF", hint: "For laser, waterjet or CNC", f: async () => { const p = planFor(tools, settings); if (p.kind !== "foam") throw new Error("Nothing to cut yet"); download(toDXF(p.plan.cutPaths), `${name}-foam.dxf`, "application/dxf"); } },
          { label: "SVG", hint: "Real-size vector, cuts in red", f: async () => { const p = planFor(tools, settings); if (p.kind !== "foam") throw new Error("Nothing to cut yet"); download(toSVG(p.plan.cutPaths), `${name}-foam.svg`, "image/svg+xml"); } },
          { label: "STEP", hint: "Foam layers as solids", f: async () => { const { cad } = await build(); download(await cad.exportSTEP(), `${name}-foam.step`, "model/step"); } },
          { label: "STL", hint: "Foam layers as meshes", f: async () => stl(await build()) },
        ];

  async function stl({ cad }: Awaited<ReturnType<typeof build>>) {
    const files = await cad.exportSTL();
    if (files.length === 1) return download(files[0].data, `${name}-${files[0].name}`, "model/stl");
    download(zipSync(Object.fromEntries(files.map((f) => [f.name, new Uint8Array(f.data)]))) as Uint8Array<ArrayBuffer>, `${name}-stl.zip`, "application/zip");
  }

  const sizeCheck = async () => {
    const { sizeCheckPDF } = await import("../lib/export/sizecheck");
    const traced = tools.filter((t) => t.kind === "traced" && t.outline.length > 2);
    if (!traced.length) throw new Error("Trace a tool first");
    download(sizeCheckPDF(traced.map((t) => ({ name: t.name, outline: placeOutline(t.outline, 0, 0, t.rotation) })), settings.paper, settings.units), `${name}-size-check.pdf`, "application/pdf");
  };

  return (
    <div className="relative" ref={ref}>
      <button className="btn btn-primary" disabled={!ready || !!working} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Download size={16} /> {working ?? "Export"} <ChevronDown size={14} />
      </button>
      {open && (
        <div role="menu" className="absolute right-0 top-10 z-20 w-72 rounded-lg border border-line bg-white p-1 shadow-xl">
          {items.map((it) => (
            <MenuItem key={it.label} hint={it.hint} onClick={() => void run(`Exporting ${it.label}…`, it.f)}>{it.label}</MenuItem>
          ))}
          <div className="my-1 border-t border-line" />
          <MenuItem hint="Print at 100% and lay your tools on it" onClick={() => void run("Making PDF…", sizeCheck)}>Size-check PDF</MenuItem>
        </div>
      )}
    </div>
  );
}

function MenuItem(props: { children: React.ReactNode; hint?: string; icon?: React.ReactNode; onClick(): void }) {
  return (
    <button role="menuitem" className="flex w-full items-start gap-2.5 rounded-md px-3 py-2 text-left hover:bg-chrome" onClick={props.onClick}>
      {props.icon && <span className="mt-0.5 text-ink-2">{props.icon}</span>}
      <span className="grid">
        <span className="font-semibold">{props.children}</span>
        {props.hint && <span className="hint">{props.hint}</span>}
      </span>
    </button>
  );
}

function useOutside(ref: React.RefObject<HTMLElement | null>, f: () => void) {
  useEffect(() => {
    const h = (e: PointerEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) f(); };
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") f(); };
    document.addEventListener("pointerdown", h);
    document.addEventListener("keydown", k);
    return () => { document.removeEventListener("pointerdown", h); document.removeEventListener("keydown", k); };
  });
}
