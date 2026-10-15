import type { SoundFolderInfo } from "@uncut/contracts";
import { type LibraryKind, filterFolderSounds, libraryMediaOf } from "@uncut/core/library";
import { FolderPlus, RefreshCw, X, Square, Play, Plus } from "lucide-react";
import { useState, useEffect } from "react";
import { type Project, useApp, actions, folderSoundUrl } from "../../state/store.ts";
import { type Preview, Wave, TogetherButton } from "./preview.tsx";

/** The most rows the Folders view draws at once (search narrows the rest). */
const FOLDER_ROWS = 200;
const sizeLabel = (bytes: number) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

/**
 * The user's sound folders (D208): Add a folder, then its sound files as a library (search, listen,
 * +). The files stay where they are; + copies one into the project's media/.
 */
export function FolderSounds({ kind, project, online, query, preview }: { kind: LibraryKind; project: Project; online: boolean; query: string; preview: Preview }) {
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
