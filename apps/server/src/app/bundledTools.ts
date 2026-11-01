// The tools the packaged app ships in Resources/tools/bin (native/tools): ffmpeg, ffprobe and
// whisper-cli. bin.ts puts that folder first on PATH, so every lookup finds them; a server without
// it (Linux, a build from source) uses what's installed. UNCUT_TOOLS_DIR names another folder, and
// set empty turns the shipped tools off.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

import { packagedResources } from "./config.ts";

const toolsDir = (env: NodeJS.ProcessEnv) => {
  if (env.UNCUT_TOOLS_DIR !== undefined) return env.UNCUT_TOOLS_DIR;
  const resources = packagedResources();
  return resources && join(resources, "tools");
};

/** Where the shipped tools are; undefined when this server has none. */
export const bundledToolsBin = (env: NodeJS.ProcessEnv = process.env): string | undefined => {
  const dir = toolsDir(env);
  return dir && existsSync(join(dir, "bin/ffmpeg")) ? join(dir, "bin") : undefined;
};

export const isBundledTool = (path: string, env: NodeJS.ProcessEnv = process.env) => dirname(path) === bundledToolsBin(env);

/** PATH without the shipped tools: what's installed on this Mac. */
export const systemPath = (path: string, env: NodeJS.ProcessEnv = process.env) => {
  const bundled = bundledToolsBin(env);
  return path
    .split(":")
    .filter((dir) => dir !== bundled)
    .join(":");
};

/** PATH with an installed ffmpeg ahead of the shipped one, which has no libx264 or libx265. */
export const installedToolsFirst = (path: string, env: NodeJS.ProcessEnv = process.env) => {
  const bundled = bundledToolsBin(env);
  return bundled ? [...systemPath(path, env).split(":"), bundled].join(":") : path;
};
