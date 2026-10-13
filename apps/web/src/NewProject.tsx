import { ArrowRight } from "lucide-react";
import { useState } from "react";

import { CANVAS_PRESETS, canvasLabel, shortPath } from "./format.ts";
import { actions, MAX_NAME_LENGTH, useApp } from "./store.ts";

export function NewProject() {
  const { appInfo } = useApp();
  const [name, setName] = useState("Untitled");
  const [preset, setPreset] = useState(CANVAS_PRESETS[0]!.id);
  const [parentDir, setParentDir] = useState(appInfo.defaultParentDir);
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  const choose = async () => {
    const dir = await actions.chooseParentFolder();
    if (dir) setParentDir(dir);
  };
  const create = async () => {
    const canvas = CANVAS_PRESETS.find((p) => p.id === preset)!.canvas;
    if (!name.trim()) return setError("A project needs a name.");
    setBusy(true);
    setError(await actions.createProject({ parentDir, name: name.trim(), canvas }));
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
      <div className="wiz-cards four">
        {CANVAS_PRESETS.map((p) => (
          <button type="button" key={p.id} className={`wiz-card ${p.id === preset ? "active" : ""}`} data-preset={p.id} onClick={() => setPreset(p.id)}>
            <div className="wiz-shape-box">
              <div className="wiz-shape" style={{ aspectRatio: `${p.canvas.width} / ${p.canvas.height}` }} />
            </div>
            {p.label}
            <span>
              {p.ratio}, {p.canvas.width}×{p.canvas.height}
            </span>
            <span>{p.canvas.fps} fps</span>
          </button>
        ))}
      </div>
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
      <p className="wiz-meta">
        Creates <span className="mono">{name.trim() || "…"}.uncut</span> in that folder, as{" "}
        {canvasLabel(CANVAS_PRESETS.find((p) => p.id === preset)!.canvas)}.
      </p>
      {error && (
        <div className="inline-error" role="alert" data-testid="form-error">
          {error}
        </div>
      )}
      <div className="wiz-foot">
        <button type="button" className="btn ghost" onClick={actions.hideNewProject}>
          Cancel
        </button>
        <button type="submit" className="btn primary" data-testid="create" disabled={busy || !parentDir || !name.trim()}>
          Create project
          <ArrowRight />
        </button>
      </div>
    </form>
  );
}
