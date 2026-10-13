// How an analysis job reads in the editor (the Library tile, the Transcript panel, the inspector's
// Beats group): its own module, so those don't import each other for one line.
import type { AnalysisJob } from "@uncut/contracts";

export function analysisText(job: AnalysisJob) {
  const pct = `${Math.round(job.progress * 100)}%`;
  if (job.phase === "running" && job.analyzer === "transcript") return job.stage === "model" ? `Downloading the speech model… ${pct}` : `Transcribing… ${pct}`;
  if (job.phase === "running" && job.analyzer === "beats") return `Finding the beats… ${pct}`;
  if (job.phase === "running") return `Analysing the ${job.analyzer === "video" ? "picture" : "sound"}… ${pct}`;
  return job.waiting === "export" ? "Waiting for the export to finish" : job.analyzer === "transcript" ? "Waiting to transcribe" : "Waiting to analyse";
}
