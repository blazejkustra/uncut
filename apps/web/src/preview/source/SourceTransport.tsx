// The source viewer's own bar (D311): play and pause, a scrub bar with the In to Out drawn on it, the
// time in the file, the marks, and Add, which puts In to Out (else the whole file) on the timeline as
// a library tile's + does.
import { Pause, Play, Plus, X } from "lucide-react";
import { useRef, type PointerEvent } from "react";

import { frameTimecode } from "../../state/format.ts";
import { actions, type MediaItem } from "../../state/store.ts";
import { Tooltip } from "../../ui/Tooltip.tsx";
import { getSource, markedRange, source, useSource } from "./source.ts";

const percent = (t: number, duration: number) => `${(Math.min(duration, Math.max(0, t)) / duration) * 100}%`;

export function SourceTransport({ media, fps, online }: { media: MediaItem; fps: number; online: boolean }) {
  const playing = useSource((s) => s.playing);
  const time = useSource((s) => s.time);
  const duration = useSource((s) => s.duration);
  const markIn = useSource((s) => s.markIn);
  const markOut = useSource((s) => s.markOut);
  const timed = media.kind !== "image";
  const marked = markIn !== undefined || markOut !== undefined;
  const add = () => void actions.addMedia(media.id, markedRange(getSource(), fps, media.probe?.frames));
  return (
    <div className="transport source-transport" data-testid="source-transport">
      {timed && (
        <span className="timecode" data-testid="source-timecode">
          {frameTimecode(time * fps, fps)}
          <span className="tc-end"> / {frameTimecode(duration * fps, fps)}</span>
        </span>
      )}
      {timed && (
        <Tooltip label={playing ? "Pause" : "Play"} shortcut="play">
          <button className="icon-btn play" data-testid="source-play" data-playing={playing ? "true" : undefined} disabled={!duration} onClick={source.toggle}>
            {playing ? <Pause /> : <Play />}
          </button>
        </Tooltip>
      )}
      {timed ? <ScrubBar duration={duration} time={time} markIn={markIn} markOut={markOut} /> : <span className="source-still muted small">Still image</span>}
      {timed && (
        <>
          <Tooltip label="Mark in here" shortcut="markIn">
            <button className="btn ghost source-mark" data-testid="source-mark-in" disabled={!duration} onClick={() => source.mark("in")}>
              In
            </button>
          </Tooltip>
          <Tooltip label="Mark out here" shortcut="markOut">
            <button className="btn ghost source-mark" data-testid="source-mark-out" disabled={!duration} onClick={() => source.mark("out")}>
              Out
            </button>
          </Tooltip>
          <Tooltip label="Clear In and Out">
            <button className="icon-btn" data-testid="source-clear-marks" disabled={!marked} onClick={source.clearMarks}>
              <X />
            </button>
          </Tooltip>
        </>
      )}
      <Tooltip label={media.kind === "audio" ? "Add to the audio track" : "Add to the end of the main track"}>
        <button className="btn source-add" data-testid="source-add" disabled={!online} onClick={add}>
          <Plus />
          {marked ? "Add In to Out" : "Add"}
        </button>
      </Tooltip>
    </div>
  );
}

function ScrubBar({ duration, time, markIn, markOut }: { duration: number; time: number; markIn: number | undefined; markOut: number | undefined }) {
  const ref = useRef<HTMLDivElement>(null);
  const seekTo = (e: PointerEvent) => {
    const r = ref.current?.getBoundingClientRect();
    if (!r || !duration) return;
    source.seek(((e.clientX - r.left) / Math.max(1, r.width)) * duration);
  };
  const onDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !duration) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    source.pause();
    seekTo(e);
  };
  const shown = duration > 0;
  return (
    <div
      className={`source-scrub ${shown ? "" : "empty"}`}
      ref={ref}
      data-testid="source-scrub"
      data-in={markIn}
      data-out={markOut}
      onPointerDown={onDown}
      onPointerMove={(e) => e.currentTarget.hasPointerCapture(e.pointerId) && seekTo(e)}
    >
      <span className="source-scrub-track" />
      {shown && (markIn !== undefined || markOut !== undefined) && (
        <span
          className="source-scrub-marks"
          data-testid="source-marks"
          style={{ left: percent(markIn ?? 0, duration), right: `calc(100% - ${percent(markOut ?? duration, duration)})` }}
        />
      )}
      {shown && <span className="source-scrub-head" style={{ left: percent(time, duration) }} />}
    </div>
  );
}
