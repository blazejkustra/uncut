// The transcript analyzer (D68): speech to words, on this Mac, with whisper.cpp (Homebrew's
// whisper-cpp, binary whisper-cli). One job: ffmpeg writes the first audio stream (0:a:0) as a
// 16 kHz mono WAV into a temp folder, and the speech model turns it into words: the bundled
// Whisper plugin (plugins/whisper-transcribe, D100) runs whisper-cli to full JSON (-ojf: segments
// with their tokens, each token timed) and joins the tokens into words. The temp folder goes
// whatever happens (done, failed, cancelled). Cached through the analysis queue (D66) as
// <fp>/transcript.json. Fillers and pauses are derived from the words when they're read (pure,
// so tuning the lists needs no re-run), pauses aligned to the loudness analyzer's silences when
// those are cached.
import { tmpdir } from "node:os";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import { Stopped, transcribeWav, transcribeWavs, type Speech } from "../../../../plugins/whisper-transcribe/whisper.ts";

import { Cancelled, ffmpegError, NO_AUDIO_STREAM, spawnRunner, type Runner } from "./analysisRunner.ts";
import { correctNames } from "./names.ts";
import { PHRASE_TAKE_MIN_S, transcribeByPhrases, type TranscriptPhrase } from "./phrases.ts";

/** Bumped when the transcript's shape or the way words are made changes, so older cache files are redone. */
export const TRANSCRIPT_VERSION = 2;
/** Temp folders are uncut-transcript-<server pid>-XXXXXX, so a sweep can tell whose they are. */
export const TEMP_PREFIX = "uncut-transcript-";

const pidAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** Removes transcript temp folders a server left behind (a crash, a forced quit): those whose server (the pid in the name) is gone, or over an hour old without one. */
export async function sweepStaleTranscriptTemp(dir = tmpdir(), now = Date.now()) {
  const names = await readdir(dir).catch(() => [] as Array<string>);
  await Promise.all(
    names.map(async (name) => {
      const m = /^uncut-transcript-(?:(\d+)-)?[A-Za-z0-9]{6}$/.exec(name);
      if (!m) return;
      const pid = m[1] ? Number(m[1]) : undefined;
      if (pid === process.pid) return;
      if (
        pid !== undefined
          ? pidAlive(pid)
          : now -
              (await stat(join(dir, name)).then(
                (s) => s.mtimeMs,
                () => now,
              )) <
            3600_000
      )
        return;
      await rm(join(dir, name), { recursive: true, force: true }).catch(() => {});
    }),
  );
}

import type { TranscriptSegment, TranscriptWord } from "../../../../plugins/whisper-transcribe/whisper.ts";
export type { Speech, TranscriptPhrase, TranscriptSegment, TranscriptWord };
export interface TranscriptResult {
  readonly hasAudio: boolean;
  readonly seconds?: number;
  /** The spoken language (detected, or the one asked for), ISO 639-1. */
  readonly language?: string;
  /** What was asked: "auto" or a language code. */
  readonly requestedLanguage?: string;
  /** The model that made it (a whisperModels id). */
  readonly model?: string;
  readonly segments?: ReadonlyArray<TranscriptSegment>;
  readonly words?: ReadonlyArray<TranscriptWord>;
  /** A long take's phrases (split at its silences, each transcribed on its own), in order. */
  readonly phrases?: ReadonlyArray<TranscriptPhrase>;
}

export const NO_SPEECH_AUDIO: TranscriptResult = { hasAudio: false };

/** A language whisper accepts: "auto" or a 2–3 letter code. */
export const isLanguage = (v: unknown): v is string => typeof v === "string" && /^(auto|[a-z]{2,3})$/.test(v);

// ---- the commands ----

export const extractArgs = (path: string, wav: string) => [
  "-hide_banner",
  "-nostdin",
  "-nostats",
  "-progress",
  "pipe:1",
  "-i",
  path,
  "-map",
  "0:a:0",
  "-vn",
  "-sn",
  "-dn",
  "-ac",
  "1",
  "-ar",
  "16000",
  "-c:a",
  "pcm_s16le",
  "-f",
  "wav",
  "-y",
  wav,
];

// ---- whisper's JSON into words: the plugin's (plugins/whisper-transcribe, D100) ----

export { parseWhisperJson, whisperArgs } from "../../../../plugins/whisper-transcribe/whisper.ts";

const ms3 = (s: number) => Math.round(s * 1000) / 1000;

// ---- running it ----

/**
 * A speech model, as Uncut sees it (D26, D100): given a 16 kHz mono WAV, the model file and a
 * language, it answers words and segments. In the app it's the bundled Whisper plugin, called
 * through the plugin host (`pluginTranscribe`); in-process tests use `transcribeDirect`.
 */
export interface SpeechRequest {
  readonly audio: string;
  readonly bin: string;
  readonly model: string;
  readonly modelId: string;
  readonly language: string;
  readonly seconds?: number | undefined;
  readonly timeoutMs: number;
  /** Phrase WAVs to transcribe instead of audio, each on its own: the answer's files, in this order. */
  readonly files?: ReadonlyArray<string> | undefined;
}
export interface SpeechAnswer extends Speech {
  readonly files?: ReadonlyArray<Speech>;
}
export type Transcribe = (
  request: SpeechRequest,
  options: { readonly signal: AbortSignal; readonly onProgress: (fraction: number) => void; readonly runner?: Runner | undefined },
) => Promise<SpeechAnswer>;

/** whisper-cli run here, through the analysis runner (tests: they watch what's spawned). */
export const transcribeDirect: Transcribe = async (request, { signal, onProgress, runner }) => {
  const run = runner ?? spawnRunner;
  const common = { model: request.model, bin: request.bin, language: request.language };
  if (request.files)
    return {
      segments: [],
      words: [],
      files: await transcribeWavs({ ...common, files: request.files }, { signal, onProgress, timeoutMs: request.timeoutMs, run }),
    };
  return transcribeWav({ ...common, audio: request.audio, seconds: request.seconds }, { signal, onProgress, timeoutMs: request.timeoutMs, run });
};

/** The bundled Whisper plugin's id and its one call. */
export const WHISPER_PLUGIN = "whisper.transcribe";
export const WHISPER_TOOL = "transcribe";

const isSpeech = (value: unknown): value is Speech =>
  !!value && typeof value === "object" && Array.isArray((value as Speech).words) && Array.isArray((value as Speech).segments);

type CallResult = {
  readonly isError?: boolean;
  readonly content: ReadonlyArray<{ readonly type: string; readonly text?: string }>;
  readonly structured?: unknown;
};
/**
 * The plugin's answer as a Transcribe: `call` runs the plugin's tool (Plugins.callPlugin); an error
 * result is thrown as its text, a cancelled call as Cancelled, and an answer without words and
 * segments is refused.
 */
export const pluginTranscribe =
  (
    call: (
      args: Record<string, unknown>,
      options: { readonly signal: AbortSignal; readonly timeoutMs: number; readonly onProgress: (progress: number, total: number | undefined) => void },
    ) => Promise<CallResult>,
  ): Transcribe =>
  async (request, { signal, onProgress }) => {
    const what = request.files ? { files: request.files } : { audio: request.audio, ...(request.seconds !== undefined ? { seconds: request.seconds } : {}) };
    const result = await call(
      { ...what, model: request.model, bin: request.bin, language: request.language, timeoutSeconds: Math.ceil(request.timeoutMs / 1000) },
      // A little longer than whisper's own limit, so the plugin's "took too long" is what's said.
      { signal, timeoutMs: request.timeoutMs + 30_000, onProgress: (progress, total) => onProgress(Math.min(1, Math.max(0, progress / (total ?? 100)))) },
    );
    if (signal.aborted) throw new Cancelled();
    const text = result.content
      .map((c) => c.text ?? "")
      .join(" ")
      .trim();
    if (result.isError) throw new Error(text || "The Whisper plugin couldn't transcribe it.");
    if (request.files) {
      const files = (result.structured as { files?: unknown } | undefined)?.files;
      if (!Array.isArray(files) || files.length !== request.files.length || !files.every(isSpeech))
        throw new Error("The Whisper plugin answered without words for each phrase.");
      return { segments: [], words: [], files };
    }
    const speech = result.structured;
    if (!isSpeech(speech)) throw new Error("The Whisper plugin answered without words.");
    return speech;
  };

export interface TranscribeOptions {
  readonly signal: AbortSignal;
  readonly runner?: Runner | undefined;
  /** "auto" (default) or a language code. */
  readonly language?: string | undefined;
  /** The media's length (seconds), for progress and the timeout. */
  readonly seconds?: number | undefined;
  readonly onProgress?: (fraction: number) => void;
  /** Where the temp folder goes (tests). */
  readonly tmpRoot?: string;
  /** The speech model (the Whisper plugin in the app). */
  readonly transcribe: Transcribe;
  /** Names the speech is likely to say (the project's brief): words that sound like one are written as it. */
  readonly names?: ReadonlyArray<string> | undefined;
}

/**
 * Transcribes the first audio stream of `path`: ffmpeg extracts it here (a temp folder Uncut
 * owns and removes), the speech model (`options.transcribe`, with whisper-cli and `model`, a
 * ggml file) turns it into words. A take longer than PHRASE_TAKE_MIN_S is transcribed phrase by
 * phrase (phrases.ts).
 */
export async function analyzeTranscript(
  ffmpeg: string,
  whisper: { readonly bin: string; readonly model: string; readonly modelId: string },
  path: string,
  options: TranscribeOptions,
): Promise<TranscriptResult> {
  const runner = options.runner ?? spawnRunner;
  const language = options.language ?? "auto";
  const timeoutMs = Math.max(60 * 60_000, (options.seconds ?? 0) * 4000);
  const dir = await mkdtemp(join(options.tmpRoot ?? tmpdir(), `${TEMP_PREFIX}${process.pid}-`));
  try {
    const wav = join(dir, "audio.wav");
    let duration: number | undefined;
    let decoded = 0;
    const extract = await runner(ffmpeg, extractArgs(path, wav), {
      signal: options.signal,
      timeoutMs,
      onStderr: (line) => {
        const m = /^\s*Duration:\s*(\d+):(\d+):([\d.]+)/.exec(line);
        if (m && duration === undefined) duration = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
      },
      onStdout: (line) => {
        const m = /^out_time_us=(\d+)/.exec(line);
        if (!m) return;
        decoded = Number(m[1]) / 1e6;
        const total = options.seconds ?? duration;
        if (total) options.onProgress?.(Math.min(0.05, (0.05 * decoded) / total));
      },
    });
    if (extract.code !== 0) {
      if (NO_AUDIO_STREAM.test(extract.stderrTail)) return NO_SPEECH_AUDIO;
      throw new Error(`ffmpeg couldn't read the sound: ${ffmpegError(extract.stderrTail) || `it exited with ${extract.code}`}`);
    }
    if (options.signal.aborted) throw new Cancelled();
    const seconds = decoded > 0 ? decoded : (options.seconds ?? duration);
    const request: SpeechRequest = { audio: wav, bin: whisper.bin, model: whisper.model, modelId: whisper.modelId, language, seconds, timeoutMs };
    const call = {
      signal: options.signal,
      runner: options.runner,
      onProgress: (fraction: number) => options.onProgress?.(Math.min(0.99, 0.05 + 0.94 * fraction)),
    };
    const byPhrases = seconds !== undefined && seconds > PHRASE_TAKE_MIN_S;
    const parsed = await (byPhrases ? transcribeByPhrases(request, options.transcribe, call) : options.transcribe(request, call)).catch((error: unknown) => {
      throw options.signal.aborted || error instanceof Stopped ? new Cancelled() : error;
    });
    if (options.signal.aborted) throw new Cancelled();
    const heard = correctNames(
      { segments: parsed.segments, words: parsed.words, ...("phrases" in parsed ? { phrases: parsed.phrases } : {}) },
      options.names ?? [],
    );
    return {
      hasAudio: true,
      ...(seconds !== undefined ? { seconds: ms3(seconds) } : {}),
      ...(parsed.language ? { language: parsed.language } : language !== "auto" ? { language } : {}),
      requestedLanguage: language,
      model: whisper.modelId,
      ...heard,
    };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// ---- the cache's shape ----

const num = (v: unknown) => typeof v === "number" && Number.isFinite(v);
/** A segment or phrase: text, start and end, and its words [first, end) within n words. */
const isSpan = (value: unknown, n: number) => {
  const x = value as TranscriptSegment;
  return (
    !!x &&
    typeof x === "object" &&
    typeof x.text === "string" &&
    num(x.start) &&
    num(x.end) &&
    Array.isArray(x.words) &&
    x.words.length === 2 &&
    Number.isInteger(x.words[0]) &&
    Number.isInteger(x.words[1]) &&
    x.words[0] >= 0 &&
    x.words[1] <= n &&
    x.words[0] <= x.words[1]
  );
};
/** Whether a cached value has the transcript's shape (anything else is a miss, redone and rewritten). */
export function isTranscriptResult(value: unknown): value is TranscriptResult {
  if (!value || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  if (typeof r.hasAudio !== "boolean") return false;
  if (!r.hasAudio) return true;
  if (r.seconds !== undefined && !num(r.seconds)) return false;
  if (r.language !== undefined && typeof r.language !== "string") return false;
  if (!Array.isArray(r.words) || !Array.isArray(r.segments)) return false;
  const wordsOk = r.words.every(
    (w) =>
      w &&
      typeof w === "object" &&
      typeof (w as TranscriptWord).text === "string" &&
      num((w as TranscriptWord).start) &&
      num((w as TranscriptWord).end) &&
      num((w as TranscriptWord).p),
  );
  const n = r.words.length;
  const segmentsOk = r.segments.every((s) => isSpan(s, n));
  const phrasesOk = r.phrases === undefined || (Array.isArray(r.phrases) && r.phrases.every((p) => isSpan(p, n)));
  return wordsOk && segmentsOk && phrasesOk;
}

// ---- fillers and pauses (derived when read) ----
// They live in @uncut/core (browser-safe) so the Transcript panel derives the same ones (D69).
export { FILLERS, fillersOf, PAUSE_MIN_S, pausesOf, type Filler, type Pause } from "@uncut/core/transcript";
