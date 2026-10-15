import { lengthLabel } from "@uncut/core/library";
import { type MusicTempo, filterMusic, type MusicTrack, MUSIC_TEMPOS, MUSIC_TRACKS, musicTempo, MUSIC_MOODS, musicInProject } from "@uncut/core/music";
import { Square, Play, Plus } from "lucide-react";
import { useState, useRef, useEffect } from "react";
import { type Project, musicUrl, actions } from "../../state/store.ts";

const TEMPO_NAMES: Readonly<Record<MusicTempo, string>> = { slow: "Slow", medium: "Medium", fast: "Fast", free: "Free tempo" };

/**
 * The bundled music library (D91): cozy CC0 tracks (core MUSIC_TRACKS) filtered by the panel's
 * search, a mood and a tempo, a play button to listen (one at a time, from the server's library
 * route) and + to put a track on the timeline: copied into the project's media/ folder, then placed
 * like any sound (D50 revised), as long as the video at most, with fades.
 */
export function MusicLibrary({ project, online, query }: { project: Project; online: boolean; query: string }) {
  const [mood, setMood] = useState<string | undefined>();
  const [tempo, setTempo] = useState<MusicTempo | undefined>();
  const [playing, setPlaying] = useState<string | undefined>();
  const audio = useRef<HTMLAudioElement | null>(null);
  useEffect(() => () => audio.current?.pause(), []);
  const tracks = filterMusic({ query, mood, tempo });
  const toggle = (track: MusicTrack) => {
    if (playing === track.id) {
      audio.current?.pause();
      return setPlaying(undefined);
    }
    const url = musicUrl(track.file);
    if (!url) return;
    audio.current?.pause();
    const el = new Audio(url);
    el.onended = () => setPlaying((p) => (p === track.id ? undefined : p));
    audio.current = el;
    setPlaying(track.id);
    el.play().catch(() => setPlaying((p) => (p === track.id ? undefined : p)));
  };
  const tempos = MUSIC_TEMPOS.filter((t) => MUSIC_TRACKS.some((m) => musicTempo(m.bpm) === t));
  return (
    <div data-testid="music-library">
      <div className="music-filters">
        <div className="music-chips" data-testid="music-moods">
          {MUSIC_MOODS.map((m) => (
            <button key={m} className={`music-chip${mood === m ? " active" : ""}`} data-testid="music-mood" data-mood={m} aria-pressed={mood === m} onClick={() => setMood(mood === m ? undefined : m)}>
              {m}
            </button>
          ))}
        </div>
        <div className="music-chips" data-testid="music-tempos">
          {tempos.map((t) => (
            <button key={t} className={`music-chip${tempo === t ? " active" : ""}`} data-testid="music-tempo" data-tempo={t} aria-pressed={tempo === t} onClick={() => setTempo(tempo === t ? undefined : t)}>
              {TEMPO_NAMES[t]}
            </button>
          ))}
        </div>
      </div>
      <div data-testid="music-list">
        {tracks.length === 0 && (
          <div className="muted small" data-testid="music-empty">
            No track matches. Clear a filter to see more.
          </div>
        )}
        {tracks.map((t) => {
          const added = musicInProject(project, t);
          return (
            <div key={t.id} className="music-row" data-testid="music-row" data-id={t.id} title={`${t.title} by ${t.author} (${t.moods.join(", ")}), CC0: ${t.source}`}>
              <button className={`icon-btn${playing === t.id ? " playing" : ""}`} data-testid="music-play" data-playing={playing === t.id} title={playing === t.id ? "Stop" : "Listen"} onClick={() => toggle(t)}>
                {playing === t.id ? <Square /> : <Play />}
              </button>
              <span className="music-text">
                <span className="music-title">{t.title}</span>
                <span className="music-meta">{[t.bpm ? `${t.bpm} bpm` : TEMPO_NAMES.free.toLowerCase(), lengthLabel(t.seconds), ...(added ? ["in the project"] : [])].join(", ")}</span>
              </span>
              <button
                className="icon-btn"
                data-testid="music-add"
                disabled={!online}
                title="Add to the audio track at the playhead (as long as the video, with fades)"
                onClick={(e) => {
                  e.currentTarget.blur();
                  void actions.addMusic(t.id);
                }}
              >
                <Plus />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
