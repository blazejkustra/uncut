// The project's canvas settings (G8, D119), pure: aspect presets and the edit a change makes.
import type { ProjectModel } from "../state/project.ts";
import type { Plan } from "../timeline/edit.ts";

export type Canvas = ProjectModel["canvas"];
export const FPS_CHOICES: ReadonlyArray<Canvas["fps"]> = [24, 25, 30, 50, 60];
export const ASPECTS: ReadonlyArray<{ readonly id: string; readonly label: string; readonly width: number; readonly height: number }> = [
  { id: "16:9", label: "16:9", width: 1920, height: 1080 },
  { id: "9:16", label: "9:16", width: 1080, height: 1920 },
  { id: "1:1", label: "1:1", width: 1080, height: 1080 },
  { id: "4:5", label: "4:5", width: 1080, height: 1350 },
];
export const aspectOf = (c: Pick<Canvas, "width" | "height">) => ASPECTS.find((a) => a.width * c.height === a.height * c.width)?.id;
/** Even, 16…8192 (the schema's range; H.264 wants even sizes). */
export const canvasSide = (v: number) => Math.min(8192, Math.max(16, Math.round(v / 2) * 2));

/**
 * The edit for a canvas change. A frame rate change is refused while the timeline has items:
 * every time in a project is in frames, and retiming them all is not done here.
 */
export function planCanvas(project: ProjectModel, patch: Partial<Canvas>): Plan | { readonly problem: string } {
  const next = { ...project.canvas, ...patch };
  if (patch.width !== undefined) next.width = canvasSide(patch.width);
  if (patch.height !== undefined) next.height = canvasSide(patch.height);
  if (patch.fps !== undefined && patch.fps !== project.canvas.fps && project.tracks.some((t) => t.items.length)) return { problem: "The frame rate can only change while the timeline is empty." };
  const same = next.width === project.canvas.width && next.height === project.canvas.height && next.fps === project.canvas.fps && next.background === project.canvas.background;
  if (same) return { ops: [], summary: "" };
  const what = patch.fps !== undefined ? `frame rate to ${next.fps} fps` : patch.background !== undefined ? `background to ${next.background}` : `canvas to ${next.width}×${next.height}`;
  return { ops: [{ op: "update_project", set: { canvas: next } }], summary: `Changed ${what}` };
}
