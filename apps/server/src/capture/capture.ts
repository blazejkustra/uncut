// Capture sources (D98): what Uncut does with a recording a capture plugin declares, for the agent
// and for the Capture tab, and the Capture tab's Argent RPCs.
//
// A plugin returns data, never edits (D97). A capture plugin allowed to add media (media:write)
// writes its take into the project's media/captures folder (the context Uncut passed) and declares
// it in structuredContent.uncut: { media: {path, name?, source} } is imported (the agent's edit
// with its turn, or the user's from the Capture tab), { replace: {media, path, source?, overrun?} }
// is swapped in for an existing media (a re-shoot). Anything else, or a file outside that folder,
// is refused with a sentence.
import { readdir, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";

import { ANALYZERS, CaptureError, type Analyzer, type CaptureDevice, type CaptureOptions, type CaptureOrientation, type CaptureState, type MultiLayout, type MultiPart, type ProjectSnapshot, type TakeKind } from "@uncut/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";

import { Analysis, cachedFor, type AnalysisShape } from "../analysis/analysis.ts";
import { MediaLibrary, type AgentImport, type MediaLibraryShape, type ReplacedMedia } from "../media/media.ts";
import { CAPTURE_DIR, Plugins, type PluginCaller, type PluginResult } from "../plugins/plugins.ts";
import { Projects } from "../project/projects.ts";
import { ServerConfig } from "../app/config.ts";
import { which } from "../app/setup.ts";
import { withoutApiKey } from "../app/shellEnv.ts";
import { safeUploadName } from "../app/remote.ts";
import { convertTake, MULTI_FILE, MULTI_PART_NAME, stamp, TAKE_MODULE, uploadedTake } from "./takes.ts";

export const ARGENT_PLUGIN = "argent.capture";
export const ARGENT_INSTALL = "npm i -g @swmansion/argent@latest";

export type Applied =
  | { readonly kind: "imported"; readonly result: AgentImport }
  | { readonly kind: "replaced"; readonly result: ReplacedMedia; readonly analyses: ReadonlyArray<Analyzer> };

const isInside = (dir: string, file: string) => {
  const rel = relative(dir, file);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
};

const str = (x: unknown) => (typeof x === "string" && x.trim() ? x.trim() : undefined);

/** The declared file, if it's a file inside the project's capture folder; else a sentence. */
async function capturedFile(path: unknown, projectDir: string): Promise<{ file: string } | { problem: string }> {
  if (typeof path !== "string" || !isAbsolute(path)) return { problem: "it didn't give an absolute path" };
  try {
    const [file, folder] = await Promise.all([realpath(path), realpath(join(projectDir, CAPTURE_DIR))]);
    return isInside(folder, file) ? { file } : { problem: `its file isn't in the project's ${CAPTURE_DIR} folder` };
  } catch {
    return { problem: "its file doesn't exist" };
  }
}

/** The source Uncut stores: the plugin's own id (not whatever it claims), device and flow as strings. */
const sourceOf = (raw: unknown, plugin: PluginCaller) => {
  const s = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const device = str(s.device);
  const flow = str(s.flow);
  return { module: plugin.id, ...(device ? { device } : {}), ...(flow ? { flow } : {}) };
};

/**
 * Acts on a plugin's declaration (D98): imports its recording or swaps a re-shot one in. undefined
 * when there's nothing to do; `{ problem }` when it was refused or failed.
 */
export const applyDeclared = (input: {
  readonly declared: Record<string, unknown> | undefined;
  readonly plugin: PluginCaller;
  readonly openId: number;
  readonly dir: string;
  readonly turnId?: string | undefined;
  readonly media: MediaLibraryShape;
  readonly analysis: AnalysisShape;
}): Effect.Effect<Applied | { readonly problem: string } | undefined> =>
  Effect.gen(function* () {
    const { declared, plugin, openId, dir, turnId, media, analysis } = input;
    if (!declared) return undefined;
    if (!plugin.capabilities.includes("media:write")) return { problem: `${plugin.name} isn't allowed to add media, so what it recorded wasn't imported.` };
    if (declared.media && typeof declared.media === "object") {
      const m = declared.media as Record<string, unknown>;
      const found = yield* Effect.promise(() => capturedFile(m.path, dir));
      if ("problem" in found) return { problem: `${plugin.name}'s recording wasn't imported: ${found.problem}.` };
      return yield* media.importCapture({ openId, dir, path: found.file, name: str(m.name), source: sourceOf(m.source, plugin), turnId }).pipe(
        Effect.map((result): Applied | { problem: string } => (result.entries.length ? { kind: "imported", result } : { problem: `The recording wasn't imported: ${result.failed[0]?.message ?? result.skipped[0]?.reason ?? "nothing was added"}` })),
        Effect.catch((error) => Effect.succeed({ problem: `The recording wasn't imported: ${error.message}` })),
      );
    }
    if (declared.replace && typeof declared.replace === "object") {
      const r = declared.replace as Record<string, unknown>;
      const mediaId = str(r.media);
      if (!mediaId) return { problem: `${plugin.name} didn't say which media to swap the new take in for.` };
      const found = yield* Effect.promise(() => capturedFile(r.path, dir));
      if ("problem" in found) return { problem: `The new take wasn't swapped in: ${found.problem}.` };
      // What the old file had been analysed for is analysed again for the new one (the cache is
      // by content, so nothing stale is read; this has the results ready). The old file is
      // never overwritten, so its cache can still be looked up after the swap.
      return yield* media.replaceMedia({ openId, dir, mediaId, path: found.file, source: sourceOf(r.source, plugin), overrun: r.overrun === "hold" ? "hold" : "trim", turnId }).pipe(
        Effect.flatMap((result) =>
          Effect.gen(function* () {
            const oldPath = isAbsolute(result.previousPath) ? result.previousPath : resolve(dir, result.previousPath);
            const had: Array<Analyzer> = [];
            for (const analyzer of ANALYZERS) {
              const cached = yield* Effect.promise(() => cachedFor({ dir, mediaId, path: oldPath, kind: result.entry.kind }, analyzer).catch(() => undefined));
              if (cached) had.push(analyzer);
            }
            if (had.length) yield* analysis.start(mediaId, had).pipe(Effect.ignore);
            return { kind: "replaced", result, analyses: had } as Applied;
          }),
        ),
        Effect.catch((error) => Effect.succeed({ problem: `The new take wasn't swapped in: ${error.message}` })),
      );
    }
    return undefined;
  });

/** What the agent reads about an applied declaration, added to the plugin's own result. */
export const appliedNote = (applied: Applied, fps: number) => {
  if (applied.kind === "imported") {
    return {
      imported: applied.result.entries.map((e) => ({ id: e.id, name: e.name, path: e.path, ...(e.probe.frames ? { frames: e.probe.frames, seconds: Number((e.probe.frames / fps).toFixed(2)) } : {}), ...(e.probe.width ? { width: e.probe.width, height: e.probe.height } : {}), hasAudio: e.probe.hasAudio })),
      ...(applied.result.snapshot ? { revision: applied.result.snapshot.revision } : {}),
      note: "The recording is in the project as media (an edit of this turn: Undo turn removes it). Place it with timeline_edit; frames are project frames.",
    };
  }
  const { entry, warnings, snapshot } = applied.result;
  return {
    replaced: { id: entry.id, path: entry.path, ...(entry.probe.frames ? { frames: entry.probe.frames, seconds: Number((entry.probe.frames / fps).toFixed(2)) } : {}) },
    ...(snapshot ? { revision: snapshot.revision } : {}),
    ...(warnings.length ? { warnings } : {}),
    ...(applied.analyses.length ? { reanalysing: applied.analyses } : {}),
    note: "The new take is swapped in everywhere the media is used, as one edit of this turn.",
  };
};

// ---- the Capture tab (D98) ----

export interface FlowTake {
  readonly device: string;
  readonly flow: string;
  readonly showTouches?: boolean | undefined;
  readonly orientation?: CaptureOrientation | undefined;
  readonly bundleId?: string | undefined;
}

export interface CaptureShape {
  readonly state: Effect.Effect<CaptureState, CaptureError>;
  readonly start: (device: string, options?: CaptureOptions) => Effect.Effect<{ device: string; startedAt: string }, CaptureError>;
  /** D143: boots a shut-down simulator or an AVD (the user's click only); the id to record. */
  readonly boot: (device: string) => Effect.Effect<{ device: string; name: string }, CaptureError>;
  /** D143: a take replaying a saved flow, imported as one user edit when the flow ends. */
  readonly record: (input: FlowTake) => Effect.Effect<{ mediaId: string; name: string; seconds: number }, CaptureError>;
  readonly stop: (device: string) => Effect.Effect<{ mediaId: string; name: string; seconds: number }, CaptureError>;
  /** D114: a take recorded on this Mac (uploaded to media/uploads/) into the project, placed when `placeAt` is given. */
  readonly save: (input: SaveTakeInput) => Effect.Effect<SavedTake, CaptureError>;
  /** D211: a multi-source take's parts into media/captures/<take>/, one user edit, start-aligned and grouped with `placeAt`. */
  readonly saveMulti: (input: SaveMultiInput) => Effect.Effect<SavedMulti, CaptureError>;
  /** D144: the same for the agent's screen_record: an edit of its turn (Undo turn removes it). */
  readonly saveForTurn: (input: SaveTakeInput & { readonly turnId: string; readonly dir: string }) => Effect.Effect<SavedTake & { readonly snapshot?: ProjectSnapshot | undefined; readonly path: string }, CaptureError>;
}

export interface SaveTakeInput {
  readonly path: string;
  readonly kind: TakeKind;
  readonly name?: string | undefined;
  readonly device?: string | undefined;
  readonly placeAt?: number | undefined;
}

export interface SaveMultiInput {
  readonly parts: ReadonlyArray<MultiPart>;
  readonly name?: string | undefined;
  readonly placeAt?: number | undefined;
  readonly layout?: MultiLayout | undefined;
}

export interface SavedMulti {
  readonly name: string;
  readonly seconds: number;
  /** The take's folder, relative to the project (media/captures/Take 20261015-101500). */
  readonly folder: string;
  readonly media: ReadonlyArray<{ readonly mediaId: string; readonly kind: TakeKind; readonly name: string; readonly file: string }>;
  readonly items: ReadonlyArray<{ readonly itemId: string; readonly trackId: string; readonly kind: TakeKind; readonly start: number; readonly in: number; readonly duration: number }>;
  readonly group?: string;
}

export interface SavedTake {
  readonly mediaId: string;
  readonly name: string;
  readonly seconds: number;
  readonly itemId?: string;
  readonly trackId?: string;
}

export class Capture extends Context.Service<Capture, CaptureShape>()("uncut/Capture") {}

const textOf = (result: PluginResult) =>
  result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join(" ")
    .slice(0, 600);

export const layer = Layer.effect(
  Capture,
  Effect.gen(function* () {
    const plugins = yield* Plugins;
    const projects = yield* Projects;
    const media = yield* MediaLibrary;
    const analysis = yield* Analysis;
    const config = yield* ServerConfig;
    // Recordings started from the Capture tab: the device, when, and the opening of the project
    // the take goes into (a project closed meanwhile gets nothing; the file stays in its folder).
    const recording = new Map<string, { startedAt: string; openId: number; dir: string; flow?: string }>();
    // Boots running now (a second click on the same device waits for nothing: refused).
    const booting = new Set<string>();

    const failed = (message: string) => new CaptureError({ reason: "failed", message });

    const state = Effect.gen(function* () {
      const open = yield* projects.current;
      const result = yield* plugins.callPlugin(ARGENT_PLUGIN, "argent_list_devices", {}, { projectDir: open?.dir });
      const structured = (result.structured && typeof result.structured === "object" ? result.structured : {}) as { argent?: { installed?: unknown; version?: unknown; problem?: unknown }; devices?: unknown };
      if (!result.plugin) return yield* new CaptureError({ reason: "unavailable", message: textOf(result) });
      const argent = structured.argent;
      if (!argent) return yield* failed(textOf(result) || "Argent's plugin didn't answer.");
      const devices = (Array.isArray(structured.devices) ? structured.devices : []).flatMap((d): Array<CaptureDevice> => {
        const x = (d && typeof d === "object" ? d : {}) as Record<string, unknown>;
        const id = str(x.id);
        if (!id) return [];
        const reason = str(x.reason);
        return [{ id, platform: str(x.platform) ?? "unknown", name: str(x.name) ?? id, state: str(x.state) ?? "unknown", recordable: x.recordable === true, ...(reason ? { reason } : {}), ...(x.bootable === true ? { bootable: true } : {}) }];
      });
      const version = str(argent.version);
      const problem = str(argent.problem);
      const flows = open
        ? yield* Effect.promise(() =>
            readdir(join(open.dir, "flows"))
              .then((names) => names.filter((n) => /\.ya?ml$/i.test(n) && !n.startsWith(".")).map((n) => n.replace(/\.ya?ml$/i, "")).sort())
              .catch(() => [] as Array<string>),
          )
        : [];
      return {
        installed: argent.installed === true,
        ...(version ? { version } : {}),
        install: ARGENT_INSTALL,
        ...(problem ? { problem } : {}),
        devices,
        recording: [...recording].map(([device, r]) => ({ device, startedAt: r.startedAt, ...(r.flow ? { flow: r.flow } : {}) })),
        flows,
      } satisfies CaptureState;
    });

    const optionArgs = (o: CaptureOptions | undefined) => ({
      ...(o?.showTouches !== undefined ? { showTouches: o.showTouches } : {}),
      ...(o?.trimStatic !== undefined ? { trimStatic: o.trimStatic } : {}),
      ...(o?.maxSeconds !== undefined ? { maxSeconds: o.maxSeconds } : {}),
      ...(o?.orientation ? { orientation: o.orientation } : {}),
      ...(str(o?.bundleId) ? { bundleId: str(o?.bundleId) } : {}),
    });

    const start = (device: string, options?: CaptureOptions) =>
      Effect.gen(function* () {
        const open = yield* projects.current;
        if (!open) return yield* new CaptureError({ reason: "no-project", message: "Open a project first: recordings go into its media folder." });
        if (recording.has(device)) return yield* failed("That device is already being recorded.");
        const result = yield* plugins.callPlugin(ARGENT_PLUGIN, "argent_capture_start", { device, ...optionArgs(options) }, { projectDir: open.dir });
        if (result.isError) return yield* failed(textOf(result));
        const startedAt = new Date().toISOString();
        recording.set(device, { startedAt, openId: open.openId, dir: open.dir });
        return { device, startedAt };
      });

    const stop = (device: string) =>
      Effect.gen(function* () {
        const r = recording.get(device);
        if (!r) return yield* failed("That device isn't being recorded.");
        recording.delete(device);
        const result = yield* plugins.callPlugin(ARGENT_PLUGIN, "argent_capture_stop", { device }, { projectDir: r.dir });
        if (result.isError || !result.plugin) return yield* failed(textOf(result));
        // One user edit (not the agent's): one ⌘Z takes it out again.
        const applied = yield* applyDeclared({ declared: result.declared, plugin: result.plugin, openId: r.openId, dir: r.dir, media, analysis });
        if (!applied) return yield* failed("The recording stopped, but Argent's plugin didn't hand over a file.");
        if ("problem" in applied) return yield* failed(applied.problem);
        if (applied.kind !== "imported") return yield* failed("Unexpected answer from Argent's plugin.");
        const entry = applied.result.entries[0]!;
        const fps = (applied.result.snapshot?.project as { canvas?: { fps?: number } } | undefined)?.canvas?.fps ?? 30;
        return { mediaId: entry.id, name: entry.name, seconds: Number(((entry.probe.frames ?? 0) / fps).toFixed(2)) };
      });

    const boot = (device: string) =>
      Effect.gen(function* () {
        if (booting.has(device)) return yield* failed("That device is booting already.");
        booting.add(device);
        const open = yield* projects.current;
        const result = yield* plugins.callPlugin(ARGENT_PLUGIN, "argent_capture_boot", { device }, { projectDir: open?.dir }).pipe(Effect.ensuring(Effect.sync(() => booting.delete(device))));
        if (result.isError || !result.plugin) return yield* failed(textOf(result) || "Argent couldn't boot it.");
        const s = (result.structured && typeof result.structured === "object" ? result.structured : {}) as Record<string, unknown>;
        const id = str(s.device);
        if (!id) return yield* failed("Argent booted it but didn't say which device to record.");
        return { device: id, name: str(s.name) ?? id };
      });

    const record = (input: FlowTake) =>
      Effect.gen(function* () {
        const open = yield* projects.current;
        if (!open) return yield* new CaptureError({ reason: "no-project", message: "Open a project first: recordings go into its media folder." });
        if (recording.has(input.device)) return yield* failed("That device is already being recorded.");
        const flow = str(input.flow);
        if (!flow) return yield* failed("Pick a flow to replay.");
        recording.set(input.device, { startedAt: new Date().toISOString(), openId: open.openId, dir: open.dir, flow });
        const result = yield* plugins
          .callPlugin(ARGENT_PLUGIN, "argent_record", { device: input.device, flow, ...optionArgs(input) }, { projectDir: open.dir })
          .pipe(Effect.ensuring(Effect.sync(() => recording.delete(input.device))));
        if (result.isError || !result.plugin) return yield* failed(textOf(result));
        const applied = yield* applyDeclared({ declared: result.declared, plugin: result.plugin, openId: open.openId, dir: open.dir, media, analysis });
        if (!applied) return yield* failed("The flow ran, but Argent's plugin didn't hand over a file.");
        if ("problem" in applied) return yield* failed(applied.problem);
        if (applied.kind !== "imported") return yield* failed("Unexpected answer from Argent's plugin.");
        const entry = applied.result.entries[0]!;
        const fps = (applied.result.snapshot?.project as { canvas?: { fps?: number } } | undefined)?.canvas?.fps ?? 30;
        return { mediaId: entry.id, name: entry.name, seconds: Number(((entry.probe.frames ?? 0) / fps).toFixed(2)) };
      });

    // One take at a time is converted and imported (a second waits), so two saves never race for a name.
    const saving = yield* Semaphore.make(1);
    const importTake = (input: SaveTakeInput & { readonly turnId?: string; readonly dir?: string }) =>
      saving.withPermits(1)(
        Effect.gen(function* () {
          const open = yield* projects.current;
          if (!open) return yield* new CaptureError({ reason: "no-project", message: "Open a project first: takes go into its media folder." });
          if (input.dir !== undefined && input.dir !== open.dir) return yield* failed("The project changed while recording, so the take wasn't added.");
          const mediaPaths = ((open.project as { media?: ReadonlyArray<{ path?: unknown }> }).media ?? []).flatMap((m) => (typeof m.path === "string" ? [m.path] : []));
          const found = yield* Effect.promise(() => uploadedTake(input.path, open.dir, mediaPaths));
          if ("problem" in found) return yield* failed(found.problem);
          const ffmpeg = yield* Effect.promise(async () => {
            await config.shellReady;
            return which("ffmpeg", process.env.PATH ?? "");
          });
          if (!ffmpeg) return yield* failed("ffmpeg isn't installed, so the take can't be saved (brew install ffmpeg). The recording is in media/uploads.");
          const fps = (open.project as { canvas?: { fps?: number } }).canvas?.fps ?? 30;
          const converted = yield* Effect.promise(() =>
            convertTake({ ffmpeg, env: withoutApiKey(process.env), projectDir: open.dir, upload: found.file, kind: input.kind, name: input.name, fps }).catch((error: Error) => ({ problem: `The take couldn't be saved: ${error.message}` })),
          );
          if ("problem" in converted) return yield* failed(converted.problem);
          const device = str(input.device);
          const placeAt = typeof input.placeAt === "number" && Number.isFinite(input.placeAt) && input.placeAt >= 0 ? Math.floor(input.placeAt) : undefined;
          const result = yield* media
            .importCapture({
              openId: open.openId,
              dir: open.dir,
              path: converted.file,
              source: { module: TAKE_MODULE[input.kind], ...(device ? { device: device.slice(0, 200) } : {}) },
              ...(placeAt !== undefined ? { place: { frame: placeAt, placement: input.kind === "voiceover" || input.kind === "system" ? input.kind : ("video" as const) } } : {}),
              ...(input.turnId ? { turnId: input.turnId } : {}),
            })
            .pipe(Effect.mapError((error) => failed(`The take wasn't imported: ${error.message}`)));
          const entry = result.entries[0];
          if (!entry) return yield* failed(`The take wasn't imported: ${result.failed[0]?.message ?? result.skipped[0]?.reason ?? "nothing was added"}`);
          return {
            mediaId: entry.id,
            name: entry.name,
            seconds: Number(((entry.probe.frames ?? 0) / fps).toFixed(2)),
            ...(result.placed ? { itemId: result.placed.itemId, trackId: result.placed.trackId } : {}),
            snapshot: result.snapshot,
            path: entry.path,
          };
        }),
      );
    const save = (input: SaveTakeInput) => importTake(input).pipe(Effect.map(({ snapshot: _s, path: _p, ...saved }) => saved satisfies SavedTake));
    const saveForTurn = (input: SaveTakeInput & { readonly turnId: string; readonly dir: string }) => importTake(input);

    const saveMulti = (input: SaveMultiInput) =>
      saving.withPermits(1)(
        Effect.gen(function* () {
          const open = yield* projects.current;
          if (!open) return yield* new CaptureError({ reason: "no-project", message: "Open a project first: takes go into its media folder." });
          const parts = input.parts;
          if (!parts.length || parts.length > 4) return yield* failed("A take records one to four sources.");
          if (new Set(parts.map((p) => p.kind)).size !== parts.length) return yield* failed("Each source can be in a take once.");
          const mediaPaths = ((open.project as { media?: ReadonlyArray<{ path?: unknown }> }).media ?? []).flatMap((m) => (typeof m.path === "string" ? [m.path] : []));
          const uploads: Array<string> = [];
          for (const part of parts) {
            const found = yield* Effect.promise(() => uploadedTake(part.path, open.dir, mediaPaths));
            if ("problem" in found) return yield* failed(found.problem);
            uploads.push(found.file);
          }
          const ffmpeg = yield* Effect.promise(async () => {
            await config.shellReady;
            return which("ffmpeg", process.env.PATH ?? "");
          });
          if (!ffmpeg) return yield* failed("ffmpeg isn't installed, so the take can't be saved (brew install ffmpeg). The recordings are in media/uploads.");
          const fps = (open.project as { canvas?: { fps?: number } }).canvas?.fps ?? 30;
          // The take's own folder: "<name> 20261015-101500" (" 2" when that's taken).
          const base = `${str(input.name) ? safeUploadName(str(input.name)!).slice(0, 80).trim() : "Take"} ${stamp()}`;
          let folder = "";
          for (let n = 1; n < 100 && !folder; n++) {
            const candidate = n === 1 ? base : `${base} ${n}`;
            if (!(yield* Effect.promise(() => stat(join(open.dir, "media", "captures", candidate)).then(() => true, () => false)))) folder = candidate;
          }
          if (!folder) return yield* failed("Too many takes with that name in media/captures.");
          const files: Array<string> = [];
          for (const [i, part] of parts.entries()) {
            const converted = yield* Effect.promise(() =>
              convertTake({ ffmpeg, env: withoutApiKey(process.env), projectDir: open.dir, upload: uploads[i]!, kind: part.kind, fps, subfolder: folder, fileName: MULTI_FILE[part.kind] }).catch((error: Error) => ({ problem: `The take couldn't be saved: ${error.message}` })),
            );
            if ("problem" in converted) return yield* failed(converted.problem);
            files.push(converted.file);
          }
          const placeAt = typeof input.placeAt === "number" && Number.isFinite(input.placeAt) && input.placeAt >= 0 ? Math.floor(input.placeAt) : undefined;
          const result = yield* media
            .importMulti({
              openId: open.openId,
              dir: open.dir,
              parts: parts.map((part, i) => {
                const device = str(part.device);
                return { path: files[i]!, name: `${folder} ${MULTI_PART_NAME[part.kind]}`, kind: part.kind, offsetMs: Number.isFinite(part.offsetMs) ? Math.max(0, part.offsetMs) : 0, source: { module: TAKE_MODULE[part.kind], ...(device ? { device: device.slice(0, 200) } : {}), take: folder } };
              }),
              frame: placeAt,
              layout: input.layout,
              summary: `Record ${folder}`,
            })
            .pipe(Effect.mapError((error) => failed(`The take wasn't imported: ${error.message}`)));
          if (result.entries.length !== parts.length) return yield* failed(`The take wasn't imported: ${result.failed[0]?.message ?? result.skipped[0]?.reason ?? "a part is missing"}`);
          const byFile = new Map(parts.map((p) => [MULTI_FILE[p.kind], p.kind]));
          const kindOf = new Map(result.entries.map((e) => [e.id, byFile.get(basename(e.path))!]));
          const shortest = Math.min(...result.entries.map((e) => e.probe.frames ?? 0));
          const frames = result.multi?.items[0]?.duration ?? shortest;
          return {
            name: folder,
            seconds: Number((frames / fps).toFixed(2)),
            folder: `media/captures/${folder}`,
            media: result.entries.map((e) => ({ mediaId: e.id, kind: kindOf.get(e.id)!, name: e.name, file: e.path })),
            items: (result.multi?.items ?? []).map((it) => ({ itemId: it.itemId, trackId: it.trackId, kind: it.kind, start: it.start, in: it.in, duration: it.duration })),
            ...(result.multi?.group ? { group: result.multi.group } : {}),
          } satisfies SavedMulti;
        }),
      );

    return Capture.of({ state, start, stop, save, saveMulti, saveForTurn, boot, record });
  }),
);
