// #102 (D276): whether an update must wait (no check falls due, no install). Pure, unit-tested in
// test/core/issue102-updater.test.ts.

// As leave.tsx (ExportDialog's exportRunning, not imported: that module pulls in half the app).
const EXPORT_RUNNING = new Set(["queued", "preparing", "rendering"]);

/** Whether an update must wait: an export running, a recording (or its countdown or save), an agent turn. */
export function updateBusy(input: {
  readonly exportPhases: ReadonlyArray<string>;
  readonly recorderPhase: string;
  readonly capturing: number;
  readonly agentRunning: boolean;
}): boolean {
  return input.exportPhases.some((p) => EXPORT_RUNNING.has(p)) || input.recorderPhase !== "idle" || input.capturing > 0 || input.agentRunning;
}
