import type { LibrarySearchResult } from "@uncut/contracts";
import { type LibraryKind, type LibrarySource, type LibraryLength, type LibraryLicense, MUSIC_GENRES, SFX_CATEGORIES, MEME_SOUNDS, LIBRARY_SOURCE_NAMES, LIBRARY_LENGTHS, limitSentence, hitKey } from "@uncut/core/library";
import { Search, RefreshCw } from "lucide-react";
import { useState, useRef, useEffect } from "react";
import { type Project, useApp, actions } from "../../state/store.ts";
import { usePreview } from "./preview.tsx";
import { HitRow, IncludedSfx } from "./rows.tsx";
import { FolderSounds } from "./FolderSounds.tsx";
import { MusicLibrary } from "./MusicLibrary.tsx";

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
export function SoundBrowser({ kind, project, online }: { kind: LibraryKind; project: Project; online: boolean }) {
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
