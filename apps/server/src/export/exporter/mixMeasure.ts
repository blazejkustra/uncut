// The mix measured by role (the agent's measure sound and the critic's sound facts): the export's
// own audio graph, once whole and once per role (voice, music, effects, other), each read by ebur128.
import { writeFile, rm } from "node:fs/promises";
import { join } from "node:path";

import { SOUND_ROLES, soundRoles, type Media, type Project, type SoundRole, type SpeechEnvelope } from "@uncut/core";

import { graphFileArgs, planExport } from "../exportPlan.ts";
import { mixMeasureCommand, parseMixMeasure, type LoudnessTrace } from "../plan/mixMeasure.ts";
import { capsOf, run, ffmpegError } from "./ffmpeg.ts";
import { makeTemp } from "./files.ts";

export interface MixTraces {
  /** The whole mix before the loudness step and the limiter. */
  readonly master: LoudnessTrace;
  /** Each role that sounds, alone. */
  readonly roles: Partial<Record<SoundRole, LoudnessTrace>>;
}

type Pass = { readonly name: "master" | SoundRole; readonly command: NonNullable<ReturnType<typeof mixMeasureCommand>> };

/** A measurer that remembers its last answer: the same sound (the same graphs and inputs) isn't measured again. */
export function makeMixMeasure() {
  let last: { readonly key: string; readonly traces: MixTraces } | undefined;
  return async (
    bin: string,
    project: Project,
    mediaPath: (m: Media) => string,
    envelopes: ReadonlyMap<string, SpeechEnvelope | null>,
    signal?: AbortSignal,
  ): Promise<MixTraces | { readonly problem: string } | undefined> => {
    const plan = planExport(project, { mediaPath, width: 320, height: 180, envelopes });
    if ("problem" in plan) return { problem: plan.problem };
    const roles = soundRoles(project);
    const master = mixMeasureCommand(plan);
    if (!master) return undefined;
    const passes: Array<Pass> = [{ name: "master", command: master }];
    for (const role of SOUND_ROLES) {
      const command = mixMeasureCommand(plan, (layer) => roles.get(layer.item.id)?.role === role);
      if (command) passes.push({ name: role, command });
    }
    const key = JSON.stringify(passes.map((p) => [p.command.inputs, p.command.graph]));
    if (last?.key === key) return last.traces;
    const caps = await capsOf(bin);
    const temp = await makeTemp();
    try {
      const measured = await Promise.all(
        passes.map(async ({ name, command }) => {
          const graphFile = join(temp, `${name}.txt`);
          await writeFile(graphFile, command.graph);
          const r = await run(
            bin,
            ["-hide_banner", "-nostdin", "-nostats", ...command.inputs, ...graphFileArgs(caps, graphFile), ...command.outputArgs],
            signal,
          );
          if (r.code !== 0) throw new Error(`Measuring the sound failed: ${ffmpegError(r.stderr)}`);
          return [name, parseMixMeasure(r.stdout)] as const;
        }),
      );
      const traces: MixTraces = { master: measured[0]![1], roles: Object.fromEntries(measured.slice(1)) };
      last = { key, traces };
      return traces;
    } catch (error) {
      return { problem: (error as Error).message };
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  };
}
