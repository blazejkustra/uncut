// A track's head on the left of the timeline (split out of Timeline.tsx): its name (double-click
// renames it in place), the main track's magnet, volume, mute, hide and lock; right-click opens
// the track menu (T7).
import { AudioLines, Eye, EyeOff, Film, Layers, Lock, LockOpen, Magnet, Type, Volume2, VolumeX } from "lucide-react";
import React from "react";

import { soundTrack } from "../audio/sound.ts";
import type { ProjectModel, Track } from "../state/project.ts";
import { actions } from "../state/store.ts";
import { trackFlag } from "./edit.ts";
import { RenameField } from "./RenameField.tsx";
import { TrackVolume } from "./TrackVolume.tsx";

export function TrackHead({
  project,
  track,
  online,
  renaming,
  onRenamed,
  onMenu,
  onRename,
  height,
}: {
  project: ProjectModel;
  track: Track;
  online: boolean;
  renaming: boolean;
  onRenamed: () => void;
  onMenu: (e: React.MouseEvent) => void;
  onRename: () => void;
  /** D316: the lane's height when a graphic's elements make it taller. */
  height?: number | undefined;
}) {
  const main = track.role === "main";
  const Icon = track.kind === "text" ? Type : track.kind === "audio" ? AudioLines : main ? Film : Layers;
  const audio = track.kind === "audio";
  const hidden = trackFlag(track, "hidden");
  const muted = trackFlag(track, "mute");
  const locked = trackFlag(track, "locked");
  return (
    <div
      className={`tl-head ${main ? "main" : ""}`}
      data-testid="track"
      data-id={track.id}
      data-kind={track.kind}
      data-main={main ? "true" : undefined}
      data-hidden={hidden ? "true" : undefined}
      data-muted={muted ? "true" : undefined}
      data-locked={locked ? "true" : undefined}
      style={height ? { height } : undefined}
      onContextMenu={onMenu}
    >
      <div className="name" onDoubleClick={() => online && !locked && onRename()}>
        <Icon />
        {renaming ? (
          <RenameField
            testId="track-rename"
            value={track.name}
            onDone={(name) => (name !== undefined && name !== track.name && void actions.renameTrack(track.id, name), onRenamed())}
          />
        ) : (
          <span className="ellipsis" data-testid="track-name">
            {track.name}
          </span>
        )}
        {main && (
          <span className="badge" title="Main track: clips play back to back">
            <Magnet />
          </span>
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
    </div>
  );
}
