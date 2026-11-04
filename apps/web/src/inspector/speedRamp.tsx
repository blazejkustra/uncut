// D327: the Inspector's speed ramp and reverse for video clips: ramp presets, the ramp's keys as
// rows (time, speed, ease; a key added at the playhead), and Play backwards.
import { presetOf, RAMP_EASES, RAMP_PRESETS, RAMP_SPEED, rampProblem, reverseProblem, speedAt, type RampEase, type SpeedKey } from "@uncut/core/speedRamp";
import type { Item } from "@uncut/core/types";
import { Trash2 } from "lucide-react";

import { usePlayback } from "../preview/playback.ts";
import { layoutOf, type ProjectModel } from "../state/project.ts";
import { actions } from "../state/store.ts";
import { NumberField } from "./fields.tsx";

const EASE_NAMES: Readonly<Record<RampEase, string>> = { linear: "Linear", in: "Ease in", out: "Ease out", inOut: "Ease in-out" };

const round = (n: number, step: number) => Math.round(n / step) * step;

/** The keys with one changed (a new speed or ease), or one more, in frame order. */
const withKey = (keys: ReadonlyArray<SpeedKey>, key: SpeedKey) => [...keys.filter((k) => k.frame !== key.frame), key].sort((a, b) => a.frame - b.frame);

export function SpeedRampEditor({ project, item, locked }: { project: ProjectModel; item: Item; locked: boolean }) {
  const frame = usePlayback((s) => s.frame);
  const fps = project.canvas.fps;
  const keys = item.speedKeys ?? [];
  const preset = presetOf(keys, item.duration);
  const blocked = rampProblem(project, item);
  const local = frame - (layoutOf(project).starts.get(item.id) ?? 0);
  const inside = local >= 0 && local < item.duration && !keys.some((k) => k.frame === local);
  const setKeys = (next: ReadonlyArray<SpeedKey>) => void actions.setSpeedRamp(item.id, next.length ? next : null);
  const reverse = reverseProblem(project, item);
  return (
    <div className="group" data-testid="speed-ramp-editor">
      <div className="speed-row" role="group" aria-label="Speed ramp">
        <button
          className={`small-btn ${keys.length ? "" : "active"}`}
          data-testid="insp-ramp-none"
          aria-pressed={!keys.length}
          disabled={locked || !keys.length}
          onClick={() => void actions.setSpeedRamp(item.id, null)}
        >
          No ramp
        </button>
        {Object.entries(RAMP_PRESETS).map(([name, p]) => (
          <button
            key={name}
            className={`small-btn ${preset === name ? "active" : ""}`}
            data-testid={`insp-ramp-${name}`}
            aria-pressed={preset === name}
            disabled={locked || !!blocked}
            title={blocked}
            onClick={() => void actions.setSpeedRamp(item.id, name)}
          >
            {p.label}
          </button>
        ))}
      </div>
      {keys.map((k, i) => (
        <div className="field-row ramp-key" key={`${k.frame}-${i}`} data-testid="insp-ramp-key">
          <span className="hint-line">{(k.frame / fps).toFixed(2)} s</span>
          <NumberField
            label="×"
            testId={`insp-ramp-speed-${i}`}
            value={k.speed}
            step={0.05}
            min={RAMP_SPEED.min}
            max={RAMP_SPEED.max}
            disabled={locked}
            onCommit={(v) => v !== undefined && setKeys(withKey(keys, { ...k, speed: v }))}
          />
          <select
            className="field input"
            data-testid={`insp-ramp-ease-${i}`}
            value={k.ease ?? "linear"}
            disabled={locked}
            onChange={(e) => setKeys(withKey(keys, { ...k, ease: e.target.value as RampEase }))}
          >
            {RAMP_EASES.map((e) => (
              <option key={e} value={e}>
                {EASE_NAMES[e]}
              </option>
            ))}
          </select>
          <button
            className="small-btn"
            data-testid={`insp-ramp-remove-${i}`}
            aria-label="Remove this key"
            disabled={locked}
            onClick={() => setKeys(keys.filter((x) => x !== k))}
          >
            <Trash2 />
          </button>
        </div>
      ))}
      <div className="speed-row">
        <button
          className="small-btn"
          data-testid="insp-ramp-add"
          disabled={locked || !!blocked || !inside}
          title={blocked ?? (inside ? undefined : "Move the playhead over the clip to add a key")}
          onClick={() => setKeys(withKey(keys, { frame: local, speed: round(speedAt(item, local), 0.05) }))}
        >
          Add a speed key at the playhead
        </button>
      </div>
      {keys.length > 0 && <p className="hint-line">A ramped clip plays without its sound.</p>}
      <label className="check-row" title={reverse && !item.reverse ? reverse : undefined}>
        <input
          type="checkbox"
          data-testid="insp-reverse"
          checked={item.reverse === true}
          disabled={locked || (!!reverse && !item.reverse)}
          onChange={(e) => void actions.setReverse(item.id, e.target.checked)}
        />
        Play backwards
      </label>
    </div>
  );
}
