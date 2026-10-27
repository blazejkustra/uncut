import type { ExportPlan } from "./types.ts";
import { audioGraph } from "./audio.ts";

/** ebur128's blocks: one reading every this many seconds. */
export const BLOCK_S = 0.1;

/** A mix's loudness over time, as ebur128 reads it (LUFS; -Infinity for silence). */
export interface LoudnessTrace {
  /** Integrated loudness (gated, LUFS); null when silent. */
  readonly lufs: number | null;
  /** The loudest true peak (dBTP); null when silent. */
  readonly truePeak: number | null;
  /** Momentary loudness (400 ms window) at the end of each BLOCK_S block: momentary[k] covers up to (k + 1) × BLOCK_S s. */
  readonly momentary: ReadonlyArray<number>;
  /** Short-term loudness (3 s window), at the same times. */
  readonly shortTerm: ReadonlyArray<number>;
}

/**
 * A measuring pass over part of the export's mix (audio only, nothing written): the layers `keep`
 * chooses, with their gains, fades, ducking and track effects as the export plays them, before the
 * loudness step and the limiter; ebur128 prints its readings on stdout. Undefined when nothing is kept.
 */
export function mixMeasureCommand(plan: ExportPlan, keep: (layer: ExportPlan["audio"][number]) => boolean = () => true) {
  const audio = plan.audio.filter(keep);
  if (!audio.length) return undefined;
  const graph = audioGraph({ ...plan, audio }, 0, { noLimiter: true, tail: "ebur128=metadata=1:peak=true,ametadata=mode=print:file=-" });
  return { inputs: graph.inputs, graph: graph.filters.join(";\n"), outputArgs: ["-map", "[aout]", "-f", "null", "-"] };
}

/** The floor for silence (ebur128 reads -120.7 LUFS for digital silence, -70 integrated). */
export const SILENCE_LUFS = -120;
const db = (text: string) => {
  const v = Number(text);
  return Number.isFinite(v) ? Math.max(SILENCE_LUFS, v) : SILENCE_LUFS;
};

/** The trace from ametadata's print of ebur128's readings (frame lines, then key=value lines). */
export function parseMixMeasure(stdout: string): LoudnessTrace {
  const momentary: Array<number> = [];
  const shortTerm: Array<number> = [];
  let integrated = SILENCE_LUFS;
  let peak = 0;
  for (const line of stdout.split("\n")) {
    const eq = line.indexOf("=");
    if (!line.startsWith("lavfi.r128.") || eq < 0) continue;
    const key = line.slice("lavfi.r128.".length, eq);
    const value = line.slice(eq + 1).trim();
    if (key === "M") momentary.push(db(value));
    else if (key === "S") shortTerm.push(db(value));
    else if (key === "I") integrated = db(value);
    else if (key === "true_peak") peak = Math.max(peak, Number(value) || 0);
  }
  const heard = integrated > -70;
  return {
    lufs: heard ? integrated : null,
    truePeak: heard && peak > 0 ? Math.round(20 * Math.log10(peak) * 10) / 10 : null,
    momentary,
    shortTerm,
  };
}
