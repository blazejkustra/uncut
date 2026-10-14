// The Audio and Sound effects tabs (D33, D54, D91, D134): the project's sounds, the online library
// (Openverse without a key, Freesound with the user's key: CC0 and CC BY only) and the bundled CC0
// files (the music of D91 and the sound-effects pack), and Copy credits for what needs it (D135).
import type { LibrarySearchResult, SoundFolderInfo } from "@uncut/contracts";
import {
  creditsOf,
  creditsText,
  filterFolderSounds,
  filterSfx,
  hitKey,
  lengthLabel,
  LIBRARY_LENGTHS,
  LIBRARY_SOURCE_NAMES,
  libraryMediaOf,
  LICENSE_NAMES,
  limitSentence,
  MEME_SOUNDS,
  MUSIC_GENRES,
  SFX_CATEGORIES,
  type LibraryHit,
  type LibraryKind,
  type LibraryLength,
  type LibraryLicense,
  type LibrarySource,
  type SfxSound,
} from "@uncut/core/library";
import { filterMusic, MUSIC_MOODS, MUSIC_TEMPOS, MUSIC_TRACKS, musicInProject, musicTempo, type MusicTempo, type MusicTrack } from "@uncut/core/music";
import { AudioLines, Check, Clapperboard, Copy, FolderPlus, Play, Plus, RefreshCw, Search, Square, X } from "lucide-react";
import React, { useEffect, useRef, useState } from "react";

import { getPlayback, playback } from "../preview/playback.ts";
import { bridge } from "../state/bridge.ts";
import { timecode } from "../state/format.ts";
import { actions, activeJobs, folderSoundUrl, libraryPreviewUrl, musicUrl, sfxUrl, useApp, type Project } from "../state/store.ts";

/**
 * The Audio tab (D33, D54): the project's sound files (music, voiceover, effects) with + to put one
 * on the first audio track, at the playhead if it's free there, else after the last sound (a track
 * is made if there is none), then the music library (D134): online and the bundled tracks (D91).
 */
export function AudioLibrary({ project }: { project: Project }) {
  const app = useApp();
  const online = app.connection === "connected";
  const importing = activeJobs(app).length > 0;
  const fps = project.canvas.fps;
  const sounds = project.media.filter((m) => m.kind === "audio");
  return (
    <aside className="library" data-testid="audio-library">
      <div className="lib-head">
        Audio
        <span className="lib-head-actions">
          <CopyCredits project={project} />
          <button className="icon-btn" data-testid="audio-import" disabled={!online} title="Import music or sound" onClick={() => void actions.importMedia()}>
            {importing ? <RefreshCw className="spin" /> : <Plus />}
          </button>
        </span>
      </div>
      <div className="lib-section">
        <div className="lib-label">In this project</div>
        {sounds.length === 0 ? (
          <div className="muted small" data-testid="audio-empty">
            No music or sound yet
          </div>
        ) : (
          <div data-testid="audio-list">
            {sounds.map((m) => (
              <div key={m.id} className="audio-row" data-testid="audio-row" data-id={m.id} title={m.path}>
                <AudioLines />
                <span className="audio-name">{m.name}</span>
                {m.probe?.frames !== undefined && <span className="audio-dur">{timecode(m.probe.frames, fps).replace(/^00:/, "")}</span>}
                <button
                  className="icon-btn"
                  data-testid="audio-add"
                  disabled={!online}
                  title="Add to the audio track at the playhead (or after the last sound)"
                  onClick={(e) => {
                    e.currentTarget.blur();
                    void actions.addMedia(m.id);
                  }}
                >
                  <Plus />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
      <SoundBrowser kind="music" project={project} online={online} />
    </aside>
  );
}

/** The Sound effects tab (D134): the online library's sound effects by category, and the bundled pack. */
export function SfxLibrary({ project }: { project: Project }) {
  const online = useApp().connection === "connected";
  return (
    <aside className="library" data-testid="sfx-library">
      <div className="lib-head">
        Sound effects
        <span className="lib-head-actions">
          <CopyCredits project={project} />
        </span>
      </div>
      <SoundBrowser kind="sfx" project={project} online={online} />
    </aside>
  );
}

/** Copies the project's credits (D135: CC BY attributions, then the CC0 sounds) for the video's description. */
function CopyCredits({ project }: { project: Project }) {
  const [copied, setCopied] = useState(false);
  const credits = creditsOf(project);
  const count = credits.attribution.length + credits.publicDomain.length;
  if (!count) return null;
  return (
    <button
      className={`icon-btn${copied ? " done" : ""}`}
      data-testid="copy-credits"
      data-attribution={credits.attribution.length}
      title={credits.attribution.length ? `Copy credits (${credits.attribution.length} need${credits.attribution.length === 1 ? "s" : ""} attribution)` : "Copy credits"}
      onClick={async (e) => {
        e.currentTarget.blur();
        await bridge.copyText(creditsText(project));
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? <Check /> : <Copy />}
    </button>
  );
}

/**
 * One sound playing at a time across the panel: its key, the element, and the waveforms worked out
 * so far. F28 (D170): `withTimeline` plays the sound together with the timeline from the playhead;
 * stopping either (the button, the sound's end, a pause of the timeline) stops both, and the
 * playhead goes back to where it started, ready for the next try.
 */
function usePreview() {
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
function TogetherButton({ preview, soundKey, url, wave }: { preview: Preview; soundKey: string; url: string | undefined; wave: boolean }) {
  const on = preview.playing === soundKey && preview.mode === "timeline";
  return (
    <button className={`icon-btn${on ? " playing" : ""}`} data-testid="sound-with-timeline" data-playing={on} disabled={!url} title={on ? "Stop" : "Play with the timeline from the playhead"} onClick={() => preview.withTimeline(soundKey, url, wave)}>
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

function Wave({ peaks, progress }: { peaks: ReadonlyArray<number>; progress: number }) {
  return (
    <span className="lib-wave" data-testid="library-wave" aria-hidden="true">
      {peaks.map((p, i) => (
        <i key={i} className={i / peaks.length < progress ? "on" : ""} style={{ height: `${Math.max(8, p * 100)}%` }} />
      ))}
    </span>
  );
}

const VIEW_KEY = (kind: LibraryKind) => `uncut.library.view.${kind}`;
type View = "online" | "included" | "folders";
const VIEWS: ReadonlyArray<{ readonly id: View; readonly name: string }> = [
  { id: "online", name: "Online" },
  { id: "included", name: "Included" },
  { id: "folders", name: "Folders" },
];

/**
 * The library for one kind of sound: a search field, then Online (Openverse, or Freesound with the
 * user's key: quick searches, length and licence filters, results with listen and +) or Included
 * (Uncut's own CC0 files). Nothing goes online until a search is asked for.
 */
function SoundBrowser({ kind, project, online }: { kind: LibraryKind; project: Project; online: boolean }) {
  const app = useApp();
  const [view, setView] = useState<View>(() => {
    const saved = localStorage.getItem(VIEW_KEY(kind));
    return saved === "included" || saved === "folders" ? saved : "online";
  });
  const [query, setQuery] = useState("");
  const [chip, setChip] = useState<string | undefined>();
  const [meme, setMeme] = useState<string | undefined>();
  const [source, setSource] = useState<LibrarySource>("openverse");
  const [sources, setSources] = useState<ReadonlyArray<LibrarySource>>(["openverse"]);
  const [length, setLength] = useState<LibraryLength | undefined>();
  const [license, setLicense] = useState<LibraryLicense | undefined>();
  const [songs, setSongs] = useState(false);
  const [result, setResult] = useState<(LibrarySearchResult & { readonly words: string }) | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [, tick] = useState(0);
  const preview = usePreview();
  const seq = useRef(0);

  useEffect(() => {
    if (!online) return;
    void actions.libraryState().then((s) => {
      if (!s) return;
      setSources(s.sources);
      if (!s.sources.includes(source)) setSource("openverse");
    });
  }, [online, app.keys]);
  // A limit's countdown.
  useEffect(() => {
    if (!result?.limit) return;
    const timer = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [result?.limit]);

  const pick = (v: View) => {
    setView(v);
    localStorage.setItem(VIEW_KEY(kind), v);
    preview.stop();
  };
  const search = async (words: string, opts: { page?: number; source?: LibrarySource; length?: LibraryLength | undefined; license?: LibraryLicense | undefined; songs?: boolean } = {}) => {
    const q = words.trim();
    if (!q || !online) return;
    const n = ++seq.current;
    setBusy(true);
    setError(undefined);
    const page = opts.page ?? 1;
    const reply = await actions.searchLibrary({ kind, query: q, source: opts.source ?? source, length: "length" in opts ? opts.length : length, license: "license" in opts ? opts.license : license, songs: opts.songs ?? songs, page });
    if (n !== seq.current) return;
    setBusy(false);
    if ("error" in reply) return setError(reply.error);
    setResult((before) => (page > 1 && before && before.words === q && !reply.limit ? { ...reply, hits: [...before.hits, ...reply.hits], words: q } : { ...reply, words: q }));
  };
  const rerun = (opts: Parameters<typeof search>[1]) => {
    if (result) void search(result.words, opts);
  };

  const chips = kind === "music" ? MUSIC_GENRES : SFX_CATEGORIES;
  const label = kind === "music" ? "music" : "sound effects";
  const searchId = kind === "music" ? "music-search" : "sfx-search";
  const hits = result?.hits ?? [];
  const limit = result?.limit;

  return (
    <div className="lib-section sound-browser" data-testid={`${kind}-browser`} data-view={view}>
      <div className="lib-search">
        <Search />
        <input
          className="field input"
          data-testid={searchId}
          placeholder={view === "online" ? `Search ${label} online` : view === "folders" ? "Search your folders" : `Search included ${label}`}
          value={query}
          spellCheck={false}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter" || view !== "online") return;
            setChip(undefined);
            void search(query);
          }}
        />
      </div>
      <div className="seg lib-views" role="tablist">
        {VIEWS.map((v) => (
          <button key={v.id} role="tab" aria-selected={view === v.id} className={view === v.id ? "active" : ""} data-testid={`library-view-${v.id}`} onClick={() => pick(v.id)}>
            {v.name}
          </button>
        ))}
      </div>

      {view === "online" ? (
        <>
          <div className="music-chips" data-testid="library-chips">
            {chips.map((c) => (
              <button
                key={c.id}
                className={`music-chip${chip === c.id ? " active" : ""}`}
                data-testid={kind === "music" ? "music-genre" : "sfx-chip"}
                data-chip={c.id}
                aria-pressed={chip === c.id}
                disabled={!online}
                onClick={() => {
                  setChip(c.id);
                  setMeme(undefined);
                  setQuery(c.query);
                  void search(c.query);
                }}
              >
                {c.name}
              </button>
            ))}
          </div>
          {kind === "sfx" && chip === "meme" && (
            <div className="music-chips" data-testid="meme-chips">
              {MEME_SOUNDS.map((m) => (
                <button
                  key={m.id}
                  className={`music-chip${meme === m.id ? " active" : ""}`}
                  data-testid="meme-chip"
                  data-chip={m.id}
                  aria-pressed={meme === m.id}
                  disabled={!online}
                  onClick={() => {
                    // By its name: the server searches for what finds it and says when it's a clip (D208).
                    setMeme(m.id);
                    setQuery(m.name);
                    void search(m.name);
                  }}
                >
                  {m.name}
                </button>
              ))}
            </div>
          )}
          <div className="lib-filters">
            {sources.length > 1 && (
              <select
                className="field input"
                data-testid="library-source"
                value={source}
                onChange={(e) => {
                  const s = e.target.value as LibrarySource;
                  setSource(s);
                  rerun({ source: s });
                }}
              >
                {sources.map((s) => (
                  <option key={s} value={s}>
                    {LIBRARY_SOURCE_NAMES[s]}
                  </option>
                ))}
              </select>
            )}
            <select
              className="field input"
              data-testid="library-length"
              value={length ?? ""}
              onChange={(e) => {
                const l = (e.target.value || undefined) as LibraryLength | undefined;
                setLength(l);
                rerun({ length: l });
              }}
            >
              <option value="">Any length</option>
              {LIBRARY_LENGTHS.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
            <select
              className="field input"
              data-testid="library-license"
              value={license ?? ""}
              onChange={(e) => {
                const l = (e.target.value || undefined) as LibraryLicense | undefined;
                setLicense(l);
                rerun({ license: l });
              }}
            >
              <option value="">CC0 and CC BY</option>
              <option value="cc0">CC0 only</option>
            </select>
            {kind === "music" && (
              <button
                className={`music-chip${songs ? " active" : ""}`}
                data-testid="library-songs"
                aria-pressed={songs}
                onClick={() => {
                  setSongs(!songs);
                  rerun({ songs: !songs });
                }}
              >
                Songs only
              </button>
            )}
          </div>
          <div className="lib-results" data-testid="library-results" data-busy={busy}>
            {limit && (
              <div className="lib-limit" data-testid="library-limit" data-scope={limit.scope}>
                {limitSentence(result!.source, limit)}
              </div>
            )}
            {error && (
              <div className="lib-limit error" data-testid="library-error">
                {error}
              </div>
            )}
            {result && !limit && !error && (result.note || result.searched) && (
              <div className="lib-alias small" data-testid="library-alias" data-searched={result.searched ?? ""}>
                {result.note ?? `Nothing for "${result.words}", so this searched for "${result.searched}".`}
                {result.note && result.searched ? ` Searched for "${result.searched}".` : ""}
              </div>
            )}
            {result && !limit && !error && hits.length === 0 && (
              <div className="muted small" data-testid="library-empty">
                Nothing found for "{result.words}". Try another word, or add a folder of your own sounds (Folders).
              </div>
            )}
            {hits.map((h) => (
              <HitRow key={hitKey(h)} hit={h} kind={kind} project={project} online={online} preview={preview} adding={app.libraryAdding === hitKey(h)} />
            ))}
            {busy && <RefreshCw className="spin lib-busy" />}
            {result && !busy && !limit && result.page < result.pages && (
              <button className="btn ghost lib-more" data-testid="library-more" onClick={() => void search(result.words, { page: result.page + 1 })}>
                More results
              </button>
            )}
          </div>
          <div className="lib-notice" data-testid="library-notice">
            {source === "openverse" ? (
              <>
                Made with{" "}
                <a href="https://openverse.org" target="_blank" rel="noreferrer">
                  Openverse
                </a>
                , not endorsed by Openverse
              </>
            ) : (
              <>
                Sounds from{" "}
                <a href="https://freesound.org" target="_blank" rel="noreferrer">
                  Freesound
                </a>
              </>
            )}
          </div>
        </>
      ) : view === "folders" ? (
        <FolderSounds kind={kind} project={project} online={online} query={query} preview={preview} />
      ) : kind === "music" ? (
        <MusicLibrary project={project} online={online} query={query} />
      ) : (
        <IncludedSfx project={project} online={online} query={query} preview={preview} />
      )}
    </div>
  );
}

type Preview = ReturnType<typeof usePreview>;

function HitRow({ hit, kind, project, online, preview, adding }: { hit: LibraryHit; kind: LibraryKind; project: Project; online: boolean; preview: Preview; adding: boolean }) {
  const key = hitKey(hit);
  const playing = preview.playing === key && preview.mode === "alone";
  const inProject = !!libraryMediaOf(project, key);
  const peaks = preview.peaks[key];
  const meta = [hit.creator, ...(hit.seconds ? [lengthLabel(hit.seconds)] : []), ...(hit.provider && hit.provider !== hit.source ? [hit.provider] : []), ...(inProject ? ["in the project"] : [])];
  return (
    <div className="music-row lib-row" data-testid="library-row" data-id={key} title={hit.attribution}>
      <button className={`icon-btn${playing ? " playing" : ""}`} data-testid="library-play" data-playing={playing} title={playing ? "Stop" : "Listen"} onClick={() => preview.toggle(key, libraryPreviewUrl(hit.source, hit.id), (hit.seconds ?? 0) <= 120)}>
        {playing ? <Square /> : <Play />}
      </button>
      <span className="music-text">
        <span className="music-title">{hit.title}</span>
        <span className="music-meta">{meta.join(", ")}</span>
        {peaks && <Wave peaks={peaks} progress={preview.playing === key ? preview.progress : 0} />}
      </span>
      {kind === "sfx" && <TogetherButton preview={preview} soundKey={key} url={libraryPreviewUrl(hit.source, hit.id)} wave={(hit.seconds ?? 0) <= 120} />}
      <span className={`lib-license ${hit.license}`} data-testid="library-license" title={hit.license === "by" ? "Needs credit: Copy credits lists it" : "Public domain, no credit needed"}>
        {LICENSE_NAMES[hit.license]}
      </span>
      <button
        className="icon-btn"
        data-testid="library-add"
        disabled={!online || adding}
        title={kind === "music" ? "Add to an audio track at the playhead (as long as the video, with fades)" : "Add to an audio track at the playhead"}
        onClick={(e) => {
          e.currentTarget.blur();
          void actions.addLibrarySound(key, kind === "music", hit.title);
        }}
      >
        {adding ? <RefreshCw className="spin" /> : <Plus />}
      </button>
    </div>
  );
}

/** The bundled sound-effects pack (D134): CC0 sounds by category, listen and +. */
function IncludedSfx({ project, online, query, preview }: { project: Project; online: boolean; query: string; preview: Preview }) {
  const [category, setCategory] = useState<string | undefined>();
  const sounds = filterSfx({ query, category });
  const used = new Set(SFX_CATEGORIES.map((c) => c.id).filter((id) => filterSfx({ category: id }).length > 0));
  return (
    <div data-testid="sfx-included">
      <div className="music-chips">
        {SFX_CATEGORIES.filter((c) => used.has(c.id)).map((c) => (
          <button key={c.id} className={`music-chip${category === c.id ? " active" : ""}`} data-testid="sfx-category" data-chip={c.id} aria-pressed={category === c.id} onClick={() => setCategory(category === c.id ? undefined : c.id)}>
            {c.name}
          </button>
        ))}
      </div>
      <div data-testid="sfx-list">
        {sounds.length === 0 && (
          <div className="muted small" data-testid="sfx-empty">
            No sound matches
          </div>
        )}
        {sounds.map((s) => (
          <SfxRow key={s.id} sound={s} project={project} online={online} preview={preview} />
        ))}
      </div>
    </div>
  );
}

function SfxRow({ sound: s, project, online, preview }: { sound: SfxSound; project: Project; online: boolean; preview: Preview }) {
  const app = useApp();
  const key = `sfx:${s.id}`;
  const playing = preview.playing === key && preview.mode === "alone";
  const inProject = !!libraryMediaOf(project, key);
  // The pack's peaks come with it (make-sfx, D208): the waveform shows before it's played.
  const peaks = preview.peaks[key] ?? s.peaks.map((p) => p / 100);
  return (
    <div className="music-row" data-testid="sfx-row" data-id={s.id} title={`${s.title} by ${s.author}, CC0: ${s.source}`}>
      <button className={`icon-btn${playing ? " playing" : ""}`} data-testid="sfx-play" data-playing={playing} title={playing ? "Stop" : "Listen"} onClick={() => preview.toggle(key, sfxUrl(s.file), true)}>
        {playing ? <Square /> : <Play />}
      </button>
      <span className="music-text">
        <span className="music-title">{s.title}</span>
        <span className="music-meta">{[s.author, lengthLabel(s.seconds), ...(inProject ? ["in the project"] : [])].join(", ")}</span>
        {peaks && <Wave peaks={peaks} progress={preview.playing === key ? preview.progress : 0} />}
      </span>
      <TogetherButton preview={preview} soundKey={key} url={sfxUrl(s.file)} wave />
      <button
        className="icon-btn"
        data-testid="sfx-add"
        disabled={!online || app.libraryAdding === key}
        title="Add to an audio track at the playhead"
        onClick={(e) => {
          e.currentTarget.blur();
          void actions.addLibrarySound(key, false, s.title);
        }}
      >
        <Plus />
      </button>
    </div>
  );
}

/** The most rows the Folders view draws at once (search narrows the rest). */
const FOLDER_ROWS = 200;
const sizeLabel = (bytes: number) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

/**
 * The user's sound folders (D208): Add a folder, then its sound files as a library (search, listen,
 * +). The files stay where they are; + copies one into the project's media/.
 */
function FolderSounds({ kind, project, online, query, preview }: { kind: LibraryKind; project: Project; online: boolean; query: string; preview: Preview }) {
  const app = useApp();
  const [folders, setFolders] = useState<ReadonlyArray<SoundFolderInfo> | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [only, setOnly] = useState<string | undefined>();
  const apply = (r: ReadonlyArray<SoundFolderInfo> | { readonly error: string } | undefined) => {
    if (!r) return;
    if ("error" in r) return setError(r.error);
    setError(undefined);
    setFolders(r);
  };
  const load = async (rescan = false) => {
    setBusy(true);
    apply(await actions.soundFolders(rescan));
    setBusy(false);
  };
  useEffect(() => {
    if (online) void load();
  }, [online]);
  const sounds = folders ? filterFolderSounds(folders, query, only) : [];
  return (
    <div data-testid="folder-sounds" data-busy={busy}>
      <div className="lib-filters">
        <button
          className="btn ghost"
          data-testid="folder-add"
          disabled={!online}
          onClick={async () => {
            setBusy(true);
            apply(await actions.addSoundFolder());
            setBusy(false);
          }}
        >
          <FolderPlus /> Add a folder
        </button>
        {!!folders?.length && (
          <button className="icon-btn" data-testid="folder-rescan" disabled={!online || busy} title="Look for new files in your folders" onClick={() => void load(true)}>
            <RefreshCw className={busy ? "spin" : ""} />
          </button>
        )}
      </div>
      {error && (
        <div className="lib-limit error" data-testid="folder-error">
          {error}
        </div>
      )}
      {folders && folders.length === 0 && (
        <div className="muted small" data-testid="folder-empty">
          Add a folder of your own sounds. Uncut lists its sound files here and copies one into the project only when you add it.
        </div>
      )}
      {!!folders?.length && (
        <div className="music-chips" data-testid="sound-folders">
          {folders.map((f) => (
            <span key={f.id} className={`music-chip folder-chip${only === f.id ? " active" : ""}`} data-testid="sound-folder" data-id={f.id} data-missing={!!f.missing} title={f.missing ? `${f.path} can't be opened` : f.path}>
              <button className="folder-chip-name" aria-pressed={only === f.id} onClick={() => setOnly(only === f.id ? undefined : f.id)}>
                {f.name} {f.missing ? "(missing)" : `(${f.sounds.length}${f.truncated ? "+" : ""})`}
              </button>
              <button
                className="folder-chip-remove"
                data-testid="sound-folder-remove"
                title="Remove this folder from the list (its files stay)"
                onClick={async () => {
                  if (only === f.id) setOnly(undefined);
                  apply(await actions.removeSoundFolder(f.id));
                }}
              >
                <X />
              </button>
            </span>
          ))}
        </div>
      )}
      <div data-testid="folder-list">
        {folders && folders.length > 0 && sounds.length === 0 && (
          <div className="muted small" data-testid="folder-none">
            {query.trim() ? `No sound in your folders matches "${query.trim()}".` : "No sound files in these folders yet."}
          </div>
        )}
        {sounds.slice(0, FOLDER_ROWS).map((f) => {
          const key = `folder:${f.id}`;
          const url = folderSoundUrl(f.id);
          const playing = preview.playing === key && preview.mode === "alone";
          const inProject = !!libraryMediaOf(project, key);
          const peaks = preview.peaks[key];
          return (
            <div key={f.id} className="music-row" data-testid="folder-row" data-id={f.id} title={f.rel}>
              <button className={`icon-btn${playing ? " playing" : ""}`} data-testid="folder-play" data-playing={playing} title={playing ? "Stop" : "Listen"} onClick={() => preview.toggle(key, url, f.bytes < 20 * 1024 * 1024)}>
                {playing ? <Square /> : <Play />}
              </button>
              <span className="music-text">
                <span className="music-title">{f.name}</span>
                <span className="music-meta">{[f.folderName, f.ext, sizeLabel(f.bytes), ...(inProject ? ["in the project"] : [])].join(", ")}</span>
                {peaks && <Wave peaks={peaks} progress={preview.playing === key ? preview.progress : 0} />}
              </span>
              {kind === "sfx" && <TogetherButton preview={preview} soundKey={key} url={url} wave={f.bytes < 20 * 1024 * 1024} />}
              <button
                className="icon-btn"
                data-testid="folder-add-sound"
                disabled={!online || app.libraryAdding === key}
                title="Copy into the project and add to an audio track at the playhead"
                onClick={(e) => {
                  e.currentTarget.blur();
                  void actions.addLibrarySound(key, kind === "music", f.name);
                }}
              >
                {app.libraryAdding === key ? <RefreshCw className="spin" /> : <Plus />}
              </button>
            </div>
          );
        })}
        {sounds.length > FOLDER_ROWS && (
          <div className="muted small" data-testid="folder-more">
            Showing {FOLDER_ROWS} of {sounds.length}. Search to narrow them down.
          </div>
        )}
      </div>
    </div>
  );
}

const TEMPO_NAMES: Readonly<Record<MusicTempo, string>> = { slow: "Slow", medium: "Medium", fast: "Fast", free: "Free tempo" };

/**
 * The bundled music library (D91): cozy CC0 tracks (core MUSIC_TRACKS) filtered by the panel's
 * search, a mood and a tempo, a play button to listen (one at a time, from the server's library
 * route) and + to put a track on the timeline: copied into the project's media/ folder, then placed
 * like any sound (D50 revised), as long as the video at most, with fades.
 */
function MusicLibrary({ project, online, query }: { project: Project; online: boolean; query: string }) {
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
