// The text Inspector's Animation tab (D81, laid out per D129): In and Out, each a move and its
// length, plus the move's own options (word by word's style, zoom's scale and ease). One edit per
// change, to every selected text.
import type { Item } from "@uncut/core/types";
import { WORD_STYLES, ZOOM_DEFAULTS } from "@uncut/core/looks";

import { type ProjectModel } from "../../state/project.ts";
import { MOVES, planAnimation, type AnimationSlot } from "../../preview/text.ts";
import { NumInput, Prop, Section, Segmented } from "../controls.tsx";
import { useTextEdit } from "./edit.ts";

const EASE_NAMES = [
  ["linear", "Linear"],
  ["out", "Ease out"],
  ["in", "Ease in"],
  ["inOut", "Ease in and out"],
] as const;

function Slot({ project, item, slot, disabled }: { project: ProjectModel; item: Item; slot: AnimationSlot; disabled: boolean }) {
  const edit = useTextEdit(project, item);
  const fps = project.canvas.fps;
  const current = item.animation?.[slot];
  const module = current?.module ?? "";
  const frames = current?.duration ?? Math.min(item.duration, Math.round(fps / 3));
  const params = current?.params ?? {};
  const set = (next: string, duration: number, nextParams: { readonly [key: string]: unknown } = next === module ? params : {}) =>
    edit.commit((p, id) => planAnimation(p, id, slot, next ? { module: next, duration, params: nextParams } : null));
  const setParam = (key: string, value: unknown) => set(module, frames, { ...params, [key]: value });
  return (
    <Section title={slot === "in" ? "In" : "Out"} testId={`insp-sec-anim-${slot}`}>
      <Prop label="Type">
        <select className="pselect" data-testid={`insp-anim-${slot}`} value={module} disabled={disabled} onChange={(e) => set(e.target.value, frames)}>
          {MOVES.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
          {module && !MOVES.some((m) => m.id === module) && <option value={module}>{module}</option>}
        </select>
      </Prop>
      <Prop label="Duration">
        <NumInput testId={`insp-anim-${slot}-dur`} unit="s" value={Number((frames / fps).toFixed(2))} step={0.1} min={0.04} max={Math.max(0.04, item.duration / fps)} disabled={disabled || !module} onCommit={(v) => v !== undefined && set(module, Math.round(v * fps))} />
      </Prop>
      {module === "move.word-by-word" && (
        <Prop label="Words">
          <Segmented testId={`insp-anim-${slot}-word-style`} attr="style" options={WORD_STYLES.map((w) => [w, w[0]!.toUpperCase() + w.slice(1)] as const)} value={(params.style as string | undefined) ?? "pop"} disabled={disabled} onChange={(w) => setParam("style", w)} />
        </Prop>
      )}
      {module === "move.zoom" && (
        <>
          <Prop label={slot === "in" ? "From" : "To"}>
            <NumInput testId={`insp-anim-${slot}-zoom-scale`} unit="%" value={Math.round((typeof params.scale === "number" ? params.scale : ZOOM_DEFAULTS.scale) * 100)} min={5} max={400} step={5} disabled={disabled} onCommit={(v) => v !== undefined && setParam("scale", v / 100)} />
          </Prop>
          <Prop label="Ease">
            <select className="pselect" data-testid={`insp-anim-${slot}-zoom-ease`} value={typeof params.ease === "string" ? params.ease : ZOOM_DEFAULTS.ease} disabled={disabled} onChange={(e) => setParam("ease", e.target.value)}>
              {EASE_NAMES.map(([v, label]) => (
                <option key={v} value={v}>
                  {label}
                </option>
              ))}
            </select>
          </Prop>
        </>
      )}
    </Section>
  );
}

export function TextAnimationTab({ project, item, disabled }: { project: ProjectModel; item: Item; disabled: boolean }) {
  return (
    <div className="pstack" data-testid="text-animation">
      <Slot project={project} item={item} slot="in" disabled={disabled} />
      <Slot project={project} item={item} slot="out" disabled={disabled} />
    </div>
  );
}
