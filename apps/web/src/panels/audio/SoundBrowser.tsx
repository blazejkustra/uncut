import type { LibrarySearchResult } from "@uncut/contracts";
import { type LibraryKind, type LibrarySource, MUSIC_GENRES, SFX_CATEGORIES, limitSentence, hitKey } from "@uncut/core/library";
import { Search, RefreshCw } from "lucide-react";
import { useState, useRef, useEffect } from "react";
import { type Project, useApp, actions } from "../../state/store.ts";
import { usePreview } from "./preview.tsx";
import { HitRow, IncludedSfx } from "./rows.tsx";
import { FolderSounds } from "./FolderSounds.tsx";
import { KeyRow } from "./KeyRow.tsx";
import { GenerateSfx } from "./GenerateSfx.tsx";
import "./audio.css";

/**
 * Where sounds come from (D249, D250): the bundled pack (sound effects), the user's folders, the
 * Music app's library (music) and the online sources. D277: no Epidemic Sound "coming soon".
 */
export type BrowserSource = "pack" | "folders" | "music-app" | LibrarySource;
const SOURCE_LABEL: Readonly<Record<BrowserSource, string>> = {
  pack: "Uncut sounds",
  folders: "Your folders",
  "music-app": "Music library",
  openverse: "Openverse",
  freesound: "Freesound",
};
const isOnline = (s: BrowserSource): s is LibrarySource => s === "openverse" || s === "freesound";
const SOURCES: Readonly<Record<LibraryKind, ReadonlyArray<BrowserSource>>> = {
  music: ["folders", "music-app", "openverse", "freesound"],
  sfx: ["pack", "openverse", "freesound", "folders"],
};
const DEFAULT: Readonly<Record<LibraryKind, BrowserSource>> = { music: "openverse", sfx: "pack" };
const SOURCE_KEY = (kind: LibraryKind) => `uncut.library.source.${kind}`;

function savedSource(kind: LibraryKind): BrowserSource {
  try {
    const saved = localStorage.getItem(SOURCE_KEY(kind)) as BrowserSource | null;
    if (saved && SOURCES[kind].includes(saved)) return saved;
  } catch {}
  return DEFAULT[kind];
}

/**
 * The library for one kind of sound (D249): one search field and one source select (plus a mood or
 * kind select where it narrows), then the source's list. Local sources filter as you type; online
 * ones search on Enter. Nothing goes online until a search is asked for.
 */
export function SoundBrowser({ kind, project, online }: { kind: LibraryKind; project: Project; online: boolean }) {
  const app = useApp();
  const [source, setSource] = useState<BrowserSource>(() => savedSource(kind));
  const [query, setQuery] = useState("");
  const [mood, setMood] = useState<string | undefined>();
  const [keyed, setKeyed] = useState<ReadonlyArray<LibrarySource>>(["openverse"]);
  const [result, setResult] = useState<(LibrarySearchResult & { readonly words: string }) | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [, tick] = useState(0);
  const preview = usePreview();
  const seq = useRef(0);

  useEffect(() => {
    if (!online) return;
    void actions.libraryState().then((s) => s && setKeyed(s.sources));
  }, [online, app.keys]);
  // A limit's countdown.
  useEffect(() => {
    if (!result?.limit) return;
    const timer = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [result?.limit]);

  const moods = kind === "music" ? MUSIC_GENRES : SFX_CATEGORIES;
  const moodQuery = (id: string | undefined) => moods.find((m) => m.id === id)?.query ?? "";
  const words = (q: string, m: string | undefined) => [q.trim(), kind === "music" || !q.trim() ? moodQuery(m) : ""].filter(Boolean).join(" ");
  const needsKey = (s: BrowserSource) => s === "freesound" && !keyed.includes(s);

  const search = async (text: string, opts: { page?: number; source?: BrowserSource } = {}) => {
    const s = opts.source ?? source;
    const q = text.trim();
    if (!q || !online || !isOnline(s) || needsKey(s)) return;
    const n = ++seq.current;
    setBusy(true);
    setError(undefined);
    const page = opts.page ?? 1;
    const reply = await actions.searchLibrary({ kind, query: q, source: s, page });
    if (n !== seq.current) return;
    setBusy(false);
    if ("error" in reply) return setError(reply.error);
    setResult((before) => (page > 1 && before && before.words === q && !reply.limit ? { ...reply, hits: [...before.hits, ...reply.hits], words: q } : { ...reply, words: q }));
  };
  const pick = (s: BrowserSource) => {
    setSource(s);
    try {
      localStorage.setItem(SOURCE_KEY(kind), s);
    } catch {}
    preview.stop();
    // D262: a search still running for the old source is dropped (its hits would show under this one).
    seq.current++;
    setBusy(false);
    setResult(undefined);
    setError(undefined);
    if (isOnline(s) && (query.trim() || mood)) void search(words(query, mood), { source: s });
  };

  const label = kind === "music" ? "music" : "sound effects";
  const searchId = kind === "music" ? "music-search" : "sfx-search";
  const placeholder = source === "pack" ? "Search Uncut's sounds" : source === "folders" ? "Search your folders" : source === "music-app" ? "Search your Music library" : `Search ${label} on ${SOURCE_LABEL[source]}`;
  const showMood = source === "pack" || isOnline(source);
  const hits = result?.hits ?? [];
  const limit = result?.limit;
  const options = SOURCES[kind].filter((s) => s !== "freesound" || keyed.includes("freesound"));

  return (
    <div className="lib-section sound-browser" data-testid={`${kind}-browser`} data-view={source}>
      <div className="lib-search">
        <Search />
        <input
          className="field input"
          data-testid={searchId}
          placeholder={placeholder}
          value={query}
          spellCheck={false}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void search(words(query, mood));
          }}
        />
      </div>
      <div className="lib-selects">
        <select className="field input" data-testid="library-source" aria-label="Source" value={source} onChange={(e) => pick(e.target.value as BrowserSource)}>
          {options.map((s) => (
            <option key={s} value={s} data-testid={`library-source-${s}`}>
              {SOURCE_LABEL[s]}
            </option>
          ))}
        </select>
        {showMood && (
          <select
            className="field input"
            data-testid="library-mood"
            aria-label={kind === "music" ? "Mood" : "Kind of sound"}
            value={mood ?? ""}
            onChange={(e) => {
              const m = e.target.value || undefined;
              setMood(m);
              if (isOnline(source) && (query.trim() || m)) void search(words(query, m));
            }}
          >
            <option value="">{kind === "music" ? "Any mood" : "Any kind"}</option>
            {moods
              .filter((m) => kind === "music" || m.id !== "meme" || source === "pack")
              .map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
          </select>
        )}
      </div>

      {kind === "sfx" && <GenerateSfx project={project} online={online} query={query} />}

      {source === "pack" ? (
        <IncludedSfx project={project} online={online} query={query} category={mood} preview={preview} />
      ) : source === "folders" || source === "music-app" ? (
        <FolderSounds kind={kind} mode={source === "music-app" ? "music" : "folders"} project={project} online={online} query={query} preview={preview} />
      ) : source === "freesound" && needsKey(source) ? (
        <KeyRow provider={source} text="Freesound needs your API key." placeholder="Freesound API key" />
      ) : isOnline(source) ? (
        <>
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
            {!result && !busy && !error && (
              <div className="muted small" data-testid="library-idle">
                Type what you're looking for and press Enter{kind === "music" ? ", or pick a mood" : ""}.
              </div>
            )}
            {result && !limit && !error && hits.length === 0 && (
              <div className="muted small" data-testid="library-empty">
                Nothing found for "{result.words}". Try another word, or add a folder of your own sounds (Your folders).
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
      ) : null}
    </div>
  );
}
