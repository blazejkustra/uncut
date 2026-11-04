import { useEffect } from "react";

import { getPlayback, playback, usePlayback, type TrackPick } from "../playback.ts";
import { visionNote } from "../vision.ts";
import { clipState } from "../../timeline/clip.ts";
import { actions, useAppSelect } from "../../state/store.ts";
import type { ProjectModel } from "../../state/project.ts";
import { useBoxDrag } from "./Region.tsx";

export function TrackSelect({ project, pick }: { project: ProjectModel; pick: TrackPick }) {
  const { drawing, handlers } = useBoxDrag(
    project.canvas,
    () => {},
    (_screen, box) => {
      playback.pickTrack(undefined);
      void actions.track({ itemId: pick.item, targetId: pick.target, frame: Math.floor(getPlayback().frame), box, ...(pick.scale ? { scale: true } : {}) });
    },
  );
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      playback.pickTrack(undefined);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
  return (
    <div className="pv-region-catch" data-testid="track-catch" {...handlers}>
      <div className="pv-track-hint">Draw a box round the object to follow</div>
      {drawing && <div className="pv-region drawing" data-testid="track-rect" style={{ left: drawing.x, top: drawing.y, width: drawing.w, height: drawing.h }} />}
    </div>
  );
}

export function TrackProgress({ project }: { project: ProjectModel }) {
  const proxies = useAppSelect((s) => s.proxies);
  const frame = usePlayback((s) => Math.round(s.frame));
  const running = proxies.filter((p) => p.vision?.output === "track" && p.vision.target);
  return (
    <>
      {running.map((state) => {
        const clip = clipState(project, state.vision!.target!, frame);
        if (!clip?.inside) return null;
        const { x, y, w, h } = clip.box;
        return (
          <div key={state.vision!.item} data-testid="track-progress" data-item={state.vision!.item} style={{ position: "absolute", left: x, top: y, width: w, height: h, pointerEvents: "none" }}>
            <div className="pv-vision-note">{visionNote(state, "track")}</div>
          </div>
        );
      })}
    </>
  );
}
