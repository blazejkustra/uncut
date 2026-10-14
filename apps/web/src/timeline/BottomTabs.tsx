// Timeline | Transcript | Mixer (D32, D83): the bottom panel's modes (split out of Timeline.tsx).
import { playback, usePlayback } from "../preview/playback.ts";

export function BottomTabs() {
  const bottom = usePlayback((s) => s.bottom);
  return (
    <div className="seg" data-testid="bottom-tabs">
      <button className={bottom === "timeline" ? "active" : ""} data-testid="bottom-timeline" onClick={() => playback.setBottom("timeline")}>
        Timeline
      </button>
      <button className={bottom === "transcript" ? "active" : ""} data-testid="bottom-transcript" title="What's said on the main track: cut by deleting words" onClick={() => playback.setBottom("transcript")}>
        Transcript
      </button>
      <button className={bottom === "mixer" ? "active" : ""} data-testid="bottom-mixer" title="Volume, pan, effects, ducking, mute and solo per track; the master volume, limiter and loudness target; live meters" onClick={() => playback.setBottom("mixer")}>
        Mixer
      </button>
    </div>
  );
}
