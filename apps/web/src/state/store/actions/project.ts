import { bridge } from "../../bridge.ts";
import { isTransportError } from "../../connection.ts";
import type { Canvas } from "../../format.ts";
import { playback } from "../../../preview/playback.ts";
import { rememberSideTab } from "../../../editor/layout.ts";
import { set, state, isRemote } from "../core.ts";
import { chooseFolder, pickRemote } from "./remote.ts";
import { confirmLeave, change } from "../edits.ts";
import { call, plainError, refreshRecents } from "../server.ts";
import { activeJobs, applyFromCall } from "../sync.ts";
import type { Project } from "../types.ts";
import { actions } from "../actions.ts";

export const projectActions = {
  /** Creates and opens the project (replacing any open one); returns the error for the form. */
  async createProject(input: { parentDir: string; name: string; canvas: Canvas; matchFirstClip?: boolean }): Promise<string | undefined> {
    // It replaces the open project: ask first when that one has work in progress (U12).
    if (state.snapshot && !(await confirmLeave("new-project"))) return undefined;
    const result = await call((c) => c["project.create"](input));
    if (result.ok) {
      // U14 (D180): a new project opens on the Agent tab.
      rememberSideTab(result.value.dir, "agent");
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
    if (state.snapshot && state.snapshot.dir !== dir && !(await confirmLeave("open-project"))) return;
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
    const dir = await chooseFolder("project");
    if (dir) await actions.openProject(dir);
  },

  async closeProject() {
    if (!state.snapshot) return;
    if (!(await confirmLeave("close-project"))) return;
    const result = await call((c) => c["project.close"]({}));
    if (!result.ok) return set({ notice: { text: plainError(result.error), transport: isTransportError(result.error) } });
    set({ snapshot: null, changedOnDisk: false, reloadProblem: undefined, notice: undefined, welcomeError: undefined });
    playback.reset();
    await refreshRecents();
  },

  // ⌘Z with nothing left says why when that's news (D71: it stops at a change made outside Uncut).
  undo: () => (state.snapshot?.canUndo ? change((c) => c["project.undo"]({})) : state.snapshot?.undoStop ? set({ notice: { text: state.snapshot.undoStop } }) : undefined),
  redo: () => (state.snapshot?.canRedo ? change((c) => c["project.redo"]({})) : undefined),
};
export const projectFileActions = {
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

  // A remote's paths aren't on this Mac: there is no Finder to show them in (D109).
  showInFolder: (path: string) => (isRemote() ? Promise.resolve() : bridge.showInFolder(path)),

  /** The project as it was at a revision (History's preview), or a sentence saying why not. */
  async historyPreview(revision: number): Promise<{ readonly project: Project } | { readonly problem: string }> {
    const result = await call((c) => c["history.preview"]({ revision }));
    return result.ok ? { project: result.value.project as Project } : { problem: plainError(result.error) };
  },
  /** Bring back a revision's state as a new revision (History's Restore; one ⌘Z takes it back). */
  historyJump: (revision: number) => change((c) => c["history.jump"]({ revision })),

  /**
   * Import files (from a drop) or, with no paths, ask with the native dialog. The server runs
   * it as a job (queued behind any running one); progress and results arrive on media.jobs.
   */
  async importMedia(paths?: ReadonlyArray<string>, drop?: { frame: number; track?: string | undefined }) {
    const picked = paths ?? (isRemote() ? await pickRemote("media") : await bridge.chooseMedia());
    const chosen = Array.isArray(picked) ? picked : [];
    const absolute = chosen.filter((p) => typeof p === "string" && p.startsWith("/"));
    if (absolute.length === 0) return;
    if (!activeJobs(state).length) set({ importReport: undefined });
    // T9 (D128): dropped on the timeline, the import puts them there in the same edit.
    const where = drop ? { drop: { frame: Math.max(0, Math.round(drop.frame)), ...(drop.track ? { track: drop.track } : {}) } } : {};
    const result = await call((c) => c["media.import"]({ paths: absolute, ...where }));
    if (!result.ok) set({ importReport: { failed: absolute.map((path) => ({ path, message: plainError(result.error) })), skipped: [] } });
  },
  dismissImportReport: () => set({ importReport: undefined }),

  dismissNotice: () => set({ notice: undefined }),
};
