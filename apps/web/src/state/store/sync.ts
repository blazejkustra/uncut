import type { ProjectSnapshot, BrandState, ImportJob, ExportJob, AnalysisJob } from "@uncut/contracts";
import { bridge } from "../bridge.ts";
import type { Result } from "../connection.ts";
import { playback } from "../../preview/playback.ts";
import { layoutOf } from "../project.ts";
import { state, set, projectOf, isRemote } from "./core.ts";
import { actions } from "./actions.ts";
import { applyWaitingUi } from "./agentUi.ts";
import { call, plainError } from "./server.ts";
import type { AppStateShape } from "./types.ts";

// The newest revision this window has shown, per project. A project's revisions only go up on the
// server (they're its own since D71, kept in history.db), so a call result at or below it is old
// news (e.g. it arrived after a reconnect's refetch). The subscription is always applied; the mark only rises.
const newestRevision = new Map<string, number>();

/** From the subscription: authoritative, always applied. */
export function applyFromServer(snapshot: ProjectSnapshot | null) {
  if (snapshot) newestRevision.set(snapshot.dir, Math.max(newestRevision.get(snapshot.dir) ?? -1, snapshot.revision));
  const switched = snapshot?.dir !== state.snapshot?.dir;
  const mediaChanged = mediaKey(snapshot) !== mediaKey(state.snapshot);
  if (mediaChanged) void refreshThumbs();
  set({
    snapshot,
    ...(switched ? { changedOnDisk: false, reloadProblem: undefined, notice: undefined, importReport: undefined, exportOpen: false, panelRequest: undefined, agentChange: undefined, agentDraft: "", agentMentions: [], agentImages: [], agentQueued: undefined } : {}),
  });
  // Then the playhead follows the project: back to the start for another project, clamped when it
  // got shorter. After the snapshot, so nothing draws the old project at the reset playhead (the
  // preview of the old project ignores changes once the open folder isn't its own).
  if (switched) playback.reset();
  // D186: the brand state follows the project (its kits, skills and choice).
  if (switched) void actions.brandGet();
  if (snapshot) {
    const { frames, end } = layoutOf(projectOf(snapshot));
    playback.setProject(frames, projectOf(snapshot).canvas.fps, end);
  }
  applyWaitingUi();
}

// Paths too: a relinked file (same id, new path) has another poster.
const mediaKey = (s: ProjectSnapshot | null) => (s ? `${s.dir}|${projectOf(s).media.map((m) => `${m.id}=${m.path}`).join(",")}` : "");
async function refreshThumbs() {
  const ids = await call((c) => c["media.thumbnails"]({}));
  if (ids.ok) set({ thumbIds: new Set(ids.value) });
}

/** From a call result: applied only if it is newer than anything shown. */
export function applyFromCall(snapshot: ProjectSnapshot) {
  if (snapshot.revision <= (newestRevision.get(snapshot.dir) ?? -1)) return;
  applyFromServer(snapshot);
}

/** A brand call's answer into the state (or its reason into brandError). */
export function brandResult(result: Result<BrandState>): boolean {
  if (result.ok) set({ brand: result.value, brandError: undefined });
  else set({ brandError: plainError(result.error) });
  return result.ok;
}
// Finished jobs whose result has been shown (or that finished before this window saw them).
const reported = new Set<string>();
let jobsSeen = false;

/** Jobs as the server reports them: progress, finished results and newly made posters. */
export function onJobs(jobs: ReadonlyArray<ImportJob>) {
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
      // The agent's imports (D65) are reported in its turn, not as the Library's import report.
      if (job.projectDir === state.snapshot?.dir && !job.agent) {
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

// Exports this window started: each is shown in Finder once it's done ("Opens in Finder when it's done").
export const revealWhenDone = new Set<string>();
// The agent's exports (export_video) this window took up as its own, once each.
const agentExportsSeen = new Set<string>();
export function onExportJobs(jobs: ReadonlyArray<ExportJob>) {
  for (const job of jobs) {
    // An export the agent started for the open project shows like one started here: the top bar's
    // progress, the dialog's Cancel and Saved, and Finder once it's done.
    if (job.agent && !agentExportsSeen.has(job.id) && job.projectDir === state.snapshot?.dir && ["queued", "preparing", "rendering"].includes(job.phase)) {
      agentExportsSeen.add(job.id);
      revealWhenDone.add(job.id);
      set({ exportJobId: job.id, exportFolder: job.output.slice(0, job.output.lastIndexOf("/")) || "/" });
    }
    if (!revealWhenDone.has(job.id) || (job.phase !== "done" && job.phase !== "failed" && job.phase !== "cancelled")) continue;
    revealWhenDone.delete(job.id);
    // A remote export stays on its server (D109): Download brings it here.
    if (job.phase === "done" && !isRemote()) void bridge.showInFolder(job.output);
  }
  set({ exportJobs: jobs });
}

/** The open project's analysis jobs for a media item (also joined ones, same content) that are waiting or running. */
export const activeAnalyses = (s: AppStateShape, mediaId: string) =>
  s.analysisJobs.filter((j) => j.projectDir === s.snapshot?.dir && (j.mediaId === mediaId || j.mediaIds.includes(mediaId)) && (j.phase === "queued" || j.phase === "running"));

// Analysis jobs this window saw waiting or running: if one of them fails, the Library says why
// (a cancel, by the user or a project closing, says nothing).
const analysesWatched = new Set<string>();
export function onAnalysisJobs(analysisJobs: ReadonlyArray<AnalysisJob>) {
  let analysisError = state.analysisError;
  for (const job of analysisJobs) {
    if (job.phase === "queued" || job.phase === "running") analysesWatched.add(job.id);
    else if (analysesWatched.delete(job.id) && job.phase === "failed" && job.projectDir === state.snapshot?.dir) {
      const name = state.snapshot ? (projectOf(state.snapshot).media.find((m) => m.id === job.mediaId)?.name ?? job.mediaId) : job.mediaId;
      analysisError = `Couldn't analyse ${name}: ${job.error ?? "the analysis stopped."}`;
    }
  }
  set({ analysisJobs, analysisError });
}

/** The open project's import jobs that are still running or waiting. */
export const activeJobs = (s: AppStateShape) => s.jobs.filter((j) => j.projectDir === s.snapshot?.dir && j.phase !== "done" && j.phase !== "failed");
