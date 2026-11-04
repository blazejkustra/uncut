// The Inspector's looks and effects for a clip (D136): its filter (intensity, remove), Adjust
// (exposure, contrast, saturation, temperature, tint, highlights, shadows, vibrance, each with a
// reset, and Reset all) and its effects with their settings, each with an on/off switch (F18). Each control previews while it moves
// (a local draft) and commits once: one edit, one ⌘Z. Core's planners (fx.ts) make the edits.
import {
  ADJUST,
  ADJUST_INFO,
  adjustOf,
  effectInfo,
  effectOptions,
  effectParams,
  MASK,
  LOOK,
  lookInfo,
  planAdjust,
  planEffect,
  planEffectBypass,
  planRemoveEffect,
  planSetLook,
  type AdjustKey,
  type EffectInfo,
  type EffectOption,
} from "@uncut/core/fx";
import type { ModuleUse } from "@uncut/core/types";
import { planShader, planShaderValues, SHADER, shaderUseOf } from "@uncut/core/shaders";
import type { Item } from "@uncut/core/types";
import { AtSign, RotateCcw, X } from "lucide-react";
import { Fragment, useEffect, useRef, useState } from "react";

import { getPlayback, usePlayback, type PreviewDraft } from "../preview/playback.ts";
import { clipState, maskKeyOf, maskValues, planMaskValue } from "../timeline/clip.ts";
import { KeyButton } from "./clip.tsx";
import { type ProjectModel } from "../state/project.ts";
import { actions } from "../state/store.ts";
import { Tooltip } from "../ui/Tooltip.tsx";
import { Prop, Section, SliderNum, Toggle } from "./controls.tsx";
import { NumberField, send, showDraft, type PlanResult } from "./fields.tsx";

/** A slider that drafts while it moves and sends one edit on release. */
export function Live({
  project,
  value,
  min,
  max,
  step,
  unit,
  testId,
  disabled,
  plan,
}: {
  project: ProjectModel;
  value: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
  testId: string;
  disabled: boolean;
  plan: (p: ProjectModel, v: number) => PlanResult;
}) {
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
              <Tooltip label="Remove the filter">
                <button className="icon-btn" data-testid="insp-filter-remove" disabled={locked} onClick={() => send((p) => planSetLook(p, item.id, undefined))}>
                  <X />
                </button>
              </Tooltip>
            </>
          }
        >
          <Prop label={lookName ?? "Filter"} testId="insp-filter-intensity">
            <Live
              project={project}
              value={Math.round((lookParams.intensity ?? 1) * 100)}
              min={0}
              max={100}
              step={1}
              unit="%"
              testId="insp-filter-amount"
              disabled={locked}
              plan={(p, v) =>
                planSetLook(p, item.id, lookParams.look, {
                  intensity: v / 100,
                  ...(look.params && (look.params as { custom?: object }).custom
                    ? { custom: (look.params as { custom: object }).custom, label: lookName ?? "" }
                    : {}),
                })
              }
            />
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
                <Tooltip label="Reset all">
                  <button className="icon-btn" data-testid="insp-adjust-reset" disabled={locked} onClick={() => send((p) => planAdjust(p, item.id, "reset"))}>
                    <RotateCcw />
                  </button>
                </Tooltip>
              )}
            </>
          ) : undefined
        }
      >
        {ADJUST_INFO.map((a) => (
          <Prop
            key={a.key}
            label={a.name}
            testId={`insp-adjust-${a.key}`}
            onReset={adjust[a.key] !== 0 && !locked ? () => send((p) => planAdjust(p, item.id, { [a.key]: 0 })) : undefined}
          >
            {a.key === "exposure" ? (
              <Live
                project={project}
                value={shown(a.key)}
                min={a.min}
                max={a.max}
                step={0.05}
                unit="EV"
                testId={`insp-adjust-${a.key}-value`}
                disabled={locked}
                plan={(p, v) => planAdjust(p, item.id, { exposure: v })}
              />
            ) : (
              <Live
                project={project}
                value={shown(a.key)}
                min={-100}
                max={100}
                step={1}
                testId={`insp-adjust-${a.key}-value`}
                disabled={locked}
                plan={(p, v) => planAdjust(p, item.id, { [a.key]: v / 100 })}
              />
            )}
          </Prop>
        ))}
      </Section>
      <ShaderEditor project={project} item={item} locked={locked} />
      {others.length > 0 && (
        <Section title="Effects" testId="insp-effects" remember="effects">
          {others.map((e) => (
            <EffectEntry key={e.module} project={project} item={item} entry={e} info={effectInfo(e.module)!} locked={locked} />
          ))}
        </Section>
      )}
    </div>
  );
}

/** One effect in the Effects section: its head (chat, on/off, remove), its options (D326), then its numbers. */
function EffectEntry({ project, item, entry, info, locked }: { project: ProjectModel; item: Item; entry: ModuleUse; info: EffectInfo; locked: boolean }) {
  const params = effectParams(entry.module, entry.params);
  const options = effectOptions(entry.module, entry.params);
  return (
    <div className={`fx-entry${entry.bypass ? " off" : ""}`} data-testid="insp-effect" data-module={entry.module} data-off={entry.bypass === true}>
      <div className="fx-entry-head">
        <span className="grow">{info.name}</span>
        {/* D264 (#77): this effect as a chip in the Agent tab's composer. */}
        <Tooltip label={`Add ${info.name.toLowerCase()} to the agent chat`}>
          <button className="icon-btn" data-testid="insp-effect-add-to-chat" onClick={() => actions.addEffectToChat(item.id, entry.module)}>
            <AtSign />
          </button>
        </Tooltip>
        <Power item={item} module={entry.module} off={entry.bypass === true} name={info.name.toLowerCase()} testId="insp-effect-power" disabled={locked} />
        <Tooltip label={`Remove ${info.name.toLowerCase()}`}>
          <button
            className="icon-btn"
            data-testid="insp-effect-remove"
            disabled={locked}
            onClick={() => send((p) => planRemoveEffect(p, item.id, entry.module))}
          >
            <X />
          </button>
        </Tooltip>
      </div>
      {info.options?.map((o) => (
        <Prop key={o.key} label={o.name} testId={`insp-effect-${o.key}`}>
          <OptionControl
            option={o}
            value={options[o.key]!}
            disabled={locked}
            onCommit={(v) => send((p) => planEffect(p, item.id, entry.module, { [o.key]: v }))}
          />
        </Prop>
      ))}
      {entry.module === MASK ? (
        <MaskFields project={project} item={item} params={params} locked={locked} />
      ) : (
        info.params.map((d) => (
          <Prop
            key={d.key}
            label={d.name}
            testId={`insp-effect-${d.key}`}
            onReset={params[d.key] !== d.default && !locked ? () => send((p) => planEffect(p, item.id, entry.module, { [d.key]: d.default })) : undefined}
          >
            <Live
              project={project}
              value={round(params[d.key]!, d.step)}
              min={d.min}
              max={d.max}
              step={d.step}
              {...(d.unit ? { unit: d.unit } : {})}
              testId={`insp-effect-${d.key}-value`}
              disabled={locked}
              plan={(p, v) => planEffect(p, item.id, entry.module, { [d.key]: v })}
            />
          </Prop>
        ))
      )}
    </div>
  );
}

/** A colour well, a list of choices or a switch for an effect's non-number param (one edit each). */
function OptionControl({
  option,
  value,
  disabled,
  onCommit,
}: {
  option: EffectOption;
  value: string | boolean;
  disabled: boolean;
  onCommit: (v: string | boolean) => void;
}) {
  const testId = `insp-effect-${option.key}-value`;
  if (option.kind === "color") return <ShaderColor value={String(value)} testId={testId} disabled={disabled} onCommit={onCommit} />;
  if (option.kind === "toggle") return <Toggle testId={testId} label={option.name} value={value === true} disabled={disabled} onChange={onCommit} />;
  return (
    <select className="field input" data-testid={testId} value={String(value)} disabled={disabled} onChange={(e) => onCommit(e.target.value)}>
      {option.choices.map((c) => (
        <option key={c.id} value={c.id}>
          {c.name}
        </option>
      ))}
    </select>
  );
}

const MASK_FIELDS = [
  ["x", "X"],
  ["y", "Y"],
  ["w", "W"],
  ["h", "H"],
  ["radius", "Radius"],
  ["feather", "Feather"],
] as const;

/**
 * A mask's shape in canvas px from the clip box's top-left (D326): x, y, w and h at the playhead,
 * each with a keyframe diamond (a keyed value is edited at the playhead), then radius and feather.
 */
function MaskFields({ project, item, params, locked }: { project: ProjectModel; item: Item; params: Record<string, number>; locked: boolean }) {
  const frame = usePlayback((s) => Math.round(s.frame));
  const state = clipState(project, item.id, frame);
  const now = maskValues(project, item.id, frame);
  if (!state || !now) return null;
  const value = (key: string) => (key in now ? now[key as keyof typeof now] : Math.round(params[key]!));
  const field = (key: (typeof MASK_FIELDS)[number][0], label: string) => {
    const prop = maskKeyOf(key);
    return (
      <Fragment key={key}>
        <NumberField
          label={label}
          testId={`insp-mask-${key}`}
          value={value(key)}
          min={key === "x" || key === "y" ? undefined : 0}
          disabled={locked}
          onCommit={(v) => v !== undefined && send((p) => planMaskValue(p, item.id, key, v, getPlayback().frame))}
        />
        {prop && <KeyButton project={project} item={item} prop={prop} local={state.local} inside={state.inside} disabled={locked} />}
      </Fragment>
    );
  };
  return (
    <div data-testid="insp-mask">
      <div className="field-row key-row">{MASK_FIELDS.slice(0, 2).map(([k, l]) => field(k, l))}</div>
      <div className="field-row key-row">{MASK_FIELDS.slice(2, 4).map(([k, l]) => field(k, l))}</div>
      <div className="field-row">{MASK_FIELDS.slice(4).map(([k, l]) => field(k, l))}</div>
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
          <Tooltip label={`Remove ${def.name}`}>
            <button className="icon-btn" data-testid="insp-shader-remove" disabled={locked} onClick={() => send((p) => planShader(p, item.id, undefined))}>
              <X />
            </button>
          </Tooltip>
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
                <Live
                  project={project}
                  value={round(Number(v), d.step ?? (d.max! - d.min!) / 100)}
                  min={d.min!}
                  max={d.max!}
                  step={d.step ?? (d.max! - d.min!) / 100}
                  testId={`insp-shader-${d.key}-value`}
                  disabled={locked}
                  plan={(p, x) => planShaderValues(p, item.id, { [d.key]: Math.min(d.max!, Math.max(d.min!, x)) })}
                />
              ) : d.type === "color" ? (
                <ShaderColor
                  value={String(v)}
                  testId={`insp-shader-${d.key}-value`}
                  disabled={locked}
                  onCommit={(c) => send((p) => planShaderValues(p, item.id, { [d.key]: c }))}
                />
              ) : (
                <Toggle
                  testId={`insp-shader-${d.key}-value`}
                  label={d.label}
                  value={v === true}
                  disabled={locked}
                  onChange={(on) => send((p) => planShaderValues(p, item.id, { [d.key]: on }))}
                />
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
  return (
    <input ref={ref} type="color" className="shader-color" data-testid={testId} value={draft} disabled={disabled} onChange={(e) => setDraft(e.target.value)} />
  );
}
