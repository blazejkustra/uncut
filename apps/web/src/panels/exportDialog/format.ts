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
    ...(choiceOfTarget(target) === "target" ? [{ id: "target" as const, label: "Project", sub: lufsText(target), hint: `The project's own loudness target (${targetWords(target)}), set in the Mixer.` }] : []),
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

export const eta = (s: number | undefined) => (s === undefined ? "" : s < 60 ? `About ${Math.max(1, Math.round(s))} s left` : `About ${Math.round(s / 60)} min left`);
