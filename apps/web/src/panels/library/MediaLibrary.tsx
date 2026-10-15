import type { ImportJob } from "@uncut/contracts";
import { RefreshCw, Plus, Film, Upload, LayoutGrid, List } from "lucide-react";
import { usedMediaIds, mediaUses } from "@uncut/core/mediaPlan";
import React, { useState } from "react";
import { bridge } from "../../state/bridge.ts";
import { type Project, useApp, activeJobs, type MediaItem, actions, isRemote } from "../../state/store.ts";
import { useMediaView, sortMedia, setMediaSort, type MediaSort, MEDIA_SORTS, setMediaMode } from "../mediaView.ts";
import { generatedMedia, GeneratedSection } from "../Generate.tsx";
import { RecentSection } from "../RecentMedia.tsx";
import { Empty, MediaTile } from "./MediaTile.tsx";

export function MediaLibrary({ project, onEdit }: { project: Project; onEdit?: () => void }) {
  const app = useApp();
  const { importReport, connection, uploading } = app;
  const running = activeJobs(app);
  const importing = running.length > 0 || uploading !== undefined;
  const [dragging, setDragging] = useState(false);
  const online = connection === "connected";
  // Generated media (D99) are listed under Generated, with their prompts.
  const generated = new Set(generatedMedia(project).map((m) => m.id));
  const view = useMediaView();
  const media = sortMedia(
    project.media.filter((m) => !generated.has(m.id)),
    view.sort,
  );
  // F26 (D168): which media the timeline uses; F8 (D167): the selected tile (⌫ removes it) and the confirm.
  const used = usedMediaIds(project);
  const [selected, setSelected] = useState<string | undefined>();
  const [confirm, setConfirm] = useState<{ readonly id: string; readonly name: string; readonly count: number } | undefined>();
  const remove = (m: MediaItem) => {
    if (!online) return;
    const count = mediaUses(project, m.id).length;
    if (count === 0) void actions.removeMedia(m.id);
    else setConfirm({ id: m.id, name: m.name, count });
  };
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    // Only files from disk have a path; anything else (a dragged link, text) is ignored. A drop
    // while an import runs is queued behind it on the server.
    // On a remote environment this Mac's paths mean nothing to the server: the files go up instead (D108).
    if (isRemote()) {
      if (online && e.dataTransfer.files.length) void actions.uploadAndImport([...e.dataTransfer.files]);
      return;
    }
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
      {uploading && (
        <div className="import-progress" data-testid="upload-progress">
          <RefreshCw className="spin" />
          <span>
            Uploading {uploading.name}
            {uploading.total > 1 ? ` (${uploading.done + 1} of ${uploading.total})` : ""}…
          </span>
        </div>
      )}
      {running.map((job) => (
        <div key={job.id} className="import-progress" data-testid="import-progress">
          <RefreshCw className="spin" />
          <span>{progressText(job)}</span>
          <div className="bar">
            <span style={{ width: `${Math.round(progressFraction(job) * 100)}%` }} />
          </div>
        </div>
      ))}
      {app.analysisError && (
        <div className="import-report" data-testid="analysis-error">
          <div className="import-line error">
            <span>{app.analysisError}</span>
          </div>
          <button className="link-btn" onClick={actions.dismissAnalysisError}>
            Dismiss
          </button>
        </div>
      )}
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
      {media.length === 0 && generated.size === 0 ? (
        <Empty icon={<Film />} title="No media yet" testId="media-empty">
          <button className="btn" data-testid="import" disabled={!online} onClick={() => void actions.importMedia()}>
            <Upload />
            Import…
          </button>
        </Empty>
      ) : media.length > 0 ? (
        <div className="lib-section">
          <div className="lib-label media-bar">
            <span>In this project</span>
            <span className="media-bar-tools">
              <select className="media-sort" data-testid="media-sort" value={view.sort} title="Sort by" aria-label="Sort by" onChange={(e) => setMediaSort(e.target.value as MediaSort)}>
                {MEDIA_SORTS.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </select>
              <button className={`icon-btn${view.mode === "grid" ? " active" : ""}`} data-testid="media-view-grid" aria-pressed={view.mode === "grid"} title="Grid" onClick={() => setMediaMode("grid")}>
                <LayoutGrid />
              </button>
              <button className={`icon-btn${view.mode === "list" ? " active" : ""}`} data-testid="media-view-list" aria-pressed={view.mode === "list"} title="List" onClick={() => setMediaMode("list")}>
                <List />
              </button>
            </span>
          </div>
          <div className={view.mode === "list" ? "media-list" : "grid2"} data-testid="media-grid" data-view={view.mode} data-sort={view.sort}>
            {media.map((m) => (
              <MediaTile key={m.id} item={m} fps={project.canvas.fps} online={online} used={used.has(m.id)} selected={selected === m.id} onSelect={() => setSelected(m.id)} onRemove={() => remove(m)} />
            ))}
          </div>
        </div>
      ) : null}
      <GeneratedSection project={project} {...(onEdit ? { onEdit } : {})} />
      <RecentSection project={project} />
      {dragging && <div className="drop-hint">Drop to import</div>}
      {confirm && (
        <RemoveMediaConfirm
          name={confirm.name}
          count={confirm.count}
          onCancel={() => setConfirm(undefined)}
          onRemove={() => {
            setConfirm(undefined);
            void actions.removeMedia(confirm.id);
          }}
        />
      )}
    </aside>
  );
}

/** F8 (D167): in the app, not a system dialog; Esc or a click outside cancels. Keys stay here (⌫ never reaches the timeline). */
function RemoveMediaConfirm({ name, count, onCancel, onRemove }: { name: string; count: number; onCancel: () => void; onRemove: () => void }) {
  return (
    <div
      className="modal-layer"
      data-testid="remove-media-confirm"
      onPointerDown={(e) => e.target === e.currentTarget && onCancel()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape") onCancel();
      }}
    >
      <div className="modal confirm-modal" role="alertdialog" aria-label={`Remove ${name}`}>
        <div className="confirm-title">Remove {name} from the project?</div>
        <div className="confirm-text" data-testid="remove-media-count">
          {count === 1 ? "1 item on the timeline uses it and goes too." : `${count} items on the timeline use it and go too.`}
        </div>
        <div className="confirm-actions">
          <button className="btn" data-testid="remove-media-cancel" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn danger" data-testid="remove-media-ok" autoFocus onClick={onRemove}>
            Remove
          </button>
        </div>
      </div>
    </div>
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
