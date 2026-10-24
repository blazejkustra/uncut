import { Square, Clapperboard } from "lucide-react";
import { useState, useRef, useEffect } from "react";
import { playback, getPlayback } from "../../preview/playback.ts";

/**
 * One sound playing at a time across the panel: its key, the element, and the waveforms worked out
 * so far. F28 (D170): `withTimeline` plays the sound together with the timeline from the playhead;
 * stopping either (the button, the sound's end, a pause of the timeline) stops both, and the
 * playhead goes back to where it started, ready for the next try.
 */
export function usePreview() {
  const [playing, setPlaying] = useState<string | undefined>();
  const [mode, setMode] = useState<"alone" | "timeline">("alone");
  const [progress, setProgress] = useState(0);
  const [peaks, setPeaks] = useState<Readonly<Record<string, ReadonlyArray<number>>>>({});
  const audio = useRef<HTMLAudioElement | null>(null);
  // While a sound plays with the timeline: where the playhead started, and the stop for both.
  const together = useRef<{ from: number; unsubscribe: () => void } | null>(null);
  const endTogether = () => {
    const t = together.current;
    if (!t) return;
    together.current = null;
    t.unsubscribe();
    playback.pause();
    playback.seek(t.from);
  };
  useEffect(
    () => () => {
      audio.current?.pause();
      endTogether();
    },
    [],
  );
  const stop = () => {
    audio.current?.pause();
    audio.current = null;
    endTogether();
    setPlaying(undefined);
    setProgress(0);
  };
  const start = (key: string, url: string, wave: boolean, withTimeline: boolean) => {
    audio.current?.pause();
    endTogether();
    // Streamed from the server (an online hit's preview is passed through, never saved).
    const el = new Audio(url);
    el.dataset.key = key;
    el.ontimeupdate = () => setProgress(el.duration > 0 ? el.currentTime / el.duration : 0);
    el.onended = () => {
      if (audio.current !== el) return;
      audio.current = null;
      endTogether();
      setPlaying((p) => (p === key ? (setProgress(0), undefined) : p));
    };
    audio.current = el;
    setPlaying(key);
    setMode(withTimeline ? "timeline" : "alone");
    setProgress(0);
    if (withTimeline) {
      playback.pause();
      const from = Math.floor(getPlayback().frame);
      playback.play();
      // The timeline paused (space, its end, a seek elsewhere doesn't count): the sound stops too.
      const unsubscribe = playback.subscribe(() => {
        if (!getPlayback().playing && together.current && audio.current === el) {
          together.current = null;
          unsubscribe();
          el.pause();
          audio.current = null;
          setPlaying((p) => (p === key ? (setProgress(0), undefined) : p));
        }
      });
      together.current = { from, unsubscribe };
    }
    el.play().catch(() => (audio.current === el ? stop() : undefined));
    if (wave && !peaks[key]) void waveOf(url).then((w) => w && setPeaks((p) => ({ ...p, [key]: w })));
  };
  const toggle = (key: string, url: string | undefined, wave: boolean) => {
    if (playing === key && mode === "alone") return stop();
    if (!url) return;
    start(key, url, wave, false);
  };
  const withTimeline = (key: string, url: string | undefined, wave: boolean) => {
    if (playing === key && mode === "timeline") return stop();
    if (!url) return;
    start(key, url, wave, true);
  };
  return { playing, mode, progress, peaks, toggle, withTimeline, stop };
}

/** F28 (D170): play the sound and the timeline together from the playhead. */
export function TogetherButton({ preview, soundKey, url, wave }: { preview: Preview; soundKey: string; url: string | undefined; wave: boolean }) {
  const on = preview.playing === soundKey && preview.mode === "timeline";
  return (
    <button
      className={`icon-btn${on ? " playing" : ""}`}
      data-testid="sound-with-timeline"
      data-playing={on}
      disabled={!url}
      title={on ? "Stop" : "Play with the timeline from the playhead"}
      onClick={() => preview.withTimeline(soundKey, url, wave)}
    >
      {on ? <Square /> : <Clapperboard />}
    </button>
  );
}

/** The sound's peaks in 48 bins (0–1), decoded from its preview; undefined when it can't be read. */
async function waveOf(url: string): Promise<ReadonlyArray<number> | undefined> {
  try {
    const bytes = await (await fetch(url)).arrayBuffer();
    const context = new OfflineAudioContext(1, 1, 44100);
    const buffer = await context.decodeAudioData(bytes);
    const data = buffer.getChannelData(0);
    const bins = 48;
    const size = Math.max(1, Math.floor(data.length / bins));
    const out: Array<number> = [];
    for (let b = 0; b < bins; b++) {
      let max = 0;
      for (let i = b * size; i < Math.min(data.length, (b + 1) * size); i++) max = Math.max(max, Math.abs(data[i]!));
      out.push(max);
    }
    const top = Math.max(...out, 1e-6);
    return out.map((v) => v / top);
  } catch {
    return undefined;
  }
}

export function Wave({ peaks, progress }: { peaks: ReadonlyArray<number>; progress: number }) {
  return (
    <span className="lib-wave" data-testid="library-wave" aria-hidden="true">
      {peaks.map((p, i) => (
        <i key={i} className={i / peaks.length < progress ? "on" : ""} style={{ height: `${Math.max(8, p * 100)}%` }} />
      ))}
    </span>
  );
}

export type Preview = ReturnType<typeof usePreview>;
