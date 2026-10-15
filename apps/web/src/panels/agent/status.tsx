import type { SetupCheck } from "@uncut/contracts";
import { Sparkles, TriangleAlert, Copy, RefreshCw } from "lucide-react";
import { useState, useEffect } from "react";
import { useApp, actions } from "../../state/store.ts";
import { useRecorder, clock, stopTake, cancelTake } from "../../capture/recorder.ts";
import { usePlayback } from "../../preview/playback.ts";
import { followShown } from "../../state/agentFollow.ts";

// Prompts that work on an empty project: text needs no media (D48).
const EXAMPLES = [
  "Make a 5 s title card that says “Kraków from above”",
  "Add a lower third at 2 s that says “Shot from a drone”",
  "Start with a 3 s title “Weekend in the mountains” and end with “Thanks for watching”",
];

/** D202: whether the agent's ui_show moves the playhead (only ever when you aren't watching); remembered. */
export function FollowToggle() {
  const { agentFollow } = useApp();
  const playing = usePlayback((s) => s.playing);
  const on = followShown(agentFollow, playing);
  return (
    <button className={`follow-toggle ${on ? "on" : ""}`} role="switch" aria-checked={on} data-testid="agent-follow" data-on={on ? "true" : "false"} title={on ? "The playhead goes to the agent's changes while you aren't watching" : "The agent's changes show as a pill over the preview"} onClick={() => actions.setAgentFollow(!on)}>
      <span className="follow-dot" />
      Follow agent
    </button>
  );
}

export function AgentEmpty({ onPick, disabled }: { onPick: (prompt: string) => void; disabled: boolean }) {
  return (
    <div className="agent-empty" data-testid="agent-empty">
      <div className="empty-icon">
        <Sparkles />
      </div>
      <div className="empty-title">Ask for an edit</div>
      <div className="agent-empty-sub">
        The agent sees the timeline and edits it live with your Claude Code login. No media needed to start: it can make titles and text right away. Every turn can be undone.
      </div>
      <div className="agent-examples">
        {EXAMPLES.map((example) => (
          <button key={example} className="agent-example" data-testid="agent-example" disabled={disabled} onClick={() => onPick(example)}>
            {example}
          </button>
        ))}
      </div>
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
      <span className="capture-timer">{phase === "countdown" ? `Recording in ${count ?? ""}` : phase === "recording" ? `Recording ${clock((now - (startedAt ?? now)) / 1000)}` : "Sending the recording…"}</span>
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
