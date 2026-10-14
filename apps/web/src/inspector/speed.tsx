// The Inspector's speed (G9, D125) and names (T7, G4): speed presets, a custom speed and keep
// pitch for clips and audio items; the item's own name and its media's display name.
import { SPEED_PRESETS, SPEED_RANGE, speedLabel } from "@uncut/core/arrange";
import type { Item } from "@uncut/core/types";
import { useEffect, useState } from "react";

import type { ProjectModel } from "../state/project.ts";
import { actions } from "../state/store.ts";
import { Group, NumberField } from "./fields.tsx";

/** Whether an item has a speed: a clip or audio item playing video or sound. */
export const hasSpeed = (project: ProjectModel, item: Item) => {
  if (item.type !== "clip" && item.type !== "audio") return false;
  const media = project.media.find((m) => m.id === item.media);
  return !!media && media.kind !== "image";
};

export function SpeedEditor({ item, locked }: { project: ProjectModel; item: Item; locked: boolean }) {
  const speed = item.speed ?? 1;
  return (
    <div data-testid="speed-editor">
      <div className="group">
        <div className="speed-row" role="group" aria-label="Speed">
          {SPEED_PRESETS.map((s) => (
            <button key={s} className={`small-btn ${Math.abs(s - speed) < 1e-6 ? "active" : ""}`} data-testid={`insp-speed-${s}`} aria-pressed={Math.abs(s - speed) < 1e-6} disabled={locked} onClick={() => void actions.setSpeed(item.id, s)}>
              {speedLabel(s)}
            </button>
          ))}
        </div>
        <div className="field-row">
          <NumberField label="×" testId="insp-speed-custom" value={Math.round(speed * 1000) / 1000} step={0.05} min={SPEED_RANGE.min} max={SPEED_RANGE.max} disabled={locked} onCommit={(v) => v !== undefined && void actions.setSpeed(item.id, v)} />
        </div>
        <label className="check-row">
          <input type="checkbox" data-testid="insp-keep-pitch" checked={item.keepPitch !== false} disabled={locked} onChange={(e) => void actions.setSpeed(item.id, speed, e.target.checked)} />
          Keep pitch
        </label>
      </div>
    </div>
  );
}

/** A name field: committed on Enter or blur, Esc puts the saved one back. */
function NameField({ value, placeholder, testId, disabled, onCommit, label }: { value: string; placeholder?: string; testId: string; disabled: boolean; onCommit: (name: string) => void; label: string }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const commit = () => {
    if (text.trim() !== value.trim()) onCommit(text);
  };
  return (
    <label className="field num-field">
      <span className="k">{label}</span>
      <input
        className="v"
        data-testid={testId}
        type="text"
        spellCheck={false}
        value={text}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") (setText(value), e.currentTarget.blur());
        }}
      />
    </label>
  );
}

export function NamesEditor({ project, item, locked }: { project: ProjectModel; item: Item; locked: boolean }) {
  const media = item.media ? project.media.find((m) => m.id === item.media) : undefined;
  return (
    <Group label="Name">
      {item.type !== "captions" && <NameField label="Item" testId="insp-name" value={item.name ?? ""} placeholder={media?.name ?? ""} disabled={locked} onCommit={(name) => void actions.renameItem(item.id, name)} />}
      {media && <NameField label="Media" testId="insp-media-name" value={media.name} disabled={false} onCommit={(name) => void actions.renameMedia(media.id, name)} />}
    </Group>
  );
}
