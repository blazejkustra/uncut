import { type FileListing, type ExportJob } from "@uncut/contracts";
import { bridge } from "../../bridge.ts";
import { set, state, online, isRemote } from "../core.ts";
import type { PickerPurpose } from "../types.ts";
import { call, plainError, uploadOne } from "../server.ts";
import { activeJobs } from "../sync.ts";

// ---- the remote file browser (D107) and uploads (D108) ----

let pickerSeq = 0;
let pickerAnswer: ((value: string | ReadonlyArray<string> | null) => void) | undefined;
/** Opens the remote file browser; resolves with what was picked (a path, paths for "media"), or null. */
export function pickRemote(
  purpose: PickerPurpose,
  opts: { start?: string | undefined; fileName?: string | undefined } = {},
): Promise<string | ReadonlyArray<string> | null> {
  pickerAnswer?.(null);
  return new Promise((resolve) => {
    pickerAnswer = resolve;
    set({ remotePicker: { purpose, start: opts.start, fileName: opts.fileName, seq: ++pickerSeq } });
  });
}
/** A folder: the native dialog on Local, the server's disk on a remote. */
export async function chooseFolder(purpose: "parent" | "project" | "plugin"): Promise<string | null> {
  if (!isRemote()) return bridge.chooseFolder(purpose);
  const picked = await pickRemote(purpose);
  return typeof picked === "string" ? picked : null;
}

export const remoteActions = {
  // ---- the remote file browser (D107) ----
  listFolder: async (dir?: string): Promise<{ readonly listing: FileListing } | { readonly problem: string }> => {
    const result = await call((c) => c["files.list"](dir ? { dir } : {}));
    return result.ok ? { listing: result.value } : { problem: plainError(result.error) };
  },
  /** The browser's answer: a path, paths ("media"), or null when cancelled. */
  answerPicker(value: string | ReadonlyArray<string> | null) {
    const answer = pickerAnswer;
    pickerAnswer = undefined;
    set({ remotePicker: undefined });
    answer?.(value);
  },
  /**
   * Local files into a remote project (D108): each goes up into media/uploads/, then they're
   * imported from there as one job, as a drop on Local imports in place.
   */
  async uploadAndImport(files: ReadonlyArray<File>, drop?: { frame: number; track?: string | undefined }) {
    if (!files.length || !state.snapshot || !online() || state.uploading) return;
    if (!activeJobs(state).length) set({ importReport: undefined });
    const dir = state.snapshot.dir;
    const paths: Array<string> = [];
    const failed: Array<{ path: string; message: string }> = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i]!;
      set({ uploading: { total: files.length, done: i, name: file.name } });
      const result = await uploadOne(file);
      if ("path" in result) paths.push(result.path);
      else failed.push({ path: file.name, message: result.message });
    }
    set({ uploading: undefined });
    // The project changed meanwhile: the files are in the old one's media/uploads/, not imported here.
    if (paths.length && state.snapshot?.dir === dir) {
      const where = drop ? { drop: { frame: Math.max(0, Math.round(drop.frame)), ...(drop.track ? { track: drop.track } : {}) } } : {};
      const result = await call((c) => c["media.import"]({ paths, ...where }));
      if (!result.ok) failed.push(...paths.map((path) => ({ path, message: plainError(result.error) })));
    }
    if (failed.length) set({ importReport: { failed: [...(state.importReport?.failed ?? []), ...failed], skipped: state.importReport?.skipped ?? [] } });
  },
  /** D109: a finished remote export, downloaded to a path picked on this Mac. */
  async downloadExport(job: ExportJob) {
    if (state.downloads[job.id] && "state" in state.downloads[job.id]!) return;
    set({ downloads: { ...state.downloads, [job.id]: { state: "running" } } });
    const name = job.output.slice(job.output.lastIndexOf("/") + 1) || "Export.mp4";
    let result: { readonly path: string } | { readonly error: string } | null;
    try {
      result = await bridge.downloadExport(job.id, name);
    } catch (error) {
      result = { error: (error as Error).message };
    }
    const { [job.id]: _running, ...rest } = state.downloads;
    set({ downloads: result ? { ...rest, [job.id]: result } : rest });
  },
  /** Finder, for a path on this Mac (a downloaded export). */
  revealLocal: (path: string) => bridge.showInFolder(path),
};
