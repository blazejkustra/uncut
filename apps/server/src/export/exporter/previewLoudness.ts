// The preview's loudness target (D246): the export's own measuring passes (audio only, nothing
// written) on the open project, so the preview plays the gain the export would use. One at a time:
// a newer call aborts the one running.
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { Media, Project, SpeechEnvelope } from "@uncut/core";

import { graphFileArgs, loudnessGain, planExport } from "../exportPlan.ts";
import { capsOf, run, ffmpegError, Cancelled } from "./ffmpeg.ts";
import { makeTemp } from "./files.ts";

export function makePreviewLoudness() {
  let running: AbortController | undefined;
  return async (bin: string, project: Project, mediaPath: (m: Media) => string, envelopes: ReadonlyMap<string, SpeechEnvelope | null>, targetLufs: number): Promise<{ gainDb?: number; lufs?: number; cancelled?: boolean } | { problem: string }> => {
    running?.abort();
    const controller = new AbortController();
    running = controller;
    const plan = planExport(project, { mediaPath, width: 320, height: 180, envelopes });
    if ("problem" in plan) return { problem: plan.problem };
    const caps = await capsOf(bin);
    const temp = await makeTemp();
    try {
      return await loudnessGain(plan, targetLufs, async (pass, name) => {
        const graphFile = join(temp, name);
        await writeFile(graphFile, pass.graph);
        const r = await run(bin, ["-hide_banner", "-nostdin", ...pass.inputs, ...graphFileArgs(caps, graphFile), ...pass.outputArgs], controller.signal);
        if (controller.signal.aborted) throw new Cancelled();
        if (r.code !== 0) throw new Error(`Measuring the loudness failed: ${ffmpegError(r.stderr)}`);
        return r.stderr;
      });
    } catch (error) {
      if (error instanceof Cancelled || controller.signal.aborted) return { cancelled: true };
      return { problem: (error as Error).message };
    } finally {
      if (running === controller) running = undefined;
      await rm(temp, { recursive: true, force: true });
    }
  };
}
