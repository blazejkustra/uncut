// Auto-update in the renderer (issue #102, D276). The desktop shell checks and downloads; this
// tells it whether an export, a recording or an agent turn is running (no check falls due and no
// install happens then), keeps the updater's status for UpdateToast, and runs Restart to update
// through the same leave check as ⌘Q (U12, D178).
import { useSyncExternalStore } from "react";

import { getRecorder, listeners as recorderListeners } from "../capture/recorder/state.ts";
import { bridge, type UpdateStatus } from "./bridge.ts";
import { confirmLeave } from "./leave.tsx";
import { getState, subscribeApp } from "./store.ts";
import { updateBusy } from "./updateBusy.ts";

const busyNow = () => {
  const s = getState();
  return updateBusy({
    exportPhases: s.exportJobs.map((j) => j.phase),
    recorderPhase: getRecorder().phase,
    capturing: s.capture?.recording.length ?? 0,
    agentRunning: s.agent !== null && s.agent !== undefined && s.agent.running !== null,
  });
};

interface UpdateView {
  readonly status: UpdateStatus;
  readonly busy: boolean;
  /** The toast the user closed (Later, or ×), until the status changes. */
  readonly dismissed: UpdateStatus | undefined;
  /** Restart to update was refused: something started meanwhile ("busy"), or the update couldn't be prepared ("not-ready"). */
  readonly refused: false | "busy" | "not-ready";
}

let view: UpdateView = { status: { kind: "idle" }, busy: false, dismissed: undefined, refused: false };
const viewListeners = new Set<() => void>();
const setView = (patch: Partial<UpdateView>) => {
  view = { ...view, ...patch };
  for (const l of viewListeners) l();
};
const subscribeView = (l: () => void) => (viewListeners.add(l), () => void viewListeners.delete(l));
export const useUpdates = () => useSyncExternalStore(subscribeView, () => view);

let started = false;
/** Once, in the app window: busy to the shell as it changes, the status from it. */
export function startUpdates() {
  if (started || !bridge.onUpdateStatus) return;
  started = true;
  const report = () => {
    const busy = busyNow();
    if (busy === view.busy) return;
    setView({ busy, refused: busy ? view.refused : false });
    bridge.setUpdateBusy?.(busy);
  };
  subscribeApp(report);
  recorderListeners.add(report);
  report();
  bridge.onUpdateStatus((status) => setView({ status, dismissed: undefined, refused: false }));
  void bridge.updateStatus?.().then((status) => view.status.kind === "idle" && setView({ status }), () => {});
}

export const dismissUpdate = () => setView({ dismissed: view.status, refused: false });

/** Restart to update: asks about pending work as ⌘Q does, then the shell quits and installs. */
export async function restartToUpdate() {
  if (!(await confirmLeave("quit"))) return;
  const result = await bridge.installUpdate?.();
  if (result === "busy" || result === "not-ready") setView({ refused: result });
}
