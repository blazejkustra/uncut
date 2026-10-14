// The Inspector's looks and effects for a clip (D136): its filter (intensity, remove), Adjust
// (exposure, contrast, saturation, temperature, tint, highlights, shadows, vibrance, each with a
// reset, and Reset all) and its effects with their settings. Each control previews while it moves
// (a local draft) and commits once: one edit, one ⌘Z. Core's planners (fx.ts) make the edits.
import { ADJUST, ADJUST_INFO, adjustOf, effectInfo, effectParams, LOOK, lookInfo, planAdjust, planEffect, planRemoveEffect, planSetLook, type AdjustKey } from "@uncut/core/fx";
import type { Item } from "@uncut/core/types";
import { RotateCcw, X } from "lucide-react";
import { useRef } from "react";

import type { PreviewDraft } from "../preview/playback.ts";
import { type ProjectModel } from "../state/project.ts";
import { Prop, Section, SliderNum } from "./controls.tsx";
import { send, showDraft, type PlanResult } from "./fields.tsx";

/** A slider that drafts while it moves and sends one edit on release. */
function Live({ project, value, min, max, step, unit, testId, disabled, plan }: { project: ProjectModel; value: number; min: number; max: number; step: number; unit?: string; testId: string; disabled: boolean; plan: (p: ProjectModel, v: number) => PlanResult }) {
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

export function EffectsEditor({ project, item, locked }: { project: ProjectModel; item: Item; locked: boolean }) {
  const effects = item.effects ?? [];
  const look = effects.find((e) => e.module === LOOK);
  const lookParams = (look?.params ?? {}) as { look?: string; intensity?: number; label?: string };
  const adjust = adjustOf(effects.find((e) => e.module === ADJUST)?.params);
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
          action={
            <button className="icon-btn" title="Remove the filter" data-testid="insp-filter-remove" disabled={locked} onClick={() => send((p) => planSetLook(p, item.id, undefined))}>
              <X />
            </button>
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
        action={
          adjusted ? (
            <button className="icon-btn" title="Reset all" data-testid="insp-adjust-reset" disabled={locked} onClick={() => send((p) => planAdjust(p, item.id, "reset"))}>
              <RotateCcw />
            </button>
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
      {others.length > 0 && (
        <Section title="Effects" testId="insp-effects">
          {others.map((e) => {
            const info = effectInfo(e.module)!;
            const params = effectParams(e.module, e.params);
            return (
              <div key={e.module} className="fx-entry" data-testid="insp-effect" data-module={e.module}>
                <div className="fx-entry-head">
                  <span>{info.name}</span>
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
