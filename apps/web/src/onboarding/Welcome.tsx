import { ChevronRight, Clapperboard, FolderOpen, Plus, Settings2 } from "lucide-react";

import { shortPath } from "../state/format.ts";
import { NewProject } from "./NewProject.tsx";
import { StatusLine } from "../panels/StatusLine.tsx";
import { EnvironmentChip } from "./Environments.tsx";
import { actions, useApp } from "../state/store.ts";

export function Welcome() {
  const { recents, appInfo, welcomeError, newProjectOpen, connection, environment } = useApp();
  const remote = environment.kind === "remote";
  const offline = connection !== "connected";
  return (
    <div className="welcome" data-testid="welcome">
      <div className="welcome-drag" />
      <div className="modal wiz welcome-card">
        <div className="wiz-header row">
          <div className="wiz-brand">Uncut</div>
          <div className="grow" />
          <EnvironmentChip />
          <button className="link-btn" data-testid="open-setup" onClick={actions.openSetup} disabled={offline} title="Check agents, Argent and ffmpeg">
            <Settings2 />
            Setup
          </button>
        </div>
        <div className="wiz-panel">
          {newProjectOpen ? (
            <NewProject />
          ) : (
            <>
              <h1>Start a video</h1>
              <p className="wiz-lead" data-testid="welcome-lead">
                {remote ? `Projects here live on ${environment.name}: its folders, its footage, its exports.` : "A project is a folder on this Mac. Your footage stays where it is."}
              </p>
              <div className="welcome-actions">
                <button className="wiz-card" data-testid="new-project" onClick={actions.showNewProject} disabled={offline}>
                  <Plus />
                  New project
                  <span>Pick a shape and a folder</span>
                </button>
                <button className="wiz-card" data-testid="open-project" onClick={() => void actions.openWithDialog()} disabled={offline}>
                  <FolderOpen />
                  Open…
                  <span>A .uncut folder</span>
                </button>
              </div>
              {welcomeError && (
                <div className="inline-error" role="alert" data-testid="welcome-error">
                  {welcomeError}
                </div>
              )}
              <h3 className="welcome-label">Recent</h3>
              {recents.length === 0 ? (
                <p className="muted welcome-empty" data-testid="no-recents">
                  No recent projects yet.
                </p>
              ) : (
                <div className="wiz-list" data-testid="recents">
                  {recents.map((r) => (
                    <button key={r.dir} className="wiz-row recent" data-testid="recent" onClick={() => void actions.openProject(r.dir)} disabled={offline} title={r.dir}>
                      <Clapperboard />
                      <div className="grow">
                        <div className="wiz-name">{r.name}</div>
                        <div className="wiz-sub ellipsis">{shortPath(r.dir, appInfo.homeDir)}</div>
                      </div>
                      <ChevronRight className="chev" />
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
        <div className="welcome-foot">
          <StatusLine />
        </div>
      </div>
    </div>
  );
}
