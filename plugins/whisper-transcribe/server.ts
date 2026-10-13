#!/usr/bin/env node
// Uncut's Whisper plugin (D26, D100): the first local model behind the plugin host. A stdio MCP
// server (one JSON-RPC message per line, no dependencies, on Uncut's own Node) that answers one
// call Uncut makes itself, never the agent (it lists no agent tools):
//
//   transcribe { audio, model, bin?, language?, seconds?, timeoutSeconds? }
//     audio: a 16 kHz mono WAV Uncut extracted; whisper's JSON is written next to it, in Uncut's
//     temp folder. model: the ggml file Uncut downloaded (Setup's Speech model row). bin: the
//     whisper-cli Uncut found (else PATH). The answer's structuredContent is { language?, segments,
//     words }; progress comes as notifications/progress (0–100) when the call has a progressToken.
//     notifications/cancelled kills whisper-cli and the call gets no answer.
//
// Uncut keeps the rest: the queue, the model downloads, the cache, the Setup rows.
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline";

import { transcribeWav } from "./whisper.ts";

type Json = Record<string, unknown>;
const str = (x: unknown) => (typeof x === "string" && x.trim() ? x : undefined);
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

const send = (msg: Json) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`);
const text = (body: string, structured?: unknown, isError = false) => ({ content: [{ type: "text", text: body }], ...(structured !== undefined ? { structuredContent: structured } : {}), ...(isError ? { isError: true } : {}) });
const inFlight = new Map<number | string, AbortController>();

async function transcribe(args: Json, signal: AbortSignal, progressToken: unknown) {
  const audio = str(args.audio);
  const model = str(args.model);
  if (!audio || !model) return text("Pass audio (a WAV) and model (a ggml file).", undefined, true);
  const file = await stat(audio).catch(() => undefined);
  if (!file?.isFile()) return text(`There's no audio file at ${audio}.`, undefined, true);
  const language = str(args.language) ?? "auto";
  if (!/^(auto|[a-z]{2,3})$/.test(language)) return text(`"${language}" isn't a language whisper knows: "auto" or a code like en.`, undefined, true);
  const seconds = typeof args.seconds === "number" && Number.isFinite(args.seconds) ? args.seconds : undefined;
  const timeoutMs = typeof args.timeoutSeconds === "number" && args.timeoutSeconds > 0 ? args.timeoutSeconds * 1000 : undefined;
  let last = -1;
  const speech = await transcribeWav(
    { audio, model, bin: str(args.bin), language, seconds },
    {
      signal,
      timeoutMs,
      onProgress: (fraction) => {
        const pct = Math.round(fraction * 100);
        if (progressToken === undefined || pct === last) return;
        last = pct;
        send({ method: "notifications/progress", params: { progressToken, progress: pct, total: 100 } });
      },
    },
  );
  return text(`${speech.words.length} words in ${speech.segments.length} segments${speech.language ? ` (${speech.language})` : ""}.`, speech);
}

async function onMessage(msg: Json) {
  const { id, method } = msg as { id?: number | string; method?: string };
  const params = (msg.params && typeof msg.params === "object" ? msg.params : {}) as Json;
  if (method === "notifications/cancelled") {
    inFlight.get(params.requestId as number | string)?.abort();
    return;
  }
  if (method === "initialize") return send({ id, result: { protocolVersion: str(params.protocolVersion) ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "uncut-whisper-transcribe", version: "0.1.0" } } });
  if (method === "ping") return send({ id, result: {} });
  if (method === "tools/list") return send({ id, result: { tools: [] } });
  if (method !== "tools/call") {
    if (id !== undefined && method !== undefined) send({ id, error: { code: -32601, message: `Unknown method ${method}` } });
    return;
  }
  const name = String(params.name ?? "");
  if (name !== "transcribe") return send({ id, result: text(`No tool ${name}`, undefined, true) });
  const abort = new AbortController();
  if (id !== undefined) inFlight.set(id, abort);
  const meta = (params._meta && typeof params._meta === "object" ? params._meta : {}) as Json;
  let result: Json;
  try {
    result = await transcribe((params.arguments && typeof params.arguments === "object" ? params.arguments : {}) as Json, abort.signal, meta.progressToken);
  } catch (error) {
    result = text(messageOf(error), undefined, true);
  } finally {
    if (id !== undefined) inFlight.delete(id);
  }
  // A cancelled call gets no answer (MCP): whisper was killed.
  if (!abort.signal.aborted) send({ id, result });
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);
if (isMain) {
  createInterface({ input: process.stdin }).on("line", (line) => {
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg && typeof msg === "object" && !Array.isArray(msg)) void onMessage(msg as Json);
  });
  // Stopping: kill whatever whisper runs.
  const quit = (code: number) => {
    for (const abort of inFlight.values()) abort.abort();
    process.exit(code);
  };
  process.stdin.on("end", () => quit(0));
  process.on("SIGTERM", () => quit(0));
  process.on("SIGINT", () => quit(0));
  process.on("uncaughtException", (error) => {
    process.stderr.write(`whisper-transcribe: ${messageOf(error)}\n`);
    quit(1);
  });
}
