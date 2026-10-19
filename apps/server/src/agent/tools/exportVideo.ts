// export_video: the agent starts the Export dialog's own job (exporter.start, the same server job
// the dialog's export.start runs), marked agent so the editor shows it like the user's (progress,
// Cancel, Saved, Open in Finder), and waits for it. Where it goes is a write to the user's disk:
// the folder is resolved and checked here (never Uncut's data, inside the project package, ~/Library,
// hidden or system folders), a taken name gets " 2" like Finder, and a card asks first unless the
// chat is Auto and the user named that folder in this message.
import { existsSync, realpathSync, statSync } from "node:fs";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";

import type { ExportJob, ExportLoudness, ExportQuality } from "@uncut/contracts";
import { choiceOfTarget, projectTargetLufs, type Project } from "@uncut/core";
import * as Effect from "effect/Effect";

import { defaultParentDir } from "../../app/files.ts";
import { expandHome } from "../../paths.ts";
import type { ProjectView } from "../../project/projects.ts";
import { inside, namedFolders } from "../permissions/paths.ts";
import type { Running } from "../session/types.ts";
import type { LibraryCtx } from "./library.ts";

/** Folder words a user says ("export to Desktop"), each a folder in their home. */
export const FOLDER_WORDS: Readonly<Record<string, string>> = { desktop: "Desktop", downloads: "Downloads", movies: "Movies", documents: "Documents", videos: "Movies", music: "Music", pictures: "Pictures" };
const ACTIVE = new Set(["queued", "preparing", "rendering"]);
/** How long export_video waits for its job (UNCUT_EXPORT_WAIT_MS for tests); after it, the job goes on in the editor. */
export const exportWaitMs = () => {
  const n = Number(process.env.UNCUT_EXPORT_WAIT_MS);
  return Number.isFinite(n) && n > 0 ? n : 25 * 60_000;
};

const real = (p: string) => {
  try {
    return realpathSync.native(p);
  } catch {
    return p;
  }
};

/** A file name the Finder accepts, ending in .mp4 (the dialog's fileName). */
export const exportFileName = (name: string) => {
  const clean = name.replace(/[/:\\]/g, "-").trim() || "Untitled";
  return /\.mp4$/i.test(clean) ? clean : `${clean}.mp4`;
};

/**
 * The folder `asked` means: a folder word (Desktop, Movies...), ~/… or an absolute path; nothing
 * is the dialog's folder (`fallback`). Its real path, or why it can't be used.
 */
export function resolveExportFolder(asked: string | undefined, o: { readonly project: string; readonly dataDir: string; readonly fallback: string; readonly home?: string }): { readonly dir: string } | { readonly problem: string } {
  const home = o.home ?? homedir();
  const said = asked?.trim().replace(/\/+$/, "") ?? "";
  let dir: string;
  if (!said) dir = o.fallback;
  else {
    const word = FOLDER_WORDS[said.replace(/^~\//, "").toLowerCase()];
    const expanded = expandHome(said, home, true);
    if (word) dir = join(home, word);
    else if (said === "~") dir = home;
    else if (isAbsolute(expanded)) dir = expanded;
    else return { problem: `"${said}" isn't a folder Uncut knows: pass Desktop, Movies, Downloads or Documents, or a full path (/Users/you/… or ~/…).` };
  }
  let kind: "dir" | "file" | undefined;
  try {
    const s = statSync(dir);
    kind = s.isDirectory() ? "dir" : "file";
  } catch {}
  if (kind !== "dir") return { problem: kind === "file" ? `${dir} is a file, not a folder.` : `The folder ${dir} doesn't exist. Make it first, or choose another.` };
  const at = real(dir);
  const problem = exportFolderProblem(at, { project: real(o.project), dataDir: real(o.dataDir), home: real(home) });
  return problem ? { problem } : { dir: at };
}

/** Why an export can't be written into the real folder `dir`, or undefined. */
export function exportFolderProblem(dir: string, o: { readonly project: string; readonly dataDir: string; readonly home: string }): string | undefined {
  if (inside(dir, o.dataDir)) return "That's Uncut's own data folder; choose another folder.";
  // A project is a package (Finder shows Name.uncut as one item): a video inside it can't be found.
  if (inside(dir, o.project)) return "That's inside the project (Finder shows it as one item, so the video would be hidden); choose another folder, like Desktop or Movies.";
  if (inside(dir, o.home)) {
    const rel = relative(o.home, dir).split(sep).filter(Boolean);
    if (rel[0] === "Library") return "That's in ~/Library (apps' own files); choose another folder.";
    if (rel.some((s) => s.startsWith("."))) return "That's a hidden folder; choose another folder.";
    return undefined;
  }
  // Outside the home folder only an external disk (/Volumes/<disk>/…) is the user's.
  const vol = relative("/Volumes", dir).split(sep);
  if (inside(dir, "/Volumes") && vol.length >= 1 && vol[0] && !vol.some((s) => s.startsWith("."))) return undefined;
  return "That's a system folder; choose a folder in your home folder or on an external disk.";
}

/** Whether the user's message names the (real) folder `dir`: a folder word or a pasted path. */
export function messageNamesFolder(text: string, dir: string, project: string, home = homedir()): boolean {
  for (const [word, folder] of Object.entries(FOLDER_WORDS)) if (new RegExp(`\\b${word}\\b`, "i").test(text) && real(join(home, folder)) === dir) return true;
  const exists = (p: string) => {
    try {
      const s = statSync(p);
      return s.isDirectory() ? ("dir" as const) : s.isFile() ? ("file" as const) : undefined;
    } catch {
      return undefined;
    }
  };
  return namedFolders(text, project, exists, home).some((f) => f.dir === dir);
}

/** The first of name.mp4, name 2.mp4, name 3.mp4… in `dir` that's free (no file, no running export to it). */
export function freeOutput(dir: string, file: string, taken: (p: string) => boolean): string {
  const stem = file.replace(/\.mp4$/i, "");
  for (let n = 1; n < 1000; n++) {
    const p = join(dir, n === 1 ? file : `${stem} ${n}.mp4`);
    if (!taken(p)) return p;
  }
  return join(dir, `${stem} ${Date.now()}.mp4`);
}

const QUALITIES: ReadonlyArray<ExportQuality> = ["draft", "standard", "high"];
const LOUDNESS: ReadonlyArray<ExportLoudness> = ["normal", "quiet", "broadcast", "target", "off"];
const mb = (bytes: number) => `${(bytes / 1e6).toFixed(bytes < 1e7 ? 1 : 0)} MB`;

export const makeExportVideo = (ctx: LibraryCtx) => {
  const { textResult, exporter, askUser, config } = ctx;

  return (r: Running, v: ProjectView, args: Record<string, unknown>) =>
    Effect.gen(function* () {
      const project = v.session.project as Project;
      const quality = (args.preset ?? "standard") as ExportQuality;
      if (!QUALITIES.includes(quality)) return textResult('preset must be "draft", "standard" or "high".', true);
      const target = projectTargetLufs(project);
      const loudness = (args.loudness ?? choiceOfTarget(target)) as ExportLoudness;
      if (!LOUDNESS.includes(loudness)) return textResult(`loudness must be one of ${LOUDNESS.join(", ")}.`, true);
      if (args.motionBlur !== undefined && typeof args.motionBlur !== "boolean") return textResult("motionBlur must be true or false.", true);
      for (const k of ["fps", "shortSide"] as const) if (args[k] !== undefined && typeof args[k] !== "number") return textResult(`${k} must be a number.`, true);
      if (args.name !== undefined && (typeof args.name !== "string" || !args.name.trim())) return textResult("name must be a file name.", true);
      if (args.folder !== undefined && typeof args.folder !== "string") return textResult("folder must be a folder name or path.", true);
      // The part of the timeline (the dialog's range): the marks and selection as they were when the message was sent.
      const kind = args.range ?? "all";
      if (kind !== "all" && kind !== "marks" && kind !== "selection") return textResult('range must be "all", "marks" or "selection".', true);
      const span = kind === "marks" ? r.ranges?.marks : kind === "selection" ? r.ranges?.selection : undefined;
      if (kind !== "all" && !span) return textResult(kind === "marks" ? "No In/Out marks were set when the user sent this message. Export the whole timeline, or ask them to set In and Out (I, O) first." : "Nothing was selected on the timeline when the user sent this message. Export the whole timeline, or ask them to select the clips first.", true);
      const range = span ? { from: Math.round(span.from), to: Math.round(span.to) } : undefined;
      if (range && range.to <= range.from) return textResult("That range is empty.", true);

      // One export at a time, as in the editor.
      const jobs = yield* exporter.jobList;
      const running = jobs.find((j) => ACTIVE.has(j.phase));
      if (exporter.busy() || running) return textResult({ refused: `An export is already running${running ? ` (${basename(running.output)}, ${running.phase === "rendering" ? `${Math.round(running.progress * 100)}%` : running.phase})` : ""}: one at a time. Tell the user, and export once it's done.` }, true);

      // Where: the folder asked for, else the dialog's (the last export's folder, else ~/Movies).
      const last = [...jobs].reverse().find((j) => j.phase === "done" || ACTIVE.has(j.phase));
      const lastDir = last && existsSync(dirname(last.output)) ? dirname(last.output) : undefined;
      const where = resolveExportFolder(args.folder as string | undefined, { project: v.dir, dataDir: config.dataDir, fallback: lastDir ?? defaultParentDir() });
      if ("problem" in where) return textResult({ refused: where.problem }, true);
      const file = exportFileName(typeof args.name === "string" ? basename(args.name.trim()) : project.name);
      const busyOutputs = new Set(jobs.filter((j) => ACTIVE.has(j.phase)).map((j) => j.output));
      const output = freeOutput(where.dir, file, (p) => existsSync(p) || busyOutputs.has(p));

      // A write to the user's disk: asked on a card unless the chat is Auto and the user named this
      // folder in this message.
      const free = r.access === "auto" && typeof args.folder === "string" && args.folder.trim() !== "" && messageNamesFolder(r.turn.prompt, where.dir, v.dir);
      if (!free) {
        const why = r.access === "auto" ? "You didn't name this folder in your message, so Uncut asks before writing there." : "This chat asks before writing files.";
        const answer = yield* askUser(r, "Export the video", 0, undefined, undefined, undefined, { permission: { tool: "export", target: output, why, always: false } });
        if (answer !== "allow") return textResult(answer === "stopped" ? "The turn was stopped." : `Not exported: the user ${answer === "timeout" ? "didn't answer" : "said no"}. Don't try again in this turn; they can export from the Export dialog (⌘E).`, true);
      }

      const video = { ...(typeof args.fps === "number" ? { fps: args.fps } : {}), ...(typeof args.shortSide === "number" ? { shortSide: args.shortSide } : {}) };
      const started = yield* exporter
        .start({ output, quality, loudness, ...(loudness === "target" ? { targetLufs: target } : {}), ...(range ? { range } : {}), ...(Object.keys(video).length ? { video } : {}), ...(typeof args.motionBlur === "boolean" ? { motionBlur: args.motionBlur } : {}), agent: true })
        .pipe(
          Effect.map((x) => ({ ok: true as const, jobId: x.jobId })),
          Effect.catch((error) => Effect.succeed({ ok: false as const, message: error.message })),
        );
      if (!started.ok) return textResult({ failed: started.message }, true);

      // Wait for it (the user sees its progress in the editor and can cancel it there).
      const until = Date.now() + exportWaitMs();
      let job: ExportJob | undefined;
      for (;;) {
        job = (yield* exporter.jobList).find((j) => j.id === started.jobId);
        if (!job || !ACTIVE.has(job.phase)) break;
        if (r.abort.signal.aborted) {
          yield* exporter.cancel(started.jobId);
          return textResult("The turn was stopped, so the export was cancelled.", true);
        }
        if (Date.now() > until) return textResult({ state: job.phase, output, progress: Math.round(job.progress * 100), note: "Still exporting; it goes on in the editor (the Export button shows its progress). Tell the user where it will be saved." });
        yield* Effect.promise(() => new Promise((res) => setTimeout(res, 250)));
      }
      if (!job) return textResult({ failed: "The export job went away." }, true);
      if (job.phase === "cancelled") return textResult("Not exported: the user cancelled the export.", true);
      if (job.phase === "failed") return textResult({ failed: job.error ?? "The export didn't finish." }, true);
      const bytes = yield* Effect.promise(() => stat(job!.output).then((s) => s.size, () => undefined));
      return textResult({
        saved: job.output,
        seconds: Number(job.seconds.toFixed(2)),
        ...(bytes !== undefined ? { size: mb(bytes) } : {}),
        picture: `${job.width}×${job.height} at ${Number(job.fps.toFixed(3))} fps`,
        preset: job.quality,
        tookSeconds: job.elapsedSeconds,
        ...(job.warnings?.length ? { warnings: job.warnings } : {}),
        ...(output !== join(where.dir, file) ? { note: `${file} was already there, so it's saved as ${basename(output)}.` } : {}),
      });
    });
};
