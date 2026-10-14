// F30 (D174): Settings › App › New items: the transition length (the Transitions panel's Length
// chips, one setting), a photo's length and a text's length, remembered on this Mac.
import { NumberField } from "../inspector/fields.tsx";
import { setTransitionSeconds, TRANSITION_LENGTHS, useTransitionSeconds } from "../timeline/transitionLength.ts";
import { DEFAULT_RANGE, setDefaultSeconds, useDefaultSeconds } from "./defaults.ts";

export function DefaultLengths() {
  const transition = useTransitionSeconds();
  const still = useDefaultSeconds("still");
  const text = useDefaultSeconds("text");
  return (
    <div className="group" data-testid="settings-defaults">
      <div className="group-label">New items</div>
      <div className="kv-row">
        <span className="muted">Transition length</span>
        <select data-testid="settings-transition-length" value={transition ?? ""} onChange={(e) => setTransitionSeconds(e.target.value === "" ? undefined : Number(e.target.value))}>
          {TRANSITION_LENGTHS.map((s) => (
            <option key={String(s)} value={s ?? ""}>
              {s === undefined ? "Each transition's own" : `${s} s`}
            </option>
          ))}
        </select>
      </div>
      <div className="kv-row">
        <span className="muted">Photo length</span>
        <NumberField label="s" testId="settings-still-seconds" value={still} step={0.5} min={DEFAULT_RANGE.min} max={DEFAULT_RANGE.max} onCommit={(v) => setDefaultSeconds("still", v)} />
      </div>
      <div className="kv-row">
        <span className="muted">Text length</span>
        <NumberField label="s" testId="settings-text-seconds" value={text} step={0.5} min={DEFAULT_RANGE.min} max={DEFAULT_RANGE.max} onCommit={(v) => setDefaultSeconds("text", v)} />
      </div>
    </div>
  );
}
