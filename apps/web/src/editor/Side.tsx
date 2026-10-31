// The side panel: Inspector (the selected item, a selected cut's transition, or the project's
// settings when nothing is selected), Agent and History. Split out of Editor.tsx.
import type { ProjectSnapshot } from "@uncut/contracts";
import { componentInfo, isDrawnComponent } from "@uncut/core/components";
import { SOLID } from "@uncut/core/render";
import { AtSign, Film, Music, Type } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { hasSound } from "../audio/sound.ts";
import { AgentPanel } from "../panels/Agent.tsx";
import { ComponentEditor } from "../inspector/component.tsx";
import { GraphicElementsEditor } from "../inspector/graphic.tsx";
import { HistoryPanel } from "../panels/History.tsx";
import { AudioEditor } from "../inspector/audio.tsx";
import { hasSpeed, NamesEditor, SpeedEditor } from "../inspector/speed.tsx";
import { BackgroundEditor } from "../inspector/background.tsx";
import { CaptionsEditor } from "../inspector/captions.tsx";
import { ClipBoxEditor } from "../inspector/clip.tsx";
import { EffectsEditor } from "../inspector/effects.tsx";
import { MultiInspector } from "../inspector/multi.tsx";
import { Section } from "../inspector/controls.tsx";
import { fxSkips } from "@uncut/core/fx";
import { TextEditor } from "../inspector/text.tsx";
import { TransitionInspector } from "../inspector/transition.tsx";
import { playback, usePlayback } from "../preview/playback.ts";
import { ProjectSettings } from "../settings/ProjectSettings.tsx";
import { frameTimecode } from "../state/format.ts";
import { itemLabel, layoutOf } from "../state/project.ts";
import { actions, useApp, type Project } from "../state/store.ts";
import { isBoxed } from "../timeline/clip.ts";
import { findItem } from "../timeline/edit.ts";
import { rememberedSideTab, rememberSideTab, type SideTab } from "./layout.ts";
import { useDocking } from "./agentStage.ts";

/** `staged` (#75, D255): the agent is centre stage; the Agent tab says so (one AgentPanel at a time). */
export function Side({
  snapshot,
  project,
  online,
  staged = false,
  onDock,
}: {
  snapshot: ProjectSnapshot;
  project: Project;
  online: boolean;
  staged?: boolean;
  onDock?: () => void;
}) {
  // U14 (D180): each project keeps the tab it was left on; a new project starts on the Agent.
  const [tab, setTabState] = useState<SideTab>(() => rememberedSideTab(snapshot.dir) ?? "inspector");
  const [tabDir, setTabDir] = useState(snapshot.dir);
  if (tabDir !== snapshot.dir) {
    setTabDir(snapshot.dir);
    setTabState(rememberedSideTab(snapshot.dir) ?? "inspector");
  }
  useEffect(() => {
    const onRemembered = (e: Event) => {
      const { dir, tab: next } = (e as CustomEvent<{ dir: string; tab: SideTab }>).detail;
      if (dir === snapshot.dir) setTabState(next);
    };
    window.addEventListener("uncut:side-tab", onRemembered);
    return () => window.removeEventListener("uncut:side-tab", onRemembered);
  }, [snapshot.dir]);
  const setTab = (next: SideTab) => {
    setTabState(next);
    rememberSideTab(snapshot.dir, next);
  };
  const selectedId = usePlayback((s) => s.selected);
  const also = usePlayback((s) => s.also);
  const selected = findItem(project, selectedId);
  // F2 (D147): several items selected: what they share, edited on all of them at once.
  // Texts only keep the text Inspector, which already restyles every selected text at once (X3).
  const picked = selected ? [selected.item.id, ...also.filter((id) => findItem(project, id))] : [];
  const many = picked.every((id) => findItem(project, id)?.item.type === "text") ? [] : picked;
  // A selected cut (D73): only while the clip after it is still on the main track, after another clip.
  const cutId = usePlayback((s) => s.cut);
  const cut = findItem(project, cutId);
  // D224: not when a gap is before it (the clips don't meet).
  const cutPlaced = cut && cut.track.role === "main" && cut.index > 0 && !((cut.item.gap ?? 0) > 0) ? cut : undefined;
  // A cut that no longer exists (its clip deleted, moved off main or first now) isn't selected any
  // more; one whose transition was undone stays selected as a hard cut.
  useEffect(() => {
    if (cutId !== undefined && !cutPlaced) playback.selectCut(undefined);
  }, [cutId, cutPlaced]);
  // ...or a side tab.
  const { panelRequest } = useApp();
  const docking = useDocking();
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
      <div className={`side-body ${docking ? "docking" : ""}`}>
        {tab === "inspector" && cutPlaced ? (
          <TransitionInspector key={cutPlaced.item.id} project={project} placed={cutPlaced} online={online} />
        ) : tab === "inspector" && many.length > 1 ? (
          <MultiInspector project={project} ids={many} />
        ) : tab === "inspector" && selected ? (
          <ItemInspector key={selected.item.id} project={project} placed={selected} />
        ) : tab === "inspector" ? (
          // Keyed on the folder: switching projects drops any half-typed value with the old Inspector.
          <ProjectInspector key={snapshot.dir} snapshot={snapshot} project={project} online={online} />
        ) : tab === "agent" && staged ? (
          <div className="side-staged" data-testid="side-staged">
            The chat is open in the middle of the window.
            <button className="btn" data-testid="side-dock" onClick={onDock}>
              Move it here
            </button>
          </div>
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

const TYPE_NAMES: Readonly<Record<string, string>> = {
  clip: "Clip",
  component: "Component",
  graphic: "Graphic",
  text: "Text",
  captions: "Captions",
  audio: "Audio",
};

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
        <span className="ellipsis grow">{itemLabel(project, item)}</span>
        {/* D141: this item as a chip in the Agent tab's composer. */}
        <button
          className="small-btn insp-chat"
          data-testid="insp-add-to-chat"
          title="Add this item to the agent chat"
          onClick={() => actions.addItemToChat(item.id)}
        >
          <AtSign />
          Add to chat
        </button>
      </div>
      <div className="insp-sub">
        {item.type === "component" && item.component === SOLID
          ? "Background"
          : (componentInfo(item.component)?.name ?? TYPE_NAMES[item.type] ?? item.type)} on{" "}
        {track.name}
        {locked ? ", locked" : ""}
      </div>
      {item.type === "text" && <TextEditor project={project} item={item} locked={locked} />}
      {item.type === "captions" && <CaptionsEditor project={project} item={item} locked={locked} />}
      {item.type === "component" && item.component === SOLID && <BackgroundEditor project={project} item={item} locked={locked} />}
      {isDrawnComponent(item) && <ComponentEditor project={project} item={item} locked={locked} />}
      {item.type === "graphic" && <GraphicElementsEditor project={project} item={item} start={layoutOf(project).starts.get(item.id) ?? 0} locked={locked} />}
      {/* F17 (D160): the clip's controls in sections that fold, each one's state remembered on this Mac. */}
      {isBoxed(project, item) && (
        <Section title="Transform" testId="insp-sec-transform" remember="transform">
          <ClipBoxEditor project={project} item={item} locked={locked} />
        </Section>
      )}
      {item.type === "clip" && media && media.kind !== "audio" && !fxSkips(media) && <EffectsEditor project={project} item={item} locked={locked} />}
      {hasSpeed(project, item) && (
        <Section title="Speed" testId="insp-sec-speed" remember="speed">
          <SpeedEditor project={project} item={item} locked={locked} />
        </Section>
      )}
      {hasSound(project, item) && (
        <Section title="Audio" testId="insp-sec-audio" remember="audio">
          <AudioEditor project={project} item={item} locked={locked} />
        </Section>
      )}
      {item.mute && (
        <div className="group" data-testid="insp-muted">
          <div className="group-label row">
            Sound off
            <button className="small-btn" data-testid="insp-unmute" disabled={locked} onClick={() => void actions.toggleItem(item.id, "mute")}>
              Unmute
            </button>
          </div>
        </div>
      )}
      <Section title="Advanced" testId="insp-sec-advanced" remember="advanced">
        <NamesEditor project={project} item={item} locked={locked} />
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
      </Section>
    </div>
  );
}
