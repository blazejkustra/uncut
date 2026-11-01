// Media › search across the footage: what's said in every indexed clip and what the agent has
// described, with a thumbnail and timecode per moment. A moment of this project's media drags onto
// the timeline as that stretch of the clip; another project's is added first. The index lives on
// this Mac; indexing transcribes with whisper.cpp here.
import type { FootageHit, FootageStatus } from "@uncut/contracts";
import { AudioLines, Image as ImageIcon, Plus, RefreshCw, Search } from "lucide-react";
import { useEffect, useState } from "react";

import { playback } from "../../preview/playback.ts";
import { actions, footageThumbUrl, useApp, type Project } from "../../state/store.ts";
import { MEDIA_DRAG_TYPE, MEDIA_RANGE_DRAG_TYPE } from "../../timeline/dnd.ts";
import "./footageSearch.css";

/** A moment dropped on the timeline keeps this much on each side of the words. */
const DROP_HANDLE_SECONDS = 0.5;

export const timecode = (seconds: number) => {
  const whole = Math.floor(seconds);
  const minutes = Math.floor(whole / 60);
  const clock = `${minutes % 60}:${String(whole % 60).padStart(2, "0")}`;
  return minutes >= 60 ? `${Math.floor(minutes / 60)}:${clock.padStart(5, "0")}` : clock;
};

/** The stretch of a moment that goes on the timeline, in project frames, inside the file. */
export function dropRange(hit: Pick<FootageHit, "start" | "end">, fps: number, frames: number | undefined) {
  const first = Math.max(0, Math.floor((hit.start - DROP_HANDLE_SECONDS) * fps));
  const last = Math.ceil((hit.end + DROP_HANDLE_SECONDS) * fps);
  return { in: first, frames: Math.max(1, Math.min(last, frames ?? last) - first) };
}

function IndexState({ status, online }: { status: FootageStatus; online: boolean }) {
  if (status.phase === "running") {
    const line =
      status.waiting === "export"
        ? "Waiting for the export to finish"
        : status.waiting === "model"
          ? "Downloading the speech model"
          : `Indexing ${status.current ?? "footage"}, ${status.indexed} of ${status.clips} done`;
    return (
      <div className="import-progress footage-progress" data-testid="footage-progress">
        <RefreshCw className="spin" />
        <span className="ellipsis">{line}</span>
        <div className="bar">
          <span style={{ width: `${Math.round(status.progress * 100)}%` }} />
        </div>
        <button className="link-btn link-cancel" data-testid="footage-cancel" disabled={!online} onClick={() => void actions.footageCancel()}>
          Cancel
        </button>
      </div>
    );
  }
  return (
    <div className="footage-state" data-testid="footage-state">
      {status.clips > 0 && (
        <span>
          {status.indexed} of {status.clips} clips searchable
        </span>
      )}
      {status.indexed < status.clips && (
        <button
          className="link-btn"
          data-testid="footage-index"
          disabled={!online}
          title="Transcribes this project's clips on this Mac, and new ones as they arrive"
          onClick={() => void actions.footageStart()}
        >
          Index footage
        </button>
      )}
      {status.error && (
        <div className="footage-error" data-testid="footage-error">
          {status.failed === 1 ? "1 clip failed" : `${status.failed} clips failed`}: {status.error}
        </div>
      )}
    </div>
  );
}

function HitRow({ hit, project, online }: { hit: FootageHit; project: Project; online: boolean }) {
  const [added, setAdded] = useState<string | undefined>();
  const media = project.media.find((m) => m.id === hit.media);
  const fps = project.canvas.fps;
  const thumb = hit.kind === "audio" ? undefined : footageThumbUrl(hit.fingerprint, Math.floor(hit.start));
  const add = async () => {
    setAdded("Adding");
    const result = await actions.mediaRecentImport(hit.recent);
    setAdded(result.ok ? "Added" : result.message);
  };
  return (
    <div
      className="gen-result footage-hit"
      data-testid="footage-hit"
      data-source={hit.source}
      data-media={hit.media}
      data-start={hit.start}
      draggable={online && !!media}
      onDragStart={(e) => {
        if (!media) return;
        e.dataTransfer.setData(MEDIA_DRAG_TYPE, media.id);
        e.dataTransfer.setData(MEDIA_RANGE_DRAG_TYPE, JSON.stringify(dropRange(hit, fps, media.probe?.frames)));
        e.dataTransfer.effectAllowed = "copy";
      }}
      onPointerEnter={() => media && media.kind !== "audio" && playback.hoverMedia(media.id, hit.start)}
      onPointerLeave={() => media && playback.hoverMedia(undefined)}
    >
      <div className="gen-thumb footage-thumb">
        {thumb ? <img src={thumb} alt="" draggable={false} loading="lazy" /> : <AudioLines />}
        <span className="footage-time" data-testid="footage-time">
          {timecode(hit.start)}
        </span>
      </div>
      <div className="gen-body">
        <div className="gen-title" title={hit.path}>
          {hit.name}
        </div>
        <div className="footage-text">
          {hit.source === "visual" && <ImageIcon aria-label="Described picture" />}
          {hit.before} <mark>{hit.match}</mark> {hit.after}
        </div>
        {!hit.media && (
          <div className="gen-actions">
            {added ? (
              <span className="gen-by">{added}</span>
            ) : (
              <button className="link-btn" data-testid="footage-add" disabled={!online} title={`From ${hit.project.name}`} onClick={() => void add()}>
                <Plus />
                Add from {hit.project.name}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export function FootageSearch({ project }: { project: Project }) {
  const app = useApp();
  const online = app.connection === "connected";
  const status = app.footage;
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<"project" | "all">("project");
  const [hits, setHits] = useState<ReadonlyArray<FootageHit> | undefined>();
  const asked = query.trim();
  const revision = status?.revision;
  useEffect(() => {
    if (!online || !asked) {
      setHits(undefined);
      return;
    }
    let live = true;
    const timer = setTimeout(() => void actions.footageSearch(asked, scope === "project").then((found) => live && setHits(found)), 150);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [online, asked, scope, revision]);
  if (!status || (project.media.length === 0 && status.everywhere === 0)) return null;
  return (
    <div className="lib-section footage-search" data-testid="footage-search">
      <div className="footage-bar">
        <label className="recent-search">
          <Search />
          <input
            className="field input"
            data-testid="footage-query"
            value={query}
            placeholder="Search your footage"
            aria-label="Search your footage"
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <select
          className="media-sort"
          data-testid="footage-scope"
          value={scope}
          aria-label="Where to search"
          onChange={(e) => setScope(e.target.value as "project" | "all")}
        >
          <option value="project">This project</option>
          <option value="all">All projects</option>
        </select>
      </div>
      <IndexState status={status} online={online} />
      {hits && (
        <div className="gen-results" data-testid="footage-results">
          {hits.length === 0 && (
            <div className="recent-none" data-testid="footage-none">
              Nothing matches. To search what's on screen, ask the agent to describe your footage.
            </div>
          )}
          {hits.map((hit) => (
            <HitRow key={hit.id} hit={hit} project={project} online={online} />
          ))}
        </div>
      )}
    </div>
  );
}
