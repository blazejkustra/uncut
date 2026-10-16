import { ArrowRight, Check, Clapperboard, RefreshCw, TriangleAlert } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { actions, useApp } from "../state/store.ts";
import { EnvironmentChip, LabsTip, useEnvironmentsUsable } from "./Environments.tsx";
import { CheckRow, PendingRow, KeyRows, SpeechModelRow } from "./rows.tsx";
import { PluginRows } from "./plugins.tsx";
import { declineIfUnanswered, useTelemetry, WizardUsageData } from "../settings/telemetry.tsx";
import "./wizard.css";
export { CheckRow, SpeechModelRow, KeyRows } from "./rows.tsx";
export { PluginRows } from "./plugins.tsx";

const STEPS = ["Agents", "Capture", "First video"] as const;

/** The t3code-style wizard from the wireframe: Agents → Capture → First video, with real checks. */
export function Onboarding({ standalone }: { standalone: boolean }) {
  const { setupChecks, setupChecking, setupError, setupFocus } = useApp();
  const [step, setStep] = useState(0);
  // Settings › Keys (the Generate tab's link): the Agents step, scrolled to the keys.
  useEffect(() => {
    if (setupFocus === "plugins") {
      // D232: the Skills tab's "Get more skills": the plugins, on the Capture step.
      setStep(1);
      requestAnimationFrame(() => document.querySelector("[data-testid=plugins]")?.scrollIntoView({ block: "start" }));
      return;
    }
    if (setupFocus !== "keys") return;
    setStep(0);
    requestAnimationFrame(() => document.querySelector("[data-testid=keys]")?.scrollIntoView({ block: "center" }));
  }, [setupFocus]);
  // D278: leaving the wizard (finished or skipped) without a yes to usage data is a no (the answer is
  // loaded up front so that holds even when it's skipped from the first step).
  useTelemetry();
  const finish = (how: "stay" | "new-project") => {
    void declineIfUnanswered();
    void actions.finishSetup(how);
  };
  // Escape skips (and remembers it), wherever focus is.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && finish("stay");
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const byId = Object.fromEntries((setupChecks ?? []).map((c) => [c.id, c]));
  // A row: its result, "Checking…" while a check runs, or nothing if the whole check failed
  // (the error box below says so; no endless spinner).
  const row = (id: string) => (byId[id] ? <CheckRow check={byId[id]} /> : setupChecking ? <PendingRow /> : null);
  const failure = setupError && !setupChecking && (
    <div className="wiz-note error" data-testid="setup-error">
      <TriangleAlert />
      {setupError}
    </div>
  );
  // A step earns its check mark only when what it needs is ready: an agent, and ffmpeg.
  const stepDone = [
    ["claude", "codex"].some((id) => byId[id]?.status === "ready"),
    byId.ffmpeg?.status === "ready",
    false,
  ];
  const [visited, setVisited] = useState<ReadonlySet<number>>(new Set([0]));
  const go = (i: number) => {
    setVisited((v) => new Set([...v, i]));
    setStep(i);
  };
  const recheck = (
    <button className="btn ghost" data-testid="check-again" onClick={() => void actions.checkSetup()} disabled={setupChecking}>
      <RefreshCw className={setupChecking ? "spin" : ""} />
      Check again
    </button>
  );

  let body: ReactNode;
  if (step === 0) {
    body = (
      <>
        <h1>Connect your agents</h1>
        <p className="wiz-lead">Uncut's agent runs your installed Claude Code, with whatever sign-in it uses. Codex support is coming later.</p>
        <div className="wiz-list">
          {row("claude")}
          {row("codex")}
          {failure}
          <KeyRows />
          <EnvironmentSettings />
        </div>
        <div className="wiz-foot">
          <p>Claude Code is all the agent needs. Change any of this later in Settings.</p>
          <div className="wiz-btns">
            {recheck}
            <button className="btn primary" data-testid="wizard-continue" onClick={() => go(1)}>
              Continue
              <ArrowRight />
            </button>
          </div>
        </div>
      </>
    );
  } else if (step === 1) {
    const ffmpegMissing = byId.ffmpeg && byId.ffmpeg.status !== "ready";
    body = (
      <>
        <h1>Record and export</h1>
        <p className="wiz-lead">Argent records simulators, emulators, web and desktop apps. ffmpeg makes thumbnails, waveforms and the final video. whisper.cpp transcribes speech on this Mac.</p>
        <div className="wiz-list">
          {row("argent")}
          {row("ffmpeg")}
          {row("whisper")}
          {byId.whisper && <SpeechModelRow />}
          <PluginRows />
          {failure}
          {ffmpegMissing && (
            <div className="wiz-note error" data-testid="ffmpeg-callout">
              <TriangleAlert />
              Without ffmpeg Uncut can't make thumbnails or export. You can continue and install it later.
            </div>
          )}
        </div>
        <div className="wiz-foot">
          <p>Argent is optional. Skip it if you only edit footage you already have.</p>
          <div className="wiz-btns">
            {recheck}
            <button className="btn primary" data-testid="wizard-continue" onClick={() => go(2)}>
              Continue
              <ArrowRight />
            </button>
          </div>
        </div>
      </>
    );
  } else {
    body = (
      <>
        <h1>Start a video</h1>
        <p className="wiz-lead">A project is a folder on this Mac. Pick a shape and where to keep it; your footage stays where it is.</p>
        <div className="wiz-list">
          <div className="wiz-row">
            <Clapperboard />
            <div className="grow">
              <div className="wiz-name">New project</div>
              <div className="wiz-sub">Landscape, vertical, 4:5 or 4K</div>
            </div>
          </div>
        </div>
        <div className="wiz-foot">
          {/* D278: the first-run question about usage data, unticked (opt-in). */}
          <WizardUsageData />
          <div className="wiz-btns">
            <button className="btn primary" data-testid="wizard-new-project" onClick={() => finish("new-project")}>
              New project
              <ArrowRight />
            </button>
          </div>
        </div>
      </>
    );
  }

  return (
    <div className={`modal-layer ${standalone ? "standalone" : ""}`} data-testid="onboarding">
      <div className="modal wiz" data-step={STEPS[step]}>
        <div className="wiz-header">
          <div className="wiz-brand">Uncut</div>
          <ol className="wiz-steps">
            {STEPS.map((name, i) => (
              <li key={name}>
                <button className={i === step ? "current" : ""} data-testid={`wizard-step-${i}`} onClick={() => go(i)}>
                  <span
                    className={`wiz-num ${i === step ? "now" : stepDone[i] && visited.has(i) ? "done" : visited.has(i) ? "visited" : ""}`}
                    data-testid={`wizard-step-mark-${i}`}
                  >
                    {i !== step && stepDone[i] && visited.has(i) ? <Check /> : i + 1}
                  </span>
                  {name}
                </button>
              </li>
            ))}
          </ol>
          {/* F32 (D175): one way past the whole wizard, on every step; Settings › App reopens it. */}
          <button className="btn ghost wiz-skip" data-testid="wizard-skip" onClick={() => finish("stay")}>
            Skip setup
          </button>
        </div>
        <div className="wiz-panel">{body}</div>
      </div>
    </div>
  );
}

/** Settings, Environments (D106): which server this window uses, and the way to the others. */
function EnvironmentSettings() {
  const { environment } = useApp();
  const usable = useEnvironmentsUsable();
  return (
    <div className="wiz-plugins" data-testid="settings-environments">
      <div className="wiz-section-row">
        <div className="wiz-section">Environment</div>
      </div>
      <div className="wiz-row">
        <div className="grow">
          <div className="wiz-name">{environment.kind === "remote" ? `Working on ${environment.name}` : "Working on this Mac"}</div>
          <div className="wiz-sub">{environment.kind === "remote" ? "Agents, ffmpeg, Argent and plugins above are that machine's." : "Add another machine to edit and export there instead."}</div>
        </div>
        <EnvironmentChip />
        {usable ? (
          <button className="btn" data-testid="settings-environments-manage" disabled={!usable} onClick={() => void actions.openEnvironments()}>
          Manage…
        </button>
        ) : (
          <LabsTip>
            <button className="btn" data-testid="settings-environments-manage" disabled={!usable} onClick={() => void actions.openEnvironments()}>
          Manage…
        </button>
          </LabsTip>
        )}
      </div>
    </div>
  );
}
