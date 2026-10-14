// The Inspector for a selected cut's transition (D73).
import { transitionInfo, transitionLimits, transitionName, TRANSITIONS } from "@uncut/core/transitions";
import { Blend, X } from "lucide-react";

import { findItem } from "../timeline/edit.ts";
import { itemLabel, type ProjectModel } from "../state/project.ts";
import { actions } from "../state/store.ts";
import { NumberField, Group } from "./fields.tsx";

export function TransitionInspector({ project, placed, online }: { project: ProjectModel; placed: NonNullable<ReturnType<typeof findItem>>; online: boolean }) {
  const fps = project.canvas.fps;
  const { item, index, track } = placed;
  const prev = track.items[index - 1]!;
  const tr = item.transitionIn;
  const locked = !online || track.locked === true || item.locked === true || prev.locked === true;
  const limits = tr ? transitionLimits(project, item.id, tr.module) : undefined;
  const range = limits && !("problem" in limits) ? limits : undefined;
  const set = (next: { module: string; duration?: number } | null) => void actions.setTransition(item.id, next);
  const secs = (frames: number) => Number((frames / fps).toFixed(2));
  return (
    <div data-testid="inspector-transition" data-item={item.id}>
      <div className="insp-title">
        <Blend />
        <span className="ellipsis">{tr ? transitionName(tr.module) : "Cut"}</span>
      </div>
      <div className="insp-sub">
        Between {itemLabel(project, prev)} and {itemLabel(project, item)} on {track.name}.{" "}
        {tr ? "Drag the marker's edges on the timeline to change its length; ⌫ removes it." : "A hard cut. Pick a transition here or click one in the Transitions panel."}
      </div>
      <Group label="Transition">
        <select className="field input" data-testid="insp-transition-type" value={tr?.module ?? ""} disabled={locked} onChange={(e) => set(e.target.value ? { module: e.target.value } : null)}>
          <option value="">None (cut)</option>
          {TRANSITIONS.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
          {tr && !transitionInfo(tr.module) && <option value={tr.module}>{transitionName(tr.module)} (draws as a crossfade)</option>}
        </select>
        {tr && transitionInfo(tr.module) && <div className="hint-line muted small">{transitionInfo(tr.module)!.description}</div>}
      </Group>
      {tr && (
        <Group label="Duration">
          <div className="field-row">
            <NumberField
              label="s"
              testId="insp-transition-seconds"
              value={secs(tr.duration)}
              step={Number((1 / fps).toFixed(3))}
              min={0}
              disabled={locked}
              onCommit={(v) => v !== undefined && set({ module: tr.module, duration: Math.round(v * fps) })}
            />
            <NumberField label="frames" testId="insp-transition-frames" value={tr.duration} step={1} min={1} disabled={locked} onCommit={(v) => v !== undefined && set({ module: tr.module, duration: Math.round(v) })} />
          </div>
          <div className="hint-line muted small" data-testid="insp-transition-range">
            {range ? `${secs(range.min)}–${secs(range.max)} s (${range.min}–${range.max} frames) fit at this cut` : limits && "problem" in limits ? limits.problem : ""}
          </div>
        </Group>
      )}
      {tr && (
        <div className="group">
          <button className="btn" data-testid="insp-transition-remove" disabled={locked} onClick={() => set(null)}>
            <X />
            Remove transition
          </button>
        </div>
      )}
    </div>
  );
}
