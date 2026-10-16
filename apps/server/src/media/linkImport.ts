// D259 (#94): Import from link, through the user's own yt-dlp. Uncut never bundles or downloads
// yt-dlp: it looks for one on PATH (which already holds the login shell's PATH, D-shellEnv) and in
// the Homebrew folders, and says how to install it when there's none. A download runs yt-dlp
// directly (no shell) with linkArgs' arguments into the project's media/links/ under a name of
// ours, renames it after the title, and imports it like a capture (D98: the import job, quiet, a
// relative path) with source {module: "import.link", url, title, kind, quality}: one user edit, on the
// timeline too when the link was dropped there. Cancel kills yt-dlp's whole process group (its
// ffmpeg too) and removes the partial files. On a remote environment it's the server's yt-dlp.
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, realpath, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative } from "node:path";

import { DEFAULT_LINK_QUALITY, LinkError, type LinkJob, type LinkRequest, type LinkTool } from "@uncut/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { ServerConfig } from "../app/config.ts";
import { versionToken, which } from "../app/setup.ts";
import { mergePath, pluginEnv } from "../app/shellEnv.ts";
import { Projects } from "../project/projects.ts";
import { MediaLibrary } from "./media.ts";
import { runProbe } from "./probe.ts";
import { checkLink, linkFileStem, linkMediaName, LINKS_DIR, parseLine, plainYtDlpError, ytDlpArgs } from "./linkArgs.ts";

const MAX_JOBS_KEPT = 10;
const STDERR_KEEP = 64 * 1024;
/** Homebrew's folders, looked in even when PATH doesn't have them (not when tests turn the shell lookup off). */
export const HOMEBREW_DIRS = ["/opt/homebrew/bin", "/usr/local/bin"];

export interface LinkImportShape {
  readonly check: Effect.Effect<LinkTool>;
  readonly start: (request: LinkRequest) => Effect.Effect<{ jobId: string }, LinkError>;
  readonly jobs: Stream.Stream<ReadonlyArray<LinkJob>>;
  readonly cancel: (jobId: string) => Effect.Effect<void>;
}

export class LinkImport extends Context.Service<LinkImport, LinkImportShape>()("uncut/LinkImport") {}

/** Where to look for yt-dlp: PATH, then the Homebrew folders (unless UNCUT_SHELL_ENV=off, the tests' bare PATH). */
export const ytDlpSearchPath = (env: NodeJS.ProcessEnv) => mergePath(env.PATH, env.UNCUT_SHELL_ENV === "off" ? "" : HOMEBREW_DIRS.join(":"));

/** Kills a detached child's whole process group: TERM, then KILL if it's still there. */
const killTree = (child: ChildProcess) => {
  const signal = (s: NodeJS.Signals) => {
    try {
      if (child.pid) process.kill(-child.pid, s);
    } catch {
      try {
        child.kill(s);
      } catch {}
    }
  };
  signal("SIGTERM");
  setTimeout(() => child.exitCode === null && child.signalCode === null && signal("SIGKILL"), 3000).unref();
};

/** Runs yt-dlp, handing each output line to `onLine`; resolves with its exit code and the tail of stderr. */
export const runYtDlp = (bin: string, args: ReadonlyArray<string>, onLine: (line: string) => void, signal: AbortSignal) =>
  new Promise<{ code: number | null; stderr: string; spawnError?: string }>((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(bin, [...args], { env: { ...pluginEnv(process.env), PATH: process.env.PATH ?? "" }, stdio: ["ignore", "pipe", "pipe"], detached: true });
    } catch (e) {
      return resolve({ code: null, stderr: "", spawnError: (e as Error).message });
    }
    let stderr = "";
    const lines = (onChunk: (text: string) => void) => {
      let buffer = "";
      return (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        const parts = buffer.split(/\r?\n|\r/);
        buffer = parts.pop() ?? "";
        for (const p of parts) onChunk(p);
        if (buffer.length > 16384) buffer = buffer.slice(-16384);
      };
    };
    child.stdout?.on("data", lines(onLine));
    child.stderr?.on(
      "data",
      lines((l) => {
        stderr = (stderr + l + "\n").slice(-STDERR_KEEP);
        onLine(l);
      }),
    );
    const onAbort = () => killTree(child);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    child.on("error", (e) => {
      signal.removeEventListener("abort", onAbort);
      resolve({ code: null, stderr, spawnError: e.message });
    });
    child.on("close", (code) => {
      signal.removeEventListener("abort", onAbort);
      resolve({ code, stderr });
    });
  });

export const layer = Layer.effect(
  LinkImport,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const projects = yield* Projects;
    const media = yield* MediaLibrary;
    const scope = yield* Effect.scope;
    const jobsRef = yield* SubscriptionRef.make<ReadonlyArray<LinkJob>>([]);
    const controllers = new Map<string, AbortController>();
    yield* Effect.addFinalizer(() => Effect.sync(() => controllers.forEach((c) => c.abort())));

    const update = (id: string, patch: Partial<LinkJob>) => Effect.runSync(SubscriptionRef.update(jobsRef, (jobs) => jobs.map((j) => (j.id === id ? { ...j, ...patch } : j))));

    const find = Effect.promise(async () => {
      await config.shellReady;
      return which("yt-dlp", ytDlpSearchPath(process.env));
    });

    const check: LinkImportShape["check"] = Effect.gen(function* () {
      const bin = yield* find;
      if (!bin) return { found: false };
      const r = yield* Effect.promise(() => runProbe(bin, ["--version"], { timeoutMs: 10000, env: pluginEnv(process.env), maxBytes: 4096 }));
      const version = r.kind === "done" && r.code === 0 ? versionToken(r.stdout) : undefined;
      return { found: true, path: bin, ...(version ? { version } : {}) };
    });

    /** The project's media/links/, inside the project by realpath (a symlinked media/ pointing out is refused). */
    const linksFolder = (dir: string) =>
      Effect.tryPromise({
        try: async () => {
          const folder = join(dir, LINKS_DIR);
          await mkdir(folder, { recursive: true });
          const [real, project] = await Promise.all([realpath(folder), realpath(dir)]);
          const rel = relative(project, real);
          if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error(`The project's ${LINKS_DIR} folder points outside the project.`);
          return real;
        },
        catch: (e) => new LinkError({ reason: "failed", message: (e as Error).message }),
      });

    /** Our temporary files for a job (yt-dlp's parts, fragments and the unrenamed result). */
    const removePartials = (folder: string, stem: string) =>
      Effect.promise(async () => {
        const files = await readdir(folder).catch(() => [] as Array<string>);
        await Promise.all(files.filter((f) => f.startsWith(`${stem}.`)).map((f) => rm(join(folder, f), { force: true, recursive: true })));
      });

    const run = (id: string, bin: string, request: { readonly url: string; readonly kind: LinkRequest["kind"]; readonly quality: NonNullable<LinkRequest["quality"]>; readonly drop?: LinkRequest["drop"] }, target: { readonly openId: number; readonly dir: string }, signal: AbortSignal) =>
      Effect.gen(function* () {
        const failed = (message: string) => new LinkError({ reason: "failed", message });
        const folder = yield* linksFolder(target.dir);
        const stem = `link-${id.slice(0, 8)}`;
        const ffmpeg = yield* Effect.promise(() => which("ffmpeg", process.env.PATH ?? ""));
        const args = ytDlpArgs({ url: request.url, kind: request.kind, quality: request.quality, outBase: join(folder, stem), ffmpeg });
        let title: string | undefined;
        let printed: string | undefined;
        const result = yield* Effect.promise(() =>
          runYtDlp(
            bin,
            args,
            (line) => {
              const read = parseLine(line);
              if (!read) return;
              if ("title" in read) {
                title = read.title;
                update(id, { title: read.title });
              } else if ("file" in read) printed = read.file;
              else if ("progress" in read) update(id, { progress: read.progress, status: `Downloading… ${Math.round(read.progress * 100)}%` });
              else update(id, { status: read.status });
            },
            signal,
          ),
        );
        if (signal.aborted) {
          yield* removePartials(folder, stem);
          return yield* failed("Cancelled.");
        }
        if (result.spawnError) {
          yield* removePartials(folder, stem);
          return yield* failed(`yt-dlp couldn't be started: ${result.spawnError}`);
        }
        if (result.code !== 0) {
          yield* removePartials(folder, stem);
          return yield* failed(plainYtDlpError(result.stderr, result.code));
        }
        // The finished file: the one yt-dlp printed (only if it's ours, in the folder), else ours by name.
        const made = yield* Effect.promise(async () => {
          const ours = (p: string) => dirname(p) === folder && basename(p).startsWith(`${stem}.`) && !/\.(part|ytdl|temp)$/.test(p);
          if (printed && isAbsolute(printed)) {
            const real = await realpath(printed).catch(() => undefined);
            if (real && ours(real) && (await stat(real).catch(() => undefined))?.isFile()) return real;
          }
          const files = (await readdir(folder).catch(() => [] as Array<string>)).filter((f) => f.startsWith(`${stem}.`) && !/\.f\d+\./.test(f) && !/\.(part|ytdl|temp)$/.test(f));
          return files.length === 1 ? join(folder, files[0]!) : undefined;
        });
        if (!made) {
          yield* removePartials(folder, stem);
          return yield* failed("yt-dlp finished but no file came out.");
        }
        // Named after the title, unique in the folder.
        const final = yield* Effect.promise(async () => {
          const ext = extname(made).toLowerCase();
          const base = linkFileStem(title);
          const taken = new Set(await readdir(folder).catch(() => [] as Array<string>));
          let name = `${base}${ext}`;
          for (let n = 2; taken.has(name); n++) name = `${base} ${n}${ext}`;
          const to = join(folder, name);
          if (dirname(to) !== folder) return made;
          return rename(made, to).then(
            () => to,
            () => made,
          );
        });
        if (signal.aborted) {
          yield* Effect.promise(() => rm(final, { force: true }));
          return yield* failed("Cancelled.");
        }
        update(id, { phase: "importing", status: "Adding it to Media…", progress: 1 });
        const open = Effect.runSync(projects.view);
        const names = new Set(open && open.openId === target.openId ? open.session.project.media.map((m) => m.name) : []);
        const source = { module: "import.link", url: request.url, ...(title ? { title } : {}), kind: request.kind, ...(request.kind === "video" ? { quality: request.quality } : {}), tool: "yt-dlp" };
        const drop = request.drop ? { frame: Math.max(0, Math.round(request.drop.frame)), ...(request.drop.track ? { track: request.drop.track } : {}) } : undefined;
        const imported = yield* media
          .importCapture({ openId: target.openId, dir: target.dir, path: final, name: linkMediaName(title, names), source, drop })
          .pipe(Effect.mapError((e) => failed(`It was downloaded but couldn't be added: ${e.message}`)));
        const entry = imported.entries[0];
        if (!entry) {
          yield* Effect.promise(() => rm(final, { force: true }));
          return yield* failed(`It was downloaded but couldn't be added: ${imported.failed[0]?.message ?? imported.skipped[0]?.reason ?? "nothing was added"}`);
        }
        return entry;
      });

    const start: LinkImportShape["start"] = (request) =>
      Effect.gen(function* () {
        const open = yield* projects.current;
        if (!open) return yield* new LinkError({ reason: "no-project", message: "Open a project first: what's imported goes into its Media." });
        const checked = checkLink(request.url);
        if ("problem" in checked) return yield* new LinkError({ reason: "bad-url", message: checked.problem });
        const bin = yield* find;
        if (!bin) return yield* new LinkError({ reason: "no-tool", message: "yt-dlp isn't installed. Install it with: brew install yt-dlp" });
        const id = randomUUID();
        const quality = request.quality ?? DEFAULT_LINK_QUALITY;
        const job: LinkJob = { id, projectDir: open.dir, url: checked.url, kind: request.kind, quality, phase: "running", status: "Starting yt-dlp…", startedAt: new Date().toISOString() };
        const live = (j: LinkJob) => j.phase === "running" || j.phase === "importing";
        yield* SubscriptionRef.update(jobsRef, (jobs) => [...jobs.filter(live), ...jobs.filter((j) => !live(j)).slice(-MAX_JOBS_KEPT), job]);
        const controller = new AbortController();
        controllers.set(id, controller);
        yield* Effect.forkIn(
          run(id, bin, { url: checked.url, kind: request.kind, quality, ...(request.drop ? { drop: request.drop } : {}) }, { openId: open.openId, dir: open.dir }, controller.signal).pipe(
            Effect.match({
              onSuccess: (entry) => update(id, { phase: "done", status: undefined, mediaId: entry.id, name: entry.name }),
              onFailure: (e) => update(id, controller.signal.aborted ? { phase: "cancelled", status: undefined } : { phase: "failed", status: undefined, error: e.message }),
            }),
            Effect.ensuring(Effect.sync(() => controllers.delete(id))),
          ),
          scope,
        );
        return { jobId: id };
      });

    return LinkImport.of({
      check,
      start,
      jobs: SubscriptionRef.changes(jobsRef),
      cancel: (jobId) => Effect.sync(() => controllers.get(jobId)?.abort()),
    });
  }),
);
