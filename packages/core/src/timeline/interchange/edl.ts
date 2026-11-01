// CMX 3600 EDL export: the main track's clips as cuts and dissolves. README.md's Timeline interchange
// section says what maps and what's lost.
import type { Media, Project } from "../types.ts";
import { layout } from "../timeline.ts";
import { itemLosses, sameTransition } from "./losses.ts";

/** Timecode at the rate's whole frames a second, non-drop: 29.97 counts 30 frames a second. */
export function timecode(frames: number, fps: number): string {
  const base = Math.round(fps);
  const whole = Math.round(frames);
  const part = (n: number) => String(n).padStart(2, "0");
  const seconds = Math.floor(whole / base);
  return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60, whole % base].map(part).join(":");
}

const clipName = (text: string) => text.replace(/[\r\n]+/g, " ");

export function writeEdl(project: Project, mediaPath: (media: Media) => string): { readonly text: string; readonly warnings: ReadonlyArray<string> } {
  const fps = project.canvas.fps;
  const tc = (frames: number) => timecode(frames, fps);
  const { starts } = layout(project);
  const warnings = new Set<string>();
  const lines = [`TITLE: ${clipName(project.name)}`, "FCM: NON-DROP FRAME", ""];
  const mediaOf = (id: string | undefined) => project.media.find((m) => m.id === id);
  let event = 0;
  const number = () => String(++event).padStart(3, "0");
  let previous: { name: string; sourceEnd: number } | undefined;
  for (const track of project.tracks) {
    if (track.role !== "main") {
      if (track.items.length) warnings.add(`Track ${track.name ?? track.id} isn't in the EDL: an EDL has one picture track.`);
      continue;
    }
    for (const item of track.items) {
      for (const lost of itemLosses(item)) warnings.add(lost);
      const media = mediaOf(item.media);
      if (item.type !== "clip" || !media) {
        warnings.add(`${item.name ?? item.id} isn't in the EDL: it has no source file.`);
        previous = undefined;
        continue;
      }
      const start = starts.get(item.id)!;
      const sourceIn = item.in ?? 0;
      const sourceOut = sourceIn + item.duration;
      const channels = media.kind === "image" ? "V" : media.probe?.hasAudio === false ? "V" : "AA/V";
      const dissolve = item.transitionIn && previous ? item.transitionIn.duration : 0;
      if (item.transitionIn && !sameTransition(item.transitionIn)) warnings.add(`${item.name ?? item.id}'s transition is written as a dissolve.`);
      const id = number();
      if (dissolve && previous) {
        lines.push(`${id}  AX       ${channels.padEnd(5)} C        ${tc(previous.sourceEnd)} ${tc(previous.sourceEnd)} ${tc(start)} ${tc(start)}`);
        lines.push(
          `${id}  AX       ${channels.padEnd(5)} D    ${String(dissolve).padStart(3, "0")} ${tc(sourceIn)} ${tc(sourceOut)} ${tc(start)} ${tc(start + item.duration)}`,
        );
        lines.push(`* FROM CLIP NAME: ${clipName(previous.name)}`, `* TO CLIP NAME: ${clipName(media.name)}`);
      } else {
        lines.push(`${id}  AX       ${channels.padEnd(5)} C        ${tc(sourceIn)} ${tc(sourceOut)} ${tc(start)} ${tc(start + item.duration)}`);
        lines.push(`* FROM CLIP NAME: ${clipName(media.name)}`);
      }
      lines.push(`* SOURCE FILE: ${mediaPath(media)}`, "");
      previous = { name: media.name, sourceEnd: sourceOut };
    }
  }
  return { text: `${lines.join("\n")}\n`, warnings: [...warnings] };
}
