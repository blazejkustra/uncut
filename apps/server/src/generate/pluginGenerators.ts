// Plugin generators (#107, #108): a generator plugin (kind "generator", its manifest's
// `generators`) adds models to the Generate tab and generate_media, each as generate.<id>. Uncut
// keeps the key: it calls the plugin's tool with a grant in _meta (uncut/grant), and the plugin
// sends its HTTP requests through Uncut (uncut/fetch), which adds the user's key for the
// generator's provider, only to that provider's own API (PROVIDER_API), and saves the result file
// into the generation's reserved name (never anywhere else; at most one file a call). The key never
// reaches the plugin's process: not its environment (pluginEnv), its arguments or a reply (redacted).
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";

import type { GenerateKind, GenerateOptions, GeneratorChoice, GeneratorOption, GeneratorPrice, KeyProvider } from "@uncut/contracts";

import { download, guardedFetch, keySafe, PROVIDER_API, providerBase, redact } from "./providers.ts";

/** One of a plugin's generators, from its manifest. */
export interface PluginGenerator {
  /** generate.<its id>: what the Generate tab, generate_media and the media's source.module say. */
  readonly id: string;
  /** Its id in the manifest (elevenlabs.voiceover): what the plugin's tool gets as `generator`. */
  readonly local: string;
  readonly plugin: { readonly id: string; readonly name: string };
  readonly name: string;
  readonly media: GenerateKind;
  readonly provider: KeyProvider;
  readonly model: string | undefined;
  readonly billing: string;
  readonly tool: string;
  readonly promptLabel: string | undefined;
  readonly placeholder: string | undefined;
  readonly maxPrompt: number;
  readonly seconds: ReadonlyArray<number> | undefined;
  readonly options: ReadonlyArray<GeneratorOption>;
  readonly price: GeneratorPrice;
}

/** What a generator plugin needs to be allowed (the user approves these on install). */
export const GENERATOR_CAPABILITIES = ["network", "api-key"];
const DEFAULT_PROMPT = 4000;

/**
 * The generators of the allowed generator plugins, in order; one whose id is taken (a built-in
 * generator's or an earlier plugin's) or whose plugin lacks network and api-key is left out, with
 * a line in `skipped`.
 */
export function pluginGeneratorsOf(
  plugins: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly capabilities: ReadonlyArray<string>;
    readonly manifest: Record<string, unknown>;
  }>,
  taken: ReadonlySet<string>,
) {
  const out: Array<PluginGenerator> = [];
  const skipped: Array<string> = [];
  const seen = new Set(taken);
  for (const p of plugins) {
    const declared = (Array.isArray(p.manifest.generators) ? p.manifest.generators : []) as ReadonlyArray<Record<string, any>>;
    if (!declared.length) continue;
    const missing = GENERATOR_CAPABILITIES.filter((c) => !p.capabilities.includes(c));
    if (missing.length) {
      skipped.push(`${p.name}'s generators need the ${missing.join(" and ")} capabilit${missing.length > 1 ? "ies" : "y"}.`);
      continue;
    }
    for (const g of declared) {
      const id = `generate.${g.id}`;
      if (seen.has(id) || !PROVIDER_API[g.provider as KeyProvider]) {
        skipped.push(
          seen.has(id)
            ? `${p.name}'s generator ${g.id} is left out: another generator has that id.`
            : `${p.name}'s generator ${g.id} is left out: Uncut doesn't keep keys for ${g.provider}.`,
        );
        continue;
      }
      seen.add(id);
      out.push({
        id,
        local: g.id,
        plugin: { id: p.id, name: p.name },
        name: g.name,
        media: g.media,
        provider: g.provider,
        model: g.model,
        billing: g.billing,
        tool: g.tool ?? "generate",
        promptLabel: g.promptLabel,
        placeholder: g.placeholder,
        maxPrompt: g.maxPrompt ?? DEFAULT_PROMPT,
        seconds: Array.isArray(g.seconds) && g.seconds.length ? g.seconds : undefined,
        options: (g.options ?? []) as ReadonlyArray<GeneratorOption>,
        price: g.price,
      });
    }
  }
  return { generators: out, skipped };
}

/** The option values a request asked for, checked against the generator's options and completed with their defaults; or why not, in a sentence. */
export function checkOptions(g: PluginGenerator, raw: unknown): GenerateOptions | string {
  if (raw !== undefined && (raw === null || typeof raw !== "object" || Array.isArray(raw))) return "options must be an object of option values.";
  const given = (raw ?? {}) as Record<string, unknown>;
  const ids = g.options.map((o) => o.id);
  const unknown = Object.keys(given).filter((k) => !ids.includes(k));
  if (unknown.length) return ids.length ? `${g.name} has no option ${unknown[0]}; its options are ${ids.join(", ")}.` : `${g.name} takes no options.`;
  const out: Record<string, string | boolean> = {};
  for (const o of g.options) {
    const v = given[o.id];
    if (o.type === "toggle") {
      if (v !== undefined && typeof v !== "boolean") return `${o.id} is true or false.`;
      out[o.id] = v ?? (typeof o.default === "boolean" ? o.default : false);
      continue;
    }
    if (v === undefined) {
      const fallback = typeof o.default === "string" ? o.default : o.dynamic ? undefined : o.choices?.[0]?.value;
      if (fallback !== undefined) out[o.id] = fallback;
      continue;
    }
    if (typeof v !== "string" || !v.trim()) return `${o.id} must be one of its values, as a string.`;
    const choices = o.choices ?? [];
    if (!o.dynamic) {
      if (!choices.some((c) => c.value === v)) return `${o.id} must be one of ${choices.map((c) => c.value).join(", ")}.`;
    } else if (v.length > 80 || /[\u0000-\u001f\u007f]/.test(v)) return `${o.id} is too long or has control characters.`;
    out[o.id] = v.trim();
  }
  return out;
}

/** A problem with the length asked for, or undefined: within the generator's lengths, none when it has none. */
export function checkSeconds(g: PluginGenerator, seconds: number | undefined): string | undefined {
  if (seconds === undefined) return undefined;
  if (!g.seconds) return `${g.name} takes no length (seconds).`;
  const min = Math.min(...g.seconds);
  const max = Math.max(...g.seconds);
  return seconds < min || seconds > max ? `seconds must be from ${min} to ${max}.` : undefined;
}

/** The estimate in US dollars: the price per unit (the `by` option's own when it has one) times the prompt's characters or the seconds. */
export function estimateOf(
  g: PluginGenerator,
  input: { readonly prompt: string; readonly seconds?: number | undefined; readonly options?: GenerateOptions | undefined },
) {
  const by = g.price.by;
  const value = by ? input.options?.[by.option] : undefined;
  const rate = by && typeof value === "string" && typeof by.usd[value] === "number" ? by.usd[value]! : g.price.usd;
  const units = g.price.unit === "character" ? input.prompt.length : (input.seconds ?? g.seconds?.[0] ?? 0);
  return Number((rate * units).toFixed(3));
}

// ---- grants and uncut/fetch ----

interface Grant {
  readonly pluginId: string;
  readonly provider: KeyProvider;
  readonly key: string;
  readonly signal: AbortSignal;
  /** Where a saved result goes, without its extension; none for a read-only call (choices). */
  readonly outBase?: string | undefined;
  /** Called right before the first request that may bill (anything but a GET). */
  readonly sent?: (() => void) | undefined;
  saved?: string;
}

const grants = new Map<string, Grant>();

/** A grant for one plugin call; `end` revokes it (the call is over) and gives back the file it saved, if any. */
export function openGrant(grant: Omit<Grant, "saved">) {
  const token = randomUUID();
  const g: Grant = { ...grant };
  grants.set(token, g);
  return { token, saved: () => g.saved, end: () => void grants.delete(token) };
}

/** The most a reply's text may be (a JSON body; audio with timestamps as base64). */
const MAX_TEXT = 12 * 1024 * 1024;
/** The most a request's body may be. */
const MAX_BODY = 1024 * 1024;
/** Headers a plugin may not set: credentials (Uncut adds the key), and what fetch sets itself. */
const DENY_HEADER = /^(authorization|cookie|host|content-length|connection|transfer-encoding|proxy-.*|x-goog-api-key|xi-api-key)$|key|token|secret|auth/i;

/** Answers a plugin's request (PluginHost.serveRequests): uncut/fetch only. */
export const servePluginRequest = (pluginId: string, method: string, params: unknown): Promise<unknown> | undefined =>
  method === "uncut/fetch" ? pluginFetch(pluginId, params) : undefined;

async function pluginFetch(pluginId: string, raw: unknown): Promise<unknown> {
  const p = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const g = typeof p.grant === "string" ? grants.get(p.grant) : undefined;
  if (!g || g.pluginId !== pluginId) throw new Error("This request has no grant from Uncut: only a generator's call may use uncut/fetch, until it ends.");
  if (g.signal.aborted) throw new Error("The generation was cancelled.");
  const api = PROVIDER_API[g.provider]!;
  const base = new URL(providerBase(api.env, api.fallback));
  let url: URL;
  try {
    url = new URL(String(p.url ?? ""), base);
  } catch {
    throw new Error("url isn't a URL.");
  }
  if (url.origin !== base.origin) throw new Error(`Uncut sends your ${api.name} key only to ${base.host}, not ${url.host}.`);
  if (!keySafe(url)) throw new Error(`${api.name}'s address isn't https, so your key wasn't sent.`);
  const method = p.method === undefined ? "GET" : p.method;
  if (method !== "GET" && method !== "POST" && method !== "DELETE") throw new Error("method is GET, POST or DELETE.");
  if (method !== "GET" && !g.outBase) throw new Error("This call may only read (GET), not make anything.");
  const headers: Record<string, string> = {};
  if (p.headers !== undefined) {
    if (!p.headers || typeof p.headers !== "object" || Array.isArray(p.headers)) throw new Error("headers must be an object of strings.");
    for (const [name, value] of Object.entries(p.headers as Record<string, unknown>)) {
      if (!/^[A-Za-z0-9-]{1,64}$/.test(name) || DENY_HEADER.test(name)) continue;
      if (typeof value !== "string" || value.length > 1000 || /[\r\n]/.test(value)) continue;
      headers[name.toLowerCase()] = value;
    }
  }
  Object.assign(headers, api.auth(g.key));
  let body: string | undefined;
  if (p.body !== undefined) {
    if (typeof p.body !== "string") throw new Error("body must be a string (JSON.stringify it).");
    if (method === "GET") throw new Error("A GET has no body.");
    if (Buffer.byteLength(p.body) > MAX_BODY) throw new Error("body is over 1 MB.");
    body = p.body;
  }
  let save: string | undefined;
  if (p.save !== undefined) {
    if (typeof p.save !== "string" || !/^[a-z0-9]{2,4}$/.test(p.save)) throw new Error("save is the file's extension, e.g. mp3.");
    if (!g.outBase) throw new Error("This call doesn't make a file, so nothing can be saved.");
    if (g.saved) throw new Error("This call saved its file already (one a call).");
    save = p.save;
  }
  if (method !== "GET") g.sent?.();
  let res: Response;
  try {
    res = await guardedFetch(url.href, { method, headers, ...(body !== undefined ? { body } : {}), redirect: "manual", signal: g.signal });
  } catch (error) {
    if (g.signal.aborted) throw new Error("The generation was cancelled.");
    throw new Error(`Couldn't reach ${api.name}: ${redact((error as Error).message, g.key)}`);
  }
  const contentType = res.headers.get("content-type") ?? "";
  if (save && res.ok && !/json|text\//.test(contentType)) {
    const path = `${g.outBase}.${save}`;
    // Taken before the download, so a second save can't race this one.
    g.saved = path;
    try {
      await download(api.name, res, path, g.signal);
    } catch (error) {
      g.saved = undefined;
      throw new Error(redact((error as Error).message, g.key));
    }
    const { size } = await stat(path);
    return { status: res.status, contentType, file: path, bytes: size };
  }
  const length = Number(res.headers.get("content-length") ?? 0);
  if (length > MAX_TEXT) {
    await res.body?.cancel().catch(() => {});
    throw new Error(`${api.name}'s reply is over 12 MB.`);
  }
  const text = await res.text();
  if (text.length > MAX_TEXT) throw new Error(`${api.name}'s reply is over 12 MB.`);
  return { status: res.status, contentType, text: redact(text, g.key) };
}

/** A plugin's choices reply ({choices: [{value, label}]}), checked: at most 200, short strings. */
export function choicesOf(structured: unknown): ReadonlyArray<GeneratorChoice> | undefined {
  const list = (structured as { choices?: unknown } | null | undefined)?.choices;
  if (!Array.isArray(list)) return undefined;
  return list
    .filter(
      (c): c is { value: string; label: string } =>
        !!c && typeof c.value === "string" && typeof c.label === "string" && c.value.length > 0 && c.value.length <= 80,
    )
    .slice(0, 200)
    .map((c) => ({ value: c.value, label: c.label.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 80) }));
}
