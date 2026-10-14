// The Inspector's background editor: its colours.
import type { Item } from "@uncut/core/types";
import { useRef } from "react";

import { playback, type PreviewDraft } from "../preview/playback.ts";
import { type ProjectModel } from "../state/project.ts";
import { planBackground } from "../preview/text.ts";
import { showDraft, send, NumberField, ColorPicker, useSettle, Group } from "./fields.tsx";

export function BackgroundEditor({ project, item, locked }: { project: ProjectModel; item: Item; locked: boolean }) {
  const props = (item.props ?? {}) as { color?: string; to?: string; angle?: number };
  const settle = useSettle(400);
  const drafts = useRef<PreviewDraft | undefined>(undefined);
  const pick = (patch: { color?: string; to?: string }, final: boolean) => {
    if (final) return send((p) => planBackground(p, item.id, patch));
    drafts.current = showDraft(project, planBackground(project, item.id, patch)) ?? drafts.current;
    settle(() => {
      const d = drafts.current;
      drafts.current = undefined;
      send((p) => planBackground(p, item.id, patch), d);
    });
  };
  const gradient = props.to !== undefined;
  return (
    <div data-testid="background-editor">
      <Group label={gradient ? "From" : "Colour"}>
        <ColorPicker project={project} testId="bg-color" value={props.color} disabled={locked} onPick={(color, final) => pick({ color }, final)} />
      </Group>
      <Group label="Gradient">
        <label className="check-row">
          <input
            type="checkbox"
            data-testid="bg-gradient"
            checked={gradient}
            disabled={locked}
            onChange={(e) => {
              // Read now: the plan runs later, when React has put the controlled box back.
              const patch = e.target.checked ? { to: "#3B1E54", angle: 160 } : { to: null };
              send((p) => planBackground(p, item.id, patch));
            }}
          />
          Fade to a second colour
        </label>
        {gradient && (
          <>
            <ColorPicker project={project} testId="bg-to" value={props.to} disabled={locked} onPick={(to, final) => pick({ to }, final)} />
            <div className="field-row">
              <NumberField label="Angle °" testId="bg-angle" value={props.angle ?? 180} disabled={locked} onCommit={(v) => v !== undefined && send((p) => planBackground(p, item.id, { angle: v }))} />
            </div>
          </>
        )}
      </Group>
    </div>
  );
}

/**
 * The sound of a clip or audio item (D54): volume in dB (a slider from −∞ to +12 and a number) and
 * fade in / fade out in seconds. The slider is heard while it moves (the playback mix plays the
 * local draft) and saved once on release; each change is one edit.
 */
