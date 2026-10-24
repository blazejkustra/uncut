// Generators (D4, D31, D99): one path from a request to media in the project, for the Generate tab
// and the agent's generate_media. A generator (providers.ts: GPT Image, Veo, Sound effects with the
// user's keys; svg.ts: the key-free SVG/HTML one) writes its file into the project's
// media/generated/ folder; Uncut imports it like a capture (D98: the import job, quiet, a relative
// path) with source {module, prompt, model, kind, size?, seconds?, options?}. A generator plugin's
// generators (#107, #108: pluginGenerators.ts) run the same way, the plugin making the request
// through Uncut with the key. From the Generate tab that's one
// user edit (one ⌘Z); from the agent it's an edit of its turn (Undo turn removes it). Undo leaves
// the file in media/generated, like captures and music copies.
import { mkdir, readdir, realpath, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { randomUUID } from "node:crypto";

import {
  GenerateError,
  type GenerateJob,
  type GenerateKind,
  type GenerateOptions,
  type GenerateRequest,
  type GeneratorChoice,
  type GeneratorInfo,
  type KeyProvider,
} from "@uncut/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { MediaLibrary, type AgentImport, type MediaEntry } from "../media/media.ts";
import { Plugins } from "../plugins/plugins.ts";
import { Projects } from "../project/projects.ts";
import { Keys, providerName } from "./keys.ts";
import { allowBaseOverrides, isTestRun, KEYED, type KeyedGenerator } from "./providers.ts";
import {
  checkOptions,
  checkSeconds,
  choicesOf,
  estimateOf,
  openGrant,
  pluginGeneratorsOf,
  servePluginRequest,
  type PluginGenerator,
} from "./pluginGenerators.ts";
import { ServerConfig } from "../app/config.ts";
import { askClaude, renderMarkup, SVG_GENERATOR, SVG_MAX_SECONDS, SVG_SECONDS, SVG_SIZES, svgPixels } from "./svg.ts";

export const GENERATED_DIR = "media/generated";
/** A generation estimated above this (US dollars) waits for the user's Allow on a card in the Agent tab when the agent asks for it (D99). */
export const CONFIRM_OVER = 1;
/** The most one agent turn may spend on keys (estimates, US dollars). */
export const TURN_CAP = 10;
const MAX_PROMPT = 4000;
const MAX_JOBS_KEPT = 10;
/** A plugin's generation may take this long (music: a few minutes of audio). */
const PLUGIN_TIMEOUT_MS = 15 * 60 * 1000;
/** A plugin's choices (the voices) come back within this. */
const CHOICES_TIMEOUT_MS = 20_000;

export interface GenerateSpec {
  readonly generator: string;
  readonly prompt: string;
  readonly kind: GenerateKind;
  readonly size?: string | undefined;
  readonly seconds?: number | undefined;
  readonly name?: string | undefined;
  /** A plugin's generator: its option values, checked and with their defaults. */
  readonly options?: GenerateOptions | undefined;
  /** generate.svg: the markup the agent wrote (else Claude is asked for it). */
  readonly content?: string | undefined;
}

export interface Produced {
  readonly result: AgentImport;
  readonly entry: MediaEntry;
  readonly cost: number;
  readonly model: string;
}

export interface GeneratorShape {
  readonly list: Effect.Effect<ReadonlyArray<GeneratorInfo>>;
  readonly start: (request: GenerateRequest) => Effect.Effect<{ jobId: string }, GenerateError>;
  readonly jobs: Stream.Stream<ReadonlyArray<GenerateJob>>;
  readonly cancel: (jobId: string) => Effect.Effect<void>;
  /** A plugin generator's choices for one of its options (#108: the voices of the user's account). */
  readonly choices: (generator: string, option: string) => Effect.Effect<ReadonlyArray<GeneratorChoice>, GenerateError>;
  /** A request checked and completed (kind defaulted), or why not; `estimate` in US dollars. */
  readonly plan: (
    raw: Record<string, unknown>,
  ) => Effect.Effect<{ readonly spec: GenerateSpec; readonly estimate: number; readonly provider?: KeyProvider | undefined } | GenerateError>;
  /** Makes it and imports it into the opening `openId` (the agent's edit with `turnId`). */
  readonly produce: (
    spec: GenerateSpec,
    target: {
      readonly openId: number;
      readonly dir: string;
      readonly turnId?: string | undefined;
      readonly signal: AbortSignal;
      readonly status?: (text: string) => void;
      /** Called right before a keyed provider's first request (from then on it may bill). */
      readonly sent?: () => void;
    },
  ) => Effect.Effect<Produced, GenerateError>;
}

export class Generator extends Context.Service<Generator, GeneratorShape>()("uncut/Generator") {}

const keyedOf = (id: string) => KEYED.find((g) => g.id === id);
export const GENERATOR_IDS = [...KEYED.map((g) => g.id), SVG_GENERATOR];
export const needsKeyLine = (provider: KeyProvider) => `Needs your ${providerName(provider)} key`;

/** A file name from the user's name or the prompt's first words, plus the time: "neon-city-skyline 20261013-101500". */
export function fileBase(spec: Pick<GenerateSpec, "name" | "prompt">, now = new Date()) {
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}-${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}${String(now.getSeconds()).padStart(2, "0")}`;
  // A name is letters, digits, spaces, dots, dashes and underscores, never starting with a dot
  // (so never "." or ".."); one that's left empty falls back to the prompt.
  const fromName = spec.name
    ?.replace(/\.[A-Za-z0-9]{2,4}$/, "")
    .replace(/[^A-Za-z0-9 ._-]+/g, "")
    .replace(/^[\s.]+/, "")
    .trim()
    .slice(0, 60);
  if (fromName && /[A-Za-z0-9]/.test(fromName)) return fromName;
  const words = spec.prompt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean)
    .slice(0, 5)
    .join("-")
    .slice(0, 40);
  return `${words || "generated"} ${stamp}`;
}

/**
 * The media's display name (D145, like G4's renames): the given name, else the prompt as a short
 * phrase in sentence case without a leading article ("A yellow sun over a navy sea." → "Yellow
 * sun over a navy sea"), cut at a word near 48 characters; " 2", " 3" when the project has it.
 * The file keeps its own unique name (fileBase).
 */
export function displayNameOf(spec: Pick<GenerateSpec, "name" | "prompt">, taken: ReadonlySet<string> = new Set()) {
  const given = spec.name
    ?.replace(/\.[A-Za-z0-9]{2,4}$/, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
  let base = given && /[\p{L}\p{N}]/u.test(given) ? given : "";
  if (!base) {
    let p = spec.prompt
      .replace(/\s+/g, " ")
      .trim()
      .replace(/^(a|an|the)\s+/i, "");
    if (p.length > 48) {
      const cut = p.slice(0, 48);
      p = cut.includes(" ", 20) ? cut.slice(0, cut.lastIndexOf(" ")) : cut;
    }
    p = p.replace(/[\s.,;:!?-]+$/, "");
    base = p ? p[0]!.toUpperCase() + p.slice(1) : "Generated";
  }
  let name = base;
  for (let n = 2; taken.has(name); n++) name = `${base} ${n}`;
  return name;
}

const cancelled = (signal: AbortSignal) => signal.aborted;

export const layer = Layer.effect(
  Generator,
  Effect.gen(function* () {
    const keys = yield* Keys;
    const config = yield* ServerConfig;
    // UNCUT_*_BASE only in test runs: the packaged app under the test harness, or the server alone.
    allowBaseOverrides(isTestRun(process.env, config.keysFd));
    // Output names taken by jobs still running (a file appears only at the end of a generation).
    const reserved = new Set<string>();
    const projects = yield* Projects;
    const media = yield* MediaLibrary;
    const plugins = yield* Plugins;
    // A generator plugin's requests (uncut/fetch) are answered here, with the key its call was granted.
    plugins.host.serveRequests(servePluginRequest);
    const reportedSkips = new Set<string>();
    /** The allowed generator plugins' generators, now. */
    const pluginGens = Effect.map(plugins.generatorPlugins, (found) => {
      const { generators, skipped } = pluginGeneratorsOf(found, new Set(GENERATOR_IDS));
      for (const line of skipped) if (!reportedSkips.has(line)) (reportedSkips.add(line), console.error(`[uncut] ${line}`));
      return generators;
    });
    const scope = yield* Effect.scope;
    const jobsRef = yield* SubscriptionRef.make<ReadonlyArray<GenerateJob>>([]);
    const controllers = new Map<string, AbortController>();
    yield* Effect.addFinalizer(() => Effect.sync(() => controllers.forEach((c) => c.abort())));

    const update = (id: string, patch: Partial<GenerateJob>) =>
      Effect.runSync(SubscriptionRef.update(jobsRef, (jobs) => jobs.map((j) => (j.id === id ? { ...j, ...patch } : j))));

    const info = (g: KeyedGenerator, has: boolean): GeneratorInfo => ({
      id: g.id,
      name: g.name,
      kinds: [...g.kinds],
      provider: g.provider,
      model: g.model,
      ready: has,
      ...(has ? {} : { needs: needsKeyLine(g.provider) }),
      sizes: [...g.sizes],
      ...(g.seconds ? { seconds: [...g.seconds] } : {}),
      billing: g.billing,
    });
    const pluginInfo = (g: PluginGenerator, has: boolean): GeneratorInfo => ({
      id: g.id,
      name: g.name,
      kinds: [g.media],
      provider: g.provider,
      ...(g.model ? { model: g.model } : {}),
      ready: has,
      ...(has ? {} : { needs: needsKeyLine(g.provider) }),
      sizes: [],
      ...(g.seconds ? { seconds: [...g.seconds] } : {}),
      billing: g.billing,
      plugin: g.plugin,
      options: [...g.options],
      price: g.price,
      ...(g.promptLabel ? { promptLabel: g.promptLabel } : {}),
      ...(g.placeholder ? { placeholder: g.placeholder } : {}),
      maxPrompt: g.maxPrompt,
    });
    const list = Effect.gen(function* () {
      const out: Array<GeneratorInfo> = [
        {
          id: SVG_GENERATOR,
          name: "SVG and HTML",
          kinds: ["image", "video"],
          ready: true,
          sizes: [...SVG_SIZES],
          seconds: [...SVG_SECONDS],
          billing: "Uses your Claude Code, no key needed",
        },
      ];
      for (const g of KEYED) out.push(info(g, yield* keys.has(g.provider)));
      for (const g of yield* pluginGens) out.push(pluginInfo(g, yield* keys.has(g.provider)));
      return out;
    });

    const plan: GeneratorShape["plan"] = (raw) =>
      Effect.gen(function* () {
        const bad = (message: string) => new GenerateError({ reason: "bad-request", message });
        const id = raw.generator;
        const fromPlugins = yield* pluginGens;
        const plugged = typeof id === "string" ? fromPlugins.find((g) => g.id === id) : undefined;
        const ids = [...GENERATOR_IDS, ...fromPlugins.map((g) => g.id)];
        if (typeof id !== "string" || !ids.includes(id))
          return new GenerateError({ reason: "unknown-generator", message: `generator must be one of ${ids.join(", ")}.` });
        const prompt = typeof raw.prompt === "string" ? raw.prompt.trim() : "";
        if (!prompt) return bad("Write a prompt first: what should it make?");
        const maxPrompt = plugged?.maxPrompt ?? MAX_PROMPT;
        if (prompt.length > maxPrompt) return bad(`The ${plugged?.promptLabel?.toLowerCase() ?? "prompt"} is over ${maxPrompt} characters.`);
        if (raw.size !== undefined && typeof raw.size !== "string") return bad("size must be a string, e.g. 1536x1024 or 16:9.");
        if (raw.seconds !== undefined && (typeof raw.seconds !== "number" || !Number.isFinite(raw.seconds) || raw.seconds <= 0))
          return bad("seconds must be a positive number.");
        if (raw.name !== undefined && typeof raw.name !== "string") return bad("name must be a string.");
        if (raw.content !== undefined && typeof raw.content !== "string") return bad("content must be the SVG or HTML as a string.");
        if (raw.options !== undefined && !plugged) return bad(`options are only for a plugin's generators; ${id} takes size and seconds.`);
        const keyed = keyedOf(id);
        const kinds: ReadonlyArray<GenerateKind> = plugged ? [plugged.media] : keyed ? keyed.kinds : ["image", "video"];
        const words: Record<string, string> = { image: "pictures", video: "video", audio: "sound" };
        if (raw.kind !== undefined && !kinds.includes(raw.kind as GenerateKind))
          return bad(
            `${plugged?.name ?? keyed?.name ?? "The SVG generator"} makes ${kinds.map((k) => words[k]).join(" or ")}, not ${words[String(raw.kind)] ?? String(raw.kind)} (kind ${kinds.join(" or ")}).`,
          );
        const kind = (raw.kind as GenerateKind | undefined) ?? kinds[0]!;
        const spec: GenerateSpec = {
          generator: id,
          prompt,
          kind,
          ...(raw.size !== undefined ? { size: raw.size as string } : {}),
          ...(raw.seconds !== undefined ? { seconds: raw.seconds as number } : {}),
          ...(typeof raw.name === "string" && raw.name.trim() ? { name: raw.name.trim() } : {}),
          ...(typeof raw.content === "string" && raw.content.trim() ? { content: raw.content } : {}),
        };
        if (plugged) {
          if (spec.content) return bad(`content is only for ${SVG_GENERATOR}.`);
          if (spec.size !== undefined) return bad(`${plugged.name} takes no size.`);
          const problem = checkSeconds(plugged, spec.seconds);
          if (problem) return bad(problem);
          const options = checkOptions(plugged, raw.options);
          if (typeof options === "string") return bad(options);
          const full = { ...spec, ...(spec.seconds === undefined && plugged.seconds ? { seconds: plugged.seconds[0]! } : {}), options };
          return { spec: full, estimate: estimateOf(plugged, full), provider: plugged.provider };
        }
        if (keyed) {
          if (spec.content) return bad(`content is only for ${SVG_GENERATOR}.`);
          const problem = keyed.check(spec);
          if (problem) return bad(problem);
          return { spec, estimate: keyed.estimate(spec), provider: keyed.provider };
        }
        if (spec.size !== undefined && !svgPixels(spec.size, { width: 1, height: 1 }))
          return bad("size must be canvas or WIDTHxHEIGHT, e.g. 1920x1080 (16 to 4096 a side).");
        if (spec.kind === "video" && spec.seconds !== undefined && spec.seconds > SVG_MAX_SECONDS)
          return bad(`An animation is at most ${SVG_MAX_SECONDS} seconds.`);
        return { spec, estimate: 0 };
      });

    const produce: GeneratorShape["produce"] = (spec, target) =>
      Effect.gen(function* () {
        const failed = (message: string) => new GenerateError({ reason: "failed", message });
        const keyed = keyedOf(spec.generator);
        const plugged = keyed || spec.generator === SVG_GENERATOR ? undefined : (yield* pluginGens).find((g) => g.id === spec.generator);
        if (!keyed && !plugged && spec.generator !== SVG_GENERATOR)
          return yield* new GenerateError({
            reason: "unknown-generator",
            message: `${spec.generator} isn't available any more (its plugin was turned off or removed).`,
          });
        const provider = keyed?.provider ?? plugged?.provider;
        let key: string | undefined;
        if (provider) {
          key = yield* keys.get(provider);
          if (!key) return yield* new GenerateError({ reason: "needs-key", message: `${needsKeyLine(provider)}. Add it in Settings › Keys.` });
        }
        // The folder, inside the project by realpath (a symlinked media/ pointing out is refused).
        const folder = yield* Effect.tryPromise({
          try: async () => {
            const dir = join(target.dir, GENERATED_DIR);
            await mkdir(dir, { recursive: true });
            const [real, project] = await Promise.all([realpath(dir), realpath(target.dir)]);
            const rel = relative(project, real);
            if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error(`The project's ${GENERATED_DIR} folder points outside the project.`);
            return real;
          },
          catch: (e) => failed((e as Error).message),
        });
        const stem = fileBase(spec);
        const taken = new Set((yield* Effect.promise(() => readdir(folder).catch(() => [] as Array<string>))).map((f) => f.replace(/\.[^.]+$/, "")));
        // Reserved for the whole job, checked and taken with no await in between: two jobs with
        // the same name in the same second can't write over each other's (paid) result.
        let outBase = join(folder, stem);
        for (let n = 2; taken.has(basename(outBase)) || reserved.has(outBase); n++) outBase = join(folder, `${stem} ${n}`);
        if (dirname(outBase) !== folder) return yield* failed("That name can't be used for a file.");
        reserved.add(outBase);
        return yield* produceInto(spec, target, key, keyed, plugged, outBase).pipe(Effect.ensuring(Effect.sync(() => reserved.delete(outBase))));
      });

    /**
     * A plugin's generation: its tool called with a grant for this generation's key and file
     * (pluginGenerators.ts); the result is the file Uncut saved for it, nothing else. A failure or
     * a cancel removes that file.
     */
    const runPlugin = async (
      g: PluginGenerator,
      spec: GenerateSpec,
      key: string,
      outBase: string,
      target: Parameters<GeneratorShape["produce"]>[1],
      status: (text: string) => void,
    ) => {
      const grant = openGrant({ pluginId: g.plugin.id, provider: g.provider, key, signal: target.signal, outBase, sent: target.sent });
      try {
        status(`Asking ${g.plugin.name}…`);
        const args = { generator: g.local, prompt: spec.prompt, ...(spec.seconds !== undefined ? { seconds: spec.seconds } : {}), options: spec.options ?? {} };
        const r = await Effect.runPromise(
          plugins.callPlugin(g.plugin.id, g.tool, args, {
            signal: target.signal,
            timeoutMs: PLUGIN_TIMEOUT_MS,
            meta: { "uncut/grant": grant.token },
            onProgress: (_p, _t, message) => message && status(message),
          }),
        );
        const saved = grant.saved();
        if (r.isError || !saved) {
          if (saved) await rm(saved, { force: true });
          const said = r.content
            .flatMap((c) => (c.type === "text" && "text" in c && typeof c.text === "string" ? [c.text] : []))
            .join(" ")
            .trim();
          throw new Error(r.isError ? said || `${g.plugin.name} stopped before it finished.` : `${g.plugin.name} finished without making a file.`);
        }
        const out = (r.structured ?? {}) as { model?: unknown };
        const model = typeof out.model === "string" && /^[\w.:-]{1,80}$/.test(out.model) ? out.model : (g.model ?? g.local);
        return { path: saved, model, cost: estimateOf(g, spec) };
      } finally {
        grant.end();
      }
    };

    const produceInto = (
      spec: GenerateSpec,
      target: Parameters<GeneratorShape["produce"]>[1],
      key: string | undefined,
      keyed: KeyedGenerator | undefined,
      plugged: PluginGenerator | undefined,
      outBase: string,
    ) =>
      Effect.gen(function* () {
        const status = target.status ?? (() => {});
        const failed = (message: string) => new GenerateError({ reason: "failed", message });

        const made = yield* Effect.tryPromise({
          try: async () => {
            if (keyed) return keyed.generate(spec, { key: key!, outBase, signal: target.signal, status, sent: target.sent });
            if (plugged) return runPlugin(plugged, spec, key!, outBase, target, status);
            const open = Effect.runSync(projects.view);
            const canvas = open && open.openId === target.openId ? open.session.project.canvas : { width: 1920, height: 1080 };
            const size = svgPixels(spec.size, canvas)!;
            const seconds = Math.min(SVG_MAX_SECONDS, spec.seconds ?? 5);
            let markup = spec.content;
            if (!markup) {
              status("Drawing it…");
              markup = await askClaude({ prompt: spec.prompt, kind: spec.kind === "video" ? "video" : "image", ...size, seconds }, target.signal);
            }
            const out = await renderMarkup(markup, {
              kind: spec.kind === "video" ? "video" : "image",
              ...size,
              seconds,
              outBase,
              signal: target.signal,
              status,
            });
            return { path: out.path, model: spec.content ? "written by the agent" : "claude", cost: 0 };
          },
          catch: (e) => (cancelled(target.signal) ? failed("Cancelled.") : failed((e as Error).message ?? String(e))),
        });
        if (cancelled(target.signal)) {
          yield* Effect.promise(() => rm(made.path, { force: true }));
          return yield* failed("Cancelled.");
        }
        status("Adding it to Media…");
        const source = {
          module: spec.generator,
          prompt: spec.prompt,
          model: made.model,
          kind: spec.kind,
          ...(spec.size ? { size: spec.size } : {}),
          ...(spec.seconds !== undefined ? { seconds: spec.seconds } : {}),
          ...(spec.options && Object.keys(spec.options).length ? { options: spec.options } : {}),
        };
        const open = Effect.runSync(projects.view);
        const names = new Set(open && open.openId === target.openId ? open.session.project.media.map((m) => m.name) : []);
        const result = yield* media
          .importCapture({ openId: target.openId, dir: target.dir, path: made.path, name: displayNameOf(spec, names), source, turnId: target.turnId })
          .pipe(Effect.mapError((e) => failed(`It was made but couldn't be added: ${e.message}`)));
        const entry = result.entries[0];
        if (!entry) {
          yield* Effect.promise(() => rm(made.path, { force: true }));
          return yield* failed(`It was made but couldn't be added: ${result.failed[0]?.message ?? result.skipped[0]?.reason ?? "nothing was added"}`);
        }
        return { result, entry, cost: made.cost, model: made.model };
      });

    const start: GeneratorShape["start"] = (request) =>
      Effect.gen(function* () {
        const open = yield* projects.current;
        if (!open) return yield* new GenerateError({ reason: "no-project", message: "Open a project first: what's generated goes into its Media." });
        const planned = yield* plan(request as unknown as Record<string, unknown>);
        if (planned instanceof GenerateError) return yield* planned;
        if (planned.provider && !(yield* keys.has(planned.provider)))
          return yield* new GenerateError({ reason: "needs-key", message: `${needsKeyLine(planned.provider)}. Add it in Settings › Keys.` });
        const id = randomUUID();
        const { spec } = planned;
        const job: GenerateJob = {
          id,
          projectDir: open.dir,
          generator: spec.generator,
          kind: spec.kind,
          prompt: spec.prompt,
          ...(spec.size ? { size: spec.size } : {}),
          ...(spec.seconds !== undefined ? { seconds: spec.seconds } : {}),
          ...(spec.options && Object.keys(spec.options).length ? { options: spec.options } : {}),
          phase: "running",
          status: "Starting…",
          startedAt: new Date().toISOString(),
          estimate: planned.estimate,
        };
        yield* SubscriptionRef.update(jobsRef, (jobs) => [
          ...jobs.filter((j) => j.phase === "running" || j.phase === "importing"),
          ...jobs.filter((j) => j.phase !== "running" && j.phase !== "importing").slice(-MAX_JOBS_KEPT),
          job,
        ]);
        const controller = new AbortController();
        controllers.set(id, controller);
        yield* Effect.forkIn(
          produce(spec, { openId: open.openId, dir: open.dir, signal: controller.signal, status: (text) => update(id, { status: text }) }).pipe(
            Effect.match({
              onSuccess: (p) => update(id, { phase: "done", status: undefined, mediaId: p.entry.id, name: p.entry.name, estimate: p.cost }),
              onFailure: (e) =>
                update(id, controller.signal.aborted ? { phase: "cancelled", status: undefined } : { phase: "failed", status: undefined, error: e.message }),
            }),
            Effect.ensuring(Effect.sync(() => controllers.delete(id))),
          ),
          scope,
        );
        return { jobId: id };
      });

    const choices: GeneratorShape["choices"] = (id, option) =>
      Effect.gen(function* () {
        const g = (yield* pluginGens).find((x) => x.id === id);
        if (!g) return yield* new GenerateError({ reason: "unknown-generator", message: `There's no plugin generator ${id}.` });
        const o = g.options.find((x) => x.id === option);
        if (!o || o.type !== "choice") return yield* new GenerateError({ reason: "bad-request", message: `${g.name} has no choice ${option}.` });
        if (!o.dynamic) return o.choices ?? [];
        const key = yield* keys.get(g.provider);
        if (!key) return yield* new GenerateError({ reason: "needs-key", message: `${needsKeyLine(g.provider)}. Add it in Settings › Keys.` });
        // A read-only grant: GET requests only, nothing saved, nothing billed.
        const signal = AbortSignal.timeout(CHOICES_TIMEOUT_MS);
        const grant = openGrant({ pluginId: g.plugin.id, provider: g.provider, key, signal });
        const r = yield* plugins
          .callPlugin(g.plugin.id, "choices", { generator: g.local, option }, { signal, timeoutMs: CHOICES_TIMEOUT_MS, meta: { "uncut/grant": grant.token } })
          .pipe(Effect.ensuring(Effect.sync(grant.end)));
        const said = r.content
          .flatMap((c) => (c.type === "text" && "text" in c && typeof c.text === "string" ? [c.text] : []))
          .join(" ")
          .trim();
        if (r.isError)
          return yield* new GenerateError({ reason: "failed", message: said || `${g.plugin.name} couldn't list the ${o.label.toLowerCase()} choices.` });
        const list = choicesOf(r.structured);
        if (!list) return yield* new GenerateError({ reason: "failed", message: `${g.plugin.name} answered without a list of choices.` });
        return list;
      });

    return Generator.of({
      list,
      start,
      choices,
      jobs: SubscriptionRef.changes(jobsRef),
      cancel: (jobId) => Effect.sync(() => controllers.get(jobId)?.abort()),
      plan,
      produce,
    });
  }),
);
