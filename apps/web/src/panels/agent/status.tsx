import type { SetupCheck } from "@uncut/contracts";
import { TriangleAlert, Copy, RefreshCw } from "lucide-react";
import { useState, useEffect } from "react";
import { actions } from "../../state/store.ts";
import { useRecorder, clock, stopTake, cancelTake } from "../../capture/recorder.ts";

// The first thing a new project shows (t3code-style): one question naming the project, no
// prefilled prompts. The composer below is where the answer goes.
export function AgentEmpty({ name }: { name: string }) {
  return (
    <div className="agent-empty" data-testid="agent-empty">
      <h2 className="agent-empty-title">
        What should we make in <span className="agent-empty-name">{name || "this project"}</span>?
      </h2>
      <div className="agent-empty-sub">No media needed to start. Every turn can be undone.</div>
    </div>
  );
}

/** Claude Code missing, signed out or billed elsewhere: what's wrong and the fix, as in onboarding. */
export function ClaudeStatus({ check, checking }: { check: SetupCheck; checking: boolean }) {
  const blocking = check.status === "missing" || check.status === "needs-login";
  return (
    <div className={`agent-setup ${blocking ? "blocking" : ""}`} data-testid="agent-setup" data-status={check.status}>
      <div className="agent-setup-head">
        <TriangleAlert />
        <span className="grow">
          <b>{check.status === "missing" ? "Claude Code isn't installed" : check.status === "needs-login" ? "Claude Code isn't signed in" : "Claude Code"}</b>
          <span className="agent-setup-detail">{check.detail}</span>
        </span>
      </div>
      {check.fix && (
        <div className="agent-setup-fix">
          <span>{check.fix.text}</span>
          {check.fix.command && (
            <div className="wiz-cmd">
              <code data-testid="agent-setup-command">{check.fix.command}</code>
              <button className="link-btn" onClick={() => void actions.copy(check.fix!.command!)} title="Copy the command">
                <Copy />
                Copy
              </button>
            </div>
          )}
        </div>
      )}
      {blocking && (
        <button className="btn agent-setup-again" data-testid="agent-check-again" disabled={checking} onClick={() => void actions.checkSetup()}>
          <RefreshCw className={checking ? "spin" : ""} />
          Check again
        </button>
      )}
    </div>
  );
}

/** D144: the screen recording the user allowed, while it counts down, records and is sent. */
export function AgentTakeLine() {
  const agentId = useRecorder((s) => s.agentId);
  const phase = useRecorder((s) => s.phase);
  const count = useRecorder((s) => s.count);
  const startedAt = useRecorder((s) => s.startedAt);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (phase !== "recording") return;
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [phase]);
  if (!agentId || phase === "idle") return null;
  return (
    <div className="agent-take small" data-testid="agent-screen-take" data-phase={phase}>
      <span className="capture-timer">{phase === "countdown" ? (count ? `Recording in ${count}` : "Starting…") : phase === "recording" ? `Recording ${clock((now - (startedAt ?? now)) / 1000)}` : "Sending the recording…"}</span>
      {phase === "recording" && (
        <button className="link-btn" data-testid="agent-screen-stop" onClick={() => void stopTake()}>
          Stop now
        </button>
      )}
      {phase !== "saving" && (
        <button className="link-btn" data-testid="agent-screen-cancel" onClick={() => cancelTake()}>
          Cancel
        </button>
      )}
    </div>
  );
}
