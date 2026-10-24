import { SlidersHorizontal } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { MAX_DB, SILENCE_DB } from "@uncut/core/audio";

import { dbLabel, planTrackGain } from "../audio/sound.ts";
import { NumberField, Slider } from "../inspector/fields.tsx";
import { getPlayback, playback, type PreviewDraft } from "../preview/playback.ts";
import type { ProjectModel, Track } from "../state/project.ts";
import { actions, getState, projectOf } from "../state/store.ts";
import { draftOf } from "./edit.ts";
import { Tooltip } from "../ui/Tooltip.tsx";

/**
 * A track's volume (D54): a button in its header opens a slider (−∞…+12 dB) and a number. The
 * slider is heard while it moves (a local draft the playback mix plays) and saved on release as
 * one edit; the mixer's mute and the rest stay as they are.
 */
export function TrackVolume({ project, track, online }: { project: ProjectModel; track: Track; online: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const db = track.mixer?.gainDb ?? 0;
  const draft = useRef<PreviewDraft | undefined>(undefined);
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [open]);
  const drop = () => {
    const d = draft.current;
    draft.current = undefined;
    return d;
  };
  const send = (v: number) => {
    const d = drop();
    const snapshot = getState().snapshot;
    void actions.timelineEdit(planTrackGain(projectOf(snapshot!), track.id, v), { baseRevision: snapshot?.revision, dir: snapshot?.dir }).finally(() => {
      if (d && getPlayback().draft === d) playback.setDraft(undefined);
    });
  };
  return (
    <div className="track-volume" ref={ref}>
      <Tooltip label={`Track volume: ${dbLabel(db)} dB`}>
        <button
          className={`icon-btn ${db !== 0 ? "on-soft" : ""}`}
          data-testid="track-volume"
          aria-expanded={open}
          disabled={!online}

          onClick={() => setOpen(!open)}
        >
          <SlidersHorizontal />
        </button>
      </Tooltip>
      {open && (
        <div className="track-volume-pop" data-testid="track-volume-pop">
          <div className="group-label">{track.name} volume</div>
          <div className="slider-row">
            <Slider
              testId="track-volume-slider"
              value={db}
              min={SILENCE_DB}
              max={MAX_DB}
              step={0.5}
              disabled={!online}
              onPreview={(v) => {
                const plan = planTrackGain(project, track.id, v);
                const result = "ops" in plan ? draftOf(project, plan.ops) : undefined;
                if (result && "project" in result) {
                  draft.current = { base: project, project: result.project };
                  playback.setDraft(draft.current);
                }
              }}
              onCommit={send}
            />
            <NumberField
              label="dB"
              testId="track-volume-num"
              value={db}
              step={0.5}
              min={SILENCE_DB}
              max={MAX_DB}
              disabled={!online}
              onCommit={(v) => send(v ?? 0)}
            />
          </div>
          <div className="hint-line muted small">{db <= SILENCE_DB ? "Silent" : `${dbLabel(db)} dB on every item of the track`}</div>
        </div>
      )}
    </div>
  );
}
