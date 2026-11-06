// The environment the checks run in, and what this Mac must have before they can prove anything.
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const factoryHome = () => resolve(process.env.UNCUT_FACTORY_HOME ?? join(homedir(), ".uncut-factory"));
export const verifyDir = () => join(factoryHome(), "verify");
export const goldensDir = () => join(factoryHome(), "goldens");

const DEFAULT_FOOTAGE_DIR = join(homedir(), "Documents/devrel/drone");
export const footageDir = () => process.env.UNCUT_FOOTAGE_DIR ?? DEFAULT_FOOTAGE_DIR;

/**
 * ELECTRON_RUN_AS_NODE, set in shells an Electron app opened, makes every packaged app exit at
 * start. The UNCUT_TEST_* overrides would let a capability check pass or stand down by decree.
 */
const STRIPPED = ["ELECTRON_RUN_AS_NODE", "UNCUT_TEST_GPU", "UNCUT_TEST_AUDIO", "UNCUT_TEST_VISIBLE"];

/** Every child process inherits the result. */
export function scrubEnvironment(env: NodeJS.ProcessEnv = process.env) {
  for (const name of STRIPPED) delete env[name];
  env.UNCUT_FOOTAGE_DIR = resolve(env.UNCUT_FOOTAGE_DIR ?? DEFAULT_FOOTAGE_DIR);
}

const firstLine = (cmd: string, args: ReadonlyArray<string>) => {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 20000 });
  return r.status === 0 ? (r.stdout.split("\n")[0] ?? "").trim() : undefined;
};

/** The first line of `ffmpeg -version`, on which frame hashes of an encode depend. */
export const ffmpegVersion = () => firstLine("ffmpeg", ["-version"]);

export interface Toolchain {
  readonly values: Readonly<Record<string, unknown>>;
  readonly missing: ReadonlyArray<string>;
}

export function toolchain(): Toolchain {
  const tools = {
    ffmpeg: ffmpegVersion(),
    ffprobe: firstLine("ffprobe", ["-version"]),
    pnpm: firstLine("pnpm", ["--version"]),
    cargo: firstLine("cargo", ["--version"]),
    git: firstLine("git", ["--version"]),
  };
  const missing = Object.entries(tools).flatMap(([name, version]) => (version ? [] : [`${name} is not installed`]));
  if (process.platform !== "darwin" || process.arch !== "arm64") missing.push(`needs an Apple silicon Mac, this is ${process.platform}-${process.arch}`);
  if (!process.versions.node.startsWith("24.")) missing.push(`needs Node 24, this is ${process.versions.node}`);
  return { values: { node: process.versions.node, ...tools }, missing };
}
