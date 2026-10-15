// A plugin's shader effects (D213): its TypeGPU functions resolved to WGSL and compared with the
// WGSL its manifest carries (what Uncut draws), for `pnpm plugin:check` and the repo's gate test;
// `--write` puts the resolved WGSL in the manifest.
//
// The plugin's .ts file is imported in a child Node run with the permission model on: it may read
// the repo and the plugin's folder and nothing else (no writing, no child processes, no workers),
// it gets no environment, and it's killed after RESOLVE_MS. Run as a script, this file is that child:
//   node --permission --allow-fs-read=... scripts/plugin-shaders.ts <file.ts> <export>...
// and prints {"<export>": {"wgsl"} | {"problems"}} as one JSON line.
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { ShaderParam } from "../packages/core/src/index.ts";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const SELF = fileURLToPath(import.meta.url);
const RESOLVE_MS = 20_000;

type Resolved = Readonly<Record<string, { readonly wgsl: string } | { readonly problems: ReadonlyArray<string> }>>;
type ShaderEntry = { readonly id: string; readonly source: string; readonly export: string; readonly params: ReadonlyArray<ShaderParam>; readonly wgsl: string };

/** The child's side: import the file, resolve each export with its params. */
async function child(file: string, wanted: ReadonlyArray<{ readonly export: string; readonly params: ReadonlyArray<ShaderParam> }>) {
  const { resolveShaderFn } = await import("../apps/server/src/plugins/shaderBuild.ts");
  // The plugin's files may import TypeGPU (Uncut's copy, wherever the plugin is) and its own
  // .ts files next to it; nothing else.
  const here = pathToFileURL(`${dirname(file)}/`).href;
  const fromRepo = createRequire(join(REPO, "package.json"));
  registerHooks({
    resolve(specifier, context, next) {
      if (!context.parentURL?.startsWith(here)) return next(specifier, context);
      if (/^typegpu(\/(data|std))?$/.test(specifier)) return { url: pathToFileURL(fromRepo.resolve(specifier)).href, shortCircuit: true };
      if (/^\.\/[^/]+\.ts$/.test(specifier)) return next(specifier, context);
      throw new Error(`a shader source imports only typegpu, typegpu/data, typegpu/std and its own ./files.ts, not ${specifier}`);
    },
  });
  const out: Record<string, unknown> = {};
  let mod: Record<string, unknown>;
  try {
    mod = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
  } catch (error) {
    for (const w of wanted) out[w.export] = { problems: [`importing it failed: ${(error as Error).message.split("\n")[0]}`] };
    process.stdout.write(`${JSON.stringify(out)}\n`);
    return;
  }
  for (const w of wanted) {
    if (!(w.export in mod)) out[w.export] = { problems: [`it doesn't export ${w.export}`] };
    else out[w.export] = resolveShaderFn(mod[w.export], w.params);
  }
  process.stdout.write(`${JSON.stringify(out)}\n`);
}

/** Resolve a source file's exports in the locked-down child; a failure of the child is a problem for each. */
export function resolveSource(dir: string, source: string, wanted: ReadonlyArray<{ readonly export: string; readonly params: ReadonlyArray<ShaderParam> }>): Resolved {
  // Real paths: the permission model compares them after symlinks (macOS's /var is /private/var).
  let real: string;
  try {
    real = realpathSync(dir);
  } catch {
    real = resolve(dir);
  }
  const file = join(real, source);
  const failAll = (why: string): Resolved => Object.fromEntries(wanted.map((w) => [w.export, { problems: [why] }]));
  try {
    const stdout = execFileSync(process.execPath, ["--permission", `--allow-fs-read=${realpathSync(REPO)}`, `--allow-fs-read=${real}`, SELF, "--child", file, JSON.stringify(wanted)], { encoding: "utf8", timeout: RESOLVE_MS, env: {}, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 8 << 20 });
    const line = stdout.trim().split("\n").at(-1) ?? "";
    return JSON.parse(line) as Resolved;
  } catch (error) {
    const e = error as { signal?: string; stderr?: string; message: string };
    if (e.signal === "SIGTERM") return failAll(`resolving ${source} took longer than ${RESOLVE_MS / 1000} s`);
    const said = (e.stderr ?? "").trim().split("\n").filter((l) => /Error|error/.test(l)).at(0) ?? e.message.split("\n")[0]!;
    return failAll(`resolving ${source} failed: ${said.trim()}`);
  }
}

/** The shader entries of a manifest (none when it has none or isn't JSON). */
export function shaderEntries(manifest: unknown): ReadonlyArray<ShaderEntry> {
  const list = (manifest as { contributes?: { shaders?: unknown } } | undefined)?.contributes?.shaders;
  return Array.isArray(list) ? (list as ReadonlyArray<ShaderEntry>) : [];
}

/**
 * The problems with a plugin's shader effects (one sentence each), resolving each source once.
 * `write`: put the resolved WGSL in the manifest where it differs (then only real problems remain).
 */
export function checkPluginShaders(dir: string, { write = false, where = dir }: { readonly write?: boolean; readonly where?: string } = {}): Array<string> {
  const manifestFile = join(dir, "uncut.module.json");
  let text: string;
  let manifest: unknown;
  try {
    text = readFileSync(manifestFile, "utf8");
    manifest = JSON.parse(text);
  } catch {
    return [];
  }
  const entries = shaderEntries(manifest);
  if (!entries.length) return [];
  const problems: Array<string> = [];
  const bySource = new Map<string, Array<ShaderEntry>>();
  for (const e of entries) {
    if (typeof e.source !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]*\.ts$/.test(e.source)) continue; // the schema says so
    bySource.set(e.source, [...(bySource.get(e.source) ?? []), e]);
  }
  const resolved = new Map<ShaderEntry, string>();
  for (const [source, list] of bySource) {
    const answers = resolveSource(dir, source, list.map((e) => ({ export: e.export, params: e.params })));
    for (const e of list) {
      const a = answers[e.export];
      if (!a) problems.push(`${where}: the shader effect ${e.id}: ${source} gave no answer for ${e.export}.`);
      else if ("problems" in a) for (const p of a.problems) problems.push(`${where}: the shader effect ${e.id} (${source}, ${e.export}): ${p.replace(/\.$/, "")}.`);
      else resolved.set(e, a.wgsl);
    }
  }
  let out = text!;
  let changed = false;
  // The k-th "wgsl" string in the file is the k-th entry's (only shader entries have one).
  let k = 0;
  out = out.replace(/"wgsl"\s*:\s*"(?:[^"\\]|\\.)*"/g, (m) => {
    const e = entries[k++];
    const wgsl = e ? resolved.get(e) : undefined;
    if (wgsl === undefined || wgsl === e!.wgsl) return m;
    if (!write) {
      problems.push(`${where}: the shader effect ${e!.id}'s wgsl isn't what ${e!.source} (${e!.export}) resolves to: run pnpm plugin:check --write ${where}.`);
      return m;
    }
    changed = true;
    return `"wgsl": ${JSON.stringify(wgsl)}`;
  });
  if (changed) writeFileSync(manifestFile, out);
  return problems;
}

if (process.argv[1] === SELF && process.argv[2] === "--child") await child(process.argv[3]!, JSON.parse(process.argv[4]!));
