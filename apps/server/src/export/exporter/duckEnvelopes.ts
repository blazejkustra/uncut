// The loudness envelopes an export's ducking and noise removal need (one set of unmeasurable files per Exporter).
import { decodeEnvelope, denoiseMediaIds, duckMediaIds, type Project, type SpeechEnvelope } from "@uncut/core";

import { analyzeLoudness, cachedFor, fingerprint, targetOf, writeCached, type LoudnessResult } from "../../analysis/analysis.ts";
import { Cancelled } from "./ffmpeg.ts";

/** How long an export waits to measure a ducking key's loudness that isn't cached (D85). */
const DUCK_MEASURE_MS = 60_000;

export const makeDuckEnvelopes = () => {
  /**
   * The loudness envelopes ducking (D85) and noise removal (D88) need, by media id: cached ones, and the missing ones
   * measured here (loudness analysis, written to the cache like the queue's). One that can't be
   * measured is left out: planExport then skips that duck with a warning.
   */
  /** Media (by content fingerprint) whose loudness couldn't be measured for an export this session (D85, D88). */
  const unmeasurable = new Set<string>();
  const duckEnvelopes = async (bin: string, dir: string, project: Project, measure: boolean, signal?: AbortSignal) => {
    const out = new Map<string, SpeechEnvelope | null>();
    for (const id of new Set([...duckMediaIds(project), ...denoiseMediaIds(project)])) {
      const media = project.media.find((m) => m.id === id);
      if (!media) continue;
      const target = targetOf(dir, media, project.canvas.fps);
      let result = (await cachedFor(target, "loudness")) as LoudnessResult | undefined;
      if (!result && !measure) continue;
      if (!result) {
        if (signal?.aborted) throw new Cancelled();
        // A file whose measurement failed or timed out this session isn't tried again on every export.
        const fp = await fingerprint(target.path).catch(() => target.path);
        if (unmeasurable.has(fp)) continue;
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), DUCK_MEASURE_MS);
          const onAbort = () => controller.abort();
          signal?.addEventListener("abort", onAbort, { once: true });
          try {
            result = await analyzeLoudness(bin, target.path, { signal: controller.signal, seconds: target.seconds });
          } finally {
            clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
          }
          await writeCached(dir, fp, "loudness", result).catch(() => {});
        } catch (error) {
          // Cancelling the export stops the measurement: that is the export's cancel, not a failure.
          if (signal?.aborted || error instanceof Cancelled) throw new Cancelled();
          unmeasurable.add(fp);
          continue;
        }
      }
      out.set(id, result.hasAudio ? (decodeEnvelope(result.envelope) ?? null) : null);
    }
    return out;
  };
  return duckEnvelopes;
};
