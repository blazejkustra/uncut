import type { ExportQuality, ExportLoudness, ExportJob } from "@uncut/contracts";
import type { ExportEncoder } from "@uncut/core/export";
import { LOUDNESS_PRESETS, choiceOfTarget, targetWords } from "@uncut/core/effects";
import type { RangeKind } from "../exportRange.ts";

export const ENCODER_NAMES: Readonly<Record<ExportEncoder, string>> = { hardware: "hardware", software: "software" };

export const QUALITIES: ReadonlyArray<{ readonly id: ExportQuality; readonly label: string; readonly hint: string }> = [
  { id: "draft", label: "Draft", hint: "Fast, for a quick look" },
  { id: "standard", label: "Standard", hint: "For sharing anywhere" },
  { id: "high", label: "High", hint: "Full size, the best copy" },
];

type LoudnessCard = { readonly id: ExportLoudness; readonly label: string; readonly sub: string; readonly hint: string };
const lufsText = (lufs: number) => `${lufs < 0 ? "−" : ""}${Math.abs(lufs)} LUFS`;
/** The loudness cards (D87): the presets, the project's own target when it isn't one, and As mixed. */
export function loudnessCards(target: number): ReadonlyArray<LoudnessCard> {
  const hints: Readonly<Record<string, string>> = {
    normal: "Evens out the volume so it plays as loud as other videos on YouTube, Instagram and TikTok.",
    quiet: "A little quieter, as podcasts and Apple Music expect.",
    broadcast: "The TV level (EBU R128): quieter, with more room for peaks.",
  };
  return [
    ...LOUDNESS_PRESETS.map((p) => ({ id: p.id, label: p.name, sub: lufsText(p.lufs), hint: hints[p.id]! })),
    ...(choiceOfTarget(target) === "target"
      ? [
          {
            id: "target" as const,
            label: "Project",
            sub: lufsText(target),
            hint: `The project's own loudness target (${targetWords(target)}), set in the Mixer.`,
          },
        ]
      : []),
    { id: "off", label: "As mixed", sub: "No change", hint: "Keeps your levels exactly as they sound in the editor." },
  ];
}

export const RANGE_KINDS: ReadonlyArray<readonly [RangeKind, string]> = [
  ["all", "Whole timeline"],
  ["marks", "In to Out"],
  ["selection", "Selected clips"],
  ["custom", "Custom"],
];

export const ACTIVE = new Set(["queued", "preparing", "rendering"]);
export const exportRunning = (job: ExportJob | undefined) => job !== undefined && ACTIVE.has(job.phase);

/** A file name the Finder accepts, ending in .mp4. */
export const fileName = (name: string) => {
  const clean = name.replace(/[/:]/g, "-").trim() || "Untitled";
  return /\.mp4$/i.test(clean) ? clean : `${clean}.mp4`;
};
export const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1);
export const dirName = (path: string) => path.slice(0, path.lastIndexOf("/")) || "/";
/** F29 (D173): the folder a file is in, by its name ("Movies"); "/" for the root. */
export const folderName = (path: string) => baseName(dirName(path)) || "/";
export const fpsText = (fps: number) => `${Number(fps.toFixed(3))} fps`;

export const eta = (s: number | undefined) =>
  s === undefined ? "" : s < 60 ? `About ${Math.max(1, Math.round(s))} s left` : `About ${Math.round(s / 60)} min left`;

/**
 * A preparing export's line and how far its step is (0–1, undefined when it can't be counted): the
 * graphics and shader effects are drawn before the encode, frame by frame, and a heavy graphic takes
 * minutes there, so it says which frame it's on rather than looking stuck. Without graphics
 * (`graphics` false) the frames drawn are the text's.
 */
export function preparingStatus(job: Pick<ExportJob, "step">, graphics = true): { readonly text: string; readonly fraction: number | undefined } {
  const s = job.step;
  const counted = s && s.done !== undefined && s.total ? { done: Math.min(s.done, s.total), total: s.total } : undefined;
  const frames = counted ? `: frame ${counted.done} of ${counted.total}` : "…";
  const text = !s
    ? "Getting ready…"
    : s.kind === "sound"
      ? "Measuring the sound…"
      : s.kind === "loudness"
        ? "Measuring the loudness…"
        : s.kind === "graphics"
          ? `Drawing the ${graphics ? "graphics" : "text"}${frames}`
          : `Drawing the shader effects${frames}`;
  return { text, fraction: counted && (s!.kind === "graphics" || s!.kind === "shaders") ? counted.done / counted.total : undefined };
}

/** The Export button's label while a job runs: the encode's percentage, or the preparing step's as the dialog's bar shows it. */
export function exportButtonText(job: Pick<ExportJob, "phase" | "progress" | "step">): string {
  if (job.phase === "rendering") return `Exporting ${Math.round(job.progress * 100)}%`;
  if (job.phase !== "preparing") return "Exporting…";
  const { fraction } = preparingStatus(job);
  return fraction === undefined ? "Preparing…" : `Preparing ${Math.round(fraction * 100)}%`;
}
