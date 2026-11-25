// A track's head on the left of the timeline (split out of Timeline.tsx): its code (V1, A1, D346)
// and name (double-click renames it in place), volume, mute, hide and lock; right-click opens the
// track menu (T7). Its bottom edge drags the lane taller or shorter, as does ⌥ + wheel over it.
import { Eye, EyeOff, Lock, LockOpen, Volume2, VolumeX } from "lucide-react";
import React, { useEffect, useRef } from "react";

import { soundTrack } from "../audio/sound.ts";
import { isDefaultTrackName, type ProjectModel, type Track } from "../state/project.ts";
import { actions } from "../state/store.ts";
import { trackFlag } from "./edit.ts";
import { laneHeight, setLaneHeight } from "./laneHeights.ts";
import { RenameField } from "./RenameField.tsx";
import { TrackVolume } from "./TrackVolume.tsx";

/** Drag a head's bottom edge: the lane follows the pointer from the height it had. */
function dragLaneEdge(e: React.PointerEvent, dir: string | undefined, track: Track) {
  e.preventDefault();
  e.stopPropagation();
  const y0 = e.clientY;
  const from = laneHeight(dir, track);
  const move = (ev: PointerEvent) => setLaneHeight(dir, track.id, from + ev.clientY - y0);
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

/** ⌥ + wheel over a head: up makes the lane taller, down shorter. */
function useLaneWheel(ref: React.RefObject<HTMLDivElement | null>, dir: string | undefined, track: Track) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.altKey) return;
      e.preventDefault();
      const px = e.deltaMode === 0 ? e.deltaY : e.deltaY * 16;
      setLaneHeight(dir, track.id, laneHeight(dir, track) - Math.max(-100, Math.min(100, px)) * 0.2);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [ref, dir, track]);
}

export function TrackHead({
  project,
  track,
  code,
  dir,
  online,
  renaming,
  onRenamed,
  onMenu,
  onRename,
  height,
}: {
  project: ProjectModel;
  track: Track;
  code: string;
  dir: string | undefined;
  online: boolean;
  renaming: boolean;
  onRenamed: () => void;
  onMenu: (e: React.MouseEvent) => void;
  onRename: () => void;
  /** The lane's height, a graphic's element rows included (D316). */
  height: number;
}) {
  const main = track.role === "main";
  const ref = useRef<HTMLDivElement>(null);
  useLaneWheel(ref, dir, track);
  const audio = track.kind === "audio";
  const hidden = trackFlag(track, "hidden");
  const muted = trackFlag(track, "mute");
  const locked = trackFlag(track, "locked");
  return (
    <div
      ref={ref}
      className={`tl-head ${main ? "main" : ""}`}
      data-testid="track"
      data-id={track.id}
      data-code={code}
      data-name={track.name}
      data-kind={track.kind}
      data-main={main ? "true" : undefined}
      data-hidden={hidden ? "true" : undefined}
      data-muted={muted ? "true" : undefined}
      data-locked={locked ? "true" : undefined}
      style={{ height }}
      onContextMenu={onMenu}
    >
      <div
        className="name"
        title={main ? `${code}, the main track: transitions go between its clips` : track.name}
        onDoubleClick={() => online && !locked && onRename()}
      >
        <span className="code" data-testid="track-code">
          {code}
        </span>
        {renaming ? (
          <RenameField
            testId="track-rename"
            value={track.name}
            onDone={(name) => (name !== undefined && name !== track.name && void actions.renameTrack(track.id, name), onRenamed())}
          />
        ) : (
          !isDefaultTrackName(track.name) && (
            <span className="ellipsis" data-testid="track-name">
              {track.name}
            </span>
          )
        )}
      </div>
      {(audio || soundTrack(project, track)) && <TrackVolume project={project} track={track} online={online} />}
      {(audio || soundTrack(project, track)) && (
        <button
          className={`icon-btn ${muted ? "on" : ""}`}
          data-testid="track-mute"
          aria-pressed={muted}
          disabled={!online}
          title={muted ? "Unmute" : audio ? "Mute" : "Mute the clips' sound"}
          onClick={() => void actions.toggleTrack(track.id, "mute")}
        >
          {muted ? <VolumeX /> : <Volume2 />}
        </button>
      )}
      {!audio && (
        <button
          className={`icon-btn ${hidden ? "on" : ""}`}
          data-testid="track-hide"
          aria-pressed={hidden}
          disabled={!online}
          title={hidden ? "Show in the preview" : "Hide from the preview"}
          onClick={() => void actions.toggleTrack(track.id, "hidden")}
        >
          {hidden ? <EyeOff /> : <Eye />}
        </button>
      )}
      <button
        className={`icon-btn ${locked ? "on" : ""}`}
        data-testid="track-lock"
        aria-pressed={locked}
        disabled={!online}
        title={locked ? "Unlock" : "Lock: no edits by hand or by the agent"}
        onClick={() => void actions.toggleTrack(track.id, "locked")}
      >
        {locked ? <Lock /> : <LockOpen />}
      </button>
      <div className="tl-resize" data-testid="track-resize" title="Drag to resize the track" onPointerDown={(e) => dragLaneEdge(e, dir, track)} />
    </div>
  );
}
