import type { ProjectSnapshot } from "@uncut/contracts";
import { Check, Redo2, RefreshCw, Settings as SettingsIcon, Share, TriangleAlert, Undo2, X } from "lucide-react";
import { useEffect, useState } from "react";

import { useBeatsLoading } from "../audio/beats.ts";
import { useDuckLoading } from "../audio/ducking.ts";
import { MixerPanel } from "../audio/Mixer.tsx";
import { EnvironmentChip } from "../onboarding/Environments.tsx";
import { NewProject } from "../onboarding/NewProject.tsx";
import { ExportDialog, exportRunning } from "../panels/ExportDialog.tsx";
import { Library, type LibraryTab } from "../panels/Library.tsx";
import { usePlayback } from "../preview/playback.ts";
import { Stage } from "../preview/Preview.tsx";
import { actions, projectOf, useApp, type Project } from "../state/store.ts";
import { Timeline } from "../timeline/Timeline.tsx";
import { ErrorToast } from "../ui/Toast.tsx";
import { ContextMenuHost } from "../timeline/ContextMenu.tsx";
import { useEditorKeys } from "./keys.ts";
import { layoutStyle, useLayout } from "./layout.ts";
import { Rail } from "./Rail.tsx";
import { Resizer } from "./Resizer.tsx";
import { Side } from "./Side.tsx";

export function Editor({ snapshot }: { snapshot: ProjectSnapshot }) {
  const project = projectOf(snapshot);
  const { connection, changedOnDisk, reloadProblem, notice, newProjectOpen, exportOpen, panelRequest, generateDraft, environment, environmentProblem } = useApp();
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
  // "Edit prompt" on a generated result opens the Generate tab with it (D99).
  useEffect(() => {
    if (generateDraft) setTab("generate");
  }, [generateDraft?.seq]);
  useEditorKeys(project.canvas.fps);
  useBeatsLoading(project, snapshot.dir);
  useDuckLoading(project, snapshot.dir);
  const sizes = useLayout();
  return (
    <div className="app" data-testid="editor" style={layoutStyle(sizes)}>
      <TopBar snapshot={snapshot} project={project} online={online} unsaved={changedOnDisk} />
      <ContextMenuHost />
      <div className="banners">
        {!online && (
          <div className="banner" data-testid="connection-banner" data-state={connection}>
            <RefreshCw className={connection === "reconnecting" ? "spin" : ""} />
            <span className="banner-text">
              {environment.kind === "remote"
                ? `${connection === "reconnecting" ? "Reconnecting to" : "Connecting to"} ${environment.name}… Changes are paused.${environmentProblem ? ` ${environmentProblem}` : ""}`
                : connection === "reconnecting"
                  ? "Reconnecting to the server… Changes are paused."
                  : connection === "server-exited"
                    ? "The server stopped. Restart Uncut to keep editing."
                    : "Connecting to the server…"}
            </span>
            {environment.kind === "remote" && (
              <button className="btn ghost" data-testid="banner-environments" onClick={() => void actions.openEnvironments()}>
                Environments…
              </button>
            )}
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
          // #67 (D239): closes itself after a while; hovering it keeps it.
          <ErrorToast text={notice.text} token={notice} onClose={actions.dismissNotice} testId="editor-error" />
        )}
      </div>
      <Rail tab={tab} onTab={setTab} />
      <Library project={project} dir={snapshot.dir} tab={tab} onTab={setTab} />
      <Stage key={snapshot.dir} project={project} dir={snapshot.dir} />
      <Side snapshot={snapshot} project={project} online={online} />
      <Bottom project={project} />
      <Resizer panel="lib" />
      <Resizer panel="side" />
      <Resizer panel="bottom" />
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

/** The bottom panel (D32): the timeline or the mixer (D83). The transcript is a rail tab (U11, D177). */
function Bottom({ project }: { project: Project }) {
  const bottom = usePlayback((s) => s.bottom);
  return bottom === "mixer" ? <MixerPanel project={project} /> : <Timeline project={project} />;
}

function TopBar({ snapshot, project, online, unsaved }: { snapshot: ProjectSnapshot; project: Project; online: boolean; unsaved: boolean }) {
  const { exportJobs, exportJobId, environment } = useApp();
  const remote = environment.kind === "remote";
  const job = exportJobs.find((j) => j.id === exportJobId && j.projectDir === snapshot.dir);
  const running = exportRunning(job);
  return (
    <header className="topbar">
      <div className="brand">Uncut</div>
      {/* A remote environment says so where the project's name is (D106). */}
      {remote && <EnvironmentChip />}
      <div className="project-title" data-testid="project-title" title={snapshot.dir}>
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
      <button className="icon-btn" title="Settings (⌘,)" data-testid="open-settings" onClick={() => actions.openSettings()}>
        <SettingsIcon />
      </button>
      <button className="icon-btn" title="Close project (⌘W)" data-testid="close-project" disabled={!online} onClick={() => void actions.closeProject()}>
        <X />
      </button>
    </header>
  );
}
