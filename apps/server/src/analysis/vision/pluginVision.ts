import * as Effect from "effect/Effect";

import { which } from "../../app/setup.ts";
import type { PluginsShape } from "../../plugins/plugins.ts";
import { VisionAnalysis } from "./vision.ts";

/** The system's ffmpeg, once the login shell's PATH is known. */
export const shellFfmpeg = (config: { readonly shellReady: Promise<unknown> }) => async () => {
  await config.shellReady;
  return which("ffmpeg", process.env.PATH ?? "");
};

/** D325: vision through the installed analyzer plugins. */
export const pluginVision = (plugins: PluginsShape, config: { readonly shellReady: Promise<unknown> }) =>
  new VisionAnalysis({
    candidates: () => Effect.runPromise(plugins.analyzerPlugins),
    call: (id, tool, args, { signal, onProgress }) => Effect.runPromise(plugins.callPlugin(id, tool, args, { signal, onProgress })),
    ffmpeg: shellFfmpeg(config),
  });
