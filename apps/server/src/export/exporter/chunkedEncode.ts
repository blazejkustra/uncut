import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { codecExtension } from "@uncut/core";

import {
  chunkLayers,
  chunkRanges,
  exportCommand,
  graphFileArgs,
  muxCommand,
  planInRange,
  type Caps,
  type CommandOptions,
  type ExportPlan,
} from "../exportPlan.ts";
import { encodeArgs, guardedRun } from "./ffmpeg.ts";

export interface ChunkedEncode {
  readonly bin: string;
  readonly caps: Caps;
  readonly plan: ExportPlan;
  readonly options: CommandOptions;
  readonly temp: string;
  readonly signal: AbortSignal;
  /** The handler of ffmpeg's -progress lines for a run whose output starts `offset` seconds into the export. */
  readonly progress: (offset: number) => (line: string) => void;
  /** Layers per chunk; absent: chunkLayers of the plan's size. */
  readonly maxLayers?: number;
}

const concatList = (files: ReadonlyArray<string>) => files.map((f) => `file '${f.replaceAll("'", "'\\''")}'`).join("\n") + "\n";

async function runWithGraph(o: ChunkedEncode, name: string, cmd: { inputs: Array<string>; graph: string; outputArgs: Array<string> }, offset: number) {
  const graphFile = join(o.temp, `${name}.txt`);
  await writeFile(graphFile, cmd.graph);
  return guardedRun(o.bin, encodeArgs(cmd, graphFileArgs(o.caps, graphFile)), o.signal, o.progress(offset));
}

/**
 * The export as one ffmpeg when its layers fit (CHUNK_LAYERS), else in time chunks of that many
 * layers at most, their pictures joined unchanged with the whole mix. stderr: every run's, in order.
 */
export async function encodeChunked(o: ChunkedEncode) {
  const ranges = chunkRanges(o.plan.visuals, o.plan.frames, o.maxLayers ?? chunkLayers(o.plan.width, o.plan.height));
  if (ranges.length === 1) return runWithGraph(o, "graph", exportCommand(o.plan, o.options), 0);
  const extension = codecExtension(o.options.video?.codec ?? "h264");
  const files: Array<string> = [];
  const stderr: Array<string> = [];
  for (const [i, range] of ranges.entries()) {
    const file = join(o.temp, `chunk-${i}.${extension}`);
    const r = await runWithGraph(o, `chunk-${i}`, exportCommand(planInRange(o.plan, range), { ...o.options, range, output: file }), range.start / o.plan.fps);
    if (r.code !== 0) return r;
    stderr.push(r.stderr);
    files.push(file);
  }
  const list = join(o.temp, "chunks.txt");
  await writeFile(list, concatList(files));
  const r = await runWithGraph(o, "mux", muxCommand(o.plan, o.options, list), o.plan.frames / o.plan.fps);
  return { ...r, stderr: [...stderr, r.stderr].join("\n") };
}
