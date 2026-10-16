import { type LibraryHit, type LibraryKind, hitKey, libraryMediaOf, lengthLabel, LICENSE_NAMES, filterSfx, type SfxSound } from "@uncut/core/library";
import { Square, Play, RefreshCw, Plus } from "lucide-react";
import { type Project, libraryPreviewUrl, actions, useApp, sfxUrl } from "../../state/store.ts";
import { type Preview, Wave, TogetherButton } from "./preview.tsx";

export function HitRow({ hit, kind, project, online, preview, adding }: { hit: LibraryHit; kind: LibraryKind; project: Project; online: boolean; preview: Preview; adding: boolean }) {
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

/** The bundled sound-effects pack (D134, D250): CC0 sounds matching the search and the kind select, listen and +. */
export function IncludedSfx({ project, online, query, category, preview }: { project: Project; online: boolean; query: string; category: string | undefined; preview: Preview }) {
  const sounds = filterSfx({ query, category });
  return (
    <div data-testid="sfx-included">
      <div data-testid="sfx-list">
        {sounds.length === 0 && (
          <div className="muted small" data-testid="sfx-empty">
            No sound matches. Try other words, or generate one.
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
    <div className="music-row" data-testid="sfx-row" data-id={s.id} title={s.provider === "uncut" ? `${s.title}: made by Uncut, CC0` : `${s.title} by ${s.author}, CC0: ${s.source}`}>
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
