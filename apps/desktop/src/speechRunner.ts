// The offline voice's page code (speech.ts loads it in an offscreen window, bundled as
// window.UncutSpeech): Reverb and its codec on WebGPU through ruNNtime, text read out with
// Verbalis first. Files come from Uncut's own scheme (speech.ts serves only what a request names).
import { createTextToSpeech, createVoiceMaker, initRunntime, type ReverbLanguage, type TextToSpeech, type Voice, type VoiceMaker } from "runntime/zoo";
import tgpu from "typegpu";
import { Verbalizer } from "verbalis";

export interface ModelUrls {
  readonly model: string;
  readonly codec: string;
  readonly tokenizer: string;
}

/** A voice as Reverb's preset files keep it (voices/*.json on Hugging Face). */
export interface VoiceFile {
  readonly language: string;
  readonly transcript: string;
  readonly frames: number;
  readonly speech_frames?: number;
  readonly codes: ReadonlyArray<number>;
}

const GAP_SECONDS = 0.2;
const FRAME_RATE = 25;
/** A text estimated longer than this (seconds) is spoken in pieces of about PIECE_SECONDS, as reverb-tts does. */
const LONGEST_SECONDS = 30;
const PIECE_SECONDS = 15;
const BRACKETS = /[()[\]{}]/g;
const SENTENCE_END = /(?<=[.!?])\s+/;

let initialised: Promise<void> | undefined;
let speaker: { readonly key: string; readonly tts: Promise<TextToSpeech> } | undefined;
let maker: { readonly key: string; readonly voices: Promise<VoiceMaker> } | undefined;
let loading = { done: 0, total: 0 };

/** How far the weights have loaded onto the GPU, 0 to 1; speech.ts asks while a request runs. */
export const progress = () => (loading.total > 0 ? Math.min(1, loading.done / loading.total) : 0);

const onProgress = (_name: string, done: number, total: number) => {
  loading = { done, total };
};

function init() {
  initialised ??= tgpu.init({ device: { optionalFeatures: ["subgroups", "shader-f16"] } }).then((root) => void initRunntime(root));
  return initialised;
}

const verbalizers = new Map<string, Verbalizer>();
function verbalize(text: string, language: ReverbLanguage) {
  let v = verbalizers.get(language);
  if (!v) {
    v = new Verbalizer(language);
    verbalizers.set(language, v);
  }
  return v.process(text);
}

async function textToSpeech(urls: ModelUrls) {
  await init();
  const key = `${urls.model}|${urls.codec}|${urls.tokenizer}`;
  if (speaker?.key !== key) {
    speaker?.tts.then((t) => t.dispose()).catch(() => {});
    const tts = createTextToSpeech({ modelPath: urls.model, codecPath: urls.codec, tokenizerPath: urls.tokenizer }, { onProgress });
    speaker = { key, tts };
    tts.catch(() => {
      if (speaker?.tts === tts) speaker = undefined;
    });
  }
  return speaker.tts;
}

async function voiceMaker(codec: string) {
  await init();
  if (maker?.key !== codec) {
    maker?.voices.then((m) => m.dispose()).catch(() => {});
    const voices = createVoiceMaker({ codecPath: codec }, { onProgress });
    maker = { key: codec, voices };
    voices.catch(() => {
      if (maker?.voices === voices) maker = undefined;
    });
  }
  return maker.voices;
}

/** The voice speaking `language`: Reverb's prompt names the text's language, the transcript stays in the voice's own. */
/** The text as Reverb was trained to read it: verbalized, no brackets, single spaces. */
const prepared = (text: string, language: ReverbLanguage) => verbalize(text, language).replace(BRACKETS, "").split(/\s+/).filter(Boolean).join(" ");

/** How long a text takes, in codec frames, at the rate the voice speaks its transcript (reverb-tts's estimate_frames). */
function estimateFrames(text: string, voice: Voice) {
  const weight = (s: string) => {
    let w = 0;
    for (const c of s) w += /\p{Z}/u.test(c) ? 0.2 : /\p{M}/u.test(c) ? 0 : /[\p{P}\p{S}]/u.test(c) ? 0.5 : /\p{N}/u.test(c) ? 3.5 : 1;
    return w;
  };
  const frames = weight(text) / (weight(voice.transcript) / voice.frames);
  return Math.max(1, Math.floor(frames < 50 ? 50 * (frames / 50) ** (1 / 3) : frames));
}

/** The text whole when it's short enough, else cut at sentence ends into pieces of about PIECE_SECONDS; a longer sentence stays whole. */
function splitText(text: string, voice: Voice) {
  if (estimateFrames(text, voice) <= LONGEST_SECONDS * FRAME_RATE) return [text];
  const pieces: Array<string> = [];
  for (const sentence of text.split(SENTENCE_END)) {
    const joinedPiece = pieces.length ? `${pieces.at(-1)} ${sentence}` : sentence;
    if (pieces.length && estimateFrames(joinedPiece, voice) <= PIECE_SECONDS * FRAME_RATE) pieces[pieces.length - 1] = joinedPiece;
    else pieces.push(sentence);
  }
  return pieces;
}

const voiceOf = (file: VoiceFile, language: ReverbLanguage): Voice => ({
  codes: Int32Array.from(file.codes),
  frames: file.frames,
  transcript: verbalize(file.transcript, file.language as ReverbLanguage),
  language,
  ...(file.speech_frames ? { speechFrames: file.speech_frames } : {}),
});

function joined(parts: ReadonlyArray<Float32Array>, sampleRate: number) {
  const gap = Math.round(GAP_SECONDS * sampleRate);
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0) + gap * Math.max(0, parts.length - 1));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length + gap;
  }
  return out;
}

/** 16-bit PCM mono WAV bytes. */
function wav(samples: Float32Array, sampleRate: number) {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  const ascii = (at: number, s: string) => [...s].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));
  ascii(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) view.setInt16(44 + i * 2, Math.round(Math.max(-1, Math.min(1, samples[i]!)) * 32767), true);
  return bytes;
}

/** The text spoken in the voice (in pieces of about 15 s when it's long), joined with a short pause: the WAV's bytes and its length. */
export async function speak(request: {
  readonly urls: ModelUrls;
  readonly voice: VoiceFile;
  readonly text: string;
  readonly language: string;
  readonly seed?: number;
}) {
  const tts = await textToSpeech(request.urls);
  const language = request.language as ReverbLanguage;
  const voice = voiceOf(request.voice, language);
  const pieces = splitText(prepared(request.text, language), voice);
  const seed = request.seed ?? 0;
  const parts: Array<Float32Array> = [];
  for (const [i, piece] of pieces.entries()) parts.push(await tts.synthesize(piece, voice, { seed: seed + i }));
  const samples = joined(parts, tts.sampleRate);
  return { wav: wav(samples, tts.sampleRate), seconds: samples.length / tts.sampleRate };
}

/** A voice from a recording: mono float samples (the file at `audio`) and what they say. */
export async function clone(request: {
  readonly codec: string;
  readonly audio: string;
  readonly sampleRate: number;
  readonly transcript: string;
  readonly language: string;
}) {
  const voices = await voiceMaker(request.codec);
  const samples = new Float32Array(await (await fetch(request.audio)).arrayBuffer());
  const voice = await voices.fromRecording(samples, {
    sampleRate: request.sampleRate,
    transcript: request.transcript,
    language: request.language as ReverbLanguage,
  });
  return {
    language: voice.language,
    transcript: voice.transcript,
    frames: voice.frames,
    duration: voice.frames / 25,
    ...(voice.speechFrames ? { speech_frames: voice.speechFrames } : {}),
    codes: Array.from(voice.codes),
  };
}
