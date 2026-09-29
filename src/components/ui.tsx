// Small shared UI pieces and unit helpers.
import type { ReactNode } from "react";
import type { Units } from "../state/types";

export const APP_NAME = "Toolbed";

export const toDisplay = (mm: number, u: Units) => (u === "mm" ? mm : mm / 25.4);
export const fromDisplay = (v: number, u: Units) => (u === "mm" ? v : v * 25.4);
export function fmt(mm: number, u: Units, digits?: number) {
  const v = toDisplay(mm, u);
  const d = digits ?? (u === "mm" ? (Math.abs(v) >= 100 ? 0 : 1) : 2);
  return `${v.toFixed(d)} ${u}`;
}

export function Seg<T extends string | number>(props: { value: T; options: { value: T; label: string }[]; onChange(v: T): void; label: string; fill?: boolean }) {
  return (
    <div className={props.fill ? "seg seg-fill" : "seg"} role="group" aria-label={props.label}>
      {props.options.map((o) => (
        <button key={String(o.value)} type="button" aria-pressed={props.value === o.value} onClick={() => props.onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Toggle(props: { checked: boolean; onChange(v: boolean): void; label: string; hint?: string }) {
  return (
    <label className="flex items-start justify-between gap-3 cursor-pointer">
      <span className="grid">
        <span className="text-[13.5px] font-semibold">{props.label}</span>
        {props.hint && <span className="hint">{props.hint}</span>}
      </span>
      <button type="button" role="switch" aria-checked={props.checked} aria-label={props.label} className="toggle mt-0.5" onClick={() => props.onChange(!props.checked)} />
    </label>
  );
}

/** Number input in the user's units; stores millimetres. */
export function LengthInput(props: { label: string; mm: number; units: Units; min?: number; max?: number; step?: number; onChange(mm: number): void; unitless?: boolean }) {
  const shown = props.unitless ? props.mm : toDisplay(props.mm, props.units);
  const step = props.step ?? (props.units === "mm" || props.unitless ? 0.5 : 0.02);
  return (
    <label className="field">
      <span>{props.label}</span>
      <div className="relative">
        <input
          className="input num pr-10"
          type="number"
          inputMode="decimal"
          step={step}
          min={props.min}
          max={props.max}
          value={Number(shown.toFixed(props.units === "mm" || props.unitless ? 2 : 3))}
          onChange={(e) => {
            const v = parseFloat(e.target.value);
            if (Number.isFinite(v)) props.onChange(props.unitless ? v : fromDisplay(v, props.units));
          }}
        />
        {!props.unitless && <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[12px] text-ink-2 pointer-events-none">{props.units}</span>}
      </div>
    </label>
  );
}

export function Section(props: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="grid gap-3 py-4 border-b border-line last:border-b-0">
      <div className="flex items-center justify-between">
        <h3 className="text-[13.5px] font-bold">{props.title}</h3>
        {props.aside}
      </div>
      {props.children}
    </section>
  );
}
