// Keyed generators (D99): GPT Image (OpenAI), Veo (Google, Gemini API) and Sound effects
// (ElevenLabs), each against its documented HTTP API with the user's own key. Base URLs can be
// pointed at a local stub (UNCUT_OPENAI_BASE, UNCUT_GOOGLE_BASE, UNCUT_ELEVENLABS_BASE) so tests
// never call a real API; UNCUT_VEO_POLL_MS shortens Veo's polling for them.
//
// A provider gets its key as an argument for one call, puts it in that request's header and
// nowhere else; every message it builds from a reply has the key redacted.
import { createWriteStream } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import { retryOnReset } from "../library/net.ts";

import type { GenerateKind, KeyProvider } from "@uncut/contracts";

export interface GenerateInput {
  readonly kind: GenerateKind;
  readonly prompt: string;
  readonly size?: string | undefined;
  readonly seconds?: number | undefined;
}

export interface ProviderContext {
  readonly key: string;
  /** Where the result goes, without its extension (the provider adds .png, .mp4, .mp3). */
  readonly outBase: string;
  readonly signal: AbortSignal;
  /** What it's doing, in words, for the Generate tab. */
  readonly status: (text: string) => void;
  /** Called right before the first request goes out (from then on the provider may bill: D99's spend reservation). */
  readonly sent?: (() => void) | undefined;
}

export interface Generated {
  readonly path: string;
  readonly model: string;
  /** US dollars: the reply's own usage when it gives one, else the estimate. */
  readonly cost: number;
}

export interface KeyedGenerator {
  readonly id: string;
  readonly name: string;
  readonly provider: KeyProvider;
  readonly model: string;
  readonly kinds: ReadonlyArray<GenerateKind>;
  readonly sizes: ReadonlyArray<string>;
  readonly seconds?: ReadonlyArray<number>;
  readonly billing: string;
  /** A problem with the input, in a sentence, or undefined. */
  readonly check: (input: GenerateInput) => string | undefined;
  /** Estimated cost in US dollars. */
  readonly estimate: (input: GenerateInput) => number;
  readonly generate: (input: GenerateInput, ctx: ProviderContext) => Promise<Generated>;
}

/**
 * Base-URL overrides (UNCUT_*_BASE, UNCUT_VEO_POLL_MS) count only in test runs (D99 review): the
 * desktop's test harness (UNCUT_CDP, set by every packaged-app test) or a server run without the
 * desktop (the server tests; it has no keys pipe, so keys there are in memory only). Otherwise the
 * fixed https hosts.
 */
let overridesAllowed = false;
/** A test run: the packaged app under the test harness (UNCUT_CDP), or the server without the desktop's keys pipe. */
export const isTestRun = (env: NodeJS.ProcessEnv, keysFd: number | undefined) => Boolean(env.UNCUT_CDP) || keysFd === undefined;
export const allowBaseOverrides = (on: boolean) => {
  overridesAllowed = on;
};
/**
 * A base URL. An override that's set but not honoured fails closed (never silently the real host),
 * and so does the real host in any test context (guardedFetch).
 */
export const providerBase = (name: string, fallback: string) => {
  const override = process.env[name];
  if (override && !overridesAllowed) throw new Error(`${name} is set, but base-URL overrides only count in test runs; nothing was sent.`);
  return (override || fallback).replace(/\/+$/, "");
};

/** node --test (NODE_TEST_CONTEXT), the test harness's UNCUT_TEST_* switches, or the packaged app under it (UNCUT_CDP). */
export const inTestContext = (env: NodeJS.ProcessEnv = process.env) => Boolean(env.NODE_TEST_CONTEXT || env.UNCUT_CDP) || Object.keys(env).some((k) => k.startsWith("UNCUT_TEST"));

/** fetch, except that in any test context a request to anything but this machine is refused: tests never reach a real provider. */
export async function guardedFetch(url: string, init: RequestInit): Promise<Response> {
  if (inTestContext() && !LOOPBACK.has(new URL(url).hostname)) throw new Error(`Refused in a test run: ${new URL(url).host} isn't this machine (tests never call a real provider).`);
  return fetch(url, init);
}
const base = providerBase;

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
/** Whether a key may go to this URL: https, or http to a loopback test stub only. */
export const keySafe = (url: URL) => url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK.has(url.hostname));

/** The most a reply may hold before it's refused (an image as base64, a JSON body). */
const MAX_JSON_BYTES = 64 * 1024 * 1024;
/** The most a downloaded video or sound may be. */
const MAX_FILE_BYTES = 1024 * 1024 * 1024;

const redact = (text: string, key: string) => (key ? text.split(key).join("[key]") : text);

/** An error sentence from a failed reply: the provider's own message when it gives one. */
async function replyError(provider: string, res: Response, key: string): Promise<Error> {
  let detail = "";
  try {
    const text = (await res.text()).slice(0, 4000);
    try {
      const body = JSON.parse(text) as { error?: { message?: unknown } | string; detail?: unknown; message?: unknown };
      const e = body.error;
      const d = body.detail as { message?: unknown } | Array<{ msg?: unknown }> | string | undefined;
      detail = typeof e === "string" ? e : typeof e?.message === "string" ? e.message : typeof d === "string" ? d : Array.isArray(d) ? d.map((x) => String(x?.msg ?? "")).join("; ") : typeof d?.message === "string" ? d.message : typeof body.message === "string" ? body.message : "";
    } catch {
      detail = text.trim().split("\n")[0] ?? "";
    }
  } catch {}
  detail = redact(detail, key).slice(0, 300);
  if (res.status === 401 || res.status === 403) return new Error(`${provider} didn't accept your key (${res.status})${detail ? `: ${detail}` : ""}. Check it in Settings › Keys.`);
  if (res.status === 429) return new Error(`${provider} says too many requests or no credit left (429)${detail ? `: ${detail}` : ""}.`);
  return new Error(`${provider} refused the request (${res.status})${detail ? `: ${detail}` : ""}.`);
}

/** fetch with the message of a network failure kept short and key-free. */
async function send(provider: string, url: string, init: RequestInit, key: string, sent?: () => void): Promise<Response> {
  if (!keySafe(new URL(url))) throw new Error(`${provider}'s address isn't https, so your key wasn't sent.`);
  sent?.();
  try {
    return await guardedFetch(url, init);
  } catch (error) {
    if ((init.signal as AbortSignal | undefined)?.aborted) throw error;
    throw new Error(`Couldn't reach ${provider}: ${redact((error as Error).message, key)}`);
  }
}

/** The most redirects a download follows. */
export const MAX_REDIRECTS = 5;

/**
 * GET `start`, following redirects by hand (at most MAX_REDIRECTS): `keyHeaders` go only to the
 * API's own origin over a key-safe scheme (https, or http to a loopback stub); a hop to another
 * origin gets no key. Plain http to anywhere else is refused outright.
 */
export async function followRedirects(provider: string, start: URL, apiOrigin: string, keyHeaders: Record<string, string>, signal: AbortSignal, key: string): Promise<Response> {
  let url = start;
  for (let hop = 0; ; hop++) {
    if (!keySafe(url)) throw new Error(`${provider}'s file link isn't https.`);
    const withKey = url.origin === apiOrigin;
    let res: Response;
    try {
      const at = url;
      // A GET: once more if a kept-alive socket was dropped under it.
      res = await retryOnReset(() => guardedFetch(at.href, { headers: withKey ? keyHeaders : {}, redirect: "manual", signal }), signal);
    } catch (error) {
      if (signal.aborted) throw error;
      throw new Error(`Couldn't reach ${provider}: ${redact((error as Error).message, key)}`);
    }
    if (res.status < 300 || res.status >= 400 || res.status === 304) return res;
    const location = res.headers.get("location");
    await res.body?.cancel().catch(() => {});
    if (!location) throw new Error(`${provider} redirected the download without saying where.`);
    if (hop + 1 > MAX_REDIRECTS) throw new Error(`${provider}'s download redirected more than ${MAX_REDIRECTS} times.`);
    url = new URL(location, url);
  }
}

async function jsonOf(provider: string, res: Response): Promise<unknown> {
  const length = Number(res.headers.get("content-length") ?? 0);
  if (length > MAX_JSON_BYTES) throw new Error(`${provider}'s reply is too large.`);
  const text = await res.text();
  if (text.length > MAX_JSON_BYTES) throw new Error(`${provider}'s reply is too large.`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${provider} answered with something that isn't JSON.`);
  }
}

/** Streams a reply body to `path` (at most MAX_FILE_BYTES); removes the part on failure. */
async function download(provider: string, res: Response, path: string, signal: AbortSignal) {
  if (!res.body) throw new Error(`${provider} sent an empty file.`);
  let bytes = 0;
  const limit = new Transform({
    transform(chunk: Buffer, _enc, done) {
      bytes += chunk.length;
      done(bytes > MAX_FILE_BYTES ? new Error(`${provider}'s file is over 1 GB.`) : null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(res.body as import("node:stream/web").ReadableStream), limit, createWriteStream(path, { flags: "wx" }), { signal });
  } catch (error) {
    await rm(path, { force: true });
    throw error;
  }
  if (bytes === 0) {
    await rm(path, { force: true });
    throw new Error(`${provider} sent an empty file.`);
  }
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason ?? new Error("cancelled"));
    const timer = setTimeout(() => (signal.removeEventListener("abort", onAbort), resolve()), ms);
    const onAbort = () => (clearTimeout(timer), reject(signal.reason ?? new Error("cancelled")));
    signal.addEventListener("abort", onAbort, { once: true });
  });

// ---- OpenAI: GPT Image ----

/**
 * POST {base}/v1/images/generations, Authorization: Bearer <key>, JSON {model, prompt, size,
 * quality, n} → { data: [{ b64_json }], usage?: { input_tokens, output_tokens } }. gpt-image-2 is
 * billed by tokens ($5 / 1M text in, $30 / 1M image out); the estimate uses gpt-image-1's published
 * output tokens per picture (medium: 1056 at 1024², 1584 at 1536×1024), the reply's usage replaces it.
 */
const OPENAI_MODEL = "gpt-image-2";
const OPENAI_SIZES = ["1536x1024", "1024x1024", "1024x1536"];
const OPENAI_TOKENS: Record<string, number> = { "1024x1024": 1056, "1536x1024": 1584, "1024x1536": 1584 };
const OPENAI_OUT_PER_TOKEN = 30 / 1e6;
const OPENAI_IN_PER_TOKEN = 5 / 1e6;

export const gptImage: KeyedGenerator = {
  id: "generate.gpt-image",
  name: "GPT Image",
  provider: "openai",
  model: OPENAI_MODEL,
  kinds: ["image"],
  sizes: OPENAI_SIZES,
  billing: "Billed to your OpenAI key, about $0.03 to $0.05 a picture",
  check: (input) => (input.kind !== "image" ? "GPT Image makes stills only (kind image)." : input.size && !OPENAI_SIZES.includes(input.size) ? `size must be one of ${OPENAI_SIZES.join(", ")}.` : undefined),
  estimate: (input) => Number(((OPENAI_TOKENS[input.size ?? OPENAI_SIZES[0]!] ?? 1584) * OPENAI_OUT_PER_TOKEN + (input.prompt.length / 4) * OPENAI_IN_PER_TOKEN).toFixed(3)),
  async generate(input, ctx) {
    const size = input.size ?? OPENAI_SIZES[0]!;
    ctx.status("Asking GPT Image…");
    const res = await send(
      "OpenAI",
      `${base("UNCUT_OPENAI_BASE", "https://api.openai.com")}/v1/images/generations`,
      { method: "POST", headers: { authorization: `Bearer ${ctx.key}`, "content-type": "application/json" }, body: JSON.stringify({ model: OPENAI_MODEL, prompt: input.prompt, size, quality: "medium", n: 1 }), signal: ctx.signal },
      ctx.key,
      ctx.sent,
    );
    if (!res.ok) throw await replyError("OpenAI", res, ctx.key);
    const body = (await jsonOf("OpenAI", res)) as { data?: Array<{ b64_json?: unknown }>; usage?: { input_tokens?: unknown; output_tokens?: unknown } };
    const b64 = body.data?.[0]?.b64_json;
    if (typeof b64 !== "string" || !b64) throw new Error("OpenAI's reply has no picture in it.");
    const png = Buffer.from(b64, "base64");
    if (png.length < 8) throw new Error("OpenAI's picture is empty.");
    const path = `${ctx.outBase}.png`;
    await writeFile(path, png, { flag: "wx" });
    const out = Number(body.usage?.output_tokens);
    const inTokens = Number(body.usage?.input_tokens);
    const cost = Number.isFinite(out) && out > 0 ? out * OPENAI_OUT_PER_TOKEN + (Number.isFinite(inTokens) ? inTokens * OPENAI_IN_PER_TOKEN : 0) : gptImage.estimate(input);
    return { path, model: OPENAI_MODEL, cost: Number(cost.toFixed(3)) };
  },
};

// ---- Google: Veo (Gemini API) ----

/**
 * POST {base}/v1beta/models/<model>:predictLongRunning, x-goog-api-key: <key>, JSON
 * {instances: [{prompt}], parameters: {aspectRatio, durationSeconds, resolution}} → an operation
 * {name}; GET {base}/v1beta/<name> until done; the video is at
 * response.generateVideoResponse.generatedSamples[0].video.uri, downloaded with the same header
 * (only when it's on the API's own host; redirects are followed). Veo 3.1 costs $0.40 a second
 * (with sound, 720p), billed only when a video is made.
 */
const VEO_MODEL = "veo-3.1-generate-preview";
const VEO_PER_SECOND = 0.4;
const VEO_SECONDS = [4, 6, 8];
const VEO_SIZES = ["16:9", "9:16"];
const VEO_TIMEOUT_MS = 10 * 60 * 1000;

export const veo: KeyedGenerator = {
  id: "generate.veo",
  name: "Veo",
  provider: "google",
  model: VEO_MODEL,
  kinds: ["video"],
  sizes: VEO_SIZES,
  seconds: VEO_SECONDS,
  billing: "Billed to your Google key, $0.40 a second of video",
  check: (input) =>
    input.kind !== "video"
      ? "Veo makes video only (kind video)."
      : input.size && !VEO_SIZES.includes(input.size)
        ? `size must be ${VEO_SIZES.join(" or ")} (an aspect ratio).`
        : input.seconds !== undefined && !VEO_SECONDS.includes(input.seconds)
          ? `seconds must be ${VEO_SECONDS.join(", ")}.`
          : undefined,
  estimate: (input) => Number(((input.seconds ?? VEO_SECONDS[0]!) * VEO_PER_SECOND).toFixed(2)),
  async generate(input, ctx) {
    const root = base("UNCUT_GOOGLE_BASE", "https://generativelanguage.googleapis.com");
    const headers = { "x-goog-api-key": ctx.key, "content-type": "application/json" };
    const seconds = input.seconds ?? VEO_SECONDS[0]!;
    ctx.status("Asking Veo…");
    const started = await send(
      "Google",
      `${root}/v1beta/models/${VEO_MODEL}:predictLongRunning`,
      { method: "POST", headers, body: JSON.stringify({ instances: [{ prompt: input.prompt }], parameters: { aspectRatio: input.size ?? VEO_SIZES[0], durationSeconds: seconds, resolution: "720p" } }), signal: ctx.signal },
      ctx.key,
      ctx.sent,
    );
    if (!started.ok) throw await replyError("Google", started, ctx.key);
    let op = (await jsonOf("Google", started)) as { name?: unknown; done?: unknown; error?: { message?: unknown }; response?: any };
    const name = op.name;
    if (typeof name !== "string" || !/^[A-Za-z0-9/_.-]+$/.test(name)) throw new Error("Google's reply has no operation to wait for.");
    const pollMs = overridesAllowed ? Math.max(10, Number(process.env.UNCUT_VEO_POLL_MS) || 10_000) : 10_000;
    const deadline = Date.now() + VEO_TIMEOUT_MS;
    const t0 = Date.now();
    while (op.done !== true) {
      ctx.status(`Veo is making the video… ${Math.round((Date.now() - t0) / 1000)} s`);
      if (Date.now() > deadline) throw new Error("Veo didn't finish in 10 minutes.");
      await sleep(pollMs, ctx.signal);
      const res = await send("Google", `${root}/v1beta/${name}`, { headers: { "x-goog-api-key": ctx.key }, signal: ctx.signal }, ctx.key);
      if (!res.ok) throw await replyError("Google", res, ctx.key);
      op = (await jsonOf("Google", res)) as typeof op;
    }
    if (op.error) throw new Error(`Veo couldn't make it: ${redact(String(op.error.message ?? "no reason given"), ctx.key).slice(0, 300)}`);
    const sample = op.response?.generateVideoResponse;
    const uri = sample?.generatedSamples?.[0]?.video?.uri;
    if (typeof uri !== "string") {
      const filtered = sample?.raiMediaFilteredReasons?.[0];
      throw new Error(typeof filtered === "string" ? `Veo didn't make it: ${filtered.slice(0, 300)}` : "Veo's reply has no video in it.");
    }
    let url: URL;
    try {
      url = new URL(uri);
    } catch {
      throw new Error("Veo's video link isn't a URL.");
    }
    ctx.status("Downloading the video…");
    const res = await followRedirects("Google", url, new URL(root).origin, { "x-goog-api-key": ctx.key }, ctx.signal, ctx.key);
    if (!res.ok) throw await replyError("Google", res, ctx.key);
    const path = `${ctx.outBase}.mp4`;
    await download("Google", res, path, ctx.signal);
    return { path, model: VEO_MODEL, cost: veo.estimate({ ...input, seconds }) };
  },
};

// ---- ElevenLabs: sound effects ----

/**
 * POST {base}/v1/sound-generation?output_format=mp3_44100_128, xi-api-key: <key>, JSON {text,
 * duration_seconds (0.5–30), model_id: eleven_text_to_sound_v2} → MP3 bytes. 40 credits a second
 * when the length is given (it always is here); about $0.01 a second at the Creator plan's credit
 * price (an estimate: the dollar price depends on the plan).
 */
const SOUND_MODEL = "eleven_text_to_sound_v2";
const SOUND_SECONDS = [2, 5, 10, 20, 30];
const SOUND_PER_SECOND = 0.01;

export const sound: KeyedGenerator = {
  id: "generate.sound",
  name: "Sound effects",
  provider: "elevenlabs",
  model: SOUND_MODEL,
  kinds: ["audio"],
  sizes: [],
  seconds: SOUND_SECONDS,
  billing: "Billed to your ElevenLabs credits, 40 a second (about $0.01)",
  check: (input) => (input.kind !== "audio" ? "Sound effects make audio only (kind audio)." : input.seconds !== undefined && !(input.seconds >= 0.5 && input.seconds <= 30) ? "seconds must be from 0.5 to 30." : undefined),
  estimate: (input) => Number(((input.seconds ?? 5) * SOUND_PER_SECOND).toFixed(3)),
  async generate(input, ctx) {
    const seconds = input.seconds ?? 5;
    ctx.status("Asking ElevenLabs…");
    const res = await send(
      "ElevenLabs",
      `${base("UNCUT_ELEVENLABS_BASE", "https://api.elevenlabs.io")}/v1/sound-generation?output_format=mp3_44100_128`,
      { method: "POST", headers: { "xi-api-key": ctx.key, "content-type": "application/json" }, body: JSON.stringify({ text: input.prompt, duration_seconds: seconds, model_id: SOUND_MODEL }), signal: ctx.signal },
      ctx.key,
      ctx.sent,
    );
    if (!res.ok) throw await replyError("ElevenLabs", res, ctx.key);
    const type = res.headers.get("content-type") ?? "";
    if (/json|text\//.test(type)) throw new Error("ElevenLabs answered with text instead of a sound.");
    const path = `${ctx.outBase}.mp3`;
    await download("ElevenLabs", res, path, ctx.signal);
    return { path, model: SOUND_MODEL, cost: sound.estimate({ ...input, seconds }) };
  },
};

export const KEYED: ReadonlyArray<KeyedGenerator> = [gptImage, veo, sound];
