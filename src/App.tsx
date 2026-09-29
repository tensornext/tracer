import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { clearSaved, loadSaved, startAutosave, useStore } from "./state/store";
import { closeImage, openImage } from "./state/session";
import type { ProjectData } from "./state/types";
import { TopBar } from "./components/TopBar";
import { ToolsPanel } from "./components/ToolsPanel";
import { SettingsPanel } from "./components/SettingsPanel";
import { PhotoView } from "./components/PhotoView";
import { LayoutView } from "./components/LayoutView";
import { EmptyState } from "./components/EmptyState";
import { StatusBar } from "./components/StatusBar";

const Preview3D = lazy(() => import("./components/Preview3D").then((m) => ({ default: m.Preview3D })));

export function App() {
  const image = useStore((s) => s.image);
  const view = useStore((s) => s.view);
  const notify = useStore((s) => s.notify);
  const [restoring, setRestoring] = useState(true);
  const [drawer, setDrawer] = useState<null | "tools" | "settings">(null);
  const projectInput = useRef<HTMLInputElement>(null);

  // Restore the last session, then autosave from here on.
  useEffect(() => {
    let stop: (() => void) | undefined;
    void (async () => {
      const saved = await loadSaved();
      if (saved?.project.image) {
        try {
          useStore.getState().loadProject(saved.project);
          await openImage(saved.image, saved.project.image.name, true);
          useStore.getState().setInteraction(saved.project.corners ? { kind: "idle" } : { kind: "paper" });
        } catch {
          useStore.getState().resetProject();
        }
      }
      setRestoring(false);
      stop = startAutosave();
    })();
    return () => stop?.();
  }, []);

  const onFile = useCallback(async (f: File) => {
    try {
      await openImage(f, f.name);
    } catch {
      notify({ tone: "error", text: "That file couldn't be opened as a photo. Try a JPEG or PNG." });
    }
  }, [notify]);

  const onSample = useCallback(async () => {
    const blob = await (await fetch("/sample.jpg")).blob();
    await openImage(blob, "sample.jpg");
  }, []);

  const onNew = useCallback(async () => {
    if (useStore.getState().tools.length && !confirm("Start a new project? The current photo and traces will be cleared.")) return;
    closeImage();
    useStore.getState().resetProject();
    useStore.getState().setImageInfo(null);
    await clearSaved();
  }, []);

  const onOpenProject = async (file: File) => {
    try {
      const data = JSON.parse(await file.text()) as ProjectData & { imageData?: string };
      if (data.version !== 1 || !data.imageData) throw new Error("Not a project file");
      const blob = await (await fetch(data.imageData)).blob();
      useStore.getState().loadProject(data);
      await openImage(blob, data.image?.name ?? file.name, true);
      useStore.getState().setInteraction({ kind: "idle" });
    } catch {
      notify({ tone: "error", text: "That file isn't a project saved from this app." });
    }
  };

  // Paste a photo from the clipboard.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const f = [...(e.clipboardData?.files ?? [])].find((x) => x.type.startsWith("image/"));
      if (f) void onFile(f);
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [onFile]);

  return (
    <div className="grid h-full grid-rows-[52px_1fr_30px]">
      <TopBar onNew={() => void onNew()} onOpenProject={() => projectInput.current?.click()} onPanel={(p) => setDrawer((d) => (d === p ? null : p))} />
      <input ref={projectInput} type="file" accept=".json,application/json" className="hidden"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) void onOpenProject(f); e.target.value = ""; }} />
      <main className="relative grid min-h-0 grid-cols-1 lg:grid-cols-[256px_1fr_272px] xl:grid-cols-[272px_1fr_300px]">
        <div className="hidden min-h-0 lg:block"><ToolsPanel /></div>
        <div className="min-h-0">
          {restoring ? <div className="mat h-full" /> : !image ? (
            <EmptyState onFile={(f) => void onFile(f)} onSample={() => void onSample()} />
          ) : view === "photo" ? <PhotoView /> : view === "layout" ? <LayoutView /> : <Suspense fallback={<div className="mat h-full" />}><Preview3D /></Suspense>}
        </div>
        <div className="hidden min-h-0 lg:block"><SettingsPanel /></div>
        {drawer && (
          <div className="absolute inset-0 z-30 lg:hidden" onClick={() => setDrawer(null)}>
            <div className="absolute inset-0 bg-ink/30" />
            <div className={`absolute top-0 bottom-0 w-[min(320px,88vw)] shadow-2xl ${drawer === "tools" ? "left-0" : "right-0"}`} onClick={(e) => e.stopPropagation()}>
              {drawer === "tools" ? <ToolsPanel /> : <SettingsPanel />}
            </div>
          </div>
        )}
      </main>
      <StatusBar />
    </div>
  );
}
