// The New project form (D209, issue #15): eight presets and a Custom card (width, height with an
// aspect lock, background colour), a frame rate for either (D295: a preset sets it, the select
// overrides it), and "Match first clip" (the first video brought in sets the size and frame rate;
// the server does it in that import's edit). Cancel and Create stay pinned under the scroll (D295).
import { ArrowRight, Link2, Link2Off, SlidersHorizontal } from "lucide-react";
import { useState } from "react";

import { FPS_CHOICES, canvasSide } from "../settings/canvas.ts";
import { CANVAS_PRESETS, canvasLabel, fpsLabel, shortPath, type Canvas } from "../state/format.ts";
import { actions, MAX_NAME_LENGTH, useApp } from "../state/store.ts";
import { Tooltip } from "../ui/Tooltip.tsx";

const CUSTOM = "custom";
const DEFAULT_BACKGROUND = "#000000";

/** A typed side: whole pixels, even, 16 to 8192. */
const sideOf = (text: string) => {
  const n = Number(text);
  return Number.isFinite(n) && n > 0 ? canvasSide(n) : undefined;
};

export function NewProject() {
  const { appInfo } = useApp();
  const [name, setName] = useState("Untitled");
  const [preset, setPreset] = useState(CANVAS_PRESETS[0]!.id);
  const [parentDir, setParentDir] = useState(appInfo.defaultParentDir);
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [width, setWidth] = useState("1920");
  const [height, setHeight] = useState("1080");
  const [lock, setLock] = useState(true);
  // The width ÷ height the lock keeps (taken when it's turned on or Custom is picked).
  const [ratio, setRatio] = useState(16 / 9);
  const [fps, setFps] = useState<Canvas["fps"]>(30);
  const [background, setBackground] = useState(DEFAULT_BACKGROUND);
  const [match, setMatch] = useState(false);

  const custom = preset === CUSTOM;
  const customCanvas = (): Canvas | undefined => {
    const w = sideOf(width);
    const h = sideOf(height);
    if (!w || !h) return undefined;
    return { width: w, height: h, fps, ...(background !== DEFAULT_BACKGROUND ? { background } : {}) };
  };
  const canvas = custom ? customCanvas() : { ...CANVAS_PRESETS.find((p) => p.id === preset)!.canvas, fps };
  /** A preset brings its own frame rate; the select changes it afterwards. */
  const pickPreset = (id: string) => {
    const p = CANVAS_PRESETS.find((x) => x.id === id);
    if (p) setFps(p.canvas.fps);
    setPreset(id);
  };

  /** One side typed: with the lock on, the other follows the locked ratio. */
  const typed = (which: "w" | "h", text: string) => {
    (which === "w" ? setWidth : setHeight)(text);
    const next = Number(text);
    if (!lock || !(next >= 16)) return;
    if (which === "w") setHeight(String(canvasSide(next / ratio)));
    else setWidth(String(canvasSide(next * ratio)));
  };
  const toggleLock = () => {
    const w = Number(width);
    const h = Number(height);
    if (!lock && w > 0 && h > 0) setRatio(w / h);
    setLock(!lock);
  };
  const pickCustom = () => {
    // Custom starts from the preset that was picked.
    const from = CANVAS_PRESETS.find((p) => p.id === preset)?.canvas;
    if (from) {
      setWidth(String(from.width));
      setHeight(String(from.height));
      setRatio(from.width / from.height);
    }
    setPreset(CUSTOM);
  };

  const choose = async () => {
    const dir = await actions.chooseParentFolder();
    if (dir) setParentDir(dir);
  };
  const create = async () => {
    if (!name.trim()) return setError("A project needs a name.");
    if (!canvas) return setError("The width and height are whole pixels from 16 to 8192.");
    setBusy(true);
    setError(await actions.createProject({ parentDir, name: name.trim(), canvas, ...(match ? { matchFirstClip: true } : {}) }));
    setBusy(false);
  };

  return (
    <form
      className="new-project"
      data-testid="new-project-form"
      onSubmit={(e) => {
        e.preventDefault();
        void create();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          actions.hideNewProject();
        }
      }}
    >
      <h1>New project</h1>
      <p className="wiz-lead">Pick a shape. You can change it later.</p>
      <div className="wiz-cards four presets">
        {CANVAS_PRESETS.map((p) => (
          <button type="button" key={p.id} className={`wiz-card ${p.id === preset ? "active" : ""}`} data-preset={p.id} onClick={() => pickPreset(p.id)}>
            <div className="wiz-shape-box">
              <div className="wiz-shape" style={{ aspectRatio: `${p.canvas.width} / ${p.canvas.height}` }} />
            </div>
            {p.label}
            <span>
              {p.ratio}, {p.canvas.width}×{p.canvas.height}
            </span>
            <span>{fpsLabel(p.id === preset ? fps : p.canvas.fps)}</span>
          </button>
        ))}
      </div>
      <button type="button" className={`wiz-card custom-card ${custom ? "active" : ""}`} data-preset={CUSTOM} data-testid="custom-canvas" onClick={pickCustom}>
        <SlidersHorizontal />
        <span className="custom-card-text">
          Custom
          <span>{custom && canvas ? canvasLabel(canvas) : "Your own size and background"}</span>
        </span>
      </button>
      {custom && (
        <div className="custom-fields" data-testid="custom-fields">
          <label className="wiz-mini">
            <span>Width</span>
            <input data-testid="custom-width" inputMode="numeric" value={width} onChange={(e) => typed("w", e.target.value)} onBlur={() => sideOf(width) && setWidth(String(sideOf(width)))} />
          </label>
          <Tooltip label={lock ? "The height follows the width" : "Width and height are free"}>
            <button type="button" className={`icon-btn aspect-lock ${lock ? "on" : ""}`} data-testid="custom-lock" aria-pressed={lock} onClick={toggleLock}>
              {lock ? <Link2 /> : <Link2Off />}
            </button>
          </Tooltip>
          <label className="wiz-mini">
            <span>Height</span>
            <input data-testid="custom-height" inputMode="numeric" value={height} onChange={(e) => typed("h", e.target.value)} onBlur={() => sideOf(height) && setHeight(String(sideOf(height)))} />
          </label>
          <label className="wiz-mini colour">
            <span>Background</span>
            <input type="color" data-testid="custom-background" value={background} onChange={(e) => setBackground(e.target.value)} />
          </label>
        </div>
      )}
      <div className="fps-row">
        <label className="wiz-mini">
          <span>Frame rate</span>
          <select data-testid="custom-fps" value={String(fps)} onChange={(e) => setFps(Number(e.target.value) as Canvas["fps"])}>
            {FPS_CHOICES.map((r) => (
              <option key={r} value={String(r)}>
                {fpsLabel(r)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="wiz-toggle" title="The first video you bring in sets the size and frame rate, while the timeline is still empty">
        <input type="checkbox" data-testid="match-first-clip" checked={match} onChange={(e) => setMatch(e.target.checked)} />
        Match first clip
        <span>Size and frame rate from the first video you add</span>
      </label>
      <div className="wiz-list form-fields">
        <label className="wiz-field">
          <span>Name</span>
          <input data-testid="project-name" maxLength={MAX_NAME_LENGTH} value={name} onChange={(e) => setName(e.target.value)} autoFocus spellCheck={false} />
        </label>
        <div className="wiz-field">
          <span>Folder</span>
          <b className="ellipsis" data-testid="parent-dir" title={parentDir}>
            {parentDir ? shortPath(parentDir, appInfo.homeDir) : "Choose a folder"}
          </b>
          <button type="button" className="btn ghost" data-testid="choose-folder" onClick={() => void choose()}>
            Choose…
          </button>
        </div>
      </div>
      <p className="wiz-meta" data-testid="new-project-meta">
        Creates <span className="mono">{name.trim() || "…"}.uncut</span> in that folder, as {canvas ? canvasLabel(canvas) : "…"}
        {match ? " until the first video sets it" : ""}.
      </p>
      {error && (
        <div className="inline-error" role="alert" data-testid="form-error">
          {error}
        </div>
      )}
      <div className="wiz-foot new-project-foot" data-testid="new-project-foot">
        <button type="button" className="btn ghost" onClick={actions.hideNewProject}>
          Cancel
        </button>
        <button type="submit" className="btn primary" data-testid="create" disabled={busy || !parentDir || !name.trim() || !canvas}>
          Create project
          <ArrowRight />
        </button>
      </div>
    </form>
  );
}
