// The bar under the preview: timecode, the transport buttons, the canvas, the preview's zoom and
// hand (G6) and the full-window preview (G7b). Split out of Preview.tsx.
// Issue #62 (D233): the bar is always 40px tall and never clips. As the preview gets narrow the
// less important parts go first (styles.css, @container stage): the canvas label, the end time,
// the jumps to start and end, the zoom and the frame steps, then the hand and the time itself.
import { Hand, Maximize, Minimize, Pause, Play, SkipBack, SkipForward, StepBack, StepForward } from "lucide-react";

import { canvasLabel, frameTimecode } from "../state/format.ts";
import { layoutOf, type ProjectModel } from "../state/project.ts";
import { playback, usePlayback } from "./playback.ts";
import { ZOOM_STEPS, type useViewport } from "./viewport.ts";

export function Transport({ project, view, full, onFull }: { project: ProjectModel; view: ReturnType<typeof useViewport>; full: boolean; onFull: () => void }) {
  const fps = project.canvas.fps;
  const frame = usePlayback((s) => Math.floor(s.frame));
  const playing = usePlayback((s) => s.playing);
  const { end, frames } = layoutOf(project);
  const custom = view.zoom !== "fit" && !ZOOM_STEPS.includes(view.zoom);
  return (
    <div className="transport">
      <span className="timecode" data-testid="timecode">
        {frameTimecode(frame, fps)}
        <span className="tc-end"> / {frameTimecode(end, fps)}</span>
      </span>
      <div className="transport-mid">
        <button className="icon-btn tp-jump" data-testid="to-start" title="Go to start (Home)" disabled={frame === 0} onClick={playback.toStart}>
          <SkipBack />
        </button>
        <button className="icon-btn tp-step" data-testid="step-back" title="Back one frame (←)" disabled={frame === 0} onClick={() => playback.step(-1)}>
          <StepBack />
        </button>
        <button className="icon-btn play" data-testid="play" title={playing ? "Pause (Space)" : "Play (Space)"} disabled={frames <= 1} onClick={playback.toggle}>
          {playing ? <Pause /> : <Play />}
        </button>
        <button className="icon-btn tp-step" data-testid="step-forward" title="Forward one frame (→)" disabled={frame >= Math.max(frames - 1, end)} onClick={() => playback.step(1)}>
          <StepForward />
        </button>
        <button className="icon-btn tp-jump" data-testid="to-end" title="Go to end (End)" disabled={frame >= end} onClick={playback.toEnd}>
          <SkipForward />
        </button>
      </div>
      <span className="muted small" data-testid="canvas-info">
        {canvasLabel(project.canvas)}
      </span>
      <select
        className="zoom-select"
        data-testid="preview-zoom"
        title="Preview zoom (⌘ scroll or pinch)"
        value={view.zoom === "fit" ? "fit" : custom ? "custom" : String(view.zoom)}
        onChange={(e) => view.setZoom(e.target.value === "fit" ? "fit" : Number(e.target.value))}
      >
        <option value="fit">Fit</option>
        {ZOOM_STEPS.map((z) => (
          <option key={z} value={String(z)}>
            {Math.round(z * 100)}%
          </option>
        ))}
        {custom && <option value="custom">{Math.round(view.scale * 100)}%</option>}
      </select>
      <button className={`icon-btn tp-hand ${view.hand ? "on" : ""}`} data-testid="preview-hand" aria-pressed={view.hand} title="Hand: drag to pan the preview" onClick={() => view.setHand(!view.hand)}>
        <Hand />
      </button>
      <button className="icon-btn" data-testid="preview-fullscreen" aria-pressed={full} title={full ? "Exit full screen (Esc)" : "Full screen preview"} onClick={onFull}>
        {full ? <Minimize /> : <Maximize />}
      </button>
    </div>
  );
}
