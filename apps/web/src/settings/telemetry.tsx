// Usage data (issue #13, D223; opt-in since #103, D278): the question in the setup wizard and, for an
// install that never answered, once on launch; the answer in Settings › App; what is sent, and the
// README's Privacy section.
import { useEffect, useSyncExternalStore } from "react";

import "./telemetry.css";

import { call } from "../state/store/server.ts";
import { useApp } from "../state/store.ts";

type TelemetryState = { readonly enabled: boolean; readonly source: "do-not-track" | "env" | "settings" | "default"; readonly configured: boolean };

/** README.md's Privacy section: who gets what (Help › Privacy opens it too). */
export const PRIVACY_URL = "https://github.com/blazejkustra/uncut#privacy";
/** The checkbox's words (the setup wizard's and Settings'). */
export const USAGE_DATA_LABEL = "Send usage data and crash reports";
/** One line on what is and isn't collected (also shown in the setup wizard). */
export const USAGE_DATA_NOTE = "Off unless you turn it on. Counts, timings and error types, with a random install id that isn't linked to your name. Never your footage, prompts, file names or paths.";

export const PrivacyLink = () => (
  <a href={PRIVACY_URL} target="_blank" rel="noreferrer" data-testid="privacy-link">
    Privacy
  </a>
);

// One copy of the server's answer for the window (Settings, the wizard and the first-launch prompt
// all show it), so an answer given in one place is at once what the others show.
let current: TelemetryState | undefined;
const listeners = new Set<() => void>();
const publish = (next: TelemetryState) => {
  current = next;
  for (const l of listeners) l();
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};
/** Saves the user's answer (settings.json) and shows it everywhere. */
export const answerTelemetry = (enabled: boolean) =>
  call((c) => c["telemetry.set"]({ enabled })).then((r) => {
    if (r.ok) publish(r.value);
  });
/** The setup wizard closed (finished or skipped) without a yes: that is a no (D278). */
export async function declineIfUnanswered(): Promise<void> {
  if (!current) {
    const r = await call((c) => c["telemetry.state"]({})).catch(() => undefined);
    if (r?.ok) publish(r.value);
  }
  if (current?.source !== "default" || !current.configured) return;
  publish({ ...current, enabled: false, source: "settings" });
  await answerTelemetry(false);
}

/** The server's answer, and a way to change it (undefined until the server has said). */
export function useTelemetry() {
  const { connection } = useApp();
  const online = connection === "connected";
  const state = useSyncExternalStore(subscribe, () => current);
  useEffect(() => {
    if (!online) return;
    void call((c) => c["telemetry.state"]({})).then((r) => r.ok && publish(r.value));
  }, [online]);
  const set = (enabled: boolean) => void answerTelemetry(enabled);
  return { online, state, set, locked: state?.source === "do-not-track" || state?.source === "env" };
}

/**
 * The question, once (D278): an install that has never answered (one from before opt-in, or a
 * wizard reopened later) is asked on launch, outside the setup wizard, with two plain choices.
 * Nothing is sent until "Share usage data".
 */
export function UsageDataPrompt() {
  const { state, set, locked } = useTelemetry();
  if (!state || state.source !== "default" || !state.configured || locked) return null;
  return (
    <div className="modal-layer" data-testid="usage-data-prompt">
      <div className="modal usage-prompt" role="dialog" aria-labelledby="usage-prompt-title">
        <h2 id="usage-prompt-title">Share usage data?</h2>
        <p>
          {USAGE_DATA_NOTE} You can change this any time in Settings › App. <PrivacyLink />
        </p>
        <div className="usage-prompt-btns">
          <button className="btn ghost" data-testid="usage-data-decline" onClick={() => set(false)}>
            Don't share
          </button>
          <button className="btn primary" data-testid="usage-data-accept" onClick={() => set(true)}>
            Share usage data
          </button>
        </div>
      </div>
    </div>
  );
}

export function UsageDataSettings() {
  const { online, state, set, locked } = useTelemetry();
  return (
    <div className="group">
      <div className="group-label">Usage data</div>
      <label className="check-row">
        <input type="checkbox" data-testid="settings-telemetry" checked={state?.enabled ?? false} disabled={!online || !state || locked || !state.configured} onChange={(e) => set(e.target.checked)} />
        {USAGE_DATA_LABEL}
      </label>
      <p className="muted" data-testid="settings-telemetry-note">
        {USAGE_DATA_NOTE}
        {state && !state.configured ? " This build has no telemetry token, so it sends nothing." : ""}
        {state?.source === "do-not-track" ? " Off because DO_NOT_TRACK is set." : ""}
        {state?.source === "env" ? " Off because UNCUT_TELEMETRY is set to off." : ""} <PrivacyLink />
      </p>
    </div>
  );
}

/** The setup wizard's last step (D278): the question, unticked until the user says yes; closing the wizard without a yes is a no. */
export function WizardUsageData() {
  const { state, set, locked } = useTelemetry();
  return (
    <label className="wiz-telemetry" data-testid="wizard-telemetry-row">
      <input type="checkbox" data-testid="wizard-telemetry" checked={state?.enabled ?? false} disabled={!state || locked || !state.configured} onChange={(e) => set(e.target.checked)} />
      <span>
        <span className="wiz-telemetry-label">{USAGE_DATA_LABEL}</span>
        <span data-testid="wizard-telemetry-note">
          {" "}
          {USAGE_DATA_NOTE}
          {state && !state.configured ? " This build sends nothing either way." : ""}
          {locked ? " Off because of an environment setting." : ""}
        </span>{" "}
        <PrivacyLink />
      </span>
    </label>
  );
}
