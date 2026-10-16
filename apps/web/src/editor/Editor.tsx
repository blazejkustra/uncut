import type { ProjectSnapshot } from "@uncut/contracts";
import { Check, Focus, Minimize2, PanelBottom, PanelLeft, PanelRight, Redo2, RefreshCw, Settings as SettingsIcon, Share, TriangleAlert, Undo2, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { useBeatsLoading } from "../audio/beats.ts";
import { useDuckLoading } from "../audio/ducking.ts";
import { MixerPanel } from "../audio/Mixer.tsx";
import { EnvironmentChip } from "../onboarding/Environments.tsx";
import { NewProject } from "../onboarding/NewProject.tsx";
import { ExportDialog, exportRunning } from "../panels/ExportDialog.tsx";
import { AgentPanel } from "../panels/Agent.tsx";
import { Library, type LibraryTab } from "../panels/Library.tsx";
import { usePlayback } from "../preview/playback.ts";
import { Stage } from "../preview/Preview.tsx";
import { actions, projectOf, useApp, type Project } from "../state/store.ts";
import { Timeline } from "../timeline/Timeline.tsx";
import { ErrorToast } from "../ui/Toast.tsx";
import { Tooltip } from "../ui/Tooltip.tsx";
import { ContextMenuHost } from "../timeline/ContextMenu.tsx";
import { LinkImportHost } from "../panels/library/ImportLinkDialog.tsx";
import { useEditorKeys } from "./keys.ts";
import { keysOf, type ShortcutId } from "./keymap.ts";
import { AgentStage } from "./AgentStage.tsx";
import { markDocked, stage, stageWanted, useStageDismissed, type StageDismissal } from "./agentStage.ts";
import { layoutStyle, panels, panelShown, panelsStyle, rememberSideTab, useLayout, usePanels, type Hideable, type Panels } from "./layout.ts";
import "./layout.css";
import { Rail } from "./Rail.tsx";
import { Resizer } from "./Resizer.tsx";
import { Side } from "./Side.tsx";
import { Wordmark } from "./Wordmark.tsx";

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
  // #76 (D256): a panel asked for (the agent's ui_show, Add to chat) comes back if it was hidden.
  useEffect(() => {
    const panel = panelRequest?.panel;
    if (!panel) return;
    if (panel === "inspector" || (panel === "agent" && !panels.get().focus)) panels.show("side");
    else if (panel === "media" || panel === "text" || panel === "elements" || panel === "audio") panels.show("lib");
  }, [panelRequest]);
  // "Edit prompt" on a generated result opens the Generate tab with it (D99).
  useEffect(() => {
    if (generateDraft) setTab("generate");
  }, [generateDraft?.seq]);
  useEditorKeys(project.canvas.fps);
  useBeatsLoading(project, snapshot.dir);
  useDuckLoading(project, snapshot.dir);
  const sizes = useLayout();
  const shown = usePanels();
  const { staged, dismiss: dismissStage } = useAgentStage(project, snapshot.dir, shown.focus);
  return (
    <div
      className="app"
      data-testid="editor"
      data-focus={shown.focus || undefined}
      data-hidden={(["lib", "side", "bottom"] as const).filter((p) => !panelShown(shown, p)).join(" ") || undefined}
      style={{ ...layoutStyle(sizes), ...panelsStyle(shown) }}
    >
      <TopBar snapshot={snapshot} project={project} online={online} unsaved={changedOnDisk} shown={shown} />
      <ContextMenuHost />
      <LinkImportHost />
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
            <Tooltip label="Dismiss">
              <button className="icon-btn" onClick={() => setDismissedProblem(`${snapshot.dir}\n${historyProblem}`)}>
                <X />
              </button>
            </Tooltip>
          </div>
        )}
        {notice && !changedOnDisk && (
          // #67 (D239): closes itself after a while; hovering it keeps it.
          // D262: a transport problem stays while the connection is still down (it goes on reconnect).
          <ErrorToast text={notice.text} token={notice} onClose={actions.dismissNotice} testId="editor-error" sticky={notice.transport === true && !online} />
        )}
      </div>
      {/* #76 (D256): hidden parts aren't rendered; focus mode is the preview and the agent under it. */}
      {panelShown(shown, "lib") && <Rail tab={tab} onTab={setTab} />}
      {panelShown(shown, "lib") && <Library project={project} dir={snapshot.dir} tab={tab} onTab={setTab} />}
      <Stage key={snapshot.dir} project={project} dir={snapshot.dir} />
      {panelShown(shown, "side") && <Side snapshot={snapshot} project={project} online={online} staged={staged} onDock={() => dismissStage("link")} />}
      {shown.focus ? (
        <section className="focus-agent" data-testid="focus-agent">
          <AgentPanel project={project} online={online} />
        </section>
      ) : (
        panelShown(shown, "bottom") && <Bottom project={project} />
      )}
      {panelShown(shown, "lib") && <Resizer panel="lib" />}
      {panelShown(shown, "side") && <Resizer panel="side" />}
      {panelShown(shown, "bottom") && <Resizer panel="bottom" />}
      {/* #75 (D255): a new, empty project: the agent centre stage over the editor. */}
      {staged && !shown.focus && <AgentStage project={project} online={online} onDismiss={dismissStage} />}
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

/**
 * #75 (D255): whether the agent centre stage shows. It opens on an empty project whose agent hasn't
 * run (not in focus mode, where the agent is already under the preview), and docks into the side
 * panel's Agent tab when that stops being so (a turn starts, media lands, the user goes to the
 * editor): the composer glides there in a view transition, and the side panel comes back if hidden.
 */
function useAgentStage(project: Project, dir: string, focus: boolean): { staged: boolean; dismiss: (how: StageDismissal) => void } {
  const { agent } = useApp();
  const dismissed = useStageDismissed();
  const staged = !focus && stageWanted(project, dir, agent, dismissed);
  // The chat goes on in the Agent tab (the side panel back if hidden), sliding in from the middle.
  const dock = useCallback(() => {
    panels.show("side");
    markDocked();
    rememberSideTab(dir, "agent");
  }, [dir]);
  // A click on the editor leaves the side panel's tab alone (they clicked something there); Esc and
  // "Go to editor" dock the chat into the Agent tab.
  const dismiss = useCallback(
    (how: StageDismissal) => {
      stage.dismiss(dir);
      if (how !== "outside") dock();
    },
    [dir, dock],
  );
  // The first turn or media landing (not a dismissal, not focus mode) docks it too.
  const was = useRef({ dir, staged });
  useEffect(() => {
    const before = was.current;
    was.current = { dir, staged };
    if (before.dir === dir && before.staged && !staged && !focus && !dismissed.includes(dir)) dock();
  }, [dir, staged]);
  return { staged, dismiss };
}

/** The bottom panel (D32): the timeline or the mixer (D83). The transcript is a rail tab (U11, D177). */
function Bottom({ project }: { project: Project }) {
  const bottom = usePlayback((s) => s.bottom);
  return bottom === "mixer" ? <MixerPanel project={project} /> : <Timeline project={project} />;
}

const TOGGLES: ReadonlyArray<{ panel: Hideable; icon: typeof PanelLeft; label: string; shortcut: ShortcutId }> = [
  { panel: "lib", icon: PanelLeft, label: "left panel", shortcut: "toggleLeft" },
  { panel: "bottom", icon: PanelBottom, label: "timeline", shortcut: "toggleTimeline" },
  { panel: "side", icon: PanelRight, label: "right panel", shortcut: "toggleRight" },
];

/** #76 (D256): the top bar's way to hide and bring back each part, and focus mode: always visible. */
function LayoutToggles({ shown }: { shown: Panels }) {
  if (shown.focus)
    return (
      <Tooltip label="Leave focus mode" shortcut="focusMode">
        <button className="focus-exit" data-testid="focus-exit" onClick={() => panels.focus(false)}>
          <Minimize2 />
          Leave focus
          <kbd>{keysOf("focusMode")[0]}</kbd>
        </button>
      </Tooltip>
    );
  return (
    <div className="layout-toggles" role="group" aria-label="Panels">
      {TOGGLES.map(({ panel, icon: Icon, label, shortcut }) => {
        const on = panelShown(shown, panel);
        return (
          <Tooltip key={panel} label={`${on ? "Hide" : "Show"} the ${label}`} shortcut={shortcut}>
            <button className="icon-btn" data-testid={`toggle-${panel}`} aria-pressed={on} onClick={() => panels.toggle(panel)}>
              <Icon />
            </button>
          </Tooltip>
        );
      })}
      <Tooltip label="Focus mode: only the preview and the agent" shortcut="focusMode">
        <button className="icon-btn" data-testid="toggle-focus" aria-pressed={false} onClick={() => panels.focus(true)}>
          <Focus />
        </button>
      </Tooltip>
    </div>
  );
}

function TopBar({ snapshot, project, online, unsaved, shown }: { snapshot: ProjectSnapshot; project: Project; online: boolean; unsaved: boolean; shown: Panels }) {
  const { exportJobs, exportJobId, environment } = useApp();
  const remote = environment.kind === "remote";
  const job = exportJobs.find((j) => j.id === exportJobId && j.projectDir === snapshot.dir);
  const running = exportRunning(job);
  return (
    <header className="topbar">
      <Wordmark dir={snapshot.dir} name={project.name} />
      {/* A remote environment says so next to the project's name (D106). */}
      {remote && <EnvironmentChip />}
      <div className="topbar-spacer" />
      <LayoutToggles shown={shown} />
      <div
        className={`saved ${unsaved ? "warn" : ""}`}
        data-testid="saved"
        title={unsaved ? "project.json on disk differs from what Uncut shows" : `Saved to project.json (revision ${snapshot.revision})`}
      >
        {unsaved ? <TriangleAlert /> : online ? <Check /> : <RefreshCw />}
        {unsaved ? "Not saved" : online ? "Saved" : "Offline"}
      </div>
      {/* Nothing left to undo in this opening: the tip says why (the Tooltip shows on a disabled button too). */}
      <Tooltip label={snapshot.canUndo || !snapshot.undoStop ? "Undo" : snapshot.undoStop} {...(snapshot.canUndo || !snapshot.undoStop ? { shortcut: "undo" as const } : {})}>
        <button className="icon-btn" data-testid="undo" aria-label="Undo" disabled={!online || !snapshot.canUndo} onClick={() => void actions.undo()}>
          <Undo2 />
        </button>
      </Tooltip>
      <Tooltip label="Redo" shortcut="redo">
        <button className="icon-btn" data-testid="redo" disabled={!online || !snapshot.canRedo} onClick={() => void actions.redo()}>
          <Redo2 />
        </button>
      </Tooltip>
      <button className="btn export-btn" title="Export the video (⌘E)" data-testid="export-button" data-running={running} disabled={!online} onClick={actions.openExport}>
        <Share />
        {running && job ? (job.phase === "rendering" ? `Exporting ${Math.round(job.progress * 100)}%` : "Exporting…") : "Export"}
      </button>
      <Tooltip label="Settings" shortcut="settings">
        <button className="icon-btn" data-testid="open-settings" onClick={() => actions.openSettings()}>
          <SettingsIcon />
        </button>
      </Tooltip>
      <Tooltip label="Close project" shortcut="close">
        <button className="icon-btn" data-testid="close-project" disabled={!online} onClick={() => void actions.closeProject()}>
          <X />
        </button>
      </Tooltip>
    </header>
  );
}
