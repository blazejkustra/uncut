// The Inspector's sound editor (D83): volume, fades, beats.
import { MAX_DB, SILENCE_DB, soundMedia } from "@uncut/core/audio";
import type { Item } from "@uncut/core/types";
import { Activity, MoveHorizontal, X } from "lucide-react";
import { useRef } from "react";

import { type PreviewDraft } from "../preview/playback.ts";
import { type ProjectModel } from "../state/project.ts";
import { useBeats } from "../audio/beats.ts";
import { analysisText } from "../state/analysisText.ts";
import { actions, activeAnalyses, useApp } from "../state/store.ts";
import { dbLabel, planFade, planGain } from "../audio/sound.ts";
import { showDraft, send, NumberField, Slider, Group } from "./fields.tsx";
import { Tooltip } from "../ui/Tooltip.tsx";

export function AudioEditor({ project, item, locked }: { project: ProjectModel; item: Item; locked: boolean }) {
  const fps = project.canvas.fps;
  const db = item.gainDb ?? 0;
  const gainDraft = useRef<PreviewDraft | undefined>(undefined);
  const secs = (frames: number | undefined) => Number(((frames ?? 0) / fps).toFixed(2));
  return (
    <div data-testid="audio-editor">
      <Group label="Volume">
        <div className="slider-row">
          <Slider
            testId="insp-volume"
            value={db}
            min={SILENCE_DB}
            max={MAX_DB}
            step={0.5}
            title={`${dbLabel(db)} dB`}
            disabled={locked}
            onPreview={(v) => (gainDraft.current = showDraft(project, planGain(project, item.id, v)) ?? gainDraft.current)}
            onCommit={(v) => {
              const d = gainDraft.current;
              gainDraft.current = undefined;
              send((p) => planGain(p, item.id, v), d);
            }}
          />
          <NumberField label="dB" testId="insp-volume-num" value={db} step={0.5} min={SILENCE_DB} max={MAX_DB} disabled={locked} onCommit={(v) => send((p) => planGain(p, item.id, v ?? 0))} />
        </div>
        <div className="hint-line muted small" data-testid="insp-volume-label">
          {db <= SILENCE_DB ? "Silent (−∞ dB)" : db === 0 ? "As recorded (0 dB)" : `${dbLabel(db)} dB`}
        </div>
      </Group>
      <Group label="Fades">
        <div className="field-row">
          <NumberField label="In s" testId="insp-fade-in" value={secs(item.fadeIn)} step={0.1} min={0} disabled={locked} onCommit={(v) => send((p) => planFade(p, item.id, "in", Math.round((v ?? 0) * fps)))} />
          <NumberField label="Out s" testId="insp-fade-out" value={secs(item.fadeOut)} step={0.1} min={0} disabled={locked} onCommit={(v) => send((p) => planFade(p, item.id, "out", Math.round((v ?? 0) * fps)))} />
        </div>
      </Group>
      {item.type === "audio" && (
        <div className="group">
          <button className="btn" data-testid="insp-fit-to-video" disabled={locked} title="Trim or loop to the end of the video, with a fade out" onClick={() => void actions.fitToVideo(item.id)}>
            <MoveHorizontal />
            Fit to video
          </button>
        </div>
      )}
      {item.type === "clip" && (
        <div className="group">
          <button className="btn" data-testid="insp-detach-audio" disabled={locked} onClick={() => void actions.detachAudio(item.id)}>
            Detach audio
          </button>
        </div>
      )}
      <BeatsGroup project={project} item={item} />
    </div>
  );
}

/**
 * The beats of the item's sound (D70): Find beats runs the analysis job (on demand, D66) with its
 * progress and a stop button; once cached, the tempo and the beat count. The timeline draws the
 * beats as ticks and snaps to them.
 */
function BeatsGroup({ project, item }: { project: ProjectModel; item: Item }) {
  const app = useApp();
  const media = soundMedia(project, item);
  const entry = useBeats((s) => (media ? s.entries.get(media.id) : undefined));
  if (!media) return null;
  const online = app.connection === "connected";
  const job = activeAnalyses(app, media.id).find((j) => j.analyzer === "beats");
  return (
    <Group label="Beats">
      <div data-testid="insp-beats" data-state={job ? job.phase : entry === undefined ? "loading" : entry === null || entry === "failed" ? "none" : entry.bpm === null ? "no-beat" : "done"}>
        {job ? (
          <div className="beats-progress" title={analysisText(job)}>
            <Activity />
            <div className="bar">
              <span style={{ width: `${Math.round((job.phase === "running" ? job.progress : 0) * 100)}%` }} />
            </div>
            <Tooltip label="Stop finding the beats">
              <button className="icon-btn" data-testid="insp-beats-cancel" disabled={!online} onClick={() => void actions.cancelAnalysis(job.id)}>
                <X />
              </button>
            </Tooltip>
          </div>
        ) : entry === null || entry === undefined || entry === "failed" ? (
          <button className="btn" data-testid="insp-find-beats" disabled={!online || entry === undefined} onClick={() => void actions.analyzeBeats(media.id)}>
            <Activity />
            Find beats
          </button>
        ) : entry.bpm === null ? (
          <div className="small" data-testid="insp-beats-summary">No steady beat found</div>
        ) : (
          <div className="small" data-testid="insp-beats-summary">
            {Math.round(entry.bpm)} BPM, {entry.beats.length} beats
          </div>
        )}
      </div>
    </Group>
  );
}

/**
 * A selected cut on the main track (D73): its transition's type (or none: a hard cut), length in
 * seconds and frames (the module's limits and the cut's: half the shorter clip, the footage past
 * the cut), and Remove (⌫ too). Each change is one edit through planSetTransition.
 */
