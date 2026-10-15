// Settings › App › Usage data (issue #13, D223): the telemetry toggle and what it sends.
import { useEffect, useState } from "react";

import { call } from "../state/store/server.ts";
import { useApp } from "../state/store.ts";

type TelemetryState = { readonly enabled: boolean; readonly source: "do-not-track" | "env" | "settings" | "default"; readonly configured: boolean };

/** One line on what is and isn't collected (also shown in the setup wizard). */
export const USAGE_DATA_NOTE = "Anonymous usage data and crash reports (counts, timings, error types) help improve Uncut. Never your footage, prompts, file names or paths.";

export function UsageDataSettings() {
  const { connection } = useApp();
  const online = connection === "connected";
  const [state, setState] = useState<TelemetryState | undefined>();
  useEffect(() => {
    if (!online) return;
    let live = true;
    void call((c) => c["telemetry.state"]({})).then((r) => live && r.ok && setState(r.value));
    return () => void (live = false);
  }, [online]);
  const locked = state?.source === "do-not-track" || state?.source === "env";
  const toggle = (enabled: boolean) => void call((c) => c["telemetry.set"]({ enabled })).then((r) => r.ok && setState(r.value));
  return (
    <div className="group">
      <div className="group-label">Usage data</div>
      <label className="check-row">
        <input type="checkbox" data-testid="settings-telemetry" checked={state?.enabled ?? false} disabled={!online || !state || locked || !state.configured} onChange={(e) => toggle(e.target.checked)} />
        Send anonymous usage data and crash reports
      </label>
      <p className="muted" data-testid="settings-telemetry-note">
        {USAGE_DATA_NOTE}
        {state && !state.configured ? " This build has no telemetry token, so it sends nothing." : ""}
        {state?.source === "do-not-track" ? " Off because DO_NOT_TRACK is set." : ""}
        {state?.source === "env" ? " Off because UNCUT_TELEMETRY is set to off." : ""}
      </p>
    </div>
  );
}
