// The project's settings (G8, D119): name, canvas size with aspect presets, frame rate, background
// colour and folder. One component, shown by the Inspector when nothing is selected and by
// Settings › Project. Canvas changes are one update_project edit each (undoable, in History).
import type { ProjectSnapshot } from "@uncut/contracts";
import { FolderOpen } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { isTransportError } from "../state/connection.ts";
import { shortPath } from "../state/format.ts";
import { actions, getState, MAX_NAME_LENGTH, plainError, useApp, type Project } from "../state/store.ts";
import { ASPECTS, aspectOf, canvasSide, FPS_CHOICES, planCanvas, type Canvas } from "./canvas.ts";

const canvasEdit = (patch: Partial<Canvas>, keepPositions = false) => actions.itemEdit((p) => planCanvas(p, patch, { keepPositions }));

export function ProjectSettings({ snapshot, project, online }: { snapshot: ProjectSnapshot; project: Project; online: boolean }) {
  const { appInfo, environment } = useApp();
  const { width, height, fps } = project.canvas;
  const hasItems = project.tracks.some((t) => t.items.length);
  const aspect = aspectOf(project.canvas);
  // F10 (D155): a new size rescales what's on the canvas unless this is on.
  const [keep, setKeep] = useState(false);
  return (
    <div data-testid="project-settings">
      <ProjectName snapshot={snapshot} project={project} online={online} />
      <div className="group">
        <div className="group-label">Aspect</div>
        <div className="seg aspect-seg" data-testid="canvas-aspect">
          {ASPECTS.map((a) => (
            <button key={a.id} className={aspect === a.id ? "active" : ""} data-testid="canvas-aspect-option" data-aspect={a.id} aria-pressed={aspect === a.id} disabled={!online} onClick={() => void canvasEdit({ width: a.width, height: a.height }, keep)}>
              {a.label}
            </button>
          ))}
        </div>
      </div>
      <div className="group">
        <div className="group-label">Resolution</div>
        <div className="field-row">
          <SizeField k="W" testId="canvas-width" value={width} online={online} onCommit={(v) => void canvasEdit({ width: v }, keep)} />
          <SizeField k="H" testId="canvas-height" value={height} online={online} onCommit={(v) => void canvasEdit({ height: v }, keep)} />
        </div>
        {hasItems && (
          <label className="check-row" title="Off: clip boxes, text and elements are rescaled with the canvas">
            <input type="checkbox" data-testid="canvas-keep-positions" checked={keep} disabled={!online} onChange={(e) => setKeep(e.target.checked)} />
            Keep positions
          </label>
        )}
      </div>
      <div className="group">
        <div className="group-label">Frame rate</div>
        {/* A disabled control gets no hover, so the reason is on a wrapper (F10, D155). */}
        <span className="fps-wrap" data-testid="canvas-fps-why" title={hasItems ? "Every time in the project is counted in frames, so the frame rate is set while the timeline is empty" : undefined}>
          <select
            className="field input"
            data-testid="canvas-fps"
            value={fps}
            disabled={!online || hasItems}
            onChange={(e) => void canvasEdit({ fps: Number(e.target.value) as Canvas["fps"] })}
          >
            {FPS_CHOICES.map((f) => (
              <option key={f} value={f}>
                {f} fps
              </option>
            ))}
          </select>
        </span>
      </div>
      <div className="group">
        <div className="group-label">Background</div>
        <label className="color-row">
          <input type="color" data-testid="canvas-background" disabled={!online} value={/^#[0-9a-f]{6}$/i.test(project.canvas.background ?? "") ? project.canvas.background! : "#000000"} onChange={(e) => void canvasEdit({ background: e.target.value.toUpperCase() })} />
          <span className="mono small">{project.canvas.background ?? "#000000"}</span>
        </label>
      </div>
      <div className="group">
        <div className="group-label">Folder</div>
        <div className="folder-row">
          <span className="mono small ellipsis selectable" data-testid="project-dir" title={snapshot.dir}>
            {shortPath(snapshot.dir, appInfo.homeDir)}
          </span>
          {/* A remote project's folder is on the server, not in this Mac's Finder (D109). */}
          {environment.kind === "remote" ? (
            <span className="muted small" data-testid="project-host">
              on {environment.name}
            </span>
          ) : (
            <button className="btn" data-testid="show-in-finder" onClick={() => void actions.showInFolder(snapshot.dir)}>
              <FolderOpen />
              Show in Finder
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** A canvas side: typed, committed on Enter or blur (rounded to even), Esc puts it back. */
function SizeField({ k, testId, value, online, onCommit }: { k: string; testId: string; value: number; online: boolean; onCommit: (v: number) => void }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const commit = () => {
    const v = Number(text);
    if (!Number.isFinite(v) || v <= 0) return setText(String(value));
    if (canvasSide(v) !== value) onCommit(v);
    else setText(String(value));
  };
  return (
    <label className="field">
      <span className="k">{k}</span>
      <input
        className="v num-input"
        data-testid={testId}
        inputMode="numeric"
        value={text}
        disabled={!online}
        onChange={(e) => setText(e.target.value.replace(/[^0-9]/g, ""))}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") setText(String(value));
        }}
      />
    </label>
  );
}

function ProjectName({ snapshot, project, online }: { snapshot: ProjectSnapshot; project: Project; online: boolean }) {
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
    // The draft belongs to this project. If another one is open now (or this field is going
    // away), drop it rather than rename the wrong project.
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
  );
}
