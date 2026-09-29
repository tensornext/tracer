import { useStore } from "../state/store";
import { prepareModel } from "../state/session";
import { LengthInput, Section, Seg, Toggle } from "./ui";

const TOLERANCES = [
  { value: 0, label: "None" },
  { value: 1.5, label: "Small" },
  { value: 3, label: "Medium" },
  { value: 4.5, label: "Large" },
];

export function SettingsPanel() {
  const s = useStore((st) => st.settings);
  const update = useStore((st) => st.updateSettings);
  const u = s.units;
  const g = s.gridfinity;
  const setG = (patch: Partial<typeof g>) => update((prev) => ({ ...prev, gridfinity: { ...prev.gridfinity, ...patch } }));
  const setF = (patch: Partial<typeof s.foam>) => update((prev) => ({ ...prev, foam: { ...prev.foam, ...patch } }));

  return (
    <aside className="h-full min-h-0 overflow-y-auto bg-panel border-l border-line px-4">
      <Section title="Photo">
        <div className="grid gap-1.5">
          <span className="text-[12.5px] font-semibold text-ink-2">Paper under the tools</span>
          <Seg fill label="Paper size" value={s.paper} onChange={(paper) => update({ paper })} options={[{ value: "letter", label: "Letter" }, { value: "a4", label: "A4" }]} />
        </div>
        <div className="grid gap-1.5">
          <span className="text-[12.5px] font-semibold text-ink-2">Tracing</span>
          <Seg fill label="Tracing engine" value={s.engine} onChange={(engine) => { update({ engine }); if (engine === "ai") void prepareModel(); }}
            options={[{ value: "ai", label: "AI" }, { value: "simple", label: "Simple" }]} />
          <span className="hint">{s.engine === "ai" ? "Runs in your browser; the model downloads once, then it's cached." : "Selects by colour. Works best for dark tools on white paper."}</span>
        </div>
        {s.engine === "ai" && (
          <div className="grid gap-1.5">
            <span className="text-[12.5px] font-semibold text-ink-2">Model</span>
            <Seg fill label="Model size" value={s.quality} onChange={(quality) => update({ quality })}
              options={[{ value: "standard", label: "Standard" }, { value: "high", label: "Precise" }]} />
            <span className="hint">Standard is a 65 MB download, Precise 155 MB. A change applies after a reload.</span>
          </div>
        )}
      </Section>

      <Section title="Fit">
        <div className="grid gap-1.5">
          <span className="text-[12.5px] font-semibold text-ink-2">Clearance around each tool</span>
          <Seg fill label="Clearance" value={TOLERANCES.some((t) => t.value === s.tolerance) ? s.tolerance : -1} onChange={(tolerance) => update({ tolerance })} options={TOLERANCES} />
        </div>
        <LengthInput label="Clearance" mm={s.tolerance} units={u} min={0} max={10} step={u === "mm" ? 0.25 : 0.01} onChange={(tolerance) => update({ tolerance })} />
        <LengthInput label="Finger slot width" mm={s.fingerDiameter} units={u} min={8} max={40} onChange={(fingerDiameter) => update({ fingerDiameter })} />
      </Section>

      {s.mode === "gridfinity" ? (
        <Section title="Gridfinity bin">
          <LengthInput label="Default pocket depth" mm={g.pocketDepth} units={u} min={2} max={120} onChange={(pocketDepth) => setG({ pocketDepth })} />
          <Toggle label="Stacking lip" checked={g.lip} onChange={(lip) => setG({ lip })} />
          <Toggle label="Round height to whole units" hint="Keeps the bin on the 7 mm Gridfinity grid" checked={g.snapHeight} onChange={(snapHeight) => setG({ snapHeight })} />
          <Toggle label="Contrasting pocket floors" hint="A 0.6 mm floor layer as a separate part, for a second filament" checked={g.contrastLayer > 0} onChange={(v) => setG({ contrastLayer: v ? 0.6 : 0 })} />
          <div className="grid gap-1.5">
            <span className="text-[12.5px] font-semibold text-ink-2">Magnet holes (6 × 2 mm)</span>
            <Seg fill label="Magnet holes" value={g.magnets} onChange={(magnets) => setG({ magnets })}
              options={[{ value: "none", label: "None" }, { value: "corners", label: "Corners" }, { value: "all", label: "Every cell" }]} />
          </div>
          <Toggle label="Split for my printer" hint="Cuts big bins along cell lines so each piece fits the bed" checked={g.split} onChange={(split) => setG({ split })} />
          {g.split && (
            <div className="grid grid-cols-2 gap-2">
              <LengthInput label="Bed width" mm={g.bedWidth} units={u} min={60} onChange={(bedWidth) => setG({ bedWidth })} />
              <LengthInput label="Bed depth" mm={g.bedDepth} units={u} min={60} onChange={(bedDepth) => setG({ bedDepth })} />
            </div>
          )}
        </Section>
      ) : (
        <Section title="Foam insert">
          <LengthInput label="Cut layer thickness" mm={s.foam.thickness} units={u} min={3} max={150} onChange={(thickness) => setF({ thickness })} />
          <LengthInput label="Backer thickness" mm={s.foam.backer} units={u} min={0} max={50} onChange={(backer) => setF({ backer })} />
          <LengthInput label="Margin around tools" mm={s.foam.margin} units={u} min={0} max={100} onChange={(margin) => setF({ margin })} />
          <span className="hint">The cut layer goes to a laser, waterjet or CNC as DXF or SVG. The backer is a plain sheet underneath.</span>
        </Section>
      )}

      <Section title="Units">
        <Seg fill label="Units" value={u} onChange={(units) => update({ units })} options={[{ value: "mm", label: "Millimetres" }, { value: "in", label: "Inches" }]} />
      </Section>
    </aside>
  );
}
