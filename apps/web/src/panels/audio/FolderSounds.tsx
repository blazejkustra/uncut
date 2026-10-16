import type { SoundFolderInfo } from "@uncut/contracts";
import { type LibraryKind, filterFolderSounds, libraryMediaOf } from "@uncut/core/library";
import { Folder, FolderPlus, Library, RefreshCw, X, Square, Play, Plus } from "lucide-react";
import { useState, useEffect } from "react";
import { type Project, useApp, actions, folderSoundUrl } from "../../state/store.ts";
import { type Preview, Wave, TogetherButton } from "./preview.tsx";

/** The most rows the list draws at once (search narrows the rest). */
const FOLDER_ROWS = 200;
const sizeLabel = (bytes: number) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);
type Result = ReadonlyArray<SoundFolderInfo> | { readonly error: string } | undefined;

/**
 * The user's own sounds (D208, D249): "folders" lists the folders they added (a plain list, each
 * with its count and ×) and their sound files; "music" lists the Music app's library (its DRM-free
 * songs), once they ask for it. The files stay where they are; + copies one into the project.
 */
export function FolderSounds({ kind, mode, project, online, query, preview }: { kind: LibraryKind; mode: "folders" | "music"; project: Project; online: boolean; query: string; preview: Preview }) {
  const app = useApp();
  const [all, setAll] = useState<ReadonlyArray<SoundFolderInfo> | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const apply = (r: Result) => {
    if (!r) return;
    if ("error" in r) return setError(r.error);
    setError(undefined);
    setAll(r);
  };
  const run = async (task: () => Promise<Result>) => {
    setBusy(true);
    apply(await task());
    setBusy(false);
  };
  useEffect(() => {
    if (online) void run(() => actions.soundFolders());
  }, [online]);
  const folders = all?.filter((f) => (mode === "music" ? f.system === "music" : !f.system));
  const library = mode === "music" ? folders?.[0] : undefined;
  const sounds = folders ? filterFolderSounds(folders, query) : [];

  return (
    <div className="lib-folders" data-testid={mode === "music" ? "music-app" : "folder-sounds"} data-busy={busy}>
      {mode === "folders" ? (
        <div className="lib-actions">
          <button className="btn ghost" data-testid="folder-add" disabled={!online} onClick={() => void run(() => actions.addSoundFolder())}>
            <FolderPlus /> Add a folder
          </button>
          {!!folders?.length && (
            <button className="icon-btn" data-testid="folder-rescan" disabled={!online || busy} title="Look for new files in your folders" onClick={() => void run(() => actions.soundFolders(true))}>
              <RefreshCw className={busy ? "spin" : ""} />
            </button>
          )}
        </div>
      ) : (
        folders &&
        !library && (
          <div className="lib-explain" data-testid="music-app-empty">
            <p>List the songs in your Music app library that are plain files on this Mac: songs you bought or imported. Apple Music songs can't be used in a video, so they're left out.</p>
            <button className="btn" data-testid="music-app-connect" disabled={!online || busy} onClick={() => void run(() => actions.addMusicLibrary())}>
              <Library /> Show my Music library
            </button>
          </div>
        )
      )}
      {error && (
        <div className="lib-limit error" data-testid="folder-error">
          {error}
        </div>
      )}
      {mode === "folders" && folders && folders.length === 0 && (
        <div className="muted small" data-testid="folder-empty">
          Add a folder of your own {kind === "music" ? "music" : "sounds"}. Uncut lists its sound files here and copies one into the project only when you add it.
        </div>
      )}
      {mode === "folders" && !!folders?.length && (
        <div className="lib-folder-list" data-testid="sound-folders">
          {folders.map((f) => (
            <div key={f.id} className="lib-folder" data-testid="sound-folder" data-id={f.id} data-missing={!!f.missing} title={f.missing ? `${f.path} can't be opened` : f.path}>
              <Folder />
              <span className="lib-folder-name">{f.name}</span>
              <span className="lib-folder-count">{f.missing ? "missing" : `${f.sounds.length}${f.truncated ? "+" : ""}`}</span>
              <button
                className="icon-btn"
                data-testid="sound-folder-remove"
                title="Remove this folder from the list (its files stay)"
                onClick={() => void run(() => actions.removeSoundFolder(f.id))}
              >
                <X />
              </button>
            </div>
          ))}
        </div>
      )}
      {library && (
        <div className="lib-folder-list" data-testid="music-app-summary" data-missing={!!library.missing} data-count={library.sounds.length} data-skipped={library.skipped ?? 0}>
          <div className="lib-folder" title={library.path}>
            <Library />
            <span className="lib-folder-name">
              {library.missing
                ? "No Music library found"
                : `${library.sounds.length}${library.truncated ? "+" : ""} song${library.sounds.length === 1 ? "" : "s"}${library.skipped ? `, ${library.skipped} Apple Music or protected left out` : ""}`}
            </span>
            <button className="icon-btn" data-testid="music-app-rescan" disabled={!online || busy} title="Read the Music library again" onClick={() => void run(() => actions.soundFolders(true))}>
              <RefreshCw className={busy ? "spin" : ""} />
            </button>
            <button className="icon-btn" data-testid="music-app-remove" title="Stop listing the Music library" onClick={() => void run(() => actions.removeSoundFolder(library.id))}>
              <X />
            </button>
          </div>
          {library.missing && (
            <div className="muted small" data-testid="music-app-missing">
              Uncut looks for ~/Music/Music/Media and for the library's XML copy (in Music, Settings, Advanced: Share Library XML with other applications).
            </div>
          )}
        </div>
      )}
      <div data-testid="folder-list">
        {folders && folders.some((f) => f.sounds.length) && sounds.length === 0 && (
          <div className="muted small" data-testid="folder-none">
            {query.trim() ? `Nothing matches "${query.trim()}".` : "No sound files here yet."}
          </div>
        )}
        {sounds.slice(0, FOLDER_ROWS).map((f) => {
          const key = `folder:${f.id}`;
          const url = folderSoundUrl(f.id);
          const playing = preview.playing === key && preview.mode === "alone";
          const inProject = !!libraryMediaOf(project, key);
          const peaks = preview.peaks[key];
          const artist = mode === "music" ? f.rel.split("/").slice(0, -1).join(", ") : f.folderName;
          return (
            <div key={f.id} className="music-row" data-testid="folder-row" data-id={f.id} title={f.rel}>
              <button className={`icon-btn${playing ? " playing" : ""}`} data-testid="folder-play" data-playing={playing} title={playing ? "Stop" : "Listen"} onClick={() => preview.toggle(key, url, f.bytes < 20 * 1024 * 1024)}>
                {playing ? <Square /> : <Play />}
              </button>
              <span className="music-text">
                <span className="music-title">{f.name}</span>
                <span className="music-meta">{[artist, f.ext, sizeLabel(f.bytes), ...(inProject ? ["in the project"] : [])].filter(Boolean).join(", ")}</span>
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
