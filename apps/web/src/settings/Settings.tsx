// Settings (G8, D119): ⌘, or Uncut › Settings…. Project (the open project's name, canvas, frame
// rate, background, folder: the same component as the Inspector's), App (what this Mac remembers:
// snapping, panel sizes, the rail's order; the agents and capture setup; environments) and the
// keyboard shortcuts. Labs (D245): feature flags. Esc or a click outside closes it.
import { setSkipStoryboard, useSkipStoryboard } from "../state/agentPrefs.ts";
import { Blocks, Clapperboard, FlaskConical, Keyboard, SlidersHorizontal, X } from "lucide-react";
import { useEffect } from "react";

import { layout, RAIL_KEY } from "../editor/layout.ts";
import { playback, usePlayback } from "../preview/playback.ts";
import { actions, projectOf, useApp, type SettingsSection } from "../state/store.ts";
import { ProjectSettings } from "./ProjectSettings.tsx";
import { ShortcutSettings } from "./Shortcuts.tsx";
import { isRecordingKey } from "../editor/keymap.ts";
import { DefaultLengths } from "./DefaultLengths.tsx";
import { setProxiesOn, useProxiesOn } from "./proxies.ts";
import { setScrubCacheOn, useScrubCacheOn } from "./scrub.ts";
import { setPlayEngineOn, usePlayEngineOn } from "./playEngine.ts";
import { setGpuCompositorOn, useGpuCompositorOn } from "./gpu.ts";
import { DefaultCaptionStyleRow } from "../inspector/captionStyles.tsx";
import { UsageDataSettings } from "./telemetry.tsx";
import { LabsSettings } from "./Labs.tsx";
import { PluginsSettings } from "./plugins/PluginsSettings.tsx";
import { LabsTip, useEnvironmentsUsable } from "../onboarding/Environments.tsx";
import { Tooltip } from "../ui/Tooltip.tsx";

const SECTIONS: ReadonlyArray<{ readonly id: SettingsSection; readonly label: string; readonly icon: typeof X }> = [
  { id: "project", label: "Project", icon: Clapperboard },
  { id: "app", label: "App", icon: SlidersHorizontal },
  { id: "plugins", label: "Plugins", icon: Blocks },
  { id: "labs", label: "Labs", icon: FlaskConical },
  { id: "shortcuts", label: "Shortcuts", icon: Keyboard },
];

const NOT_TYPED = new Set(["checkbox", "radio", "range", "color", "button", "submit", "reset", "file"]);

export function Settings() {
  const { snapshot, settingsSection, connection } = useApp();
  const online = connection === "connected";
  const section = settingsSection === "project" && !snapshot ? "app" : settingsSection;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // #78: Esc while Settings › Shortcuts listens for a key cancels that (its own handler).
      if (e.key !== "Escape" || isRecordingKey()) return;
      // Esc in a field puts its value back first (the field's own handler); the next one closes.
      // A switch, checkbox, radio, slider or colour has no typed value to put back: Esc closes.
      const el = document.activeElement;
      if (el instanceof HTMLInputElement && !NOT_TYPED.has(el.type)) return void el.blur();
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
              <button
                key={s.id}
                className={section === s.id ? "active" : ""}
                data-testid={`settings-nav-${s.id}`}
                disabled={s.id === "project" && !snapshot}
                onClick={() => actions.openSettings(s.id)}
              >
                <Icon />
                {s.label}
              </button>
            );
          })}
        </nav>
        <div className="settings-body" data-testid={`settings-${section}`}>
          <div className="sheet-head">
            <span className="grow">{SECTIONS.find((s) => s.id === section)!.label}</span>
            <Tooltip label="Close" keys={["Esc"]}>
              <button className="icon-btn" data-testid="settings-close" onClick={actions.closeSettings}>
                <X />
              </button>
            </Tooltip>
          </div>
          {section === "project" && snapshot && <ProjectSettings key={snapshot.dir} snapshot={snapshot} project={projectOf(snapshot)} online={online} />}
          {section === "app" && <AppSettings />}
          {section === "plugins" && <PluginsSettings />}
          {section === "labs" && <LabsSettings />}
          {section === "shortcuts" && <ShortcutSettings />}
        </div>
      </div>
    </div>
  );
}

function AppSettings() {
  const snapping = usePlayback((s) => s.snapping);
  const proxies = useProxiesOn();
  const scrubCache = useScrubCacheOn();
  const playEngine = usePlayEngineOn();
  const gpu = useGpuCompositorOn();
  const environments = useEnvironmentsUsable();
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
        <label className="check-row">
          <input type="checkbox" data-testid="settings-scrub-cache" checked={scrubCache} onChange={(e) => setScrubCacheOn(e.target.checked)} />
          Decode frames ahead for scrubbing
        </label>
        <label className="check-row">
          <input type="checkbox" data-testid="settings-play-engine" checked={playEngine} onChange={(e) => setPlayEngineOn(e.target.checked)} />
          Decode frames ahead for playback
        </label>
        <label className="check-row">
          <input type="checkbox" data-testid="settings-gpu-compositor" checked={gpu} onChange={(e) => setGpuCompositorOn(e.target.checked)} />
          Draw videos and images on the GPU
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
      <UsageDataSettings />
      <div className="group">
        <div className="group-label">Agents, capture and plugins</div>
        <div className="settings-buttons">
          <button className="btn" data-testid="settings-setup" onClick={() => actions.openSetup()}>
            Agents and setup…
          </button>
          {environments ? (
            <button
              className="btn"
              data-testid="settings-open-environments"
              disabled={!environments}
              onClick={() => (actions.closeSettings(), void actions.openEnvironments())}
            >
              Environments…
            </button>
          ) : (
            <LabsTip>
              <button
                className="btn"
                data-testid="settings-open-environments"
                disabled={!environments}
                onClick={() => (actions.closeSettings(), void actions.openEnvironments())}
              >
                Environments…
              </button>
            </LabsTip>
          )}
        </div>
        {!environments && (
          <span className="labs-hint" data-testid="settings-environments-labs">
            Environments is in Labs.{" "}
            <button className="link-btn" data-testid="settings-go-labs" onClick={() => actions.openSettings("labs")}>
              Turn it on in Labs
            </button>
          </span>
        )}
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
        Auto skips the storyboard approval
      </label>
    </div>
  );
}
