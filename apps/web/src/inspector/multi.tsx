// The Inspector for several selected items (Fable QA round 2, F2, D147): a header with how many
// and of what, then the controls they share. Every change goes to each selected item it applies to
// as one edit (timeline/multi.ts planForAll): the filter's strength and removal, Adjust, effects,
// speed, volume and opacity. A value shows when all of them have it, else the first one's.
import { SPEED_PRESETS, SPEED_RANGE, speedLabel } from "@uncut/core/arrange";
import { MAX_DB, SILENCE_DB } from "@uncut/core/audio";
import { fxSkips } from "@uncut/core/fx";
import { ADJUST, ADJUST_INFO, adjustOf, effectInfo, effectParams, LOOK, lookInfo, planAdjust, planEffect, planRemoveEffect, planSetLook, type AdjustKey } from "@uncut/core/fx";
import type { Item } from "@uncut/core/types";
import { AtSign, Layers, RotateCcw, X } from "lucide-react";

import { hasSound, planGain } from "../audio/sound.ts";
import { getPlayback } from "../preview/playback.ts";
import { type ProjectModel } from "../state/project.ts";
import { actions, speedPlan } from "../state/store.ts";
import { Tooltip } from "../ui/Tooltip.tsx";
import { clipState, isBoxed, planClipBox } from "../timeline/clip.ts";
import { findItem, type Plan } from "../timeline/edit.ts";
import { planForAll } from "../timeline/multi.ts";
import { Prop, Section } from "./controls.tsx";
import { Live } from "./effects.tsx";
import { Group, NumberField, send, type PlanResult } from "./fields.tsx";
import { hasSpeed } from "./speed.tsx";

const NOUNS: Readonly<Record<string, readonly [string, string]>> = {
  clip: ["clip", "clips"],
  component: ["element", "elements"],
  graphic: ["graphic", "graphics"],
  text: ["text", "texts"],
  captions: ["captions", "captions"],
  audio: ["sound", "sounds"],
};

/** "3 clips, 1 text". */
export function selectionWords(items: ReadonlyArray<Item>): string {
  const counts = new Map<string, number>();
  for (const i of items) counts.set(i.type, (counts.get(i.type) ?? 0) + 1);
  return [...counts].map(([type, n]) => `${n} ${NOUNS[type]?.[n === 1 ? 0 : 1] ?? type}`).join(", ");
}

const round = (v: number, step: number) => Math.round(v / step) * step;

export function MultiInspector({ project, ids }: { project: ProjectModel; ids: ReadonlyArray<string> }) {
  const placed = ids.map((id) => findItem(project, id)).filter((p) => p !== undefined);
  const items = placed.map((p) => p.item);
  const lockedIds = new Set(placed.filter((p) => p.track.locked || p.item.locked).map((p) => p.item.id));
  const editable = items.filter((i) => !lockedIds.has(i.id));
  const fxClips = editable.filter((i) => {
    const media = i.type === "clip" && i.media ? project.media.find((m) => m.id === i.media) : undefined;
    return !!media && media.kind !== "audio" && !fxSkips(media);
  });
  const speedItems = editable.filter((i) => hasSpeed(project, i));
  const soundItems = editable.filter((i) => hasSound(project, i));
  const boxItems = editable.filter((i) => isBoxed(project, i));
  /** One edit over `targets`; `plan` per item, `label` for the joined edit. */
  const all = (targets: ReadonlyArray<Item>, plan: (p: ProjectModel, id: string) => Plan | { readonly problem: string }, label: (n: number) => string) => (p: ProjectModel): PlanResult =>
    planForAll(
      p,
      targets.map((i) => i.id),
      plan,
      label,
    );
  const shared = <T,>(list: ReadonlyArray<Item>, of: (i: Item) => T): { value: T; same: boolean } => {
    const values = list.map(of);
    return { value: values[0]!, same: values.every((v) => JSON.stringify(v) === JSON.stringify(values[0])) };
  };

  // Filter: the same look on every clip (its strength editable), or mixed.
  const lookOf = (i: Item) => ((i.effects ?? []).find((e) => e.module === LOOK)?.params ?? undefined) as { look?: string; intensity?: number; label?: string; custom?: object } | undefined;
  const looks = fxClips.length ? shared(fxClips, (i) => lookOf(i)?.look ?? null) : undefined;
  const anyLook = fxClips.some((i) => lookOf(i));
  const firstLook = fxClips.map(lookOf).find((l) => l);
  const lookName = firstLook?.label ?? lookInfo(firstLook?.look)?.name ?? firstLook?.look;
  const adjust = fxClips.length ? adjustOf((fxClips[0]!.effects ?? []).find((e) => e.module === ADJUST)?.params) : undefined;
  const adjusted = fxClips.some((i) => ADJUST_INFO.some((a) => adjustOf((i.effects ?? []).find((e) => e.module === ADJUST)?.params)[a.key] !== 0));
  const shownAdjust = (key: AdjustKey) => (key === "exposure" ? round(adjust![key], 0.05) : Math.round(adjust![key] * 100));
  // Effects any of them has: settings from the first that has it, changes go to those that have it.
  const modules = [...new Set(fxClips.flatMap((i) => (i.effects ?? []).map((e) => e.module)))].filter((m) => m !== LOOK && m !== ADJUST && effectInfo(m));
  const speed = speedItems.length ? shared(speedItems, (i) => i.speed ?? 1) : undefined;
  const gain = soundItems.length ? shared(soundItems, (i) => i.gainDb ?? 0) : undefined;
  const frame = Math.round(getPlayback().frame);
  const opacityOf = (i: Item) => Math.round((clipState(project, i.id, frame)?.box.opacity ?? 1) * 100);
  const opacity = boxItems.length ? shared(boxItems, opacityOf) : undefined;
  const n = (list: ReadonlyArray<Item>, one: string, many: string) => (list.length === 1 ? one : `${list.length} ${many}`);

  return (
    <div data-testid="inspector-multi" data-count={items.length}>
      <div className="insp-title">
        <Layers />
        <span className="ellipsis grow" data-testid="inspector-multi-title">
          {items.length} items selected
        </span>
        {/* D264 (#77): every selected item as a chip in the Agent tab's composer. */}
        <Tooltip label={`Add these ${items.length} items to the agent chat`} shortcut="addToChat">
          <button className="small-btn insp-chat" data-testid="multi-add-to-chat" onClick={() => items.forEach((i) => actions.addItemToChat(i.id))}>
            <AtSign />
            Add to chat
          </button>
        </Tooltip>
      </div>
      <div className="insp-sub" data-testid="inspector-multi-sub">
        {selectionWords(items)}
        {lockedIds.size ? `, ${lockedIds.size} locked` : ""}
      </div>
      {fxClips.length > 0 && (
        <>
          <Section
            title="Filter"
            testId="multi-filter"
            remember="filter"
            action={
              anyLook ? (
                <Tooltip label="Remove the filter from all">
                  <button className="icon-btn" data-testid="multi-filter-remove" onClick={() => send(all(fxClips.filter((i) => lookOf(i)), (p, id) => planSetLook(p, id, undefined), (k) => `Remove the filter from ${k} clips`))}>
                    <X />
                  </button>
                </Tooltip>
              ) : undefined
            }
          >
            {looks?.same && firstLook?.look ? (
              <Prop label={lookName ?? "Filter"} testId="multi-filter-intensity">
                <Live
                  project={project}
                  value={Math.round((firstLook.intensity ?? 1) * 100)}
                  min={0}
                  max={100}
                  step={1}
                  unit="%"
                  testId="multi-filter-amount"
                  disabled={false}
                  plan={(p, v) => all(fxClips, (q, id) => planSetLook(q, id, firstLook.look, { intensity: v / 100, ...(firstLook.custom ? { custom: firstLook.custom as never, label: lookName ?? "" } : {}) }), (k) => `Set ${lookName} on ${k} clips to ${v}%`)(p)}
                />
              </Prop>
            ) : (
              <div className="muted small" data-testid="multi-filter-state">
                {anyLook ? "Different filters" : "No filter"}
              </div>
            )}
          </Section>
          <Section
            title="Adjust"
            testId="multi-adjust"
            remember="adjust"
            action={
              adjusted ? (
                <Tooltip label="Reset all">
                  <button className="icon-btn" data-testid="multi-adjust-reset" onClick={() => send(all(fxClips, (p, id) => planAdjust(p, id, "reset"), (k) => `Reset the adjustments of ${k} clips`))}>
                    <RotateCcw />
                  </button>
                </Tooltip>
              ) : undefined
            }
          >
            {ADJUST_INFO.map((a) => (
              <Prop key={a.key} label={a.name} testId={`multi-adjust-${a.key}`}>
                <Live
                  project={project}
                  value={shownAdjust(a.key)}
                  min={a.key === "exposure" ? a.min : -100}
                  max={a.key === "exposure" ? a.max : 100}
                  step={a.key === "exposure" ? 0.05 : 1}
                  {...(a.key === "exposure" ? { unit: "EV" } : {})}
                  testId={`multi-adjust-${a.key}-value`}
                  disabled={false}
                  plan={(p, v) => all(fxClips, (q, id) => planAdjust(q, id, { [a.key]: a.key === "exposure" ? v : v / 100 }), (k) => `Set ${a.name.toLowerCase()} of ${k} clips`)(p)}
                />
              </Prop>
            ))}
          </Section>
          {modules.length > 0 && (
            <Section title="Effects" testId="multi-effects" remember="effects">
              {modules.map((module) => {
                const info = effectInfo(module)!;
                const having = fxClips.filter((i) => (i.effects ?? []).some((e) => e.module === module));
                const params = effectParams(module, (having[0]!.effects ?? []).find((e) => e.module === module)?.params);
                return (
                  <div key={module} className="fx-entry" data-testid="multi-effect" data-module={module} data-count={having.length}>
                    <div className="fx-entry-head">
                      <span>
                        {info.name} <span className="muted small">{having.length === fxClips.length ? "all" : `${having.length} of ${fxClips.length}`}</span>
                      </span>
                      <Tooltip label={`Remove ${info.name.toLowerCase()} from all`}>
                        <button className="icon-btn" data-testid="multi-effect-remove" onClick={() => send(all(having, (p, id) => planRemoveEffect(p, id, module), (k) => `Remove ${info.name.toLowerCase()} from ${k} clips`))}>
                          <X />
                        </button>
                      </Tooltip>
                    </div>
                    {info.params.map((d) => (
                      <Prop key={d.key} label={d.name} testId={`multi-effect-${d.key}`}>
                        <Live project={project} value={round(params[d.key]!, d.step)} min={d.min} max={d.max} step={d.step} {...(d.unit ? { unit: d.unit } : {})} testId={`multi-effect-${d.key}-value`} disabled={false} plan={(p, v) => all(having, (q, id) => planEffect(q, id, module, { [d.key]: v }), (k) => `Set ${info.name.toLowerCase()} ${d.name.toLowerCase()} on ${k} clips`)(p)} />
                      </Prop>
                    ))}
                  </div>
                );
              })}
            </Section>
          )}
        </>
      )}
      {speed && (
        <Group label={`Speed (${n(speedItems, "1 item", "items")})`}>
          <div className="speed-row" role="group" aria-label="Speed" data-testid="multi-speed">
            {SPEED_PRESETS.map((s) => (
              <button key={s} className={`small-btn ${speed.same && Math.abs(s - speed.value) < 1e-6 ? "active" : ""}`} data-testid={`multi-speed-${s}`} onClick={() => send(all(speedItems, (p, id) => speedPlan(p, id, s), (k) => `Speed ${speedLabel(s)} on ${k} items`))}>
                {speedLabel(s)}
              </button>
            ))}
          </div>
          <div className="field-row">
            <NumberField label="×" testId="multi-speed-custom" value={speed.same ? Math.round(speed.value * 1000) / 1000 : undefined} placeholder="Mixed" step={0.05} min={SPEED_RANGE.min} max={SPEED_RANGE.max} onCommit={(v) => v !== undefined && send(all(speedItems, (p, id) => speedPlan(p, id, v), (k) => `Speed ${speedLabel(v)} on ${k} items`))} />
          </div>
        </Group>
      )}
      {gain && (
        <Group label={`Volume (${n(soundItems, "1 item", "items")})`}>
          <Prop label="dB" testId="multi-volume">
            <Live project={project} value={gain.value} min={SILENCE_DB} max={MAX_DB} step={0.5} unit="dB" testId="multi-volume-value" disabled={false} plan={(p, v) => all(soundItems, (q, id) => planGain(q, id, v), (k) => `Set volume of ${k} items to ${v} dB`)(p)} />
          </Prop>
        </Group>
      )}
      {opacity && (
        <Group label={`Opacity (${n(boxItems, "1 item", "items")})`}>
          <Prop label="%" testId="multi-opacity">
            <Live project={project} value={opacity.value} min={0} max={100} step={1} unit="%" testId="multi-opacity-value" disabled={false} plan={(p, v) => all(boxItems, (q, id) => planClipBox(q, id, { opacity: v / 100 }, getPlayback().frame), (k) => `Set opacity of ${k} items to ${v}%`)(p)} />
          </Prop>
        </Group>
      )}
    </div>
  );
}
