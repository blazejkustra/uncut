// App state and the actions that change it. This module owns the server connection; the
// components only read state (useApp) and call actions.
//
// The open project comes from the server's project.subscribe stream, which is ordered and
// re-sent in full on every reconnect, so the screen always ends up showing what the server
// has. Call results are applied too (for snappiness) but never over a newer revision.
import { MEDIA_FILE_PATH, THUMB_PATH, TOKEN_QUERY_PARAM, type AgentState, type ImportJob, type MediaImportResult, type ProjectSnapshot, type RecentProject, type ServerConnection, type ServerHello, type SetupCheck } from "@uncut/contracts";
import { useSyncExternalStore } from "react";

import { bridge, type AppInfo, type MenuCommand } from "./bridge.ts";
import { connect, isTransportError, type CallError, type Connection, type Result } from "./connection.ts";
import type { Canvas } from "./format.ts";
import { getPlayback, playback } from "./playback.ts";
import { draftOf, planDelete, planSplit, planTrackFlag, type Plan, type TrackFlag } from "./edit.ts";
import { layoutOf, planAddMedia, planAddText, type Planned, type ProjectModel, type TextPreset } from "./project.ts";

export type ConnectionState = "connecting" | "connected" | "reconnecting" | "server-exited" | "failed";

export type { MediaItem } from "./project.ts";
export type Project = ProjectModel;

/** A message in the editor's banner. `transport` ones go away when the connection comes back. */
export interface Notice {
  readonly text: string;
  readonly transport?: boolean;
}

export interface AppStateShape {
  readonly ready: boolean;
  readonly connection: ConnectionState;
  readonly connectionMessage?: string;
  readonly hello?: ServerHello;
  readonly appInfo: AppInfo;
  readonly snapshot: ProjectSnapshot | null;
  readonly recents: ReadonlyArray<RecentProject>;
  readonly newProjectOpen: boolean;
  // A readable error for the welcome screen (a failed open there).
  readonly welcomeError?: string;
  // project.json changed on disk: changes are refused until a reload succeeds.
  readonly changedOnDisk: boolean;
  // Why the last reload failed (folder gone, file unreadable), shown in the same banner.
  readonly reloadProblem?: string;
  readonly notice?: Notice;
  // Onboarding: open on first launch, or from Settings… / the welcome card.
  readonly setupOpen: boolean;
  readonly setupChecks?: ReadonlyArray<SetupCheck>;
  readonly setupChecking: boolean;
  // The last setup.check failed as a whole (server unreachable): shown with Check again.
  readonly setupError?: string;
  // Import jobs on the server (running and recent); the library shows the open project's.
  readonly jobs: ReadonlyArray<ImportJob>;
  readonly importReport?: { readonly failed: MediaImportResult["failed"]; readonly skipped: MediaImportResult["skipped"] };
  // Media ids that have a poster on the server; others show an icon (no request, no 404).
  readonly thumbIds: ReadonlySet<string>;
  // The open project's agent (turns, the running one) from agent.subscribe.
  readonly agent: AgentState | null;
  // Why the last agent action failed (not installed, busy…), shown in the Agent tab.
  readonly agentError?: string;
}

export const MAX_NAME_LENGTH = 100;

let state: AppStateShape = {
  ready: false,
  connection: "connecting",
  appInfo: { homeDir: "", defaultParentDir: "" },
  snapshot: null,
  recents: [],
  newProjectOpen: false,
  changedOnDisk: false,
  setupOpen: false,
  setupChecking: false,
  jobs: [],
  thumbIds: new Set(),
  agent: null,
};
const listeners = new Set<() => void>();

const set = (patch: Partial<AppStateShape>) => {
  const before = state;
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
  if (before.snapshot !== state.snapshot || before.recents !== state.recents) syncShell();
};

export const useApp = () =>
  useSyncExternalStore(
    (listener) => (listeners.add(listener), () => listeners.delete(listener)),
    () => state,
  );

export const getState = () => state;
export const projectOf = (snapshot: ProjectSnapshot) => snapshot.project as Project;
export const online = () => state.connection === "connected";

/** Keep the native menu (Open Recent, ⌘W) and the window title in step with the screen. */
function syncShell() {
  bridge.setAppState({ projectOpen: state.snapshot !== null, recents: state.recents.map(({ name, dir }) => ({ name, dir })) });
  document.title = state.snapshot ? projectOf(state.snapshot).name : "Uncut";
}

// The newest revision this window has shown. Revisions only go up on the server, so a
// call result at or below it is old news (e.g. it arrived after a reconnect's refetch).
let newestRevision = -1;

/** From the subscription: authoritative, always applied. */
function applyFromServer(snapshot: ProjectSnapshot | null) {
  if (snapshot) newestRevision = Math.max(newestRevision, snapshot.revision);
  const switched = snapshot?.dir !== state.snapshot?.dir;
  const mediaChanged = mediaKey(snapshot) !== mediaKey(state.snapshot);
  if (mediaChanged) void refreshThumbs();
  set({
    snapshot,
    ...(switched ? { changedOnDisk: false, reloadProblem: undefined, notice: undefined, importReport: undefined } : {}),
  });
  // Then the playhead follows the project: back to the start for another project, clamped when it
  // got shorter. After the snapshot, so nothing draws the old project at the reset playhead (the
  // preview of the old project ignores changes once the open folder isn't its own).
  if (switched) playback.reset();
  if (snapshot) playback.setProject(layoutOf(projectOf(snapshot)).frames, projectOf(snapshot).canvas.fps);
}

// Paths too: a relinked file (same id, new path) has another poster.
const mediaKey = (s: ProjectSnapshot | null) => (s ? `${s.dir}|${projectOf(s).media.map((m) => `${m.id}=${m.path}`).join(",")}` : "");
async function refreshThumbs() {
  const ids = await call((c) => c["media.thumbnails"]({}));
  if (ids.ok) set({ thumbIds: new Set(ids.value) });
}

/** From a call result: applied only if it is newer than anything shown. */
function applyFromCall(snapshot: ProjectSnapshot) {
  if (snapshot.revision <= newestRevision) return;
  applyFromServer(snapshot);
}

/** A sentence for a failed call, without validator jargon. */
export function plainError(error: CallError): string {
  if (isTransportError(error)) return "Not connected to the server. Try again when it's back.";
  const first = error.details?.[0];
  if (error._tag === "EditRefused" && first && /invalid|malformed/.test(error.message)) return `That change isn't allowed: ${first.message}.`;
  if (error._tag === "EditRefused" && first?.code === "depends") return error.message;
  if (error._tag === "EditRefused" && first?.code === "conflict") return "The agent changed that while you were editing it, so your change wasn't applied. Try again on what's there now.";
  if (error.reason === "missing") return "The project folder is gone, or has no project.json.";
  if (error.reason === "invalid" && first?.code === "json") return "project.json can't be read: it isn't valid JSON.";
  if (error.reason === "invalid") return `project.json can't be read: ${first ? `${first.path === "/" ? "" : `${first.path} `}${first.message}` : error.message}.`;
  return error.message;
}

let connection: Connection | undefined;
let serverConnection: ServerConnection | undefined;

/** A short, stable tag for a file path (FNV-1a), so a relinked file gets a different URL. */
const pathTag = (path: string) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < path.length; i++) h = Math.imul(h ^ path.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
};
const serverUrl = (route: string, id: string, path?: string) => {
  if (!serverConnection) return undefined;
  const url = new URL(serverConnection.url.replace(/^ws/, "http"));
  url.pathname = `${route}/${encodeURIComponent(id)}`;
  url.search = "";
  url.searchParams.set(TOKEN_QUERY_PARAM, serverConnection.token);
  // The server only looks at the id; the tag makes the URL (and so every <img>/<video> keyed on
  // it) change when the media item points at another file.
  if (path !== undefined) url.searchParams.set("v", pathTag(path));
  return url.href;
};
/** The poster for a media item, from the server's token-protected route (never file://). */
export const thumbUrl = (id: string, path?: string) => serverUrl(THUMB_PATH, id, path);
/** The original file of a media item, streamed by the server with byte ranges (never file://). */
export const mediaUrl = (id: string, path?: string) => serverUrl(MEDIA_FILE_PATH, id, path);
let unsubscribe: (() => void) | undefined;
let unsubscribeJobs: (() => void) | undefined;
let unsubscribeAgent: (() => void) | undefined;
// Finished jobs whose result has been shown (or that finished before this window saw them).
const reported = new Set<string>();
let jobsSeen = false;

/** Jobs as the server reports them: progress, finished results and newly made posters. */
function onJobs(jobs: ReadonlyArray<ImportJob>) {
  const before = new Map(state.jobs.map((j) => [j.id, j]));
  let report = state.importReport;
  let posters = false;
  for (const job of jobs) {
    const prev = before.get(job.id);
    if (prev?.postersDone !== job.postersDone && job.postersDone > 0) posters = true;
    const finished = job.phase === "done" || job.phase === "failed";
    // On (re)connect, jobs that finished earlier are history, not news.
    if (finished && !jobsSeen) reported.add(job.id);
    if (finished && !reported.has(job.id)) {
      reported.add(job.id);
      posters = true;
      if (job.projectDir === state.snapshot?.dir) {
        const failed = job.phase === "failed" ? job.result?.failed ?? [{ path: `${job.total} file${job.total === 1 ? "" : "s"}`, message: job.error ?? "The import stopped." }] : job.result?.failed ?? [];
        const skipped = job.result?.skipped ?? [];
        report = failed.length || skipped.length ? { failed: [...(report?.failed ?? []), ...failed], skipped: [...(report?.skipped ?? []), ...skipped] } : report;
      }
    }
  }
  jobsSeen = true;
  set({ jobs, importReport: report });
  if (posters) void refreshThumbs();
}

/** The open project's import jobs that are still running or waiting. */
export const activeJobs = (s: AppStateShape) => s.jobs.filter((j) => j.projectDir === s.snapshot?.dir && j.phase !== "done" && j.phase !== "failed");
const call: Connection["call"] = (f) =>
  connection ? connection.call(f) : Promise.resolve({ ok: false, error: { _tag: "NotConnected", message: "Not connected to the server" } });

const refreshRecents = async () => {
  const recents = await call((c) => c["recents.list"]({}));
  if (recents.ok) set({ recents: recents.value });
};

export async function start() {
  bridge.onServerExit((message) => set({ connection: "server-exited", connectionMessage: message }));
  bridge.onMenuCommand(runCommand);
  window.addEventListener("keydown", onKeyDown);
  const [appInfo, server] = await Promise.all([bridge.appInfo(), bridge.getServerConnection().then((c) => ({ ok: true as const, c }), (e: Error) => ({ ok: false as const, e }))]);
  set({ appInfo });
  if (!server.ok) {
    set({ connection: "failed", connectionMessage: server.e.message, ready: true });
    return;
  }
  let firstSnapshot: () => void = () => {};
  const gotFirstSnapshot = new Promise<void>((resolve) => (firstSnapshot = resolve));
  serverConnection = server.c;
  const conn = connect(server.c, {
    // Every (re)connect resubscribes: the server re-sends the current project first.
    onConnect: () => {
      if (state.connection === "server-exited") return;
      set({ connection: "connected", notice: state.notice?.transport ? undefined : state.notice });
      unsubscribeJobs?.();
      unsubscribeJobs = conn.subscribe((c) => c["media.jobs"]({}), onJobs);
      unsubscribeAgent?.();
      unsubscribeAgent = conn.subscribe(
        (c) => c["agent.subscribe"]({}),
        (agent) => set({ agent }),
      );
      unsubscribe?.();
      unsubscribe = conn.subscribe(
        (c) => c["project.subscribe"]({}),
        (snapshot) => {
          applyFromServer(snapshot);
          firstSnapshot();
        },
      );
      void refreshRecents();
    },
    onDisconnect: () => {
      if (state.connection !== "server-exited") set({ connection: "reconnecting" });
    },
  });
  connection = conn;
  const hello = await call((c) => c["server.hello"]({}));
  if (hello.ok) set({ hello: hello.value });
  else if (!isTransportError(hello.error)) set({ connectionMessage: plainError(hello.error) });
  await Promise.race([gotFirstSnapshot, new Promise((r) => setTimeout(r, 5000))]);
  // First launch (onboarding never finished or skipped): show it.
  const setup = await call((c) => c["setup.state"]({}));
  if (setup.ok && !setup.value.onboarded) actions.openSetup();
  set({ ready: true });
}

/**
 * Runs a call that changes the project. Success clears the banner. A transport failure is
 * "unknown", not "didn't happen": nothing is rolled back here, the subscription will show
 * what the server did. Returns the error (if any) for callers that show it inline.
 */
async function change(run: Parameters<Connection["call"]>[0], { inline = false } = {}): Promise<CallError | undefined> {
  const result = (await call(run)) as Result<ProjectSnapshot>;
  if (result.ok) {
    const renamed = state.snapshot && projectOf(state.snapshot).name !== projectOf(result.value).name;
    applyFromCall(result.value);
    set({ notice: undefined });
    if (renamed) void refreshRecents(); // the Open Recent menu shows the new name
    return undefined;
  }
  const error = result.error;
  if (error.reason === "changed-on-disk") set({ changedOnDisk: true, reloadProblem: undefined, notice: undefined });
  else if (!inline) set({ notice: { text: plainError(error), transport: isTransportError(error) } });
  return error;
}

/** Plan an edit against the project on screen, send it, then select (and go to) the new item. */
// One add at a time: a double click must not plan two edits against the same project (they'd
// pick the same new id, and the second would be refused). Clicks while one is in flight are dropped.
let adding = false;
async function addPlanned(plan: (project: ProjectModel) => Planned) {
  if (adding || !state.snapshot || !online()) return;
  const planned = plan(projectOf(state.snapshot));
  if ("problem" in planned) return set({ notice: { text: planned.problem } });
  adding = true;
  let error: CallError | undefined;
  try {
    error = await change((c) => c["project.edit"]({ ops: planned.ops, summary: planned.summary }));
  } finally {
    adding = false;
  }
  if (error) return;
  playback.pause();
  playback.select(planned.itemId);
  playback.seek(planned.start);
}

/**
 * A manual timeline edit (D52): ops planned against the project at `baseRevision`, sent as one
 * project.edit, so it is validated, undoes in one step and is listed in the agent's next note.
 * If the agent changed the same item after that revision the server refuses it (D6) and the
 * banner says so. Shares the one-at-a-time guard with adds. Returns whether it was applied.
 */
async function timelineEdit(plan: Plan | { readonly problem: string }, origin: { readonly baseRevision?: number | undefined; readonly dir?: string | undefined } = {}): Promise<boolean> {
  const snapshot = state.snapshot;
  if (!snapshot || !online()) return false;
  // Planned in another project (it was switched mid-gesture): never send it to this one.
  if (origin.dir !== undefined && origin.dir !== snapshot.dir) return false;
  if ("problem" in plan) {
    set({ notice: { text: plan.problem } });
    return false;
  }
  if (!plan.ops.length) return false;
  if (adding) {
    set({ notice: { text: "The last change is still being saved. Try that again in a moment." } });
    return false;
  }
  // Checked with the server's timeline rules first, so a refusal reads as a sentence, not jargon.
  const draft = draftOf(projectOf(snapshot), plan.ops);
  if ("problem" in draft && origin.baseRevision === undefined) {
    set({ notice: { text: draft.problem } });
    return false;
  }
  const baseRevision = origin.baseRevision ?? snapshot.revision;
  adding = true;
  try {
    return !(await change((c) => c["project.edit"]({ ops: plan.ops, summary: plan.summary, baseRevision })));
  } finally {
    adding = false;
  }
}

export const actions = {
  showNewProject: () => set({ newProjectOpen: true }),
  hideNewProject: () => set({ newProjectOpen: false }),

  chooseParentFolder: () => bridge.chooseFolder("parent"),

  /** Creates and opens the project (replacing any open one); returns the error for the form. */
  async createProject(input: { parentDir: string; name: string; canvas: Canvas }): Promise<string | undefined> {
    const result = await call((c) => c["project.create"](input));
    if (result.ok) {
      applyFromCall(result.value);
      set({ newProjectOpen: false, welcomeError: undefined, notice: undefined });
      void refreshRecents();
      return undefined;
    }
    if (result.error.reason === "exists") return `"${input.name}.uncut" already exists in that folder. Pick another name or folder.`;
    return plainError(result.error);
  },

  /** Opens a project. The error shows where the user is: the welcome card or the editor banner. */
  async openProject(dir: string) {
    const result = await call((c) => c["project.open"]({ dir }));
    if (result.ok) {
      applyFromCall(result.value);
      set({ welcomeError: undefined, notice: undefined });
      void refreshRecents();
      return;
    }
    const text = `Couldn't open ${dir.split("/").pop()}. ${plainError(result.error)}`;
    if (state.snapshot) set({ notice: { text, transport: isTransportError(result.error) } });
    else set({ welcomeError: text });
  },

  async openWithDialog() {
    const dir = await bridge.chooseFolder("project");
    if (dir) await actions.openProject(dir);
  },

  async closeProject() {
    if (!state.snapshot) return;
    const result = await call((c) => c["project.close"]({}));
    if (!result.ok) return set({ notice: { text: plainError(result.error), transport: isTransportError(result.error) } });
    set({ snapshot: null, changedOnDisk: false, reloadProblem: undefined, notice: undefined, welcomeError: undefined });
    playback.reset();
    await refreshRecents();
  },

  undo: () => (state.snapshot?.canUndo ? change((c) => c["project.undo"]({})) : undefined),
  redo: () => (state.snapshot?.canRedo ? change((c) => c["project.redo"]({})) : undefined),
  /** Media tile → timeline (see planAddMedia); the playhead moves to the new item. */
  addMedia: (mediaId: string) => addPlanned((project) => planAddMedia(project, mediaId)),
  /** Text tab preset → a text item at the playhead (see planAddText). */
  addText: (preset: TextPreset) => addPlanned((project) => planAddText(project, preset, getPlayback().frame)),
  /** A planned move or trim from the timeline (see edit.ts). */
  timelineEdit,
  /** S: split at the playhead (see planSplit); the part after the playhead is selected. */
  async split() {
    if (!state.snapshot) return;
    const { selected, frame } = getPlayback();
    const plan = planSplit(projectOf(state.snapshot), selected, frame);
    if (await timelineEdit(plan)) playback.select("newId" in plan ? plan.newId : undefined);
  },
  /** ⌫: delete the selected item; on main the rest closes up. */
  async deleteSelected() {
    if (!state.snapshot) return;
    if (await timelineEdit(planDelete(projectOf(state.snapshot), getPlayback().selected))) playback.select(undefined);
  },
  toggleTrack: (trackId: string, flag: TrackFlag) => (state.snapshot ? timelineEdit(planTrackFlag(projectOf(state.snapshot), trackId, flag)) : undefined),
  rename: (name: string) =>
    change((c) => c["project.edit"]({ ops: [{ op: "update_project", set: { name } }], summary: "Rename project" }), { inline: true }),

  async reload() {
    const result = await call((c) => c["project.reload"]({}));
    if (result.ok) {
      applyFromCall(result.value);
      set({ changedOnDisk: false, reloadProblem: undefined, notice: undefined });
      void refreshRecents();
    } else if (isTransportError(result.error)) set({ notice: { text: plainError(result.error), transport: true } });
    else set({ reloadProblem: plainError(result.error) });
  },

  showInFolder: (path: string) => bridge.showInFolder(path),

  /**
   * Import files (from a drop) or, with no paths, ask with the native dialog. The server runs
   * it as a job (queued behind any running one); progress and results arrive on media.jobs.
   */
  async importMedia(paths?: ReadonlyArray<string>) {
    const chosen = paths ?? (await bridge.chooseMedia());
    const absolute = chosen.filter((p) => typeof p === "string" && p.startsWith("/"));
    if (absolute.length === 0) return;
    if (!activeJobs(state).length) set({ importReport: undefined });
    const result = await call((c) => c["media.import"]({ paths: absolute }));
    if (!result.ok) set({ importReport: { failed: absolute.map((path) => ({ path, message: plainError(result.error) })), skipped: [] } });
  },
  dismissImportReport: () => set({ importReport: undefined }),

  dismissNotice: () => set({ notice: undefined }),

  /** Start an agent turn; returns false (and says why in the Agent tab) when it didn't start. */
  async agentSend(prompt: string): Promise<boolean> {
    if (!online()) return false;
    set({ agentError: undefined });
    // The agent works on what's on screen: stop playback so the frame it's told about stays put.
    playback.pause();
    const { frame, selected } = getPlayback();
    const result = await call((c) => c["agent.send"]({ prompt, frame: Math.floor(frame), ...(selected ? { selected } : {}) }));
    if (result.ok) return true;
    set({ agentError: plainError(result.error) });
    // "Not installed" may be news to the setup rows too.
    if (result.error.reason === "not-installed") void actions.checkSetup();
    return false;
  },
  agentCancel: () => call((c) => c["agent.cancel"]({})),
  async agentUndoTurn(turnId: string) {
    set({ agentError: undefined });
    const result = (await call((c) => c["agent.undoTurn"]({ turnId }))) as Result<ProjectSnapshot>;
    if (result.ok) applyFromCall(result.value);
    else if (result.error.reason === "changed-on-disk") set({ changedOnDisk: true, reloadProblem: undefined });
    else set({ agentError: plainError(result.error) });
  },
  dismissAgentError: () => set({ agentError: undefined }),

  openSetup() {
    set({ setupOpen: true });
    void actions.checkSetup();
  },
  async checkSetup() {
    set({ setupChecking: true, setupError: undefined });
    const result = await call((c) => c["setup.check"]({}));
    if (result.ok) set({ setupChecking: false, setupChecks: result.value });
    else set({ setupChecking: false, setupError: `Couldn't check this Mac. ${plainError(result.error)}` });
  },
  copy: (text: string) => bridge.copyText(text),
  /** Finish (or skip) onboarding; it won't open on launch again. */
  async finishSetup(next: "new-project" | "stay") {
    set({ setupOpen: false });
    await call((c) => c["setup.complete"]({}));
    if (next === "new-project") actions.showNewProject();
  },
};

function runCommand(command: MenuCommand) {
  // Everything below talks to the server; while it's away the buttons are disabled too.
  if (!online()) return;
  if (command.type === "open-setup") return actions.openSetup();
  switch (command.type) {
    case "new-project":
      // Over the editor if one is open; the current project only closes once the new one exists.
      return actions.showNewProject();
    case "open-project":
      return void actions.openWithDialog();
    case "open-recent":
      return void actions.openProject(command.dir);
    case "close-project":
      if (state.newProjectOpen) return actions.hideNewProject();
      return void actions.closeProject();
    case "undo":
    case "redo":
      return undoOrRedo(command.type);
  }
}

const isEditable = (el: Element | null) => el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || (el instanceof HTMLElement && el.isContentEditable);

// In a text field ⌘Z undoes typing; elsewhere it undoes the last project change.
function undoOrRedo(kind: "undo" | "redo") {
  if (isEditable(document.activeElement)) document.execCommand(kind);
  else void actions[kind]();
}

// The menu shows these shortcuts but doesn't register them (registerAccelerator: false), so
// the keys arrive here and there is one code path for them.
function onKeyDown(event: KeyboardEvent) {
  if (!event.metaKey || event.altKey || event.ctrlKey) return;
  const key = event.key.toLowerCase();
  const command: MenuCommand | undefined =
    key === "z"
      ? { type: event.shiftKey ? "redo" : "undo" }
      : event.shiftKey
        ? undefined
        : key === ","
          ? { type: "open-setup" }
          : key === "n"
          ? { type: "new-project" }
          : key === "o"
            ? { type: "open-project" }
            : key === "w" && state.snapshot
              ? { type: "close-project" }
              : undefined;
  if (!command) return;
  event.preventDefault();
  runCommand(command);
}
