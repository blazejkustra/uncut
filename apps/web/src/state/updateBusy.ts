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

/**
 * The "Uncut X is ready" toast's second line. `quitting`: Restart to update passed the leave check
 * and the shell is about to quit and install; the app then vanishes for a few seconds (Squirrel
 * verifies and swaps the bundle), so say that it comes back by itself, or users reopen the old one.
 */
export function updateSubline(input: { readonly refused: false | "busy" | "not-ready"; readonly quitting: boolean }): string {
  if (input.quitting) return "Uncut closes now and reopens by itself in a few seconds. No need to open it again.";
  if (input.refused === "busy") return "Something started meanwhile. Restart once it's done.";
  if (input.refused === "not-ready") return "Couldn't prepare the update. Download it from GitHub instead.";
  return "Restart to update now, or it installs when you quit.";
}
