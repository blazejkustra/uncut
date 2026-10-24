import { useRef } from "react";
import { SILENCE_DB } from "@uncut/core/audio";
import { trackFlag, planTrackFlag } from "../../timeline/edit.ts";
import type { PreviewDraft } from "../../preview/playback.ts";
import { planTrackPan, planTrackGain, dbLabel, planMasterGain, MASTER_EXPORT_NOTE } from "../sound.ts";
import type { ProjectModel, Track } from "../../state/project.ts";
import { actions } from "../../state/store.ts";
import { EffectSlots, DuckRow, MasterControls } from "./effects.tsx";
import { PanSlider, preview, commit, Meter, Fader } from "./controls.tsx";

export function Strip({ project, track, online }: { project: ProjectModel; track: Track; online: boolean }) {
  const muted = trackFlag(track, "mute");
  const solo = trackFlag(track, "solo");
  const draft = useRef<PreviewDraft | undefined>(undefined);
  const take = () => {
    const d = draft.current;
    draft.current = undefined;
    return d;
  };
  const db = track.mixer?.gainDb ?? 0;
  const pan = track.mixer?.pan ?? 0;
  return (
    <div className={`strip-ch ${muted ? "muted" : ""} ${solo ? "soloed" : ""}`} data-testid="mixer-strip" data-track={track.id}>
      <div className="strip-name ellipsis" title={track.name}>
        {track.name}
      </div>
      <EffectSlots project={project} track={track} online={online} />
      <DuckRow project={project} track={track} online={online} />
      <PanSlider
        name={track.name}
        value={pan}
        disabled={!online}
        onPreview={(p) => (draft.current = preview(project, planTrackPan(project, track.id, p)) ?? draft.current)}
        onCommit={(p) => commit((now) => planTrackPan(now, track.id, p), take())}
      />
      <div className="strip-body">
        <Meter id={track.id} />
        <Fader
          testId="mixer-fader"
          label={`${track.name} volume`}
          value={db}
          disabled={!online}
          onPreview={(v) => (draft.current = preview(project, planTrackGain(project, track.id, v)) ?? draft.current)}
          onCommit={(v) => commit((now) => planTrackGain(now, track.id, v), take())}
        />
      </div>
      <div className="strip-foot">
        <span className="strip-db mono" data-testid="mixer-db">
          {dbLabel(db)}
        </span>
        <button
          className={`ms-btn ${muted ? "on mute" : ""}`}
          data-testid="mixer-mute"
          aria-pressed={muted}
          disabled={!online}
          title={muted ? "Unmute" : "Mute"}
          onClick={() => void actions.toggleTrack(track.id, "mute")}
        >
          M
        </button>
        <button
          className={`ms-btn ${solo ? "on solo" : ""}`}
          data-testid="mixer-solo"
          aria-pressed={solo}
          disabled={!online}
          title={solo ? "Unsolo" : "Solo: only soloed tracks play, in the preview and the export"}
          onClick={() => commit((now) => planTrackFlag(now, track.id, "solo"))}
        >
          S
        </button>
      </div>
    </div>
  );
}

export function MasterStrip({ project, online }: { project: ProjectModel; online: boolean }) {
  const draft = useRef<PreviewDraft | undefined>(undefined);
  const db = project.master?.gainDb ?? 0;
  return (
    <div className="strip-ch master" data-testid="mixer-master">
      <div className="strip-name">Master</div>
      <MasterControls project={project} online={online} />
      <div className="pan-row" />
      <div className="strip-body">
        <Meter id="master" />
        <Fader
          testId="mixer-master-fader"
          label="Master volume"
          value={db}
          disabled={!online}
          onPreview={(v) => (draft.current = preview(project, planMasterGain(project, v)) ?? draft.current)}
          onCommit={(v) => {
            const d = draft.current;
            draft.current = undefined;
            commit((now) => planMasterGain(now, v), d);
          }}
        />
      </div>
      <div className="strip-foot">
        <span className="strip-db mono" data-testid="mixer-master-db">
          {dbLabel(db)}
        </span>
      </div>
      {db !== 0 && (
        <div className="master-note small" data-testid="mixer-master-note" title={MASTER_EXPORT_NOTE}>
          {db <= SILENCE_DB ? "Silent: the export too" : "Export: As mixed"}
        </div>
      )}
    </div>
  );
}
