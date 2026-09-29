import { useRef, useState } from "react";
import { ImagePlus, Images } from "lucide-react";

export function EmptyState({ onFile, onSample }: { onFile(f: File): void; onSample(): void }) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  return (
    <div
      className={`mat relative grid h-full place-items-center overflow-auto p-6 ${over ? "outline-4 outline-dashed -outline-offset-8 outline-mat-ink/60" : ""}`}
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const f = [...e.dataTransfer.files].find((x) => x.type.startsWith("image/"));
        if (f) onFile(f);
      }}
    >
      <div className="grid max-w-[640px] gap-8 text-mat-ink">
        <div className="grid gap-3">
          <h1 className="text-[40px] leading-[1.05] font-bold text-white tracking-tight sm:text-[52px]">
            Photograph your tools.
            <br />
            Print the bin they live in.
          </h1>
          <p className="max-w-[52ch] text-[16px] text-mat-ink/90">
            Lay your tools on a sheet of Letter or A4 paper, take one photo from above, and get a Gridfinity bin or a foam insert cut to their exact shapes.
          </p>
        </div>
        <div className="flex flex-wrap gap-3">
          <button className="btn btn-primary h-11 px-5 text-[15px]" onClick={() => input.current?.click()}><ImagePlus size={18} /> Choose a photo</button>
          <button className="btn h-11 px-5 text-[15px]" onClick={onSample}><Images size={18} /> Try the sample photo</button>
          <input ref={input} type="file" accept="image/*" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ""; }} />
        </div>
        <ol className="grid gap-4 sm:grid-cols-3 text-[13.5px]">
          <li className="grid gap-1 border-t border-mat-ink/30 pt-3">
            <span className="num text-[13px] text-orange font-semibold">1</span>
            <span className="font-semibold text-white">Tools on paper</span>
            <span className="text-mat-ink/85">The sheet sets the scale. A contrasting surface around it helps.</span>
          </li>
          <li className="grid gap-1 border-t border-mat-ink/30 pt-3">
            <span className="num text-[13px] text-orange font-semibold">2</span>
            <span className="font-semibold text-white">Shoot from above</span>
            <span className="text-mat-ink/85">Step back and zoom in rather than shooting up close, so tall tools don't trace large.</span>
          </li>
          <li className="grid gap-1 border-t border-mat-ink/30 pt-3">
            <span className="num text-[13px] text-orange font-semibold">3</span>
            <span className="font-semibold text-white">Click each tool</span>
            <span className="text-mat-ink/85">Tracing runs in your browser. Your photo never leaves your computer.</span>
          </li>
        </ol>
      </div>
    </div>
  );
}
