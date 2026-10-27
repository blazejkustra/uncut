#!/usr/bin/env node
// Uncut's Whisper plugin (D26, D100): the first local model behind the plugin host. A stdio MCP
// server on Uncut's own Node, written with @uncut/plugin-sdk (D102), that answers one call Uncut
// makes itself, never the agent (it lists no agent tools):
//
//   transcribe { audio | files, model, bin?, language?, seconds?, timeoutSeconds? }
//     audio: a 16 kHz mono WAV Uncut extracted; whisper's JSON is written next to it, in Uncut's
//     temp folder. files instead: several WAVs (a long take's phrases), each transcribed on its own
//     in one whisper-cli run; the answer is then { files: [{ language?, segments, words }] }.
//     model: the ggml file Uncut downloaded (Setup's Speech model row). bin: the
//     whisper-cli Uncut found (else PATH). The answer's structuredContent is { language?, segments,
//     words }; progress comes as notifications/progress (0–100) when the call has a progressToken.
//     notifications/cancelled kills whisper-cli and the call gets no answer.
//
// Uncut keeps the rest: the queue, the model downloads, the cache, the Setup rows.
import { stat } from "node:fs/promises";
import { resolve } from "node:path";

import { failure, serve, text, type Json, type ToolContext } from "@uncut/plugin-sdk";

import { transcribeWav, transcribeWavs } from "./whisper.ts";

const str = (x: unknown) => (typeof x === "string" && x.trim() ? x : undefined);

const isFile = async (path: string) => (await stat(path).catch(() => undefined))?.isFile() === true;

/** MCP progress 0–100, each whole percent once. */
function percentProgress(progress: ToolContext["progress"]) {
  let last = -1;
  return (fraction: number) => {
    const pct = Math.round(fraction * 100);
    if (pct === last) return;
    last = pct;
    progress(pct, 100);
  };
}

async function transcribeFiles(args: Json, files: ReadonlyArray<unknown>, { signal, progress }: ToolContext) {
  const model = str(args.model);
  if (!model || !files.length || !files.every((f) => typeof f === "string" && f.trim())) return failure("Pass files (WAV paths) and model (a ggml file).");
  for (const f of files as ReadonlyArray<string>) if (!(await isFile(f))) return failure(`There's no audio file at ${f}.`);
  const language = str(args.language) ?? "auto";
  if (!/^(auto|[a-z]{2,3})$/.test(language)) return failure(`"${language}" isn't a language whisper knows: "auto" or a code like en.`);
  const timeoutMs = typeof args.timeoutSeconds === "number" && args.timeoutSeconds > 0 ? args.timeoutSeconds * 1000 : undefined;
  const answers = await transcribeWavs(
    { files: files as ReadonlyArray<string>, model, bin: str(args.bin), language },
    { signal, timeoutMs, onProgress: percentProgress(progress) },
  );
  const words = answers.reduce((n, a) => n + a.words.length, 0);
  return text(`${words} words in ${answers.length} files.`, { files: answers } as unknown as Json);
}

async function transcribe(args: Json, context: ToolContext) {
  if (Array.isArray(args.files)) return transcribeFiles(args, args.files, context);
  const audio = str(args.audio);
  const model = str(args.model);
  if (!audio || !model) return failure("Pass audio (a WAV) and model (a ggml file).");
  if (!(await isFile(audio))) return failure(`There's no audio file at ${audio}.`);
  const language = str(args.language) ?? "auto";
  if (!/^(auto|[a-z]{2,3})$/.test(language)) return failure(`"${language}" isn't a language whisper knows: "auto" or a code like en.`);
  const seconds = typeof args.seconds === "number" && Number.isFinite(args.seconds) ? args.seconds : undefined;
  const timeoutMs = typeof args.timeoutSeconds === "number" && args.timeoutSeconds > 0 ? args.timeoutSeconds * 1000 : undefined;
  const speech = await transcribeWav(
    { audio, model, bin: str(args.bin), language, seconds },
    { signal: context.signal, timeoutMs, onProgress: percentProgress(context.progress) },
  );
  return text(
    `${speech.words.length} words in ${speech.segments.length} segments${speech.language ? ` (${speech.language})` : ""}.`,
    speech as unknown as Json,
  );
}

// notifications/cancelled aborts the call's signal, which kills whisper-cli; the call gets no
// answer. Stopping (stdin closed, SIGTERM) aborts every call the same way.
const isMain = process.argv[1] && resolve(process.argv[1]) === import.meta.filename;
if (isMain) serve({ manifest: new URL("./uncut.module.json", import.meta.url), tools: { transcribe } });
