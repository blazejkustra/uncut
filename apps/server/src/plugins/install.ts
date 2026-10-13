// Installing a plugin (D102): from a folder on this Mac or a git URL, into <dataDir>/plugins/<id>.
//
// A git source is cloned shallowly (`git clone --depth 1`) into a temp folder, with a clean
// environment: no system or global git config, no terminal prompts, only the file, https, ssh and
// git protocols. The plugin's manifest is checked like discovery checks it (checkManifest), then
// every file is checked before anything is copied: no symlink that leads out of the folder or is
// absolute, no special files, at most MAX_INSTALL_BYTES and MAX_INSTALL_FILES. The copy goes to a
// dot-folder first (discovery skips those) and is renamed into place, so a half copy is never
// scanned. Installing never allows a plugin: the user does that afterwards (D97).
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rename, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import type { ModuleManifest } from "@uncut/core";

import { checkManifest, MANIFEST_FILE } from "./plugins.ts";

export const MAX_INSTALL_BYTES = 50 * 1024 * 1024;
export const MAX_INSTALL_FILES = 5000;
export const GIT_TIMEOUT_MS = 120_000;
/** A clone bigger than this is stopped (the plugin itself is capped at MAX_INSTALL_BYTES after). */
export const MAX_CLONE_BYTES = 200 * 1024 * 1024;
const CLONE_POLL_MS = 250;
/** The protocols git may use for an install (GIT_ALLOW_PROTOCOL): never ext:: or fd::. */
export const GIT_PROTOCOLS = "file:https:ssh:git";

/** A refusal or failure, in one sentence. `reason` "replaces-bundled": allowed when asked for on purpose. */
export class InstallError extends Error {
  readonly reason: "invalid" | "replaces-bundled" | "io";
  constructor(reason: InstallError["reason"], message: string) {
    super(message);
    this.reason = reason;
  }
}

export type InstallSource = { readonly kind: "folder"; readonly path: string } | { readonly kind: "git"; readonly url: string };

const GIT_URL = /^(https|ssh|git|file):\/\/\S+$/i;
const SCP_URL = /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[^\s-]\S*$/;
const REF = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;

/** A folder's full path or a git URL (https://, ssh://, git://, file:// or user@host:path). */
export function parseSource(raw: string): InstallSource {
  const source = raw.trim();
  if (!source) throw new InstallError("invalid", "Choose a folder or paste a git URL.");
  if (GIT_URL.test(source) || SCP_URL.test(source)) return { kind: "git", url: source };
  if (/^[a-z][a-z0-9+.-]*:/i.test(source) && !source.startsWith("/")) {
    throw new InstallError("invalid", `Uncut installs plugins from a folder or a git URL starting with https://, ssh://, git:// or file://, not ${source.split(":")[0]}.`);
  }
  if (!isAbsolute(source)) throw new InstallError("invalid", "Give the folder's full path (starting with /) or a git URL.");
  return { kind: "folder", path: resolve(source) };
}

/** A branch or tag name for `git clone --branch`. */
export function checkRef(ref: string | undefined): string | undefined {
  const r = ref?.trim();
  if (!r) return undefined;
  if (!REF.test(r) || r.includes("..") || r.endsWith("/") || r.endsWith(".lock")) throw new InstallError("invalid", `"${r.slice(0, 80)}" isn't a branch or tag name.`);
  return r;
}

/** git's environment for an install: the basics and nothing of the user's git setup. */
export function gitEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return {
    PATH: env.PATH ?? "/usr/bin:/bin",
    HOME: env.HOME ?? tmpdir(),
    ...(env.SSH_AUTH_SOCK ? { SSH_AUTH_SOCK: env.SSH_AUTH_SOCK } : {}),
    LANG: "C",
    LC_ALL: "C",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_ALLOW_PROTOCOL: GIT_PROTOCOLS,
    GIT_SSH_COMMAND: "ssh -o BatchMode=yes",
  };
}

/** Bytes under `dir` (0 if it isn't there yet); files that vanish meanwhile are skipped. */
export async function folderBytes(dir: string): Promise<number> {
  let total = 0;
  const walk = async (d: string) => {
    let names: Array<string>;
    try {
      names = await readdir(d);
    } catch {
      return;
    }
    for (const name of names) {
      try {
        const info = await lstat(join(d, name));
        if (info.isDirectory()) await walk(join(d, name));
        else total += info.size;
      } catch {}
    }
  };
  await walk(dir);
  return total;
}

class TooBig extends Error {}

/**
 * Runs git (its own process group, killed on timeout, or when `watch.dir` grows past
 * `watch.maxBytes`); resolves stdout, rejects with git's last line.
 */
function runGit(git: string, args: ReadonlyArray<string>, options: { cwd?: string; timeoutMs?: number; watch?: { dir: string; maxBytes: number } } = {}): Promise<string> {
  return new Promise((done, fail) => {
    const child = spawn(git, [...args], { cwd: options.cwd ?? tmpdir(), env: gitEnv(), stdio: ["ignore", "pipe", "pipe"], detached: true });
    let out = "";
    let err = "";
    child.stdout.setEncoding("utf8").on("data", (c: string) => (out = (out + c).slice(-100_000)));
    child.stderr.setEncoding("utf8").on("data", (c: string) => (err = (err + c).slice(-8000)));
    let timedOut = false;
    let tooBig = false;
    const kill = () => {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {}
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, options.timeoutMs ?? GIT_TIMEOUT_MS);
    // The clone's size, polled: a huge repository is stopped, not downloaded to the end.
    let polling = false;
    const poll = options.watch
      ? setInterval(() => {
          if (polling) return;
          polling = true;
          void folderBytes(options.watch!.dir).then((bytes) => {
            polling = false;
            if (bytes > options.watch!.maxBytes) {
              tooBig = true;
              kill();
            }
          });
        }, CLONE_POLL_MS)
      : undefined;
    child.once("error", (error) => (clearTimeout(timer), clearInterval(poll), fail(error)));
    child.once("close", (code) => {
      clearTimeout(timer);
      clearInterval(poll);
      if (tooBig) return fail(new TooBig());
      if (code === 0) return done(out);
      const last = err.trim().split("\n").filter((l) => !/^warning:/i.test(l)).at(-1)?.replace(/^fatal:\s*/i, "") ?? "";
      fail(new Error(timedOut ? `it took longer than ${Math.round((options.timeoutMs ?? GIT_TIMEOUT_MS) / 1000)} s` : last || `git exited with code ${code}`));
    });
  });
}

/** A shallow clone of `url` (at `ref`) into `dest`, at most `maxBytes` on disk; returns the commit. */
export async function gitClone(git: string, url: string, ref: string | undefined, dest: string, timeoutMs?: number, maxBytes = MAX_CLONE_BYTES): Promise<string> {
  const tooBig = new InstallError("invalid", `That repository is bigger than ${Math.round(maxBytes / 1024 / 1024)} MB, so Uncut stopped cloning it.`);
  try {
    await runGit(git, ["clone", "--depth", "1", "--single-branch", "--no-tags", ...(ref ? ["--branch", ref] : []), "--", url, dest], { timeoutMs, watch: { dir: dest, maxBytes } });
  } catch (error) {
    if (error instanceof TooBig) throw tooBig;
    throw new InstallError("io", `Couldn't clone ${url}${ref ? ` at ${ref}` : ""}: ${(error as Error).message}.`);
  }
  // A clone faster than one poll is measured once at the end.
  if ((await folderBytes(dest)) > maxBytes) throw tooBig;
  return (await runGit(git, ["rev-parse", "HEAD"], { cwd: dest })).trim();
}

const isInside = (dir: string, file: string) => {
  const rel = relative(dir, file);
  return rel !== "" && rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel);
};

interface Entry {
  readonly rel: string;
  readonly type: "dir" | "file" | "link";
  readonly mode: number;
  readonly target?: string;
}

/**
 * Every file under `root` (without .git folders), checked: a symlink must be relative and lead to
 * something inside the folder; no sockets, pipes or devices; size and count capped.
 */
export async function checkFiles(root: string, limits = { bytes: MAX_INSTALL_BYTES, files: MAX_INSTALL_FILES }): Promise<ReadonlyArray<Entry>> {
  const realRoot = await realpath(root);
  const entries: Array<Entry> = [];
  let bytes = 0;
  const walk = async (rel: string) => {
    for (const name of (await readdir(join(realRoot, rel))).sort()) {
      if (name === ".git") continue;
      const path = rel ? join(rel, name) : name;
      const full = join(realRoot, path);
      const info = await lstat(full);
      if (entries.length >= limits.files) throw new InstallError("invalid", `It has more than ${limits.files} files; Uncut installs plugins up to that many.`);
      if (info.isSymbolicLink()) {
        const target = await readlink(full);
        let real: string | undefined;
        try {
          real = await realpath(full);
        } catch {}
        if (isAbsolute(target) || !real || !(real === realRoot || isInside(realRoot, real))) {
          throw new InstallError("invalid", `Its ${path} is a link to something outside the plugin's folder, so Uncut won't install it.`);
        }
        entries.push({ rel: path, type: "link", mode: 0, target });
      } else if (info.isDirectory()) {
        entries.push({ rel: path, type: "dir", mode: info.mode & 0o777 });
        await walk(path);
      } else if (info.isFile()) {
        bytes += info.size;
        if (bytes > limits.bytes) throw new InstallError("invalid", `It's bigger than ${Math.round(limits.bytes / 1024 / 1024)} MB; Uncut installs plugins up to that size.`);
        entries.push({ rel: path, type: "file", mode: info.mode & 0o777 });
      } else {
        throw new InstallError("invalid", `Its ${path} isn't a regular file or folder (a socket, pipe or device), so Uncut won't install it.`);
      }
    }
  };
  await walk("");
  return entries;
}

async function copyEntries(from: string, to: string, entries: ReadonlyArray<Entry>) {
  const src = await realpath(from);
  await mkdir(to, { recursive: true });
  for (const e of entries) {
    const dest = join(to, e.rel);
    if (e.type === "dir") await mkdir(dest, { recursive: true, mode: e.mode | 0o700 });
    else if (e.type === "link") await symlink(e.target!, dest);
    else {
      await copyFile(join(src, e.rel), dest);
      await chmod(dest, (e.mode | 0o600) & 0o755);
    }
  }
}

export interface Installed {
  readonly id: string;
  readonly name: string;
  readonly dir: string;
  readonly kind: "folder" | "git";
  readonly source: string;
  readonly ref?: string;
  readonly commit?: string;
}

export interface InstallContext {
  /** <dataDir>/plugins. */
  readonly pluginsRoot: string;
  /** Built-in module ids: never taken. */
  readonly builtinIds: ReadonlySet<string>;
  /** Plugins that ship with Uncut, by id (taken only with replaceBundled). */
  readonly bundled: ReadonlyMap<string, string>;
  /** git, when a git source needs it. */
  readonly git: () => Promise<string | undefined>;
  /**
   * Runs after every check, with the new copy staged, right before it replaces `<id>`: the host
   * stops the plugin and removes its approval here (D97), so new code never runs under the old
   * approval. Throwing aborts the install (nothing is replaced).
   */
  readonly beforeSwap?: (id: string) => Promise<void>;
  /** The clone cap (tests). */
  readonly maxCloneBytes?: number;
}

/** Installs a plugin folder (copied) or git repository (cloned, then copied). Throws InstallError. */
export async function installPlugin(input: { readonly source: string; readonly ref?: string | undefined; readonly replaceBundled?: boolean | undefined }, ctx: InstallContext): Promise<Installed> {
  const source = parseSource(input.source);
  const ref = checkRef(input.ref);
  if (ref && source.kind === "folder") throw new InstallError("invalid", "A branch or tag only goes with a git URL.");
  let temp: string | undefined;
  try {
    let from: string;
    let commit: string | undefined;
    if (source.kind === "git") {
      const git = await ctx.git();
      if (!git) throw new InstallError("invalid", "Installing from a git URL needs git, which isn't installed (xcode-select --install installs it).");
      temp = await mkdtemp(join(tmpdir(), "uncut-plugin-"));
      from = join(temp, "clone");
      commit = await gitClone(git, source.url, ref, from, undefined, ctx.maxCloneBytes);
      await rm(join(from, ".git"), { recursive: true, force: true });
    } else {
      try {
        from = await realpath(source.path);
        if (!(await stat(from)).isDirectory()) throw new Error("not a folder");
      } catch {
        throw new InstallError("invalid", `There's no folder at ${source.path}.`);
      }
      await mkdir(ctx.pluginsRoot, { recursive: true });
      const root = await realpath(ctx.pluginsRoot);
      if (from === root || isInside(root, from)) throw new InstallError("invalid", "That folder is already in Uncut's plugins folder.");
    }
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(join(from, MANIFEST_FILE), "utf8"));
    } catch (error) {
      throw new InstallError("invalid", (error as NodeJS.ErrnoException).code === "ENOENT" ? `There's no ${MANIFEST_FILE} at the top of ${source.kind === "git" ? "that repository" : "that folder"}, so it isn't an Uncut plugin.` : `Its ${MANIFEST_FILE} isn't valid JSON.`);
    }
    const checked = checkManifest(raw, ctx.builtinIds);
    if ("problem" in checked) throw new InstallError("invalid", checked.problem);
    const manifest: ModuleManifest = checked.manifest;
    const bundledName = ctx.bundled.get(manifest.id);
    if (bundledName !== undefined && !input.replaceBundled) {
      throw new InstallError("replaces-bundled", `${manifest.name} has the id ${manifest.id}, like ${bundledName}, which ships with Uncut. Installing it replaces that one until you remove it.`);
    }
    const entries = await checkFiles(from);
    await mkdir(ctx.pluginsRoot, { recursive: true });
    const dest = join(ctx.pluginsRoot, manifest.id);
    const staging = join(ctx.pluginsRoot, `.install-${randomBytes(6).toString("hex")}`);
    const old = join(ctx.pluginsRoot, `.old-${randomBytes(6).toString("hex")}`);
    let moved = false;
    try {
      await copyEntries(from, staging, entries);
      try {
        await ctx.beforeSwap?.(manifest.id);
      } catch (error) {
        throw new InstallError("io", `${manifest.name} wasn't installed: ${(error as Error).message}`);
      }
      try {
        await rename(dest, old);
        moved = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      try {
        await renameStaging(staging, dest);
      } catch (error) {
        // Put the old copy back.
        if (moved) await rename(old, dest).catch(() => {});
        moved = false;
        throw error;
      }
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      if (error instanceof InstallError) throw error;
      throw new InstallError("io", `Couldn't copy it into ${ctx.pluginsRoot}: ${(error as Error).message}.`);
    }
    // The old copy is gone from sight; failing to delete it is only litter (swept at startup).
    if (moved) await rm(old, { recursive: true, force: true }).catch(() => {});
    return {
      id: manifest.id,
      name: manifest.name,
      dir: await realpath(dest),
      kind: source.kind,
      source: source.kind === "git" ? source.url : source.path,
      ...(ref ? { ref } : {}),
      ...(commit ? { commit } : {}),
    };
  } finally {
    if (temp) await rm(temp, { recursive: true, force: true });
  }
}

/** The swap's last step (a seam for the rollback test). */
export const swapHooks = { rename: (from: string, to: string) => rename(from, to) };
const renameStaging = (from: string, to: string) => swapHooks.rename(from, to);

/** Removes what an interrupted install or removal left in <dataDir>/plugins (.install-*, .old-*, .remove-*). */
export async function sweepLeftovers(pluginsRoot: string): Promise<ReadonlyArray<string>> {
  let names: Array<string>;
  try {
    names = await readdir(pluginsRoot);
  } catch {
    return [];
  }
  const litter = names.filter((n) => /^\.(install|old|remove)-[0-9a-f]+$/.test(n));
  await Promise.all(litter.map((n) => rm(join(pluginsRoot, n), { recursive: true, force: true }).catch(() => {})));
  return litter;
}

/** Whether `dir` is a plugin folder Uncut may remove: directly inside <dataDir>/plugins. */
export async function isRemovable(pluginsRoot: string, dir: string): Promise<boolean> {
  try {
    const [root, real] = await Promise.all([realpath(pluginsRoot), realpath(dir)]);
    return dirname(real) === root;
  } catch {
    return false;
  }
}

/** Removes an installed plugin's folder (only one directly inside <dataDir>/plugins). */
export async function removePluginFolder(pluginsRoot: string, dir: string): Promise<void> {
  if (!(await isRemovable(pluginsRoot, dir))) throw new InstallError("invalid", "Uncut only removes plugins in its own plugins folder.");
  const real = await realpath(dir);
  // Out of sight first (discovery skips dot-folders), then gone.
  const trash = join(dirname(real), `.remove-${randomBytes(6).toString("hex")}`);
  await rename(real, trash);
  await rm(trash, { recursive: true, force: true });
}
