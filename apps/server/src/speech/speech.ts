// The offline voice (plugins/reverb-tts): the voices (Reverb's presets and the user's cloned ones,
// voices.ts), cloning one from a clip, and what the Reverb plugin's generator needs for a call
// (generate.ts: the voice file, the language, the model files and how to start the runner). The
// model's files are downloaded on first use (reverbFiles.ts), with their progress in the status.
//
// A clone: the clip (a project media's or a file's, from start for seconds) cut by ffmpeg into
// 24 kHz float samples and a 16 kHz WAV, what it says written by Whisper (unless given), then the
// Reverb plugin's clone call turns it into a voice, saved with the user's consent.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import { VoiceError, type GenerateOptions, type GeneratorChoice, type VoiceCloneRequest, type VoiceInfo, type VoicesState } from "@uncut/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { CLONE_MAX_SECONDS, CLONE_MIN_SECONDS, DEFAULT_VOICE, isLanguage, LANGUAGES, SAMPLE_RATE } from "../../../../plugins/reverb-tts/reverb.ts";
import { ServerConfig } from "../app/config.ts";
import { which } from "../app/setup.ts";
import { pluginTranscribe, WHISPER_PLUGIN, WHISPER_TOOL } from "../analysis/transcription.ts";
import { Whisper } from "../analysis/whisper.ts";
import { speechRunnerCommand } from "../export/rasterizer.ts";
import { Plugins } from "../plugins/plugins.ts";
import { Projects } from "../project/projects.ts";
import { ReverbFiles, reverbDir, TOTAL_BYTES } from "./reverbFiles.ts";
import { CONSENT_LINE, savedInfo, VoiceStore, voicesDir, type SavedVoice } from "./voices.ts";

export const REVERB_PLUGIN = "reverb.tts";
export { CONSENT_LINE };

const DEFAULT_CLONE_SECONDS = 10;
const CLONE_TIMEOUT_MS = 5 * 60 * 1000;
const TRANSCRIBE_TIMEOUT_MS = 2 * 60 * 1000;
const MAX_TRANSCRIPT = 1000;

type Status = (text: string) => void;

export interface SpeechShape {
  readonly state: Stream.Stream<VoicesState>;
  readonly voices: Effect.Effect<ReadonlyArray<VoiceInfo>>;
  /** A clone from the Generate tab: returns at once, its progress on state. One at a time. */
  readonly clone: (request: VoiceCloneRequest) => Effect.Effect<{ readonly jobId: string }, VoiceError>;
  /** A clone the caller waits for (the agent's voice_clone). */
  readonly cloneNow: (request: VoiceCloneRequest, options: { readonly signal: AbortSignal; readonly status?: Status }) => Effect.Effect<VoiceInfo, VoiceError>;
  readonly cancel: Effect.Effect<void>;
  readonly remove: (id: string) => Effect.Effect<void, VoiceError>;
  /** The Reverb plugin's generator call's arguments past the prompt: the voice file, the language, the files, the runner. */
  readonly generateArgs: (options: GenerateOptions | undefined, signal: AbortSignal, status: Status) => Promise<Record<string, unknown>>;
  /** The voice option's choices: the presets and the user's voices. */
  readonly choices: Effect.Effect<ReadonlyArray<GeneratorChoice>>;
}

export class Speech extends Context.Service<Speech, SpeechShape>()("uncut/Speech") {}

const bad = (message: string) => new VoiceError({ reason: "bad-request", message });
const failed = (message: string) => new VoiceError({ reason: "failed", message });
const mb = (bytes: number) => Math.round(bytes / 1e6);

/** "Downloading the voice model, 40% of 384 MB" while the files come down. */
const downloadStatus = (status: Status) => (received: number, total: number) =>
  status(`Downloading the voice model, ${Math.floor((received / Math.max(1, total)) * 100)}% of ${mb(TOTAL_BYTES)} MB`);

const runFfmpeg = (bin: string, args: ReadonlyArray<string>, signal: AbortSignal) =>
  new Promise<void>((done, fail) =>
    execFile(bin, [...args], { signal, maxBuffer: 4 * 1024 * 1024 }, (error, _out, stderr) => {
      if (!error) return done();
      const why = String(stderr).trim().split("\n").filter(Boolean).at(-1);
      fail(new Error(signal.aborted ? "Cancelled." : `ffmpeg couldn't cut the clip${why ? `: ${why}` : "."}`));
    }),
  );

/** The clip as the codec's float samples and as whisper's WAV, both mono, in one ffmpeg run. */
const clipArgs = (path: string, start: number, seconds: number, f32: string, wav: string) => [
  "-hide_banner",
  "-nostdin",
  "-loglevel",
  "error",
  "-ss",
  String(start),
  "-t",
  String(seconds),
  "-i",
  path,
  "-map",
  "0:a:0",
  "-vn",
  "-ac",
  "1",
  "-ar",
  String(SAMPLE_RATE),
  "-f",
  "f32le",
  "-y",
  f32,
  "-map",
  "0:a:0",
  "-vn",
  "-ac",
  "1",
  "-ar",
  "16000",
  "-c:a",
  "pcm_s16le",
  "-y",
  wav,
];

/** The request checked: its clip's range and name, or why not. */
function checkClone(r: VoiceCloneRequest) {
  if (r.consent !== true) return bad(`Cloning a voice needs the user's confirmation: "${CONSENT_LINE}".`);
  const name = r.name.replace(/\s+/g, " ").trim();
  if (!name || name.length > 60) return bad("Give the voice a name (up to 60 characters).");
  if (!r.media === !r.path) return bad("Pick one clip: a media id or a file's path.");
  const start = r.start ?? 0;
  const seconds = r.seconds ?? DEFAULT_CLONE_SECONDS;
  if (!Number.isFinite(start) || start < 0) return bad("start is the clip's start in seconds, 0 or more.");
  if (!Number.isFinite(seconds) || seconds < CLONE_MIN_SECONDS || seconds > CLONE_MAX_SECONDS)
    return bad(`A voice needs ${CLONE_MIN_SECONDS} to ${CLONE_MAX_SECONDS} seconds of clean speech (seconds).`);
  if (r.language !== undefined && !isLanguage(r.language)) return bad(`language is one of ${Object.keys(LANGUAGES).join(", ")}.`);
  if (r.transcript !== undefined && r.transcript.length > MAX_TRANSCRIPT) return bad(`The transcript is over ${MAX_TRANSCRIPT} characters.`);
  return { name, start, seconds };
}

export const layer = Layer.effect(
  Speech,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const plugins = yield* Plugins;
    const projects = yield* Projects;
    const whisper = yield* Whisper;
    const files = new ReverbFiles(reverbDir(config.dataDir), config.reverbModelUrl);
    const store = new VoiceStore(voicesDir(config.dataDir));
    yield* Effect.addFinalizer(() => Effect.sync(() => files.shutdown()));
    const stateRef = yield* SubscriptionRef.make<VoicesState>({ voices: yield* Effect.promise(() => store.list()) });
    let cloning: AbortController | undefined;

    const setState = (patch: Partial<VoicesState>) => Effect.runSync(SubscriptionRef.update(stateRef, (s) => ({ ...s, ...patch })));
    const refreshVoices = async () => setState({ voices: await store.list() });

    const call = (tool: string, args: Record<string, unknown>, signal: AbortSignal, status: Status, timeoutMs: number) =>
      Effect.runPromise(plugins.callPlugin(REVERB_PLUGIN, tool, args, { signal, timeoutMs, onProgress: (_p, _t, message) => message && status(message) }));

    const runner = () => {
      const command = speechRunnerCommand();
      if ("problem" in command) throw new Error(command.problem);
      return command;
    };

    /** The clip's file: a media of the open project (audio or video) or a file on this Mac. */
    const sourceOf = async (r: VoiceCloneRequest) => {
      if (r.path) {
        if (!isAbsolute(r.path)) throw bad("path must be an absolute path to an audio or video file.");
        if (!(await stat(r.path).catch(() => undefined))?.isFile()) throw bad(`There's no file at ${r.path}.`);
        return { path: r.path, label: r.path.split("/").pop()! };
      }
      const open = Effect.runSync(projects.current);
      if (!open) throw new VoiceError({ reason: "no-project", message: "Open a project first, or pick a file." });
      const media = (open.project as { media: ReadonlyArray<{ id: string; name: string; kind: string; path: string }> }).media.find((m) => m.id === r.media);
      if (!media) throw bad(`There's no media "${r.media}" in this project.`);
      if (media.kind !== "audio" && media.kind !== "video") throw bad(`${media.name} is a picture: pick a clip with someone speaking.`);
      return { path: isAbsolute(media.path) ? media.path : resolve(open.dir, media.path), label: media.name };
    };

    /** What the clip says, by Whisper, and its language when Whisper heard one of Reverb's. */
    const transcribe = async (wav: string, language: string | undefined, signal: AbortSignal, status: Status) => {
      status("Writing down what the clip says…");
      let tools: Awaited<ReturnType<typeof whisper.resolve>>;
      try {
        tools = await whisper.resolve({ signal, onDownload: (f) => status(`Downloading the speech model, ${Math.floor(f * 100)}%`) });
      } catch (error) {
        throw bad(`Type what the clip says: Whisper can't write it down here (${(error as Error).message})`);
      }
      const speech = await pluginTranscribe((args, o) => Effect.runPromise(plugins.callPlugin(WHISPER_PLUGIN, WHISPER_TOOL, args, o)))(
        { audio: wav, ...tools, language: language ?? "auto", timeoutMs: TRANSCRIBE_TIMEOUT_MS },
        { signal, onProgress: () => {} },
      );
      const text = speech.segments
        .map((s) => s.text.trim())
        .join(" ")
        .trim();
      if (!text) throw bad("Whisper heard no speech in that clip: pick a few seconds of someone talking.");
      return { text, language: isLanguage(speech.language) ? speech.language : undefined };
    };

    const cloneVoice = async (r: VoiceCloneRequest, signal: AbortSignal, status: Status): Promise<VoiceInfo> => {
      const checked = checkClone(r);
      if (checked instanceof VoiceError) throw checked;
      const source = await sourceOf(r);
      await config.shellReady;
      const ffmpeg = await which("ffmpeg", process.env.PATH ?? "");
      if (!ffmpeg) throw failed("Cloning a voice needs ffmpeg (brew install ffmpeg).");
      const tmp = await mkdtemp(join(tmpdir(), "uncut-voice-"));
      try {
        status("Cutting the clip…");
        const f32 = join(tmp, "clip.f32");
        const wav = join(tmp, "clip.wav");
        await runFfmpeg(ffmpeg, clipArgs(source.path, checked.start, checked.seconds, f32, wav), signal);
        const seconds = (await stat(f32)).size / 4 / SAMPLE_RATE;
        if (seconds < CLONE_MIN_SECONDS)
          throw bad(`That clip has ${seconds.toFixed(1)} s of sound there; a voice needs at least ${CLONE_MIN_SECONDS} s. Start it earlier.`);
        const heard = r.transcript?.trim() ? { text: r.transcript.trim(), language: undefined } : await transcribe(wav, r.language, signal, status);
        const language = r.language ?? heard.language ?? "en";
        const paths = await files.ensure({ signal, onProgress: downloadStatus(status) });
        const out = join(tmp, "voice.json");
        const answer = await call(
          "clone",
          { audio: f32, transcript: heard.text, language, out, files: { codec: paths.codec }, runner: runner() },
          signal,
          status,
          CLONE_TIMEOUT_MS,
        );
        if (answer.isError) throw failed(answer.content.map((c) => ("text" in c ? c.text : "")).join(" ") || "Reverb couldn't learn the voice.");
        const made = JSON.parse(await readFile(out, "utf8")) as Omit<SavedVoice, "id" | "name" | "createdAt" | "consent">;
        const saved = await store.save({ ...made, language }, { name: checked.name, source: `${source.label} from ${checked.start} s` });
        await refreshVoices();
        return savedInfo(saved);
      } finally {
        await rm(tmp, { recursive: true, force: true });
      }
    };

    const asVoiceError = (error: unknown, signal: AbortSignal) =>
      error instanceof VoiceError ? error : failed(signal.aborted ? "Cancelled." : ((error as Error).message ?? String(error)));

    const cloneNow: SpeechShape["cloneNow"] = (request, { signal, status }) =>
      Effect.tryPromise({ try: () => cloneVoice(request, signal, status ?? (() => {})), catch: (e) => asVoiceError(e, signal) });

    const clone: SpeechShape["clone"] = (request) =>
      Effect.gen(function* () {
        if (cloning) return yield* new VoiceError({ reason: "busy", message: "A voice is being cloned already: wait for it, or cancel it." });
        const checked = checkClone(request);
        if (checked instanceof VoiceError) return yield* checked;
        const controller = new AbortController();
        cloning = controller;
        const id = randomUUID();
        const job = { id, name: checked.name };
        setState({ clone: { ...job, phase: "running", status: "Starting…" } });
        const status = (text: string) => setState({ clone: { ...job, phase: "running", status: text } });
        void cloneVoice(request, controller.signal, status)
          .then(
            (voice) => setState({ clone: { ...job, phase: "done", voice } }),
            (error) =>
              setState({
                clone: controller.signal.aborted
                  ? { ...job, phase: "cancelled" }
                  : { ...job, phase: "failed", error: asVoiceError(error, controller.signal).message },
              }),
          )
          .finally(() => {
            if (cloning === controller) cloning = undefined;
          });
        return { jobId: id };
      });

    const generateArgs: SpeechShape["generateArgs"] = async (options, signal, status) => {
      const wanted = typeof options?.voice === "string" && options.voice.trim() ? options.voice : DEFAULT_VOICE;
      const voice = await store.find(wanted);
      if (!voice) {
        const some = (await store.list()).map((v) => v.name).slice(0, 12);
        throw new Error(`There's no voice "${wanted.slice(0, 60)}". Some of them: ${some.join(", ")}.`);
      }
      const language = options?.language && options.language !== "auto" ? options.language : voice.language;
      if (!isLanguage(language)) throw new Error(`language is one of ${Object.keys(LANGUAGES).join(", ")}.`);
      const paths = await files.ensure({ signal, onProgress: downloadStatus(status) });
      return { voice: voice.preset ? files.presetPath(voice.id) : store.path(voice.id), language, files: paths, runner: runner() };
    };

    return Speech.of({
      state: Stream.unwrap(Effect.map(Effect.promise(refreshVoices), () => SubscriptionRef.changes(stateRef))),
      voices: Effect.promise(() => store.list()),
      clone,
      cloneNow,
      cancel: Effect.sync(() => cloning?.abort()),
      remove: (id) =>
        Effect.gen(function* () {
          const removed = yield* Effect.promise(() => store.remove(id));
          if (!removed) return yield* new VoiceError({ reason: "unknown-voice", message: `There's no cloned voice "${id}".` });
          yield* Effect.promise(refreshVoices);
        }),
      generateArgs,
      choices: Effect.promise(async () => (await store.list()).map((v) => ({ value: v.id, label: v.preset ? v.name : `${v.name} (yours)` }))),
    });
  }),
);
