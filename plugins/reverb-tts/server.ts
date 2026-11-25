#!/usr/bin/env node
// Uncut's offline voice: Reverb (text to speech and voice cloning) on this Mac's GPU, a stdio MCP
// server on Uncut's own Node. Uncut keeps the downloads, the saved voices and the media; it calls
// two tools here, never the agent directly:
//
//   generate { generator, prompt, voice, language, out, files: { model, codec, tokenizer }, runner }
//     the prompt read in the voice (a voice .json file), saved as a WAV at out.
//   clone { audio, transcript, language, out, files: { codec }, runner }
//     a voice made from audio (raw mono float32 samples at 24 kHz) saved as .json at out.
//
// runner is how to start Uncut's voice runner (its Electron binary with --uncut-speech). Progress
// comes as notifications/progress messages; notifications/cancelled stops the runner.
import { failure, serve, text, type Json, type ToolContext } from "@uncut/plugin-sdk";

import { isLanguage, runnerFor, SAMPLE_RATE, stopRunner, Stopped, type RunnerCommand } from "./reverb.ts";

const str = (x: unknown) => (typeof x === "string" && x.trim() ? x : undefined);

function runnerOf(args: Json): RunnerCommand | undefined {
  const r = args.runner as { bin?: unknown; args?: unknown } | undefined;
  if (!r || !str(r.bin) || !Array.isArray(r.args) || !r.args.every((a) => typeof a === "string")) return undefined;
  return { bin: r.bin as string, args: r.args as ReadonlyArray<string> };
}

const filesOf = (args: Json, ids: ReadonlyArray<string>) => {
  const files = (args.files ?? {}) as Record<string, unknown>;
  return ids.every((id) => str(files[id])) ? (Object.fromEntries(ids.map((id) => [id, files[id]])) as Record<string, string>) : undefined;
};

/** "Loading the voice model, 40%", each whole ten percent once. */
function loadingProgress(ctx: ToolContext) {
  let last = -1;
  return (fraction: number) => {
    const tens = Math.floor(fraction * 10);
    if (tens === last) return;
    last = tens;
    ctx.progress(0, undefined, `Loading the voice model, ${tens * 10}%`);
  };
}

async function run(command: RunnerCommand, body: Record<string, unknown>, ctx: ToolContext) {
  try {
    return await runnerFor(command).request(body, { signal: ctx.signal, onLoading: loadingProgress(ctx) });
  } catch (error) {
    if (error instanceof Stopped) throw error;
    return { ok: false, error: (error as Error).message };
  }
}

async function generate(args: Json, ctx: ToolContext) {
  const command = runnerOf(args);
  const files = filesOf(args, ["model", "codec", "tokenizer"]);
  const prompt = str(args.prompt);
  const voice = str(args.voice);
  const out = str(args.out);
  if (!command || !files || !prompt || !voice || !out) return failure("Pass prompt, voice (a voice file), out, files (model, codec, tokenizer) and runner.");
  if (!isLanguage(args.language)) return failure(`language must be one of en, de, fr, es, it, pl, pt.`);
  ctx.progress(0, undefined, "Reading the script…");
  const answer = await run(command, { kind: "speak", files, voice, text: prompt, language: args.language, out }, ctx);
  if (answer.ok !== true) return failure(`Reverb couldn't read it: ${String(answer.error)}`);
  const seconds = typeof answer.seconds === "number" ? Number(answer.seconds.toFixed(2)) : undefined;
  return text(`Read the script${seconds ? ` (${seconds} s)` : ""}.`, { model: "reverb-int4", ...(seconds ? { seconds } : {}) });
}

async function clone(args: Json, ctx: ToolContext) {
  const command = runnerOf(args);
  const files = filesOf(args, ["codec"]);
  const audio = str(args.audio);
  const transcript = str(args.transcript);
  const out = str(args.out);
  if (!command || !files || !audio || !transcript || !out) return failure("Pass audio (24 kHz float samples), transcript, out, files (codec) and runner.");
  if (!isLanguage(args.language)) return failure(`language must be one of en, de, fr, es, it, pl, pt.`);
  ctx.progress(0, undefined, "Learning the voice…");
  const answer = await run(command, { kind: "clone", files, audio, sampleRate: SAMPLE_RATE, transcript, language: args.language, out }, ctx);
  if (answer.ok !== true) return failure(`Reverb couldn't learn the voice: ${String(answer.error)}`);
  return text("Learned the voice.", { voice: out });
}

serve({
  manifest: new URL("./uncut.module.json", import.meta.url),
  tools: { generate, clone },
  onExit: stopRunner,
});
