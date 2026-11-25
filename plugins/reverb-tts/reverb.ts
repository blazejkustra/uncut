// Reverb as the plugin runs it: the files Uncut downloads (pinned to a commit, sizes and SHA-256
// from huggingface.co/api/models/<repo>/tree/<commit>, 2026-11-25), the preset voices, and the
// voice runner: Uncut's own Electron binary in its --uncut-speech mode (apps/desktop/src/speech.ts),
// which Uncut names in each call. One runner is kept while the plugin runs, so the weights load once.
import { type ChildProcess, spawn } from "node:child_process";
import * as readline from "node:readline";

const REVERB = "https://huggingface.co/software-mansion/Reverb-TTS/resolve/d0dd065f2a7147ba6509007409200c802fe720b3";
const CODEC = "https://huggingface.co/software-mansion/higgs-audio-v2-tokenizer-Reverb/resolve/e0d9ccd2935d7f953764a83b09444dc0677a44a0";

export interface ModelFile {
  readonly id: "model" | "codec" | "tokenizer";
  readonly file: string;
  readonly url: string;
  readonly bytes: number;
  readonly sha256?: string;
}

/** Reverb's int4 weights for ruNNtime, the Higgs Audio v2 codec it speaks through, and its tokenizer: 386 MB in all. */
export const MODEL_FILES: ReadonlyArray<ModelFile> = [
  {
    id: "model",
    file: "reverb-int4.safetensors",
    url: `${REVERB}/model/runntime/int4/model.safetensors`,
    bytes: 190532806,
    sha256: "7df6cca18cfe8039cc840721d7d32a84d4747d89e50c30526326a87a9c756e68",
  },
  {
    id: "codec",
    file: "higgs-codec.safetensors",
    url: `${CODEC}/combined/safetensors/d8e8/model.safetensors`,
    bytes: 193091970,
    sha256: "6f5da87e4bf48b8d15794271cce73983e02873da7e35d4583583b0adc160f3f3",
  },
  { id: "tokenizer", file: "tokenizer.json", url: `${REVERB}/model/tokenizer.json`, bytes: 2170389 },
];

export const LANGUAGES = { en: "English", de: "German", fr: "French", es: "Spanish", it: "Italian", pl: "Polish", pt: "Portuguese" } as const;
export type Language = keyof typeof LANGUAGES;
export const isLanguage = (v: unknown): v is Language => typeof v === "string" && Object.hasOwn(LANGUAGES, v);

export interface PresetVoice {
  readonly id: string;
  readonly name: string;
  readonly language: Language;
  readonly bytes: number;
}

/** Reverb's preset voices (voices/<id>.json in its repo), already encoded. */
export const PRESET_VOICES: ReadonlyArray<PresetVoice> = [
  { id: "en_male_narrator_1", name: "Narrator, male", language: "en", bytes: 7855 },
  { id: "en_male_narrator_2", name: "Narrator, male 2", language: "en", bytes: 14830 },
  { id: "en_female_narrator", name: "Narrator, female", language: "en", bytes: 14990 },
  { id: "en_female_whisper", name: "Whisper, female", language: "en", bytes: 13933 },
  { id: "en_male_angry", name: "Angry, male", language: "en", bytes: 7017 },
  { id: "de_male_standard", name: "German, male", language: "de", bytes: 9466 },
  { id: "de_female_standard", name: "German, female", language: "de", bytes: 6775 },
  { id: "fr_male_standard", name: "French, male", language: "fr", bytes: 7772 },
  { id: "fr_female_standard", name: "French, female", language: "fr", bytes: 6394 },
  { id: "es_male_standard_1", name: "Spanish, male", language: "es", bytes: 5365 },
  { id: "es_male_standard_2", name: "Spanish, male 2", language: "es", bytes: 8087 },
  { id: "it_male_standard", name: "Italian, male", language: "it", bytes: 6448 },
  { id: "it_male_expressive", name: "Italian, male, expressive", language: "it", bytes: 8770 },
  { id: "pl_male_standard", name: "Polish, male", language: "pl", bytes: 8867 },
  { id: "pt_male_standard", name: "Portuguese, male", language: "pt", bytes: 6436 },
  { id: "pt_female_standard", name: "Portuguese, female", language: "pt", bytes: 7164 },
];
export const DEFAULT_VOICE = "en_male_narrator_1";
export const presetVoiceUrl = (id: string) => `${REVERB}/voices/${id}.json`;

/** The codec's sample rate: what a clone's samples are given at. */
export const SAMPLE_RATE = 24000;
/** How long a clone's recording may be, in seconds (Reverb: 3 to 10 s of clean speech is best, over 15 s makes worse takes). */
export const CLONE_MIN_SECONDS = 3;
export const CLONE_MAX_SECONDS = 15;

/** How Uncut says to start the runner: its binary and arguments. */
export interface RunnerCommand {
  readonly bin: string;
  readonly args: ReadonlyArray<string>;
}

interface Waiting {
  readonly resolve: (answer: Record<string, unknown>) => void;
  readonly reject: (error: Error) => void;
  readonly onLoading?: ((fraction: number) => void) | undefined;
}

/** Stopped by a cancel: the call gets no answer. */
export class Stopped extends Error {}

/** One --uncut-speech process: requests in JSON lines, answered in order. */
export class SpeechRunner {
  private readonly child: ChildProcess;
  private readonly ready: Promise<void>;
  private readonly waiting = new Map<number, Waiting>();
  private nextId = 0;
  private stderr = "";
  private failStart: (error: Error) => void = () => {};
  readonly command: RunnerCommand;
  gone = false;

  constructor(command: RunnerCommand) {
    this.command = command;
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    this.child = spawn(command.bin, [...command.args], { env, stdio: ["pipe", "pipe", "pipe"] });
    this.child.stderr?.on("data", (chunk: Buffer) => (this.stderr = `${this.stderr}${chunk}`.slice(-4000)));
    let started: () => void = () => {};
    this.ready = new Promise<void>((resolve, reject) => ((started = resolve), (this.failStart = reject)));
    this.ready.catch(() => {});
    readline.createInterface({ input: this.child.stdout! }).on("line", (line) => this.onLine(line, started));
    this.child.on("error", (error) => this.end(new Error(`The voice runner couldn't start: ${error.message}`)));
    this.child.on("exit", (code, signal) => this.end(new Error(`The voice runner stopped (${signal ?? `exit ${code}`})${this.lastError()}`)));
  }

  /** Gone: every request still waiting fails with `error`. */
  private end(error: Error) {
    if (this.gone) return;
    this.gone = true;
    this.failStart(error);
    for (const w of this.waiting.values()) w.reject(error);
    this.waiting.clear();
  }

  private lastError() {
    const line = this.stderr.split("\n").find((l) => l.startsWith("[uncut-speech]"));
    return line ? `: ${line.slice("[uncut-speech] ".length)}` : ".";
  }

  private onLine(line: string, started: () => void) {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    if (msg.uncut !== "speech") return;
    if (msg.ready === true) return started();
    const w = this.waiting.get(msg.id as number);
    if (!w) return;
    if (typeof msg.loading === "number") return w.onLoading?.(msg.loading);
    this.waiting.delete(msg.id as number);
    if (msg.ok === true) w.resolve(msg);
    else w.reject(new Error(typeof msg.error === "string" ? msg.error : "The voice runner failed without saying why."));
  }

  /** Sends one request and waits for its answer; `signal` stops the runner (Stopped). */
  async request(body: Record<string, unknown>, options: { readonly signal: AbortSignal; readonly onLoading?: (fraction: number) => void }) {
    await this.ready;
    const id = ++this.nextId;
    const answer = new Promise<Record<string, unknown>>((resolve, reject) => this.waiting.set(id, { resolve, reject, onLoading: options.onLoading }));
    const stop = () => this.stop();
    options.signal.addEventListener("abort", stop, { once: true });
    try {
      this.child.stdin!.write(`${JSON.stringify({ id, ...body })}\n`);
      return await answer;
    } finally {
      options.signal.removeEventListener("abort", stop);
    }
  }

  /** Kills it: what's waiting fails with Stopped. */
  stop() {
    this.child.kill("SIGKILL");
    this.end(new Stopped("Cancelled."));
  }
}

let runner: SpeechRunner | undefined;

/** The running runner for `command`, started when there's none (or it stopped, or the command changed). */
export function runnerFor(command: RunnerCommand) {
  const same = runner && !runner.gone && runner.command.bin === command.bin && runner.command.args.join("\0") === command.args.join("\0");
  if (!same) {
    runner?.stop();
    runner = new SpeechRunner(command);
  }
  return runner!;
}

export const stopRunner = () => runner?.stop();
