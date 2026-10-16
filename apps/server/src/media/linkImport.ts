// D259 (#94), D280: Import from link, through the user's own yt-dlp, run by the Import from link
// plugin (plugins/catalog/uncut-link-import, uncut.link-import): not bundled, off until the user installs
// and allows it in Settings › Plugins; refused here otherwise. Uncut never bundles or downloads
// yt-dlp: the plugin looks for one in the search path Uncut gives it (PATH, which already holds the
// login shell's PATH, and the Homebrew folders). Uncut calls the plugin itself (plugins.callPlugin,
// like the Whisper plugin): it has no agent tools, so the agent can't start a download. The plugin
// downloads into the project's media/links/ under a name of ours; Uncut renames it after the title
// and imports it like a capture (D98: the import job, quiet, a relative path) with source
// {module: "import.link", url, title, kind, quality, tool}: one user edit, on the timeline too when
// the link was dropped there. Cancel cancels the plugin call: the plugin kills yt-dlp's whole
// process group (its ffmpeg too) and removes the partial files. On a remote environment it's the
// server's plugin and yt-dlp.
import { randomUUID } from "node:crypto";
import { mkdir, readdir, realpath, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative } from "node:path";

import { DEFAULT_LINK_QUALITY, LINK_PLUGIN_ID, LinkError, type LinkJob, type LinkRequest, type LinkTool } from "@uncut/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { ServerConfig } from "../app/config.ts";
import { mergePath } from "../app/shellEnv.ts";
import { Plugins } from "../plugins/plugins.ts";
import { Projects } from "../project/projects.ts";
import { MediaLibrary } from "./media.ts";
import { checkLink, linkFileStem, linkMediaName, LINKS_DIR } from "./linkArgs.ts";

const MAX_JOBS_KEPT = 10;
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

/** One download may take this long (the manifest's per-call limit is 30 minutes; Cancel stops it sooner). */
const DOWNLOAD_TIMEOUT_MS = 6 * 60 * 60 * 1000;

/** Why Import from link can't run when its plugin isn't installed and allowed, in words. */
export const pluginRefusal = (status: "ready" | "needs-approval" | "broken" | undefined): string | undefined =>
  status === "ready"
    ? undefined
    : status === "needs-approval"
      ? "Import from link isn't allowed yet: allow it in Settings › Plugins."
      : status === "broken"
        ? "The Import from link plugin can't be used right now: look at it in Settings › Plugins."
        : "Import from link is a plugin: install it from Settings › Plugins first.";

export const layer = Layer.effect(
  LinkImport,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const projects = yield* Projects;
    const media = yield* MediaLibrary;
    const plugins = yield* Plugins;
    const scope = yield* Effect.scope;
    const jobsRef = yield* SubscriptionRef.make<ReadonlyArray<LinkJob>>([]);
    const controllers = new Map<string, AbortController>();
    yield* Effect.addFinalizer(() => Effect.sync(() => controllers.forEach((c) => c.abort())));

    const update = (id: string, patch: Partial<LinkJob>) => Effect.runSync(SubscriptionRef.update(jobsRef, (jobs) => jobs.map((j) => (j.id === id ? { ...j, ...patch } : j))));

    /** The plugin's status (installed and allowed: "ready"), after a fresh scan; undefined when it isn't installed. */
    const pluginStatus = Effect.map(plugins.list, (list) => list.find((p) => p.id === LINK_PLUGIN_ID)?.status);
    /** Where the plugin looks for yt-dlp and ffmpeg: PATH (with the login shell's, once read) and the Homebrew folders. */
    const searchPath = Effect.promise(async () => {
      await config.shellReady;
      return ytDlpSearchPath(process.env);
    });
    const textOf = (r: { readonly content: ReadonlyArray<{ readonly type: string; readonly text?: string }> }) => r.content.flatMap((c) => (c.type === "text" && c.text ? [c.text] : [])).join(" ").trim();

    const check: LinkImportShape["check"] = Effect.gen(function* () {
      const refused = pluginRefusal(yield* pluginStatus);
      if (refused) return { found: false, problem: refused };
      const r = yield* plugins.callPlugin(LINK_PLUGIN_ID, "check", { searchPath: yield* searchPath }, { timeoutMs: 20000 });
      const out = (r.structured ?? {}) as { found?: unknown; path?: unknown; version?: unknown };
      if (r.isError) return { found: false, problem: textOf(r) || "Import from link couldn't look for yt-dlp." };
      if (out.found !== true) return { found: false };
      return { found: true, ...(typeof out.path === "string" ? { path: out.path } : {}), ...(typeof out.version === "string" ? { version: out.version.slice(0, 32) } : {}) };
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

    const run = (id: string, request: { readonly url: string; readonly kind: LinkRequest["kind"]; readonly quality: NonNullable<LinkRequest["quality"]>; readonly drop?: LinkRequest["drop"] }, target: { readonly openId: number; readonly dir: string }, signal: AbortSignal) =>
      Effect.gen(function* () {
        const failed = (message: string) => new LinkError({ reason: "failed", message });
        const folder = yield* linksFolder(target.dir);
        const stem = `link-${id.slice(0, 8)}`;
        // The plugin runs yt-dlp; progress comes as MCP progress (a step in words as its message).
        const result = yield* plugins.callPlugin(
          LINK_PLUGIN_ID,
          "download",
          { url: request.url, kind: request.kind, quality: request.quality, folder, stem, searchPath: yield* searchPath },
          {
            signal,
            timeoutMs: DOWNLOAD_TIMEOUT_MS,
            onProgress: (progress, total, message) => {
              const p = Math.max(0, Math.min(1, total ? progress / total : progress));
              update(id, message ? { progress: p, status: message } : { progress: p, status: `Downloading… ${Math.round(p * 100)}%` });
            },
          },
        );
        if (signal.aborted) {
          // The plugin removes the partial files once yt-dlp's process group is gone; these are what's already there.
          yield* removePartials(folder, stem);
          return yield* failed("Cancelled.");
        }
        if (result.isError) {
          yield* removePartials(folder, stem);
          // Turned off or removed while it ran: say so, not the plugin host's words.
          const refused = pluginRefusal(yield* pluginStatus);
          return yield* failed(refused ?? (textOf(result) || "yt-dlp stopped before it finished."));
        }
        const out = (result.structured ?? {}) as { file?: unknown; title?: unknown };
        const title = typeof out.title === "string" && out.title.trim() ? out.title.trim().slice(0, 500) : undefined;
        if (title) update(id, { title });
        // The finished file: the one the plugin names, only if it's ours (in the folder, our stem), else ours by name.
        const made = yield* Effect.promise(async () => {
          const ours = (p: string) => dirname(p) === folder && basename(p).startsWith(`${stem}.`) && !/\.(part|ytdl|temp)$/.test(p);
          if (typeof out.file === "string") {
            const real = await realpath(isAbsolute(out.file) ? out.file : join(folder, out.file)).catch(() => undefined);
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
        const refused = pluginRefusal(yield* pluginStatus);
        if (refused) return yield* new LinkError({ reason: "no-plugin", message: refused });
        const checked = checkLink(request.url);
        if ("problem" in checked) return yield* new LinkError({ reason: "bad-url", message: checked.problem });
        const tool = yield* check;
        if (!tool.found) return yield* new LinkError(tool.problem ? { reason: "failed", message: tool.problem } : { reason: "no-tool", message: "yt-dlp isn't installed. Install it with: brew install yt-dlp" });
        const id = randomUUID();
        const quality = request.quality ?? DEFAULT_LINK_QUALITY;
        const job: LinkJob = { id, projectDir: open.dir, url: checked.url, kind: request.kind, quality, phase: "running", status: "Starting yt-dlp…", startedAt: new Date().toISOString() };
        const live = (j: LinkJob) => j.phase === "running" || j.phase === "importing";
        yield* SubscriptionRef.update(jobsRef, (jobs) => [...jobs.filter(live), ...jobs.filter((j) => !live(j)).slice(-MAX_JOBS_KEPT), job]);
        const controller = new AbortController();
        controllers.set(id, controller);
        yield* Effect.forkIn(
          run(id, { url: checked.url, kind: request.kind, quality, ...(request.drop ? { drop: request.drop } : {}) }, { openId: open.openId, dir: open.dir }, controller.signal).pipe(
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
