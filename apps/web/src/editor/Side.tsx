// The side panel: Inspector (the selected item, a selected cut's transition, or the project's
// settings when nothing is selected), Agent and History. Split out of Editor.tsx.
import type { ProjectSnapshot } from "@uncut/contracts";
import { componentInfo, isDrawnComponent } from "@uncut/core/components";
import { SOLID } from "@uncut/core/render";
import { Film, Music, Type } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { hasSound } from "../audio/sound.ts";
import { AgentPanel } from "../panels/Agent.tsx";
import { ComponentEditor } from "../panels/ComponentEditor.tsx";
import { HistoryPanel } from "../panels/History.tsx";
import { AudioEditor, BackgroundEditor, CaptionsEditor, ClipBoxEditor, TextEditor, TransitionInspector } from "../panels/ItemEditors.tsx";
import { playback, usePlayback } from "../preview/playback.ts";
import { ProjectSettings } from "../settings/ProjectSettings.tsx";
import { frameTimecode } from "../state/format.ts";
import { itemLabel } from "../state/project.ts";
import { useApp, type Project } from "../state/store.ts";
import { isBoxed } from "../timeline/clip.ts";
import { findItem } from "../timeline/edit.ts";

export function Side({ snapshot, project, online }: { snapshot: ProjectSnapshot; project: Project; online: boolean }) {
  const [tab, setTab] = useState<"inspector" | "agent" | "history">("inspector");
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
    // The Checks tab is gone (K1, D121): a request for it is a no-op.
    if (panel === "inspector" || panel === "agent") setTab(panel);
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
      </div>
      <div className="side-body">
        {tab === "inspector" && cutPlaced ? (
          <TransitionInspector key={cutPlaced.item.id} project={project} placed={cutPlaced} online={online} />
        ) : tab === "inspector" && selected ? (
          <ItemInspector key={selected.item.id} project={project} placed={selected} />
        ) : tab === "inspector" ? (
          // Keyed on the folder: switching projects drops any half-typed value with the old Inspector.
          <ProjectInspector key={snapshot.dir} snapshot={snapshot} project={project} online={online} />
        ) : tab === "agent" ? (
          <AgentPanel project={project} online={online} />
        ) : (
          <HistoryPanel key={snapshot.dir} snapshot={snapshot} online={online} />
        )}
      </div>
    </aside>
  );
}

function ProjectInspector({ snapshot, project, online }: { snapshot: ProjectSnapshot; project: Project; online: boolean }) {
  return (
    <>
      <div className="insp-title">
        <Film />
        Project
      </div>
      <ProjectSettings snapshot={snapshot} project={project} online={online} />
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
        {locked ? ", locked" : ""}
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
    </div>
  );
}
