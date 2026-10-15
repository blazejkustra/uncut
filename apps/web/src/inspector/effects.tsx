// The Inspector's looks and effects for a clip (D136): its filter (intensity, remove), Adjust
// (exposure, contrast, saturation, temperature, tint, highlights, shadows, vibrance, each with a
// reset, and Reset all) and its effects with their settings, each with an on/off switch (F18). Each control previews while it moves
// (a local draft) and commits once: one edit, one ⌘Z. Core's planners (fx.ts) make the edits.
import { ADJUST, ADJUST_INFO, adjustOf, effectInfo, effectParams, LOOK, lookInfo, planAdjust, planEffect, planEffectBypass, planRemoveEffect, planSetLook, type AdjustKey } from "@uncut/core/fx";
import { planShader, planShaderValues, SHADER, shaderUseOf } from "@uncut/core/shaders";
import type { Item } from "@uncut/core/types";
import { RotateCcw, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { PreviewDraft } from "../preview/playback.ts";
import { type ProjectModel } from "../state/project.ts";
import { Prop, Section, SliderNum, Toggle } from "./controls.tsx";
import { send, showDraft, type PlanResult } from "./fields.tsx";

/** A slider that drafts while it moves and sends one edit on release. */
export function Live({ project, value, min, max, step, unit, testId, disabled, plan }: { project: ProjectModel; value: number; min: number; max: number; step: number; unit?: string; testId: string; disabled: boolean; plan: (p: ProjectModel, v: number) => PlanResult }) {
  const draft = useRef<PreviewDraft | undefined>(undefined);
  return (
    <SliderNum
      value={value}
      min={min}
      max={max}
      step={step}
      {...(unit ? { unit } : {})}
      testId={testId}
      disabled={disabled}
      onPreview={(v) => (draft.current = showDraft(project, plan(project, v)) ?? draft.current)}
      onCommit={(v) => {
        const d = draft.current;
        draft.current = undefined;
        send((p) => plan(p, v), d);
      }}
    />
  );
}

const round = (v: number, step: number) => Math.round(v / step) * step;

/** An effect's on/off switch (F18, D161): off keeps it and its settings but draws nothing (bypass). One edit. */
function Power({ item, module, off, name, testId, disabled }: { item: Item; module: string; off: boolean; name: string; testId: string; disabled: boolean }) {
  return (
    <span className="fx-power" title={off ? `Turn ${name} on` : `Turn ${name} off`}>
      <Toggle testId={testId} label={`${name} on`} value={!off} disabled={disabled} onChange={(on) => send((p) => planEffectBypass(p, item.id, module, on))} />
    </span>
  );
}

export function EffectsEditor({ project, item, locked }: { project: ProjectModel; item: Item; locked: boolean }) {
  const effects = item.effects ?? [];
  const look = effects.find((e) => e.module === LOOK);
  const lookParams = (look?.params ?? {}) as { look?: string; intensity?: number; label?: string };
  const adjustEntry = effects.find((e) => e.module === ADJUST);
  const adjust = adjustOf(adjustEntry?.params);
  const others = effects.filter((e) => e.module !== LOOK && e.module !== ADJUST && effectInfo(e.module));
  const lookName = lookParams.label ?? lookInfo(lookParams.look)?.name ?? lookParams.look;
  const adjusted = ADJUST_INFO.some((a) => adjust[a.key] !== 0);
  // Exposure in stops (−2 to 2); the rest shown −100 to 100.
  const shown = (key: AdjustKey) => (key === "exposure" ? round(adjust[key], 0.05) : Math.round(adjust[key] * 100));
  return (
    <div data-testid="effects-editor">
      {look && (
        <Section
          title="Filter"
          testId="insp-filter"
          remember="filter"
          action={
            <>
            <Power item={item} module={LOOK} off={look.bypass === true} name="the filter" testId="insp-filter-power" disabled={locked} />
            <button className="icon-btn" title="Remove the filter" data-testid="insp-filter-remove" disabled={locked} onClick={() => send((p) => planSetLook(p, item.id, undefined))}>
              <X />
            </button>
            </>
          }
        >
          <Prop label={lookName ?? "Filter"} testId="insp-filter-intensity">
            <Live project={project} value={Math.round((lookParams.intensity ?? 1) * 100)} min={0} max={100} step={1} unit="%" testId="insp-filter-amount" disabled={locked} plan={(p, v) => planSetLook(p, item.id, lookParams.look, { intensity: v / 100, ...(look.params && (look.params as { custom?: object }).custom ? { custom: (look.params as { custom: object }).custom, label: lookName ?? "" } : {}) })} />
          </Prop>
        </Section>
      )}
      <Section
        title="Adjust"
        testId="insp-adjust"
        remember="adjust"
        action={
          adjustEntry ? (
            <>
              <Power item={item} module={ADJUST} off={adjustEntry.bypass === true} name="the adjustments" testId="insp-adjust-power" disabled={locked} />
              {adjusted && (
                <button className="icon-btn" title="Reset all" data-testid="insp-adjust-reset" disabled={locked} onClick={() => send((p) => planAdjust(p, item.id, "reset"))}>
                  <RotateCcw />
                </button>
              )}
            </>
          ) : undefined
        }
      >
        {ADJUST_INFO.map((a) => (
          <Prop key={a.key} label={a.name} testId={`insp-adjust-${a.key}`} onReset={adjust[a.key] !== 0 && !locked ? () => send((p) => planAdjust(p, item.id, { [a.key]: 0 })) : undefined}>
            {a.key === "exposure" ? (
              <Live project={project} value={shown(a.key)} min={a.min} max={a.max} step={0.05} unit="EV" testId={`insp-adjust-${a.key}-value`} disabled={locked} plan={(p, v) => planAdjust(p, item.id, { exposure: v })} />
            ) : (
              <Live project={project} value={shown(a.key)} min={-100} max={100} step={1} testId={`insp-adjust-${a.key}-value`} disabled={locked} plan={(p, v) => planAdjust(p, item.id, { [a.key]: v / 100 })} />
            )}
          </Prop>
        ))}
      </Section>
      <ShaderEditor project={project} item={item} locked={locked} />
      {others.length > 0 && (
        <Section title="Effects" testId="insp-effects" remember="effects">
          {others.map((e) => {
            const info = effectInfo(e.module)!;
            const params = effectParams(e.module, e.params);
            return (
              <div key={e.module} className={`fx-entry${e.bypass ? " off" : ""}`} data-testid="insp-effect" data-module={e.module} data-off={e.bypass === true}>
                <div className="fx-entry-head">
                  <span className="grow">{info.name}</span>
                  <Power item={item} module={e.module} off={e.bypass === true} name={info.name.toLowerCase()} testId="insp-effect-power" disabled={locked} />
                  <button className="icon-btn" title={`Remove ${info.name.toLowerCase()}`} data-testid="insp-effect-remove" disabled={locked} onClick={() => send((p) => planRemoveEffect(p, item.id, e.module))}>
                    <X />
                  </button>
                </div>
                {info.params.map((d) => (
                  <Prop key={d.key} label={d.name} testId={`insp-effect-${d.key}`} onReset={params[d.key] !== d.default && !locked ? () => send((p) => planEffect(p, item.id, e.module, { [d.key]: d.default })) : undefined}>
                    <Live project={project} value={round(params[d.key]!, d.step)} min={d.min} max={d.max} step={d.step} {...(d.unit ? { unit: d.unit } : {})} testId={`insp-effect-${d.key}-value`} disabled={locked} plan={(p, v) => planEffect(p, item.id, e.module, { [d.key]: v })} />
                  </Prop>
                ))}
              </div>
            );
          })}
        </Section>
      )}
    </div>
  );
}

/** A clip's shader effect (D213): its name, on/off, remove, and a control per param (one edit each). */
function ShaderEditor({ project, item, locked }: { project: ProjectModel; item: Item; locked: boolean }) {
  const entry = (item.effects ?? []).find((e) => e.module === SHADER);
  const use = entry ? shaderUseOf(entry) : undefined;
  if (!entry || !use) return null;
  const { def, values } = use;
  return (
    <Section
      title="Shader"
      testId="insp-shader"
      remember="shader"
      action={
        <>
          <Power item={item} module={SHADER} off={entry.bypass === true} name="the shader effect" testId="insp-shader-power" disabled={locked} />
          <button className="icon-btn" title={`Remove ${def.name}`} data-testid="insp-shader-remove" disabled={locked} onClick={() => send((p) => planShader(p, item.id, undefined))}>
            <X />
          </button>
        </>
      }
    >
      <div className={`fx-entry${entry.bypass ? " off" : ""}`} data-testid="insp-shader-entry" data-shader={def.id}>
        <div className="fx-entry-head">
          <span className="grow">{def.name}</span>
        </div>
        {def.params.map((d) => {
          const v = values[d.key];
          const reset = v !== d.default && !locked ? () => send((p) => planShaderValues(p, item.id, { [d.key]: d.default })) : undefined;
          return (
            <Prop key={d.key} label={d.label} testId={`insp-shader-${d.key}`} onReset={reset}>
              {d.type === "number" ? (
                <Live project={project} value={round(Number(v), d.step ?? (d.max! - d.min!) / 100)} min={d.min!} max={d.max!} step={d.step ?? (d.max! - d.min!) / 100} testId={`insp-shader-${d.key}-value`} disabled={locked} plan={(p, x) => planShaderValues(p, item.id, { [d.key]: Math.min(d.max!, Math.max(d.min!, x)) })} />
              ) : d.type === "color" ? (
                <ShaderColor value={String(v)} testId={`insp-shader-${d.key}-value`} disabled={locked} onCommit={(c) => send((p) => planShaderValues(p, item.id, { [d.key]: c }))} />
              ) : (
                <Toggle testId={`insp-shader-${d.key}-value`} label={d.label} value={v === true} disabled={locked} onChange={(on) => send((p) => planShaderValues(p, item.id, { [d.key]: on }))} />
              )}
            </Prop>
          );
        })}
      </div>
    </Section>
  );
}

/** A colour for a shader param: picked freely, one edit when the picker closes (or the field loses focus). */
function ShaderColor({ value, testId, disabled, onCommit }: { value: string; testId: string; disabled: boolean; onCommit: (hex: string) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const ref = useRef<HTMLInputElement>(null);
  // The native "change" event fires once the picker is done (React's onChange is every move).
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const done = () => el.value.toLowerCase() !== value && onCommit(el.value.toLowerCase());
    el.addEventListener("change", done);
    return () => el.removeEventListener("change", done);
  }, [value, onCommit]);
  return <input ref={ref} type="color" className="shader-color" data-testid={testId} value={draft} disabled={disabled} onChange={(e) => setDraft(e.target.value)} />;
}
