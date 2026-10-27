// The measure tool: the mix's loudness by role (agentMix.ts) and the colour readout of frames or clips (agentColour.ts).
import { isAbsolute, resolve } from "node:path";
import { clipFx, fxSkips, sourceAt, type Item, type Project } from "@uncut/core";
import * as Effect from "effect/Effect";

import { mixReport } from "../agentMix.ts";
import { colourReadout, colourStats, graded, GRADING_DIRECTIONS, matchReadout, mergeStats, type ColourStats } from "../agentColour.ts";
import type { ProjectView } from "../../project/projects.ts";
import type { CoreCtx } from "../session/core.ts";

/** Frames are read this wide (px): enough for percentiles, cheap to decode. */
const COLOUR_WIDTH = 480;
const MAX_FRAMES = 12;
const MAX_ITEMS = 6;
/** Where in a clip its samples are taken (fractions of its length): away from transitions at its ends. */
const CLIP_SAMPLES = [0.25, 0.5, 0.75];

const intList = (v: unknown) => (Array.isArray(v) && v.length > 0 && v.every((f) => Number.isInteger(f) && f >= 0) ? (v as Array<number>) : undefined);

/** A picture clip by id, or why it can't be read. */
function clipOf(project: Project, id: unknown): { readonly item: Item; readonly name: string; readonly path: string } | { readonly problem: string } {
  for (const track of project.tracks) {
    const item = track.items.find((i) => i.id === id);
    if (!item) continue;
    const media = item.type === "clip" ? project.media.find((m) => m.id === item.media) : undefined;
    if (!media || media.kind === "audio" || fxSkips(media)) return { problem: `${String(id)} isn't a video or picture clip; read it with frames instead.` };
    return { item, name: item.name ?? media.name, path: media.path };
  }
  return { problem: `There's no item ${JSON.stringify(id)}; project_read lists the ids.` };
}

export const makeMeasureTools = (ctx: CoreCtx) => {
  const { textResult, exporter } = ctx;

  const failed = (error: { readonly message: string }) => Effect.succeed(textResult(error.message, true));

  const measureSound = (v: ProjectView) =>
    exporter.measureMix().pipe(
      Effect.map((traces) =>
        traces ? textResult(mixReport(v.session.project, traces)) : textResult("Nothing sounds in the mix: no audible track has sound."),
      ),
      Effect.catch(failed),
    );

  const statsOfFrames = (frames: ReadonlyArray<number>) =>
    Effect.gen(function* () {
      const rendered = yield* exporter.renderFrames(frames, COLOUR_WIDTH);
      const images = yield* exporter.jpegPixels(rendered.map((r) => r.jpeg));
      return rendered.map((r, k) => ({ frame: r.frame, stats: colourStats(images[k]!) }));
    });

  /** A clip alone, as graded: its media's frames at the samples, through its look and effect.color. */
  const statsOfClip = (v: ProjectView, clip: { readonly item: Item; readonly path: string }) =>
    Effect.gen(function* () {
      const project = v.session.project;
      const seconds = CLIP_SAMPLES.map((f) => sourceAt(project, clip.item, Math.floor(clip.item.duration * f)));
      const path = isAbsolute(clip.path) ? clip.path : resolve(v.dir, clip.path);
      const pulled = yield* exporter.mediaFrames(path, seconds, COLOUR_WIDTH, project.canvas.fps);
      const images = yield* exporter.jpegPixels(pulled.map((p) => p.jpeg));
      const spec = clipFx(clip.item)?.colour;
      return mergeStats(images.map((image) => colourStats(graded(image, spec))));
    });

  const measureColour = (v: ProjectView, args: Record<string, unknown>) =>
    Effect.gen(function* () {
      const fps = v.session.project.canvas.fps;
      const frames = args.frames === undefined ? undefined : intList(args.frames);
      if (args.frames !== undefined && (!frames || frames.length > MAX_FRAMES))
        return textResult(`frames must be 1 to ${MAX_FRAMES} frame numbers (integers from 0).`, true);
      const ids = Array.isArray(args.items) ? args.items.slice(0, MAX_ITEMS) : undefined;
      if (!frames && !ids?.length) return textResult("Pass frames (of the edit) or items (clip ids) to read the colour of.", true);
      const clips = (ids ?? []).map((id) => clipOf(v.session.project, id));
      const bad = clips.find((c) => "problem" in c);
      if (bad && "problem" in bad) return textResult(bad.problem, true);
      const readFrames = frames ? yield* statsOfFrames(frames) : [];
      const readClips: Array<{ readonly id: string; readonly name: string; readonly stats: ColourStats }> = [];
      for (const clip of clips) {
        if ("problem" in clip) continue;
        readClips.push({ id: clip.item.id, name: clip.name, stats: yield* statsOfClip(v, clip) });
      }
      const [first, ...rest] = readClips;
      return textResult({
        directions: GRADING_DIRECTIONS,
        ...(readFrames.length
          ? { frames: readFrames.map((f) => ({ frame: f.frame, seconds: Math.round((f.frame / fps) * 100) / 100, ...colourReadout(f.stats) })) }
          : {}),
        ...(readClips.length
          ? {
              items: readClips.map((c) => ({ item: c.id, name: c.name, ...colourReadout(c.stats) })),
              note: "Each clip is read alone from its media at 25, 50 and 75 % of its length, through its look and effect.color (overlays and other effects left out).",
            }
          : {}),
        ...(first && rest.length ? { match: rest.map((c) => matchReadout(first, c)) } : {}),
      });
    }).pipe(Effect.catch(failed));

  const measure = (v: ProjectView, args: Record<string, unknown>) => {
    if (args.what === "sound") return measureSound(v);
    if (args.what === "colour") return measureColour(v, args);
    return Effect.succeed(textResult('what must be "sound" or "colour".', true));
  };

  return { measure };
};
