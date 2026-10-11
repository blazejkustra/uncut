import type { ImportJob, ProjectSnapshot } from "@uncut/contracts";
import {
  AudioLines,
  Blend,
  Check,
  CircleDot,
  Eye,
  Film,
  FolderOpen,
  Image as ImageIcon,
  Lock,
  Magnet,
  Maximize2,
  Music,
  Play,
  Plus,
  Redo2,
  RefreshCw,
  Shapes,
  SkipBack,
  SkipForward,
  TriangleAlert,
  Sparkles,
  Type,
  Undo2,
  Upload,
  Volume2,
  X,
} from "lucide-react";
import React, { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { canvasLabel, shortPath, timecode } from "./format.ts";
import { isTransportError } from "./connection.ts";
import { NewProject } from "./NewProject.tsx";
import { bridge } from "./bridge.ts";
import { actions, activeJobs, getState, MAX_NAME_LENGTH, plainError, projectOf, thumbUrl, useApp, type MediaItem, type Project } from "./store.ts";

const LATER = "Coming in a later phase";

export function Editor({ snapshot }: { snapshot: ProjectSnapshot }) {
  const project = projectOf(snapshot);
  const { connection, changedOnDisk, reloadProblem, notice, newProjectOpen } = useApp();
  const online = connection === "connected";
  return (
    <div className="app" data-testid="editor">
      <TopBar snapshot={snapshot} project={project} online={online} unsaved={changedOnDisk} />
      <div className="banners">
        {!online && (
          <div className="banner" data-testid="connection-banner" data-state={connection}>
            <RefreshCw className={connection === "reconnecting" ? "spin" : ""} />
            {connection === "reconnecting"
              ? "Reconnecting to the server… Changes are paused."
              : connection === "server-exited"
                ? "The server stopped. Restart Uncut to keep editing."
                : "Connecting to the server…"}
          </div>
        )}
        {changedOnDisk && (
          <div className="banner warn" data-testid="changed-on-disk">
            <span className="banner-text" data-testid="changed-on-disk-text">
              {reloadProblem ? `Can't reload. ${reloadProblem}` : "project.json was changed outside Uncut. Reload it to keep editing."}
            </span>
            <button className="btn" data-testid="reload" onClick={() => void actions.reload()} disabled={!online}>
              {reloadProblem ? "Reload again" : "Reload"}
            </button>
            <button className="btn ghost" data-testid="banner-close-project" onClick={() => void actions.closeProject()} disabled={!online}>
              Close project
            </button>
          </div>
        )}
        {notice && !changedOnDisk && (
          <div className="banner error" data-testid="editor-error">
            <span className="banner-text">{notice.text}</span>
            <button className="icon-btn" title="Dismiss" onClick={actions.dismissNotice}>
              <X />
            </button>
          </div>
        )}
      </div>
      <Rail />
      <Library project={project} />
      <Stage project={project} />
      <Side snapshot={snapshot} project={project} online={online} />
      <Timeline project={project} />
      {newProjectOpen && (
        <div className="modal-layer" data-testid="new-project-modal">
          <div className="modal wiz">
            <div className="wiz-panel">
              <NewProject />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function TopBar({ snapshot, project, online, unsaved }: { snapshot: ProjectSnapshot; project: Project; online: boolean; unsaved: boolean }) {
  return (
    <header className="topbar">
      <div className="brand">Uncut</div>
      <div className="project-title" data-testid="project-title">
        {project.name}
      </div>
      <div className="topbar-spacer" />
      <div
        className={`saved ${unsaved ? "warn" : ""}`}
        data-testid="saved"
        title={unsaved ? "project.json on disk differs from what Uncut shows" : `Saved to project.json (revision ${snapshot.revision})`}
      >
        {unsaved ? <TriangleAlert /> : online ? <Check /> : <RefreshCw />}
        {unsaved ? "Not saved" : online ? "Saved" : "Offline"}
      </div>
      <button className="icon-btn" title="Undo (⌘Z)" data-testid="undo" disabled={!online || !snapshot.canUndo} onClick={() => void actions.undo()}>
        <Undo2 />
      </button>
      <button className="icon-btn" title="Redo (⇧⌘Z)" data-testid="redo" disabled={!online || !snapshot.canRedo} onClick={() => void actions.redo()}>
        <Redo2 />
      </button>
      <button className="icon-btn" title="Close project (⌘W)" data-testid="close-project" disabled={!online} onClick={() => void actions.closeProject()}>
        <X />
      </button>
    </header>
  );
}

const RAIL: ReadonlyArray<[string, typeof Film]> = [
  ["Capture", CircleDot],
  ["Text", Type],
  ["Elements", Shapes],
  ["Transitions", Blend],
  ["Audio", Music],
  ["Generate", Sparkles],
];

function Rail() {
  return (
    <nav className="rail">
      <button className="active" title="Media">
        <Film />
        <span>Media</span>
      </button>
      {RAIL.map(([label, Icon]) => (
        <button key={label} disabled title={`${label}: ${LATER}`}>
          <Icon />
          <span>{label}</span>
        </button>
      ))}
    </nav>
  );
}

function Library({ project }: { project: Project }) {
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
              <MediaTile key={m.id} item={m} fps={project.canvas.fps} />
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

function MediaTile({ item, fps }: { item: MediaItem; fps: number }) {
  const { thumbIds } = useApp();
  const [broken, setBroken] = useState(false);
  const Icon = item.kind === "audio" ? AudioLines : item.kind === "image" ? ImageIcon : Film;
  const src = thumbIds.has(item.id) ? thumbUrl(item.id) : undefined;
  const seconds = item.probe?.frames ? item.probe.frames / fps : undefined;
  return (
    <div className="tile" data-testid="media-tile" data-id={item.id} title={item.path}>
      <div className="thumb">
        {src && !broken ? <img key={src} src={src} alt="" onError={() => setBroken(true)} data-testid="thumb" /> : <Icon />}
        {seconds !== undefined && (
          <span className="dur" data-testid="duration">
            {timecode(Math.round(seconds * fps), fps).replace(/^00:/, "")}
          </span>
        )}
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

function Empty({ icon, title, children, testId }: { icon: ReactNode; title: string; children?: ReactNode; testId?: string }) {
  return (
    <div className="empty" data-testid={testId}>
      <div className="empty-icon">{icon}</div>
      <div className="empty-title">{title}</div>
      <div className="empty-sub">{children}</div>
    </div>
  );
}

/** Fits a w×h box inside its container, like object-fit: contain. */
function useFit(width: number, height: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      const style = getComputedStyle(el);
      const aw = el.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      const ah = el.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
      const scale = Math.max(0, Math.min(aw / width, ah / height));
      setSize({ w: Math.floor(width * scale), h: Math.floor(height * scale) });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, [width, height]);
  return { ref, size };
}

function Stage({ project }: { project: Project }) {
  const { width, height, fps } = project.canvas;
  const { ref, size } = useFit(width, height);
  return (
    <main className="stage">
      <div className="stage-canvas" ref={ref}>
        <div className="frame" data-testid="preview-frame" style={{ width: size.w, height: size.h }} />
      </div>
      <div className="transport">
        <span className="timecode" data-testid="timecode">
          {timecode(0, fps)} / {timecode(0, fps)}
        </span>
        <div className="transport-mid">
          <button className="icon-btn" disabled title="Back one frame">
            <SkipBack />
          </button>
          <button className="icon-btn play" disabled title="Play: nothing to play yet">
            <Play />
          </button>
          <button className="icon-btn" disabled title="Forward one frame">
            <SkipForward />
          </button>
        </div>
        <span className="muted small" data-testid="canvas-info">
          {canvasLabel(project.canvas)}
        </span>
        <button className="icon-btn" disabled title="Fit">
          <Maximize2 />
        </button>
      </div>
    </main>
  );
}

function Side({ snapshot, project, online }: { snapshot: ProjectSnapshot; project: Project; online: boolean }) {
  const [tab, setTab] = useState<"inspector" | "agent">("inspector");
  return (
    <aside className="side">
      <div className="tabs">
        <button className={tab === "inspector" ? "active" : ""} data-testid="tab-inspector" onClick={() => setTab("inspector")}>
          Inspector
        </button>
        <button className={tab === "agent" ? "active" : ""} data-testid="tab-agent" onClick={() => setTab("agent")}>
          Agent
        </button>
      </div>
      <div className="side-body">
        {tab === "inspector" ? (
          // Keyed on the folder: switching projects drops any half-typed value with the old Inspector.
          <Inspector key={snapshot.dir} snapshot={snapshot} project={project} online={online} />
        ) : (
          <Empty icon={<Sparkles />} title="No agent yet" testId="agent-empty">
            The agent arrives in a later phase.
          </Empty>
        )}
      </div>
    </aside>
  );
}

function Inspector({ snapshot, project, online }: { snapshot: ProjectSnapshot; project: Project; online: boolean }) {
  const { appInfo } = useApp();
  const [name, setName] = useState(project.name);
  const [error, setError] = useState<string | undefined>();
  const editing = useRef(false);
  const mounted = useRef(true);
  useEffect(() => () => void (mounted.current = false), []);
  // Follow the server: any new snapshot (an undo, a reload, a reconnect's refetch) resets the
  // field unless it is being edited.
  useEffect(() => {
    if (!editing.current) setName(project.name);
  }, [snapshot, project.name]);
  // A newer revision means something succeeded since the error: it no longer applies.
  useEffect(() => setError(undefined), [snapshot.revision]);

  const commit = async () => {
    editing.current = false;
    // The draft belongs to this project. If another one is open now (or this Inspector is
    // going away), drop it rather than rename the wrong project.
    if (!mounted.current || getState().snapshot?.dir !== snapshot.dir) return;
    const next = name.trim();
    if (next === project.name) return setName(project.name);
    if (!next) {
      setName(project.name);
      return setError("A project needs a name.");
    }
    const failure = await actions.rename(next);
    if (!mounted.current || !failure) return setError(undefined);
    // Refused because of a hand edit: the banner explains; the field shows the real name again.
    if (failure.reason === "changed-on-disk") {
      setName(project.name);
      return setError(undefined);
    }
    // Lost connection: the rename may or may not have happened. Show nothing here; the
    // field follows whatever the server sends once it's back.
    if (isTransportError(failure)) return setError(undefined);
    setName(project.name);
    setError(plainError(failure));
  };

  return (
    <>
      <div className="insp-title">
        <Film />
        Project
      </div>
      <div className="insp-sub">Nothing selected. These are the project's settings.</div>
      <div className="group">
        <div className="group-label">Name</div>
        <input
          className="field input"
          data-testid="inspector-name"
          value={name}
          disabled={!online}
          maxLength={MAX_NAME_LENGTH}
          spellCheck={false}
          onFocus={() => (editing.current = true)}
          onChange={(e) => {
            setName(e.target.value);
            setError(undefined);
          }}
          onBlur={() => void commit()}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            if (e.key === "Escape") {
              editing.current = false;
              setName(project.name);
              requestAnimationFrame(() => (e.target as HTMLInputElement).blur());
            }
          }}
        />
        {error && (
          <div className="inline-error small" data-testid="inspector-error">
            {error}
          </div>
        )}
      </div>
      <div className="group">
        <div className="group-label">Canvas</div>
        <div className="field-row three">
          <Field k="W" v={project.canvas.width} />
          <Field k="H" v={project.canvas.height} />
          <Field k="FPS" v={project.canvas.fps} />
        </div>
      </div>
      <div className="group">
        <div className="group-label">Folder</div>
        <div className="folder-row">
          <span className="mono small ellipsis" data-testid="project-dir" title={snapshot.dir}>
            {shortPath(snapshot.dir, appInfo.homeDir)}
          </span>
          <button className="btn" data-testid="show-in-finder" onClick={() => void actions.showInFolder(snapshot.dir)}>
            <FolderOpen />
            Show in Finder
          </button>
        </div>
      </div>
    </>
  );
}

function Field({ k, v }: { k: string; v: ReactNode }) {
  return (
    <div className="field">
      <span className="k">{k}</span>
      <span className="v">{v}</span>
    </div>
  );
}

const SECONDS = 30;
const PX_PER_SECOND = 48;

function Timeline({ project }: { project: Project }) {
  const width = SECONDS * PX_PER_SECOND;
  const empty = project.tracks.every((t) => t.items.length === 0);
  return (
    <section className="bottom">
      <div className="bottom-toolbar">
        <div className="seg">
          <button className="active">Timeline</button>
          <button disabled title={LATER}>
            Transcript
          </button>
          <button disabled title={LATER}>
            Mixer
          </button>
        </div>
        <span className="muted small">{project.tracks.length} tracks</span>
      </div>
      <div className="bottom-body">
        <div className="tl" data-testid="timeline">
          <div className="tl-heads">
            <div className="tl-corner" />
            {project.tracks.map((track) => {
              const main = track.role === "main";
              const Icon = track.kind === "text" ? Type : track.kind === "audio" ? AudioLines : Film;
              return (
                <div key={track.id} className={`tl-head ${main ? "main" : ""}`} data-testid="track" data-kind={track.kind} data-main={main ? "true" : undefined}>
                  <div className="name">
                    <Icon />
                    {track.name}
                    {main && (
                      <span className="badge" title="Main track: clips play back to back">
                        <Magnet />
                      </span>
                    )}
                  </div>
                  <button className="icon-btn" disabled title={track.kind === "audio" ? "Mute" : "Hide"}>
                    {track.kind === "audio" ? <Volume2 /> : <Eye />}
                  </button>
                  <button className="icon-btn" disabled title="Lock">
                    <Lock />
                  </button>
                </div>
              );
            })}
          </div>
          <div className="tl-lanes" style={{ width: width + 24 }}>
            <div className="tl-ruler">
              {Array.from({ length: SECONDS + 1 }, (_, s) => (
                <div key={s} className="tick" style={{ left: s * PX_PER_SECOND }}>
                  {s % 2 === 0 && <span>{s}s</span>}
                </div>
              ))}
            </div>
            {project.tracks.map((track) => (
              <div key={track.id} className={`tl-lane ${track.role === "main" ? "main" : ""}`} />
            ))}
            <div className="playhead" style={{ left: 0 }} />
          </div>
        </div>
      </div>
      {empty && (
        <div className="tl-empty" data-testid="timeline-empty">
          {project.media.length ? "Putting clips on the timeline comes in the next phase" : "Import media to start"}
        </div>
      )}
    </section>
  );
}
