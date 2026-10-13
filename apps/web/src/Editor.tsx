import type { ProjectSnapshot } from "@uncut/contracts";
import { Blend, Check, CircleDot, Film, FolderOpen, Music, Redo2, RefreshCw, Shapes, Share, Sparkles, TriangleAlert, Type, Undo2, X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { AgentPanel } from "./Agent.tsx";
import { ExportDialog, exportRunning } from "./ExportDialog.tsx";
import { HistoryPanel } from "./History.tsx";
import { ChecksPanel, warningCount } from "./Checks.tsx";
import { isTransportError } from "./connection.ts";
import { shortPath } from "./format.ts";
import { itemLabel } from "./project.ts";
import { AudioEditor, BackgroundEditor, CaptionsEditor, ClipBoxEditor, TextEditor, TransitionInspector } from "./ItemEditors.tsx";
import { isBoxed } from "./clip.ts";
import { ComponentEditor } from "./ComponentEditor.tsx";
import { componentInfo, isDrawnComponent } from "@uncut/core/components";
import { useBeatsLoading } from "./beats.ts";
import { useDuckLoading } from "./ducking.ts";
import { hasSound } from "./sound.ts";
import { Library, type LibraryTab } from "./Library.tsx";
import { NewProject } from "./NewProject.tsx";
import { SOLID } from "@uncut/core/render";
import { findItem } from "./edit.ts";
import { frameTimecode } from "./format.ts";
import { getPlayback, playback, usePlayback } from "./playback.ts";
import { Stage } from "./Preview.tsx";
import { actions, getState, isTextEntry, MAX_NAME_LENGTH, plainError, projectOf, useApp, type Project } from "./store.ts";
import { MixerPanel } from "./Mixer.tsx";
import { Timeline } from "./Timeline.tsx";
import { cutSelectedWords, TranscriptPanel } from "./Transcript.tsx";
import { transcriptStore } from "./transcript.ts";

const LATER = "Coming in a later phase";

// Keys belong to the control while typing, picking from a list or moving a slider.
const isEditable = (el: EventTarget | null) => isTextEntry(el) || el instanceof HTMLSelectElement || (el instanceof HTMLInputElement && el.type === "range");

/**
 * Editor keys: Space plays/pauses, ←/→ step a frame (⇧ a second), Home/End jump, Esc deselects,
 * S splits at the playhead, ⌫/Delete deletes the selected item, ⌘+/⌘−/⌘0 zoom the timeline.
 * Not while typing or with a dialog open. (⌘Z/⇧⌘Z live in the store.)
 */
function useEditorKeys(fps: number) {
  useEffect(() => {
    const blocked = (e: KeyboardEvent) => isEditable(e.target) || getState().newProjectOpen || getState().setupOpen || getState().exportOpen;
    const onKeyDown = (e: KeyboardEvent) => {
      if (blocked(e) || e.altKey || e.ctrlKey) return;
      const done = () => e.preventDefault();
      if (e.metaKey) {
        if (e.key === "=" || e.key === "+") (playback.zoomIn(), done());
        else if (e.key === "-" || e.key === "_") (playback.zoomOut(), done());
        else if (e.key === "0") (playback.zoomFit(), done());
        return;
      }
      if (e.code === "Space") {
        // Also stops a focused button from being "clicked" by the same key.
        done();
        if (!e.repeat) playback.toggle();
      } else if (e.key === "ArrowLeft") (playback.step(e.shiftKey ? -fps : -1), done());
      else if (e.key === "ArrowRight") (playback.step(e.shiftKey ? fps : 1), done());
      else if (e.key === "Home") (playback.toStart(), done());
      else if (e.key === "End") (playback.toEnd(), done());
      else if (e.key === "Escape") (playback.select(undefined), transcriptStore.clear());
      else if ((e.key === "s" || e.key === "S") && !e.shiftKey) (done(), e.repeat || void actions.split());
      else if (e.key === "Backspace" || e.key === "Delete") {
        done();
        // In the Transcript panel ⌫ cuts the selected words (D69), never the timeline item it doesn't show.
        // The Mixer (D83) shows no selection, so ⌫ there deletes nothing.
        const bottom = getPlayback().bottom;
        if (!e.repeat && bottom !== "mixer") void (bottom === "transcript" ? cutSelectedWords() : actions.deleteSelected());
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === "Space" && !blocked(e)) e.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [fps]);
}

export function Editor({ snapshot }: { snapshot: ProjectSnapshot }) {
  const project = projectOf(snapshot);
  const { connection, changedOnDisk, reloadProblem, notice, newProjectOpen, exportOpen, panelRequest } = useApp();
  const online = connection === "connected";
  const [tab, setTab] = useState<LibraryTab>("media");
  // history.db can't be used (D71): said once per project and problem, dismissable.
  const [dismissedProblem, setDismissedProblem] = useState<string | undefined>();
  const historyProblem = snapshot.historyProblem && `${snapshot.dir}\n${snapshot.historyProblem}` !== dismissedProblem ? snapshot.historyProblem : undefined;
  // The agent's ui_show can open a library tab (D65).
  useEffect(() => {
    const panel = panelRequest?.panel;
    if (panel === "media" || panel === "text" || panel === "elements" || panel === "audio") setTab(panel);
  }, [panelRequest]);
  useEditorKeys(project.canvas.fps);
  useBeatsLoading(project, snapshot.dir);
  useDuckLoading(project, snapshot.dir);
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
        {historyProblem && !changedOnDisk && (
          <div className="banner warn" data-testid="history-note">
            <TriangleAlert />
            <span className="banner-text">{historyProblem}</span>
            <button className="icon-btn" title="Dismiss" onClick={() => setDismissedProblem(`${snapshot.dir}\n${historyProblem}`)}>
              <X />
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
      <Rail tab={tab} onTab={setTab} />
      <Library project={project} tab={tab} />
      <Stage key={snapshot.dir} project={project} dir={snapshot.dir} />
      <Side snapshot={snapshot} project={project} online={online} />
      <Bottom project={project} dir={snapshot.dir} />
      {exportOpen && !newProjectOpen && <ExportDialog key={snapshot.dir} project={project} dir={snapshot.dir} />}
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

/** The bottom panel (D32): the timeline, the transcript of what's on the main track, or the mixer (D83). */
function Bottom({ project, dir }: { project: Project; dir: string }) {
  const bottom = usePlayback((s) => s.bottom);
  return bottom === "transcript" ? <TranscriptPanel project={project} dir={dir} /> : bottom === "mixer" ? <MixerPanel project={project} /> : <Timeline project={project} />;
}

function TopBar({ snapshot, project, online, unsaved }: { snapshot: ProjectSnapshot; project: Project; online: boolean; unsaved: boolean }) {
  const { exportJobs, exportJobId } = useApp();
  const job = exportJobs.find((j) => j.id === exportJobId && j.projectDir === snapshot.dir);
  const running = exportRunning(job);
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
      <button className="icon-btn" title={snapshot.canUndo || !snapshot.undoStop ? "Undo (⌘Z)" : snapshot.undoStop} data-testid="undo" disabled={!online || !snapshot.canUndo} onClick={() => void actions.undo()}>
        <Undo2 />
      </button>
      <button className="icon-btn" title="Redo (⇧⌘Z)" data-testid="redo" disabled={!online || !snapshot.canRedo} onClick={() => void actions.redo()}>
        <Redo2 />
      </button>
      <button className="btn export-btn" title="Export the video (⌘E)" data-testid="export-button" data-running={running} disabled={!online} onClick={actions.openExport}>
        <Share />
        {running && job ? (job.phase === "rendering" ? `Exporting ${Math.round(job.progress * 100)}%` : "Exporting…") : "Export"}
      </button>
      <button className="icon-btn" title="Close project (⌘W)" data-testid="close-project" disabled={!online} onClick={() => void actions.closeProject()}>
        <X />
      </button>
    </header>
  );
}

// Media, Text, Elements (backgrounds), Audio and Transitions work; the rest arrive in later chunks.
const RAIL: ReadonlyArray<[string, typeof Film]> = [
  ["Capture", CircleDot],
  ["Generate", Sparkles],
];

function Rail({ tab, onTab }: { tab: LibraryTab; onTab: (tab: LibraryTab) => void }) {
  return (
    <nav className="rail">
      <button className={tab === "media" ? "active" : ""} data-testid="rail-media" title="Media" onClick={() => onTab("media")}>
        <Film />
        <span>Media</span>
      </button>
      <button className={tab === "text" ? "active" : ""} data-testid="rail-text" title="Text" onClick={() => onTab("text")}>
        <Type />
        <span>Text</span>
      </button>
      <button className={tab === "elements" ? "active" : ""} data-testid="rail-elements" title="Elements: backgrounds" onClick={() => onTab("elements")}>
        <Shapes />
        <span>Elements</span>
      </button>
      <button className={tab === "audio" ? "active" : ""} data-testid="rail-audio" title="Audio: music and sound" onClick={() => onTab("audio")}>
        <Music />
        <span>Audio</span>
      </button>
      <button className={tab === "transitions" ? "active" : ""} data-testid="rail-transitions" title="Transitions between clips on the main track" onClick={() => onTab("transitions")}>
        <Blend />
        <span>Transitions</span>
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

function Side({ snapshot, project, online }: { snapshot: ProjectSnapshot; project: Project; online: boolean }) {
  const [tab, setTab] = useState<"inspector" | "agent" | "history" | "checks">("inspector");
  const warnings = warningCount(project);
  const selected = findItem(project, usePlayback((s) => s.selected));
  // A selected cut (D73): only while the clip after it is still on the main track, after another clip.
  const cutId = usePlayback((s) => s.cut);
  const cut = findItem(project, cutId);
  const cutPlaced = cut && cut.track.role === "main" && cut.index > 0 ? cut : undefined;
  // A cut that no longer exists (its clip deleted, moved off main or first now) isn't selected any
  // more; one whose transition was undone stays selected as a hard cut.
  useEffect(() => {
    if (cutId !== undefined && !cutPlaced) playback.selectCut(undefined);
  }, [cutId, cutPlaced]);
  // ...or a side tab.
  const { panelRequest } = useApp();
  useEffect(() => {
    const panel = panelRequest?.panel;
    if (panel === "inspector" || panel === "agent" || panel === "checks") setTab(panel);
  }, [panelRequest]);
  return (
    <aside className="side">
      <div className="tabs">
        <button className={tab === "inspector" ? "active" : ""} data-testid="tab-inspector" onClick={() => setTab("inspector")}>
          Inspector
        </button>
        <button className={tab === "agent" ? "active" : ""} data-testid="tab-agent" onClick={() => setTab("agent")}>
          Agent
        </button>
        <button className={tab === "history" ? "active" : ""} data-testid="tab-history" onClick={() => setTab("history")}>
          History
        </button>
        <button className={tab === "checks" ? "active" : ""} data-testid="tab-checks" title={warnings ? `${warnings} check${warnings === 1 ? "" : "s"} to look at` : "Taste checks"} onClick={() => setTab("checks")}>
          Checks
          {warnings > 0 && (
            <span className="tab-count" data-testid="checks-count">
              {warnings}
            </span>
          )}
        </button>
      </div>
      <div className="side-body">
        {tab === "inspector" && cutPlaced ? (
          <TransitionInspector key={cutPlaced.item.id} project={project} placed={cutPlaced} online={online} />
        ) : tab === "inspector" && selected ? (
          <ItemInspector key={selected.item.id} project={project} placed={selected} />
        ) : tab === "inspector" ? (
          // Keyed on the folder: switching projects drops any half-typed value with the old Inspector.
          <Inspector key={snapshot.dir} snapshot={snapshot} project={project} online={online} />
        ) : tab === "agent" ? (
          <AgentPanel project={project} online={online} />
        ) : tab === "checks" ? (
          <ChecksPanel project={project} online={online} />
        ) : (
          <HistoryPanel key={snapshot.dir} snapshot={snapshot} online={online} />
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

const TYPE_NAMES: Readonly<Record<string, string>> = { clip: "Clip", component: "Component", graphic: "Graphic", text: "Text", captions: "Captions", audio: "Audio" };

/** The selected item: text and backgrounds get their editors (chunk 4), every item its basics (chunk 3). */
function ItemInspector({ project, placed }: { project: Project; placed: NonNullable<ReturnType<typeof findItem>> }) {
  const { item, track, start } = placed;
  const locked = track.locked === true || item.locked === true;
  const fps = project.canvas.fps;
  const tc = (f: number) => `${frameTimecode(f, fps)}`;
  const media = item.media ? project.media.find((m) => m.id === item.media) : undefined;
  const Row = ({ k, id, v, title }: { k: string; id: string; v: ReactNode; title?: string }) => (
    <div className="kv-row">
      <span className="muted">{k}</span>
      <span className="mono small" data-testid={id} title={title}>
        {v}
      </span>
    </div>
  );
  return (
    <div data-testid="inspector-item" data-item={item.id}>
      <div className="insp-title">
        {item.type === "text" || item.type === "captions" ? <Type /> : item.type === "audio" ? <Music /> : <Film />}
        <span className="ellipsis">{itemLabel(project, item)}</span>
      </div>
      <div className="insp-sub">
        {item.type === "component" && item.component === SOLID ? "Background" : (componentInfo(item.component)?.name ?? TYPE_NAMES[item.type] ?? item.type)} on {track.name}
        {locked ? ". The track is locked: unlock it in the timeline to edit it." : item.type === "captions" ? ". They follow the speech on the main track: cut the clips and the captions move with them." : ". Drag it on the timeline to move it, its edges to trim it."}
      </div>
      {item.type === "text" && <TextEditor project={project} item={item} locked={locked} />}
      {item.type === "captions" && <CaptionsEditor project={project} item={item} locked={locked} />}
      {item.type === "component" && item.component === SOLID && <BackgroundEditor project={project} item={item} locked={locked} />}
      {isDrawnComponent(item) && <ComponentEditor project={project} item={item} locked={locked} />}
      {isBoxed(project, item) && <ClipBoxEditor project={project} item={item} locked={locked} />}
      {hasSound(project, item) && <AudioEditor project={project} item={item} locked={locked} />}
      <div className="group">
        <Row k="Type" id="insp-type" v={TYPE_NAMES[item.type] ?? item.type} />
        <Row k="Track" id="insp-track" v={track.name} />
        <Row k="Start" id="insp-start" v={tc(start)} title={`frame ${start}`} />
        <Row k="Duration" id="insp-duration" v={`${(item.duration / fps).toFixed(2)}s`} title={`${item.duration} frames`} />
        {media && (
          <>
            <Row k="Media" id="insp-media" v={media.name} />
            <Row k="Source in" id="insp-in" v={tc(item.in ?? 0)} title={`frame ${item.in ?? 0}`} />
            <Row k="Source out" id="insp-out" v={tc((item.in ?? 0) + item.duration)} title={`frame ${(item.in ?? 0) + item.duration}`} />
          </>
        )}
      </div>
      <div className="hint muted small">S splits at the playhead, ⌫ deletes, Esc deselects.</div>
    </div>
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
