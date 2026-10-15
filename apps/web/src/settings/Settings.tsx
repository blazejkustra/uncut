// Settings (G8, D119): ⌘, or Uncut › Settings…. Project (the open project's name, canvas, frame
// rate, background, folder: the same component as the Inspector's), App (what this Mac remembers:
// snapping, panel sizes, the rail's order; the agents and capture setup; environments) and the
// keyboard shortcuts. Esc or a click outside closes it.
import { setSkipStoryboard, useSkipStoryboard } from "../state/agentPrefs.ts";
import { Clapperboard, Keyboard, SlidersHorizontal, X } from "lucide-react";
import { useEffect } from "react";

import { layout, RAIL_KEY } from "../editor/layout.ts";
import { playback, usePlayback } from "../preview/playback.ts";
import { actions, projectOf, useApp, type SettingsSection } from "../state/store.ts";
import { ProjectSettings } from "./ProjectSettings.tsx";
import { ShortcutList } from "./Shortcuts.tsx";
import { DefaultLengths } from "./DefaultLengths.tsx";
import { setProxiesOn, useProxiesOn } from "./proxies.ts";
import { DefaultCaptionStyleRow } from "../inspector/captionStyles.tsx";

const SECTIONS: ReadonlyArray<{ readonly id: SettingsSection; readonly label: string; readonly icon: typeof X }> = [
  { id: "project", label: "Project", icon: Clapperboard },
  { id: "app", label: "App", icon: SlidersHorizontal },
  { id: "shortcuts", label: "Shortcuts", icon: Keyboard },
];

export function Settings() {
  const { snapshot, settingsSection, connection } = useApp();
  const online = connection === "connected";
  const section = settingsSection === "project" && !snapshot ? "app" : settingsSection;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Esc in a field puts its value back first (the field's own handler); the next one closes.
      if (document.activeElement instanceof HTMLInputElement && document.activeElement.type !== "color") return void document.activeElement.blur();
      e.preventDefault();
      e.stopImmediatePropagation();
      actions.closeSettings();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
  return (
    <div className="modal-layer" data-testid="settings" onPointerDown={(e) => e.target === e.currentTarget && actions.closeSettings()}>
      <div className="modal settings-modal">
        <nav className="settings-nav">
          <div className="settings-title">Settings</div>
          {SECTIONS.map((s) => {
            const Icon = s.icon;
            return (
              <button key={s.id} className={section === s.id ? "active" : ""} data-testid={`settings-nav-${s.id}`} disabled={s.id === "project" && !snapshot} onClick={() => actions.openSettings(s.id)}>
                <Icon />
                {s.label}
              </button>
            );
          })}
        </nav>
        <div className="settings-body" data-testid={`settings-${section}`}>
          <div className="sheet-head">
            <span className="grow">{SECTIONS.find((s) => s.id === section)!.label}</span>
            <button className="icon-btn" title="Close (Esc)" data-testid="settings-close" onClick={actions.closeSettings}>
              <X />
            </button>
          </div>
          {section === "project" && snapshot && <ProjectSettings key={snapshot.dir} snapshot={snapshot} project={projectOf(snapshot)} online={online} />}
          {section === "app" && <AppSettings />}
          {section === "shortcuts" && <ShortcutList />}
        </div>
      </div>
    </div>
  );
}

function AppSettings() {
  const snapping = usePlayback((s) => s.snapping);
  const proxies = useProxiesOn();
  return (
    <div data-testid="app-settings">
      <div className="group">
        <div className="group-label">Timeline</div>
        <label className="check-row">
          <input type="checkbox" data-testid="settings-snapping" checked={snapping} onChange={playback.toggleSnapping} />
          Snap to the playhead, item edges and beats
        </label>
      </div>
      <DefaultLengths />
      <div className="group">
        <div className="group-label">Preview</div>
        <label className="check-row">
          <input type="checkbox" data-testid="settings-proxies" checked={proxies} onChange={(e) => setProxiesOn(e.target.checked)} />
          Use proxies for preview
        </label>
      </div>
      <div className="group">
        <div className="group-label">Captions</div>
        <DefaultCaptionStyleRow />
      </div>
      <div className="group">
        <div className="group-label">Layout</div>
        <div className="settings-buttons">
          <button className="btn" data-testid="settings-reset-layout" onClick={() => (["lib", "side", "bottom"] as const).forEach((p) => layout.reset(p))}>
            Reset panel sizes
          </button>
          <button
            className="btn"
            data-testid="settings-reset-rail"
            onClick={() => {
              localStorage.removeItem(RAIL_KEY);
              window.dispatchEvent(new Event("uncut:rail-reset"));
            }}
          >
            Reset tab order
          </button>
        </div>
      </div>
      <div className="group">
        <div className="group-label">Saving</div>
        <div className="kv-row">
          <span className="muted">Autosave</span>
          <span data-testid="settings-autosave">Every change, to project.json</span>
        </div>
      </div>
      <AgentSettings />
      <div className="group">
        <div className="group-label">Agents, capture and plugins</div>
        <div className="settings-buttons">
          <button className="btn" data-testid="settings-setup" onClick={() => actions.openSetup()}>
            Agents and setup…
          </button>
          <button className="btn" data-testid="settings-open-environments" onClick={() => (actions.closeSettings(), void actions.openEnvironments())}>
            Environments…
          </button>
        </div>
      </div>
    </div>
  );
}

/** D188: the agent's storyboard gate. */
function AgentSettings() {
  const skip = useSkipStoryboard();
  return (
    <div className="group">
      <div className="group-label">Agent</div>
      <label className="check-row">
        <input type="checkbox" data-testid="settings-skip-storyboard" checked={skip} onChange={(e) => setSkipStoryboard(e.target.checked)} />
        Edit freely skips the storyboard approval
      </label>
    </div>
  );
}
