// #75 (D255): the agent centre stage on a new, empty project: the Agent tab (its suggestions, the
// thread and the composer) in a large card over the dimmed, blurred editor. The backdrop takes no
// pointer events: a click on the editor lands where it was aimed and sends the stage to the editor,
// as do Esc and "Go to editor". Media dropped on the card imports, as in the Media panel.
import { ArrowRight, Upload } from "lucide-react";
import React, { useEffect, useRef, useState } from "react";

import { AgentPanel } from "../panels/Agent.tsx";
import { ImportReport } from "../panels/library/ImportReport.tsx";
import { bridge } from "../state/bridge.ts";
import { actions, getState, isRemote, type Project } from "../state/store.ts";
import type { StageDismissal } from "./agentStage.ts";
import "./agentStage.css";

export function AgentStage({ project, online, onDismiss }: { project: Project; online: boolean; onDismiss: (how: StageDismissal) => void }) {
  const card = useRef<HTMLDivElement>(null);
  const [dropping, setDropping] = useState(false);
  useEffect(() => {
    const dialog = () => {
      const s = getState();
      // D266: and any other dialog on screen (Import from link…), wherever the focus is.
      return s.newProjectOpen || s.exportOpen || s.settingsOpen || s.setupOpen || s.shortcutsOpen || s.environmentsOpen || document.querySelector(".modal-layer") !== null;
    };
    // The composer's pickers take Esc first (they prevent its default).
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || dialog()) return;
      e.preventDefault();
      onDismiss("esc");
    };
    const onDown = (e: PointerEvent) => {
      const target = e.target as Element | null;
      if (!target || card.current?.contains(target) || target.closest?.(".topbar, .modal-layer, .ctx-menu, [role=menu]") || dialog()) return;
      onDismiss("outside");
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown, true);
    };
  }, [onDismiss]);

  const files = (e: React.DragEvent) => [...e.dataTransfer.types].includes("Files");
  const onDrop = (e: React.DragEvent) => {
    if (!files(e)) return;
    // Before the composer's own drop (which would make paths of videos): here media imports.
    e.preventDefault();
    e.stopPropagation();
    setDropping(false);
    if (!online || !e.dataTransfer.files.length) return;
    if (isRemote()) return void actions.uploadAndImport([...e.dataTransfer.files]);
    const paths = [...e.dataTransfer.files].map((f) => bridge.pathForFile(f)).filter((p) => p.startsWith("/"));
    if (paths.length) void actions.importMedia(paths);
  };

  return (
    <div className="agent-stage" data-testid="agent-stage">
      <div
        ref={card}
        className={`agent-stage-card ${dropping ? "dropping" : ""}`}
        data-testid="agent-stage-card"
        role="dialog"
        aria-label="Ask the agent"
        onDragOverCapture={(e) => {
          if (!files(e)) return;
          e.preventDefault();
          e.stopPropagation();
          e.dataTransfer.dropEffect = "copy";
          setDropping(true);
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropping(false);
        }}
        onDropCapture={onDrop}
      >
        <div className="agent-stage-head">
          <span className="agent-stage-kicker">New project</span>
          <span className="grow" />
          <button className="link-btn" data-testid="agent-stage-dismiss" title="Go to the editor (Esc)" onClick={() => onDismiss("link")}>
            Go to editor
            <ArrowRight />
          </button>
        </div>
        <AgentPanel project={project} online={online} />
        {/* D266: a drop that imported nothing says why here, not only in Media under the backdrop. */}
        <ImportReport testId="agent-stage-import-report" className="agent-stage-report" />
        <div className="agent-stage-foot">
          <Upload />
          Drop videos, sounds or pictures here to import them
          <span className="grow" />
          <kbd>Esc</kbd> editor
        </div>
        {dropping && (
          <div className="agent-stage-drop" data-testid="agent-stage-drop">
            <Upload />
            Import into the project
          </div>
        )}
      </div>
    </div>
  );
}
