import { useMemo } from "react";
import { AlertTriangle, Cpu, X } from "lucide-react";
import { useStore } from "../state/store";
import { frameFor } from "../state/geometry";

export function StatusBar() {
  const model = useStore((s) => s.model);
  const engine = useStore((s) => s.settings.engine);
  const corners = useStore((s) => s.corners);
  const paper = useStore((s) => s.settings.paper);
  const notice = useStore((s) => s.notice);
  const notify = useStore((s) => s.notify);
  const image = useStore((s) => s.image);
  const frame = useMemo(() => frameFor(corners, paper), [corners, paper]);

  const modelText = engine === "simple"
    ? "Simple colour selection"
    : model.status === "loading"
      ? model.total ? `Downloading the AI tracer: ${(model.loaded / 1e6).toFixed(0)} of ${(model.total / 1e6).toFixed(0)} MB (first time only)` : "Loading the AI tracer…"
      : model.status === "ready"
        ? `AI tracer ready (${model.device === "webgpu" ? "GPU" : "CPU, slower"})`
        : model.status === "error"
          ? "AI tracer unavailable, using simple selection"
          : "AI tracer loads when you add a photo";

  return (
    <footer className="flex h-[30px] items-center gap-4 overflow-hidden whitespace-nowrap border-t border-line bg-panel px-4 text-[12.5px] text-ink-2">
      <span className="flex flex-none items-center gap-1.5"><Cpu size={13} /> {modelText}</span>
      {image && frame && (
        <span className="num hidden xl:inline">Scale {frame.mmPerPxAtCenter.toFixed(3)} mm per pixel on the {paper === "letter" ? "Letter" : "A4"} sheet</span>
      )}
      {frame && frame.obliqueness > 1.15 && (
        <span className="flex flex-none items-center gap-1 text-warn font-semibold" title="Photo is at an angle; tall tools may come out slightly large"><AlertTriangle size={13} /> Photo is at an angle; tall tools may come out slightly large</span>
      )}
      <div className="flex-1" />
      {notice && (
        <span title={notice.text} className={`flex min-w-0 items-center gap-1.5 font-semibold ${notice.tone === "error" ? "text-error" : notice.tone === "warn" ? "text-warn" : "text-ink"}`}>
          <span className="truncate">{notice.text}</span>
          <button className="btn-ghost rounded p-0.5" aria-label="Dismiss" onClick={() => notify(null)}><X size={13} /></button>
        </span>
      )}
    </footer>
  );
}
