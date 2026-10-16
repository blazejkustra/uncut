// Usage data (issue #13, D223; anonymous and on by default with an opt-out since #103, D283): one
// quiet line on the setup wizard's last step, the toggle in Settings › App, and the README's
// Privacy section.
import { useEffect, useSyncExternalStore } from "react";

import "./telemetry.css";

import { call } from "../state/store/server.ts";
import { useApp } from "../state/store.ts";

type TelemetryState = { readonly enabled: boolean; readonly source: "do-not-track" | "env" | "settings" | "default"; readonly configured: boolean };

/** README.md's Privacy section: who gets what (Help › Privacy opens it too). */
export const PRIVACY_URL = "https://github.com/blazejkustra/uncut#privacy";
/** The Settings toggle's words. */
export const USAGE_DATA_LABEL = "Send anonymous usage data and crash reports";
/** One line on what is and isn't collected (Settings). */
export const USAGE_DATA_NOTE = "Counts, timings and error types, with no identifier. Never your footage, prompts, file names or paths.";
/** The setup wizard's line (shown only while sending is on). */
export const WIZARD_USAGE_LINE = "Uncut sends anonymous usage counts and crash types, never your footage or prompts. You can turn it off in Settings.";

export const PrivacyLink = () => (
  <a href={PRIVACY_URL} target="_blank" rel="noreferrer" data-testid="privacy-link">
    Privacy
  </a>
);

// One copy of the server's answer for the window (Settings and the wizard both show it).
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
/** Saves the toggle (settings.json) and shows it everywhere. */
export const answerTelemetry = (enabled: boolean) =>
  call((c) => c["telemetry.set"]({ enabled })).then((r) => {
    if (r.ok) publish(r.value);
  });

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

/** The setup wizard's last step (D283): one quiet line, only while this build sends (so never in dev builds, or when turned off). */
export function WizardUsageData() {
  const { state } = useTelemetry();
  // The <p> stays (empty) so the footer's button keeps its place.
  return (
    <p className="wiz-usage-line">
      {state?.enabled && (
        <span data-testid="wizard-telemetry-note">
          {WIZARD_USAGE_LINE} <PrivacyLink />
        </span>
      )}
    </p>
  );
}
