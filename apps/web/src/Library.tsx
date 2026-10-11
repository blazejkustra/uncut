// The library panel on the left: the media in the project (import, drop, add to the timeline)
// and the Text tab's presets. Which one shows is the rail's choice.
import type { ImportJob } from "@uncut/contracts";
import { AudioLines, Film, Image as ImageIcon, Plus, RefreshCw, Type, Upload } from "lucide-react";
import React, { useState, type ReactNode } from "react";

import { bridge } from "./bridge.ts";
import { timecode } from "./format.ts";
import { TEXT_PRESETS } from "./project.ts";
import { actions, activeJobs, thumbUrl, useApp, type MediaItem, type Project } from "./store.ts";
import { MEDIA_DRAG_TYPE } from "./Timeline.tsx";

export type LibraryTab = "media" | "text";

export function Library({ project, tab }: { project: Project; tab: LibraryTab }) {
  return tab === "text" ? <TextLibrary /> : <MediaLibrary project={project} />;
}

/** Presets that add a 3 s text item at the playhead (on a free text track). */
function TextLibrary() {
  const { connection } = useApp();
  const online = connection === "connected";
  return (
    <aside className="library" data-testid="text-library">
      <div className="lib-head">Text</div>
      <div className="lib-section">
        <div className="lib-label">Add at the playhead</div>
        <div className="grid2">
          {TEXT_PRESETS.map((preset) => (
            <button
              key={preset.id}
              className="tile text-tile"
              data-testid="text-preset"
              data-preset={preset.id}
              disabled={!online}
              title={`Add ${preset.label.toLowerCase()} at the playhead`}
              onClick={(e) => {
                e.currentTarget.blur();
                void actions.addText(preset);
              }}
            >
              <div className={`thumb tp ${preset.id}`}>
                <span>{preset.label}</span>
              </div>
              <div className="tile-name">{preset.label}</div>
            </button>
          ))}
        </div>
      </div>
      <div className="lib-hint">
        <Type />
        Text lands on the first text track that's free at the playhead, 3 seconds long.
      </div>
    </aside>
  );
}

function MediaLibrary({ project }: { project: Project }) {
  const app = useApp();
  const { importReport, connection } = app;
  const running = activeJobs(app);
  const importing = running.length > 0;
  const [dragging, setDragging] = useState(false);
  const online = connection === "connected";
  const media = project.media;
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    // Only files from disk have a path; anything else (a dragged link, text) is ignored. A drop
    // while an import runs is queued behind it on the server.
    const paths = [...e.dataTransfer.files].map((f) => bridge.pathForFile(f)).filter((p) => p.startsWith("/"));
    if (paths.length && online) void actions.importMedia(paths);
  };
  return (
    <aside
      className={`library ${dragging ? "dragging" : ""}`}
      data-testid="library"
      onDragOver={(e) => {
        if (![...e.dataTransfer.types].includes("Files")) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={onDrop}
    >
      <div className="lib-head">
        Media
        <button className="icon-btn" data-testid="import-plus" disabled={!online} title="Import media" onClick={() => void actions.importMedia()}>
          {importing ? <RefreshCw className="spin" /> : <Plus />}
        </button>
      </div>
      {running.map((job) => (
        <div key={job.id} className="import-progress" data-testid="import-progress">
          <RefreshCw className="spin" />
          <span>{progressText(job)}</span>
          <div className="bar">
            <span style={{ width: `${Math.round(progressFraction(job) * 100)}%` }} />
          </div>
        </div>
      ))}
      {importReport && (
        <div className="import-report" data-testid="import-report">
          {importReport.failed.map((f) => (
            <div key={`f-${f.path}`} className="import-line error">
              <span className="ellipsis" title={f.path}>
                {f.path.split("/").pop()}
              </span>
              <span>{f.message}</span>
            </div>
          ))}
          {importReport.skipped.map((s) => (
            <div key={`s-${s.path}`} className="import-line">
              <span className="ellipsis" title={s.path}>
                {s.path.split("/").pop()}
              </span>
              <span>{s.reason}</span>
            </div>
          ))}
          <button className="link-btn" onClick={actions.dismissImportReport}>
            Dismiss
          </button>
        </div>
      )}
      {media.length === 0 ? (
        <Empty icon={<Film />} title="No media yet" testId="media-empty">
          Drop files here, or import them. Footage stays where it is; the project references it.
          <button className="btn" data-testid="import" disabled={!online} onClick={() => void actions.importMedia()}>
            <Upload />
            Import…
          </button>
        </Empty>
      ) : (
        <div className="lib-section">
          <div className="lib-label">In this project</div>
          <div className="grid2" data-testid="media-grid">
            {media.map((m) => (
              <MediaTile key={m.id} item={m} fps={project.canvas.fps} online={online} />
            ))}
          </div>
        </div>
      )}
      {dragging && <div className="drop-hint">Drop to import</div>}
    </aside>
  );
}

/** "Importing 37 of 200…" and friends. */
function progressText(job: ImportJob) {
  switch (job.phase) {
    case "queued":
      return `Waiting to import ${job.total} file${job.total === 1 ? "" : "s"}…`;
    case "probing":
      return `Importing ${Math.min(job.probed + 1, job.total)} of ${job.total}…`;
    case "adding":
      return `Adding ${job.total} file${job.total === 1 ? "" : "s"}…`;
    default:
      return `Making thumbnails, ${job.postersDone} of ${job.postersTotal}…`;
  }
}
const progressFraction = (job: ImportJob) =>
  job.phase === "posters" ? 0.8 + 0.2 * (job.postersTotal ? job.postersDone / job.postersTotal : 1) : job.phase === "probing" ? 0.75 * (job.probed / Math.max(1, job.total)) : job.phase === "adding" ? 0.78 : 0;

/** "59.94", "30", "23.98" */
const fpsLabel = (fps: number) => String(Math.round(fps * 100) / 100);

/** "3840×2160, 59.94 fps" for video, "4096×3072" for images, "Audio" for sound. */
export function mediaMeta(m: MediaItem) {
  const size = m.probe?.width && m.probe?.height ? `${m.probe.width}×${m.probe.height}` : undefined;
  if (m.kind === "audio") return "Audio";
  if (m.kind === "image") return size ?? "Image";
  return [size, m.probe?.fps ? `${fpsLabel(m.probe.fps)} fps` : undefined].filter(Boolean).join(", ");
}

function MediaTile({ item, fps, online }: { item: MediaItem; fps: number; online: boolean }) {
  const { thumbIds } = useApp();
  const [broken, setBroken] = useState(false);
  const Icon = item.kind === "audio" ? AudioLines : item.kind === "image" ? ImageIcon : Film;
  const src = thumbIds.has(item.id) ? thumbUrl(item.id, item.path) : undefined;
  const seconds = item.probe?.frames ? item.probe.frames / fps : undefined;
  return (
    <div
      className="tile"
      data-testid="media-tile"
      data-id={item.id}
      title={item.path}
      draggable={online}
      onDragStart={(e) => {
        e.dataTransfer.setData(MEDIA_DRAG_TYPE, item.id);
        e.dataTransfer.effectAllowed = "copy";
      }}
    >
      <div className="thumb">
        {src && !broken ? <img key={src} src={src} alt="" draggable={false} onError={() => setBroken(true)} data-testid="thumb" /> : <Icon />}
        {seconds !== undefined && (
          <span className="dur" data-testid="duration">
            {timecode(Math.round(seconds * fps), fps).replace(/^00:/, "")}
          </span>
        )}
        <button
          className="tile-add"
          data-testid="add-to-timeline"
          title={item.kind === "audio" ? "Add to the audio track" : "Add to the end of the main track"}
          disabled={!online}
          onClick={(e) => {
            e.currentTarget.blur();
            void actions.addMedia(item.id);
          }}
        >
          <Plus />
        </button>
      </div>
      <div className="tile-name" data-testid="tile-name">
        {item.name}
      </div>
      <div className="tile-sub" data-testid="tile-meta">
        {mediaMeta(item)}
      </div>
    </div>
  );
}

export function Empty({ icon, title, children, testId }: { icon: ReactNode; title: string; children?: ReactNode; testId?: string }) {
  return (
    <div className="empty" data-testid={testId}>
      <div className="empty-icon">{icon}</div>
      <div className="empty-title">{title}</div>
      <div className="empty-sub">{children}</div>
    </div>
  );
}
