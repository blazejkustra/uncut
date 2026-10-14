// What isn't safely on disk yet, or is still running, when the user leaves (U12, D178): quitting,
// closing the window, closing or switching the project, switching the environment. Pure: the
// inputs are read by state/leave.tsx, which asks the user about whatever this lists.

export type LeaveReason = "quit" | "window" | "close-project" | "open-project" | "new-project" | "environment";

export interface PendingInput {
  readonly reason: LeaveReason;
  /** Project edits sent to the server and not answered yet (or queued behind one). */
  readonly saving: number;
  /** A field being typed in: an open rename, or another value not saved until the field is left. */
  readonly draft: "rename" | "field" | undefined;
  /** Text in the agent's composer that wasn't sent. */
  readonly message: boolean;
  readonly agentRunning: boolean;
  /** Exports still running (any project: they stop with the app). */
  readonly exports: ReadonlyArray<{ readonly id: string; readonly name: string }>;
  /** A take on this Mac (D114). */
  readonly recorder: "idle" | "countdown" | "recording" | "saving";
  /** Devices recording through Argent (D143). */
  readonly devices: ReadonlyArray<string>;
  /** Files going up to a remote project (D108). */
  readonly uploading: number;
  /** Media imports of the open project still adding media. */
  readonly imports: number;
  /** Generations still running (D99). */
  readonly generating: number;
  /** Remote exports being downloaded to this Mac (D109). */
  readonly downloads: number;
}

/**
 * How the dialog's first button deals with an item: `save` commits or stops-and-keeps it, `wait`
 * lets it finish, `none` can't be kept (it's lost on leaving). The second button stops or drops
 * every item (`stop` names the way, if there is one).
 */
export interface PendingItem {
  readonly id: string;
  readonly text: string;
  readonly how: "save" | "wait" | "none";
  readonly stop?: "agent" | "export" | "take" | "rename";
  readonly target?: string;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** What's pending for this way of leaving, in the order the dialog lists it. */
export function pendingWork(input: PendingInput): Array<PendingItem> {
  const out: Array<PendingItem> = [];
  // Only quitting (or closing the window, which quits) stops the server and so what runs in it
  // for every project; a project change only stops what belongs to the open project.
  const app = input.reason === "quit" || input.reason === "window";
  const window = app || input.reason === "environment";
  if (input.draft === "rename") out.push({ id: "draft", text: "A name being edited", how: "save", stop: "rename" });
  else if (input.draft === "field") out.push({ id: "draft", text: "A value being typed", how: "save" });
  if (input.saving > 0) out.push({ id: "saving", text: input.saving === 1 ? "The last change is being saved" : `${plural(input.saving, "change")} being saved`, how: "wait" });
  if (input.recorder === "recording" || input.recorder === "countdown") out.push({ id: "take", text: "A recording on this Mac", how: "save", stop: "take" });
  else if (input.recorder === "saving") out.push({ id: "take", text: "A recording being saved", how: "wait" });
  for (const device of input.devices) out.push({ id: `device:${device}`, text: `Recording ${device}`, how: "save", target: device });
  if (input.uploading > 0) out.push({ id: "uploading", text: `Uploading ${plural(input.uploading, "file")}`, how: "wait" });
  if (input.imports > 0) out.push({ id: "imports", text: "Media being imported", how: "wait" });
  if (input.agentRunning) out.push({ id: "agent", text: "The agent is working", how: "wait", stop: "agent" });
  if (app) for (const e of input.exports) out.push({ id: `export:${e.id}`, text: `Exporting ${e.name}`, how: "wait", stop: "export", target: e.id });
  if (app && input.generating > 0) out.push({ id: "generating", text: `Generating ${plural(input.generating, "result")}`, how: "wait" });
  if (window && input.downloads > 0) out.push({ id: "downloads", text: `Downloading ${plural(input.downloads, "export")}`, how: "wait" });
  if (input.message) out.push({ id: "message", text: "An unsent message to the agent (not kept)", how: "none" });
  return out;
}

/** The dialog's words for a way of leaving and what's pending. */
export function leaveWords(reason: LeaveReason, items: ReadonlyArray<PendingItem>) {
  const title =
    reason === "quit"
      ? "Quit Uncut?"
      : reason === "window"
        ? "Close Uncut?"
        : reason === "close-project"
          ? "Close the project?"
          : reason === "environment"
            ? "Switch the environment?"
            : "Leave this project?";
  const saves = items.some((i) => i.how === "save");
  const waits = items.some((i) => i.how === "wait");
  // Something running (it stops) and something unsaved (it's dropped).
  const running = items.some((i) => (i.how === "wait" && i.id !== "saving") || i.stop === "take" || i.id.startsWith("device:"));
  const unsaved = items.some((i) => i.id === "draft" || i.id === "saving" || i.how === "none");
  const keep = saves && waits ? "Save and wait" : saves ? "Save" : waits ? "Wait" : undefined;
  const drop = running && unsaved ? "Discard and stop" : running ? "Stop" : "Discard";
  return { title, keep, drop };
}
