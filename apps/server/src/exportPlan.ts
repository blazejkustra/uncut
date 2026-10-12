// What an export draws and plays, and the ffmpeg command that makes it (D39, D55). Pure: no
// processes, no files; the export service (exporter.ts) rasterises the text, runs ffmpeg and
// reports progress. Everything here follows the preview's maths in @uncut/core:
// - Picture: every layer visualsAt would return, composited bottom-up in visualsAt's order
//   (tracks from the bottom, items in order), from frame ceil(from) to ceil(to) of its span.
//   Footage and stills without a box (D75: no transform, or the full frame contain at scale 1) are
//   scaled to fit like the preview's object-fit: contain, over transparent bars. A boxed clip is
//   scaled to its picture's size, padded / cropped to its box, its corners rounded (a mask), and
//   overlaid at the box's position; per-frame sizes (keyed scale) and positions (keyed x / y) are
//   lookups on the frame number, and keyed opacity is sent to colorchannelmixer frame by frame
//   (sendcmd), all from core's boxes. A looped clip is one layer per pass through its media. Text and backgrounds are PNGs Chromium drew from core's textHtml / solidHtml with
//   RENDER_CSS; a text whose position moves (rise, slide, wipe) gets one PNG per distinct state.
//   Opacity (a transition's crossfade, fade/rise/slide in and out) is linear in frames, so it is
//   ffmpeg's fade on the layer's alpha, evaluated at the same frames (time mode). A dip to black
//   is core's black layer over the main track (a raster with two ramps); a wipe crops the
//   incoming layer from the left at the same frames (pad + crop + overlay x, per frame).
// - Sound: every item audibleAt would return, from its media at the same source time, with the
//   gain of core itemGain (combined dB with the −60 dB cutoff, gainKeys, fades, transition
//   crossfades) as one volume expression per item, mixed with amix normalize=0 (D54).
// - A frame f is the moment f / fps (D38); a clip shows the source frame on screen at its source
//   time, as the preview's <video> does (the last frame that starts at or before it).
import {
  animationAt,
  audioSpan,
  baseBox,
  clipBox,
  isPlainBox,
  type ClipBox,
  type Rect,
  dipsOf,
  spanOf,
  canvasBackground,
  layout,
  outputSize,
  RENDER_CSS,
  SILENCE_DB,
  SOLID,
  solidHtml,
  soundMedia,
  sourceAt,
  textHtml,
  trackAudible,
  type ExportQuality,
  type Item,
  type Span,
  type Media,
  type Project,
  type Track,
} from "@uncut/core";

export type Quality = ExportQuality;
export { outputSize };
export type Loudness = "off" | "normal" | "quiet";

/** Integrated loudness targets (LUFS) of the loudness choices. */
export const LOUDNESS_TARGET: Readonly<Record<Exclude<Loudness, "off">, number>> = { normal: -14, quiet: -16 };

/** A linear opacity ramp on a layer, in project frames: fade in from 0 at `st` to 1 at st + d, or out. */
export interface Ramp {
  readonly type: "in" | "out";
  readonly st: number;
  readonly d: number;
}

/**
 * A boxed clip at one frame, in output pixels (D75): the box (edges rounded to whole pixels, so
 * boxes that share an edge meet without a seam) and the picture inside it (its size and its
 * top-left relative to the box's, edges rounded the same way, so a picture that covers the box
 * covers it exactly). The box's size and radius never change over a layer; x, y and the picture do.
 */
export interface Placement {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly cx: number;
  readonly cy: number;
  readonly cw: number;
  readonly ch: number;
  readonly radius: number;
}

interface LayerBase {
  readonly item: Item;
  readonly track: Track;
  /** First frame drawn and the frame after the last (integers). */
  readonly f0: number;
  readonly f1: number;
  readonly ramps: ReadonlyArray<Ramp>;
  /** A wipe transition into it: shown from the left edge, 0 at frame `st` to the whole width at st + d. */
  readonly wipe?: { readonly st: number; readonly d: number };
  /** The box's opacity (transform.opacity, opacity keys) for each frame from f0; absent when always 1. */
  readonly alpha?: ReadonlyArray<number>;
}

/** A clip's box for each frame from f0 (absent: the plain full frame, drawn as before D75). */
export interface Geometry {
  readonly frames: ReadonlyArray<Placement>;
}

export type VisualLayer =
  | (LayerBase & {
      readonly kind: "video";
      readonly file: string;
      /** Source time (s) of frame f0, and source seconds per project second. */
      readonly source: number;
      readonly speed: number;
      /** The picture fills the canvas exactly (same aspect), so it needs no bars. */
      readonly fills: boolean;
      readonly geometry?: Geometry;
      /**
       * A looped clip played from one input (D75 review): the media's first `length` project frames
       * are decoded once and repeated (ffmpeg's loop filter), frame f0 showing frame `offset` of them.
       */
      readonly cycle?: { readonly length: number; readonly offset: number };
    })
  | (LayerBase & { readonly kind: "image"; readonly file: string; readonly fills: boolean; readonly geometry?: Geometry })
  | (LayerBase & {
      readonly kind: "raster";
      /** HTML of each distinct look, at canvas size. */
      readonly states: ReadonlyArray<string>;
      /** For each frame from f0, the index of its look. */
      readonly frames: ReadonlyArray<number>;
    });

/** What itemGain needs of an item, kept so the volume expression can be built (and checked). */
export interface GainModel {
  /** item.gainDb + the track's mixer.gainDb. */
  readonly baseDb: number;
  readonly keys: ReadonlyArray<{ readonly frame: number; readonly db: number }>;
  readonly duration: number;
  readonly half: number;
  readonly nextHalf: number;
  readonly fadeIn: number;
  readonly fadeOut: number;
}

export interface AudioLayer {
  readonly item: Item;
  readonly file: string;
  /** The span it sounds over, in (possibly fractional) project frames. */
  readonly from: number;
  readonly to: number;
  /** Source time (s) at `from`, and the speed. */
  readonly source: number;
  readonly speed: number;
  /** Looped audio wraps at the end of the file. */
  readonly loop: boolean;
  /**
   * A looped item at speed 1 (D75 review): the media's first `samples` samples (48 kHz: exactly
   * its length in project frames) repeated with aloop, starting `offset` samples in, so passes stay
   * on the picture's frames instead of drifting at the file's real length.
   */
  readonly cycle?: { readonly samples: number; readonly offset: number };
  readonly gain: GainModel;
}

export interface ExportPlan {
  readonly fps: number;
  readonly canvas: { readonly width: number; readonly height: number };
  /** Output size. */
  readonly width: number;
  readonly height: number;
  /** Frames in the export. */
  readonly frames: number;
  /** The canvas colour as HTML, drawn under everything. */
  readonly backgroundHtml: string;
  readonly visuals: ReadonlyArray<VisualLayer>;
  readonly audio: ReadonlyArray<AudioLayer>;
  /** Every media file the export reads. */
  readonly files: ReadonlyArray<{ readonly media: Media; readonly path: string }>;
}

/** The CSS every rasterised layer gets: the preview's (D53). */
export const RASTER_CSS = RENDER_CSS;

// ---- opacity ----

const OPACITY_MOVES = new Set(["move.fade", "move.rise", "move.slide-left"]);

/**
 * The opacity ramps of an item as visualsAt computes its opacity: a crossfade's (0 at `from` → 1
 * at start + half; a wipe changes no opacity), then the in and out animations (fade, rise and
 * slide-left change opacity; wipe doesn't), skipped on a side where a main-track transition blends.
 */
export function opacityRamps(item: Item, start: number, span: Pick<Span, "half" | "skipIn" | "skipOut" | "wipe">): Array<Ramp> {
  const ramps: Array<Ramp> = [];
  if (span.half > 0 && !span.wipe) ramps.push({ type: "in", st: start - span.half, d: 2 * span.half });
  const a = item.animation;
  if (!span.skipIn && a?.in && a.in.duration > 0 && OPACITY_MOVES.has(a.in.module)) ramps.push({ type: "in", st: start, d: a.in.duration });
  if (!span.skipOut && a?.out && a.out.duration > 0 && OPACITY_MOVES.has(a.out.module)) ramps.push({ type: "out", st: start + item.duration - 1 - a.out.duration, d: a.out.duration });
  return ramps;
}

/** The box's opacity at frame f (1 without one). */
export const alphaAt = (layer: Pick<LayerBase, "alpha" | "f0">, f: number) => layer.alpha?.[f - layer.f0] ?? 1;

/**
 * A core box in output pixels: `kx`, `ky` output pixels per canvas pixel. The box's size and the
 * picture inside it are rounded where the box is without keys (`base`, core baseBox), every edge
 * on its own (not x and w), so two boxes sharing an edge meet on one pixel, a picture that covers
 * its box still covers it, and a box that moves (x / y keys) keeps one size. x and y are the box's
 * position at this frame.
 */
export function placementOf(box: ClipBox, kx: number, ky: number, base: Rect = box): Placement {
  const x0 = Math.round(base.x * kx);
  const y0 = Math.round(base.y * ky);
  const w = Math.max(1, Math.round((base.x + base.w) * kx) - x0);
  const h = Math.max(1, Math.round((base.y + base.h) * ky) - y0);
  // The picture as it sits in the box, moved with the box to where the box is without keys.
  const c = { x: box.content.x - box.x + base.x, y: box.content.y - box.y + base.y, w: box.content.w, h: box.content.h };
  const cx = Math.round(c.x * kx) - x0;
  const cy = Math.round(c.y * ky) - y0;
  const cw = Math.max(1, Math.round((c.x + c.w) * kx) - x0 - cx);
  const ch = Math.max(1, Math.round((c.y + c.h) * ky) - y0 - cy);
  return { x: Math.round(box.x * kx), y: Math.round(box.y * ky), w, h, cx, cy, cw, ch, radius: Math.min(Math.round(box.radius * Math.min(kx, ky)), Math.floor(Math.min(w, h) / 2)) };
}

/** The share of a wiped layer shown at frame f (core visualsAt's `wipe`; 1 when whole). */
export const wipeAt = (wipe: VisualLayer["wipe"], f: number) => (wipe ? Math.min(1, Math.max(0, (f - wipe.st) / wipe.d)) : 1);

/** The ramps' opacity at frame f, as ffmpeg's fade computes it (the tests compare it with visualsAt). */
export const rampsAt = (ramps: ReadonlyArray<Ramp>, f: number) =>
  ramps.reduce((o, r) => {
    const p = Math.min(1, Math.max(0, (f - r.st) / r.d));
    return o * (r.type === "in" ? p : 1 - p);
  }, 1);

/**
 * The frames [from, to) of a layer (from f0 ≤ from < to ≤ f1) as a layer of their own: per-frame
 * data sliced, a video's source time moved on. `source` overrides that (a looped clip's next pass).
 */
function sliceLayer(layer: VisualLayer, from: number, to: number, fps: number, source?: number): VisualLayer {
  const a = from - layer.f0;
  const b = to - layer.f0;
  const common = { f0: from, f1: to, ...(layer.alpha ? { alpha: layer.alpha.slice(a, b) } : {}) };
  if (layer.kind === "raster") return { ...layer, ...common, frames: layer.frames.slice(a, b) };
  const geometry = layer.geometry ? { geometry: { frames: layer.geometry.frames.slice(a, b) } } : {};
  if (layer.kind === "video" && layer.cycle) return { ...layer, ...common, ...geometry, cycle: { ...layer.cycle, offset: (layer.cycle.offset + a) % layer.cycle.length }, source: (((layer.cycle.offset + a) % layer.cycle.length) / fps) };
  if (layer.kind === "video") return { ...layer, ...common, ...geometry, source: source ?? layer.source + (a * layer.speed) / fps };
  return { ...layer, ...common, ...geometry };
}

/**
 * A wiped layer as two: the wipe's frames (cropped per frame, so with alpha) and the rest of the
 * item as a plain layer, so the pad/crop/overlay work runs only over the wipe.
 */
function splitWipe(layer: VisualLayer, fps: number): Array<VisualLayer> {
  if (!layer.wipe) return [layer];
  const end = Math.min(layer.f1, Math.max(layer.f0, Math.ceil(layer.wipe.st + layer.wipe.d)));
  const { wipe, ...plain } = layer;
  if (end <= layer.f0) return [plain as VisualLayer];
  if (end >= layer.f1) return [layer];
  return [sliceLayer(layer, layer.f0, end, fps), sliceLayer(plain as VisualLayer, end, layer.f1, fps)];
}

/**
 * A looped video clip as one layer per pass through its media (each from the source time core
 * gives its first frame), so every pass is decoded from a plain seek rather than a looped input.
 */
/** Passes a looped clip may take as inputs of their own; more go through the loop filter (one input). */
export const MAX_LOOP_INPUTS = 8;
/** The most memory (bytes) the loop filter may hold for one looped clip; above it, one input per pass. */
const MAX_LOOP_BUFFER = 1.5e9;

function splitLoop(layer: VisualLayer, project: Project, start: number, size: { width: number; height: number }): Array<VisualLayer> {
  if (layer.kind !== "video" || !layer.item.loop) return [layer];
  const fps = project.canvas.fps;
  const length = layer.item.media ? project.media.find((m) => m.id === layer.item.media)?.probe?.frames : undefined;
  if (!length) return [layer];
  const out: Array<VisualLayer> = [];
  const pass = (f: number) => Math.floor(((layer.item.in ?? 0) + (f - start) * layer.speed) / length);
  // Many passes at speed 1: one input, the media decoded once and repeated (memory permitting).
  const geo = layer.geometry?.frames;
  const pixels = geo ? Math.max(...geo.map((p) => p.cw)) * Math.max(...geo.map((p) => p.ch)) : size.width * size.height;
  if (layer.speed === 1 && pass(layer.f1 - 1) - pass(layer.f0) + 1 > MAX_LOOP_INPUTS && length * pixels * 1.5 <= MAX_LOOP_BUFFER) {
    const offset = (((layer.item.in ?? 0) + layer.f0 - start) % length + length) % length;
    return [{ ...layer, source: offset / fps, cycle: { length, offset } }];
  }
  let from = layer.f0;
  for (let f = layer.f0 + 1; f <= layer.f1; f++) {
    if (f < layer.f1 && pass(f) === pass(from)) continue;
    out.push(sliceLayer(layer, from, f, fps, sourceAt(project, layer.item, from - start)));
    from = f;
  }
  return out;
}

// ---- gain ----

const clamp01 = (p: number) => Math.min(1, Math.max(0, p));

/** core keyDbAt, on keys already sorted. */
const keyDb = (keys: GainModel["keys"], local: number) => {
  if (!keys.length) return 0;
  if (local <= keys[0]!.frame) return keys[0]!.db;
  for (let i = 1; i < keys.length; i++) {
    const a = keys[i - 1]!;
    const b = keys[i]!;
    if (local <= b.frame) return b.frame === a.frame ? b.db : a.db + ((b.db - a.db) * (local - a.frame)) / (b.frame - a.frame);
  }
  return keys.at(-1)!.db;
};

/** The model's gain at `local` frames from the item's start: core itemGain, restated so it can be turned into an expression. */
export function gainAt(m: GainModel, local: number): number {
  const db = m.baseDb + keyDb(m.keys, Math.min(m.duration, Math.max(0, local)));
  let g = db <= SILENCE_DB ? 0 : 10 ** (db / 20);
  if (!(m.half > 0) && m.fadeIn > 0) g *= clamp01(local / m.fadeIn);
  if (!(m.nextHalf > 0) && m.fadeOut > 0) g *= clamp01((m.duration - local) / m.fadeOut);
  if (m.half > 0) g *= clamp01((local + m.half) / (2 * m.half));
  if (m.nextHalf > 0) g *= clamp01((m.duration + m.nextHalf - local) / (2 * m.nextHalf));
  return g;
}

/** The gain when it never changes over the item (no keys, fades or transitions), else undefined. */
export function constantGain(m: GainModel): number | undefined {
  if (m.keys.length > 1 || m.half > 0 || m.nextHalf > 0 || m.fadeIn > 0 || m.fadeOut > 0) return undefined;
  const db = m.baseDb + (m.keys[0]?.db ?? 0);
  return db <= SILENCE_DB ? 0 : 10 ** (db / 20);
}

/** Samples per block the gain is evaluated for (10 ms at 48 kHz). */
export const AUDIO_BLOCK = 480;

const n = (x: number) => {
  const s = (Math.round(x * 1e6) / 1e6).toString();
  return s.includes("e") ? x.toFixed(9) : s;
};

/**
 * ffmpeg volume expression (eval=frame) for the model: the gain at the middle of each audio
 * block (AUDIO_BLOCK samples at 48 kHz; volume's nb_samples is NaN per frame, so the block is
 * fixed by asetnsamples), `t` being seconds since the layer's start (`from`). Variables: 0 = local frames,
 * 1 = local clamped to the item, 2 = combined dB.
 */
export function gainExpr(m: GainModel, fps: number): string {
  const L = "ld(1)";
  let keys = m.keys.length ? n(m.keys.at(-1)!.db) : "0";
  for (let i = m.keys.length - 1; i >= 1; i--) {
    const a = m.keys[i - 1]!;
    const b = m.keys[i]!;
    const value = b.frame === a.frame ? n(b.db) : `(${n(a.db)}+(${n(b.db - a.db)})*(${L}-${n(a.frame)})/${n(b.frame - a.frame)})`;
    keys = `if(lte(${L},${n(b.frame)}),${value},${keys})`;
  }
  if (m.keys.length) keys = `if(lte(${L},${n(m.keys[0]!.frame)}),${n(m.keys[0]!.db)},${keys})`;
  const parts = [`if(lte(ld(2),${SILENCE_DB}),0,pow(10,ld(2)/20))`];
  if (!(m.half > 0) && m.fadeIn > 0) parts.push(`clip(ld(0)/${n(m.fadeIn)},0,1)`);
  if (!(m.nextHalf > 0) && m.fadeOut > 0) parts.push(`clip((${n(m.duration)}-ld(0))/${n(m.fadeOut)},0,1)`);
  if (m.half > 0) parts.push(`clip((ld(0)+${n(m.half)})/${n(2 * m.half)},0,1)`);
  if (m.nextHalf > 0) parts.push(`clip((${n(m.duration + m.nextHalf)}-ld(0))/${n(2 * m.nextHalf)},0,1)`);
  return [
    `st(0,(t+${n(AUDIO_BLOCK / 2 / 48000)})*${fps}-${n(m.half)})`,
    `st(1,clip(ld(0),0,${n(m.duration)}))`,
    `st(2,${n(m.baseDb)}+${keys})`,
    parts.join("*"),
  ].join(";");
}

// ---- the plan ----

export interface PlanOptions {
  /** The file of a media item (relative paths resolved against the project folder). */
  readonly mediaPath: (media: Media) => string;
  readonly width: number;
  readonly height: number;
}

/** Everything the export draws and plays, or why there's nothing to export. */
export function planExport(project: Project, { mediaPath, width, height }: PlanOptions): ExportPlan | { readonly problem: string } {
  const fps = project.canvas.fps;
  const { starts, duration } = layout(project);
  if (!project.tracks.some((t) => t.items.length)) return { problem: "The timeline is empty: there's nothing to export yet." };
  const mediaOf = (item: Item) => (item.media ? project.media.find((m) => m.id === item.media) : undefined);
  const files = new Map<string, { media: Media; path: string }>();
  const fileOf = (media: Media) => {
    const path = mediaPath(media);
    files.set(media.id, { media, path });
    return path;
  };
  const aspect = project.canvas.width / project.canvas.height;
  const fills = (media: Media) => !!media.probe?.width && !!media.probe?.height && Math.abs(media.probe.width / media.probe.height - aspect) < 0.002;

  const visuals: Array<VisualLayer> = [];
  for (const track of [...project.tracks].reverse()) {
    if (track.hidden || track.kind === "audio") continue;
    track.items.forEach((item, i) => {
      const media = mediaOf(item);
      const isMedia = item.type === "clip" && media && media.kind !== "audio";
      const isSolid = item.type === "component" && item.component === SOLID;
      const isText = item.type === "text" && typeof item.text === "string";
      if (!isMedia && !isSolid && !isText) return;
      const start = starts.get(item.id)!;
      const span = spanOf(track, i, start);
      const f0 = Math.max(0, Math.ceil(span.from));
      const f1 = Math.min(duration, Math.ceil(span.to));
      if (f1 <= f0) return;
      const ramps = opacityRamps(item, start, span);
      const base = { item, track, f0, f1, ramps, ...(span.wipe ? { wipe: { st: span.from, d: 2 * span.half } } : {}) };
      if (isMedia) {
        const path = fileOf(media);
        // The box at every frame (D75): a plain one (no transform) keeps the full-frame chain.
        const boxes = Array.from({ length: f1 - f0 }, (_, k) => clipBox(item, project.canvas, media.probe, f0 + k - start));
        const plain = boxes.every((b) => isPlainBox(b, project.canvas));
        const rest = baseBox(item, project.canvas, media.probe);
        const geometry = plain ? {} : { geometry: { frames: boxes.map((b) => placementOf(b, width / project.canvas.width, height / project.canvas.height, rest)) } };
        const alpha = boxes.some((b) => b.opacity !== 1) ? { alpha: boxes.map((b) => b.opacity) } : {};
        const layer: VisualLayer =
          media.kind === "image"
            ? { ...base, ...alpha, kind: "image", file: path, fills: fills(media), ...geometry }
            : { ...base, ...alpha, kind: "video", file: path, source: sourceAt(project, item, f0 - start), speed: item.speed ?? 1, fills: fills(media), ...geometry };
        for (const pass of splitLoop(layer, project, start, { width, height })) visuals.push(...splitWipe(pass, fps));
        return;
      }
      // Text moves (rise, slide, wipe) are drawn by Chromium frame by frame; opacity is a ramp.
      const states: Array<string> = [];
      const index = new Map<string, number>();
      const frames: Array<number> = [];
      for (let f = f0; f < f1; f++) {
        const motion = isText ? animationAt(item, f - start, project.canvas, { skipIn: span.skipIn, skipOut: span.skipOut }).motion : {};
        const html = isText ? textHtml(item, project, { motion }) : solidHtml(item, project);
        let k = index.get(html);
        if (k === undefined) {
          k = states.length;
          states.push(html);
          index.set(html, k);
        }
        frames.push(k);
      }
      visuals.push(...splitWipe({ ...base, kind: "raster", states, frames }, fps));
    });
    // Dips to black: core's black layer over the main track, fading in to the cut and out after it.
    for (const dip of dipsOf(track, starts)) {
      const f0 = Math.max(0, Math.ceil(dip.cut - dip.half));
      const f1 = Math.min(duration, Math.ceil(dip.cut + dip.half));
      if (f1 <= f0) continue;
      const ramps: Array<Ramp> = [
        { type: "in", st: dip.cut - dip.half, d: dip.half },
        { type: "out", st: dip.cut, d: dip.half },
      ];
      visuals.push({ item: dip.item, track, f0, f1, ramps, kind: "raster", states: [solidHtml(dip.item, project)], frames: Array.from({ length: f1 - f0 }, () => 0) });
    }
  }

  const audio: Array<AudioLayer> = [];
  for (const track of project.tracks) {
    if (!trackAudible(project, track)) continue;
    track.items.forEach((item, index) => {
      const media = soundMedia(project, item);
      if (!media) return;
      const start = starts.get(item.id) ?? 0;
      const span = audioSpan(track, index, start);
      const gain: GainModel = {
        baseDb: (item.gainDb ?? 0) + (track.mixer?.gainDb ?? 0),
        keys: [...(item.gainKeys ?? [])].sort((a, b) => a.frame - b.frame),
        duration: item.duration,
        half: span.half,
        nextHalf: span.nextHalf,
        // A dip to black dips the sound: core fades it over half the dip instead of the item's own fade.
        fadeIn: span.dipIn > 0 ? span.dipIn : (item.fadeIn ?? 0),
        fadeOut: span.dipOut > 0 ? span.dipOut : (item.fadeOut ?? 0),
      };
      if (constantGain(gain) === 0) return;
      const from = Math.max(0, span.from);
      const source = Math.max(0, sourceAt(project, item, from - start));
      const length = item.loop ? media.probe?.frames : undefined;
      const cycle = length && (item.speed ?? 1) === 1 ? { cycle: { samples: Math.round((length * 48000) / fps), offset: Math.round(source * 48000) } } : {};
      audio.push({ item, file: fileOf(media), from, to: span.to, source, speed: item.speed ?? 1, loop: item.loop === true, gain, ...cycle });
    });
  }

  return {
    fps,
    canvas: { width: project.canvas.width, height: project.canvas.height },
    width,
    height,
    frames: duration,
    backgroundHtml: `<div style="position:absolute;inset:0;background:${canvasBackground(project)}"></div>`,
    visuals,
    audio,
    files: [...files.values()],
  };
}

// ---- ffmpeg ----

/** What the rasteriser made for a raster layer: one PNG, or a numbered sequence (one file per frame). */
export type RasterOutput = { readonly kind: "still"; readonly png: string } | { readonly kind: "sequence"; readonly pattern: string };

export interface Caps {
  readonly encoders: ReadonlySet<string>;
  readonly videotoolboxDecode: boolean;
  /** ffmpeg's major version (undefined for builds that don't say, e.g. git snapshots). */
  readonly major?: number | undefined;
}

/** How to hand ffmpeg a filter graph in a file: `-/filter_complex` from 7 on, `-filter_complex_script` before (deprecated since 7). */
export const graphFileArgs = (caps: Pick<Caps, "major">, file: string) => (caps.major !== undefined && caps.major < 7 ? ["-filter_complex_script", file] : ["-/filter_complex", file]);

/** Encoder arguments for a quality: VideoToolbox when this ffmpeg has it, else libx264. */
export function videoCodec(quality: Quality, caps: Caps, size: { width: number; height: number }, fps: number): Array<string> {
  const pixels = size.width * size.height * fps;
  const rate = (bitsPerPixel: number) => `${Math.max(1, Math.round((pixels * bitsPerPixel) / 1e5) / 10)}M`;
  // The encoders don't all write the colour tags they're given, so the bitstream filter does.
  const tags = (codec: "h264" | "hevc") => ["-bsf:v", `${codec}_metadata=colour_primaries=1:transfer_characteristics=1:matrix_coefficients=1:video_full_range_flag=0`];
  if (quality === "high" && caps.encoders.has("hevc_videotoolbox")) return ["-c:v", "hevc_videotoolbox", "-allow_sw", "1", "-profile:v", "main", "-b:v", rate(0.1), "-tag:v", "hvc1", ...tags("hevc")];
  if (caps.encoders.has("h264_videotoolbox")) {
    const bpp = quality === "draft" ? 0.06 : quality === "standard" ? 0.1 : 0.16;
    return ["-c:v", "h264_videotoolbox", "-allow_sw", "1", "-profile:v", "high", "-b:v", rate(bpp), ...(quality === "draft" ? ["-prio_speed", "1"] : []), "-tag:v", "avc1", ...tags("h264")];
  }
  const crf = quality === "draft" ? "26" : quality === "standard" ? "20" : "17";
  return ["-c:v", "libx264", "-preset", quality === "draft" ? "veryfast" : "medium", "-crf", crf, "-tag:v", "avc1", ...tags("h264")];
}

const atempo = (speed: number) => {
  const out: Array<string> = [];
  let s = speed;
  while (s > 100) (out.push("atempo=100"), (s /= 100));
  while (s < 0.5) (out.push("atempo=0.5"), (s /= 0.5));
  if (Math.abs(s - 1) > 1e-9) out.push(`atempo=${n(s)}`);
  return out;
};

const fadeFilters = (ramps: ReadonlyArray<Ramp>, fps: number) => ramps.map((r) => `fade=t=${r.type}:st=${n(Math.max(0, r.st) / fps)}:d=${n(r.d / fps)}:alpha=1`);

export interface AudioGraph {
  /** Input arguments for the audio layers, starting at input index `first`. */
  readonly inputs: Array<string>;
  /** Filter chains ending in the label [aout] (48 kHz stereo, `frames` long). */
  readonly filters: Array<string>;
}

/** The audio half of the graph. `loudnorm` is appended to the mix when given. */
export function audioGraph(plan: ExportPlan, first: number, loudnorm?: string): AudioGraph {
  const total = n(plan.frames / plan.fps);
  const inputs: Array<string> = [];
  const filters: Array<string> = [`anullsrc=r=48000:cl=stereo,atrim=duration=${total}[asil]`];
  const labels = ["[asil]"];
  plan.audio.forEach((layer, k) => {
    const index = first + k;
    const seconds = (layer.to - layer.from) / plan.fps;
    if (layer.cycle) inputs.push("-t", n(layer.cycle.samples / 48000 + 0.5), "-i", layer.file);
    else inputs.push(...(layer.loop ? ["-stream_loop", "-1"] : []), "-ss", n(layer.source), "-t", n(seconds * layer.speed + 0.05), "-i", layer.file);
    const constant = constantGain(layer.gain);
    const volume = constant !== undefined ? `volume=${n(constant)}` : `asetnsamples=n=${AUDIO_BLOCK}:p=0,volume=eval=frame:volume='${gainExpr(layer.gain, plan.fps)}'`;
    const delay = Math.round((layer.from / plan.fps) * 48000);
    filters.push(
      [
        `[${index}:a:0]aresample=48000`,
        // Mono plays at full level in both ears, as Web Audio up-mixes it in the preview.
        "pan=stereo|FL<FL+FC+BL+SL|FR<FR+FC+BR+SR",
        "aformat=sample_fmts=fltp:channel_layouts=stereo",
        ...(layer.cycle
          ? [
              // Exactly the media's length in project frames (padded if its sound is shorter), repeated.
              `apad=whole_len=${layer.cycle.samples}`,
              `atrim=end_sample=${layer.cycle.samples}`,
              `aloop=loop=-1:size=${layer.cycle.samples}`,
              `atrim=start_sample=${layer.cycle.offset}:end_sample=${layer.cycle.offset + Math.round(seconds * 48000)}`,
            ]
          : [`atrim=duration=${n(seconds * layer.speed)}`]),
        "asetpts=PTS-STARTPTS",
        ...atempo(layer.speed),
        volume,
        `adelay=delays=${delay}S:all=1`,
      ].join(",") + `[a${k}]`,
    );
    labels.push(`[a${k}]`);
  });
  const mix =
    labels.length === 1
      ? `[asil]anull`
      : `${labels.join("")}amix=inputs=${labels.length}:duration=first:dropout_transition=0:normalize=0`;
  filters.push(`${mix},atrim=duration=${total}${loudnorm ? `,${loudnorm},aresample=48000` : ""},aformat=sample_fmts=fltp:channel_layouts=stereo[aout]`);
  return { inputs, filters };
}

/**
 * For a video without colour tags (its height given), filters that make ffmpeg read it as the
 * preview shows it: Chromium on macOS takes BT.601 with SMPTE-C primaries below 720 lines (so the
 * primaries are converted to BT.709's) and BT.709 from 720 lines up. Tagged video: nothing.
 */
export const untaggedFilter = (height: number | undefined) =>
  height === undefined
    ? ""
    : height < 720
      ? "setparams=colorspace=smpte170m:color_primaries=smpte170m:color_trc=smpte170m:range=tv,colorspace=all=bt709:format=yuv420p,"
      : "setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv,";

export interface CommandOptions {
  /** Video files without colour tags, with their height (see untaggedFilter). */
  readonly untagged?: ReadonlyMap<string, number> | undefined;
  readonly background: string;
  readonly rasters: ReadonlyMap<VisualLayer, RasterOutput>;
  readonly caps: Caps;
  readonly quality: Quality;
  readonly loudnorm?: string | undefined;
  readonly output: string;
}

/**
 * One frame of a video file as the preview and the export show it at `source` seconds (D38): the
 * last source frame that starts at or before that moment. Seek up to a second early, shift the
 * timestamps so the moment is 0, and let fps (round=up) pick, then keep the first frame. Shared by
 * render_frames and contact sheets of media (D65); the export's own chain does the same per layer.
 */
export function sourceFramePick(source: number, fps: number): { readonly seekArgs: ReadonlyArray<string>; readonly filter: string } {
  const pre = Math.min(1, Math.max(0, source));
  return {
    seekArgs: ["-ss", n(source - pre), "-t", n(pre + 0.5)],
    filter: `setpts=PTS-${n(pre + 0.0001)}/TB,fps=${fps}:start_time=0:round=up,trim=end_frame=1,setpts=0`,
  };
}

// ---- boxes (D75) ----

/**
 * An ffmpeg expression for a per-frame value: values[i] when `v` (evaluated once, kept in slot
 * `slot`) is i; before 0 the first, past the end the last. Runs of one value collapse, and the
 * runs are searched as a balanced tree, so the expression stays shallow for long keyed stretches.
 */
export function frameLookup(values: ReadonlyArray<number>, v: string, slot = 9): string {
  const runs: Array<{ start: number; value: number }> = [];
  values.forEach((value, i) => {
    if (!runs.length || runs.at(-1)!.value !== value) runs.push({ start: i, value });
  });
  if (runs.length <= 1) return n(runs[0]?.value ?? 0);
  const tree = (lo: number, hi: number): string => {
    if (lo === hi) return n(runs[lo]!.value);
    const mid = (lo + hi + 1) >> 1;
    return `if(lt(ld(${slot}),${runs[mid]!.start}),${tree(lo, mid - 1)},${tree(mid, hi)})`;
  };
  return `st(${slot},${v});${tree(0, runs.length - 1)}`;
}

const same = (values: ReadonlyArray<number>) => values.every((x) => x === values[0]);

/**
 * A rounded-corner mask for a w×h box (one grey frame: 255 inside, the corners' edges
 * antialiased like the preview's border-radius), as a source chain ending in `label`.
 */
export const cornerMask = (w: number, h: number, r: number, fps: number, label: string) =>
  `color=c=black:s=${w}x${h}:r=${fps},trim=end_frame=1,format=gray,geq=lum='255*clip(${r}+0.5-hypot(max(max(${r}-X-0.5,X+0.5-${w - r}),0),max(max(${r}-Y-0.5,Y+0.5-${h - r}),0)),0,1)'[${label}]`;

/**
 * Graph lines that turn the picture at `input` into its box at `output` (D75): scaled to the
 * picture's size (per frame when the scale is keyed: `n` counts the layer's frames), padded and/or
 * cropped to the box (transparent where a contained picture doesn't reach), and its corners
 * rounded with a mask (multiplied into any alpha the picture has). The box's size never changes.
 */
export function boxGraph(frames: ReadonlyArray<Placement>, input: string, output: string, fps: number): Array<string> {
  const p0 = frames[0]!;
  const { w, h, radius } = p0;
  const cws = frames.map((p) => p.cw);
  const chs = frames.map((p) => p.ch);
  const fixed = same(cws) && same(chs);
  // The layer's frames are numbered from 0 at its first (pts on the 1/fps grid) when this runs.
  const local = `floor(t*${fps}+0.5)`;
  const scale = fixed ? `scale=w=${p0.cw}:h=${p0.ch}` : `scale=w='${frameLookup(cws, local)}':h='${frameLookup(chs, local)}':eval=frame`;
  // 4:4:4 (no chroma subsampling), so odd sizes and offsets are exact; converted where it's overlaid.
  const chain = [`${scale}:out_color_matrix=bt709:out_range=tv`, "format=yuva444p"];
  // The area holding both the picture and the box, relative to the box's top-left.
  const minX = Math.min(0, ...frames.map((p) => p.cx));
  const minY = Math.min(0, ...frames.map((p) => p.cy));
  const pw = Math.max(w, ...frames.map((p) => p.cx + p.cw)) - minX;
  const ph = Math.max(h, ...frames.map((p) => p.cy + p.ch)) - minY;
  if (fixed) {
    if (pw > p0.cw || ph > p0.ch) chain.push(`pad=w=${pw}:h=${ph}:x=${p0.cx - minX}:y=${p0.cy - minY}:color=black@0`);
    if (pw > w || ph > h) chain.push(`crop=w=${w}:h=${h}:x=${-minX}:y=${-minY}:exact=1`);
  } else {
    // A keyed zoom stays centred on the box: pad around the picture's centre, crop the box out.
    // Same parity as the box, so the crop sits exactly on the centre.
    const PW = Math.max(w, ...cws) + 2 + ((Math.max(w, ...cws) - w) % 2);
    const PH = Math.max(h, ...chs) + 2 + ((Math.max(h, ...chs) - h) % 2);
    chain.push(`pad=w=${PW}:h=${PH}:x='floor((ow-iw)/2)':y='floor((oh-ih)/2)':color=black@0:eval=frame`, `crop=w=${w}:h=${h}:x=${Math.floor((PW - w) / 2)}:y=${Math.floor((PH - h) / 2)}:exact=1`);
  }
  if (radius <= 0) return [`[${input}]${chain.join(",")}[${output}]`];
  const id = output;
  return [
    `[${input}]${chain.join(",")},split=2[${id}c][${id}a]`,
    cornerMask(w, h, radius, fps, `${id}m`),
    `[${id}a]alphaextract[${id}e]`,
    `[${id}e][${id}m]blend=all_mode=multiply[${id}k]`,
    `[${id}c][${id}k]alphamerge[${output}]`,
  ];
}

/** The box's opacity as filters on the alpha plane: a constant, or a value per frame (sendcmd). */
function alphaFilters(layer: VisualLayer, k: number, fps: number): Array<string> {
  if (!layer.alpha) return [];
  if (same(layer.alpha)) return [`lutyuv=a='val*${n(layer.alpha[0]!)}'`];
  const commands: Array<string> = [];
  layer.alpha.forEach((a, i) => {
    if (i > 0 && a === layer.alpha![i - 1]) return;
    commands.push(`${n(Math.max(0, layer.f0 + i - 0.5) / fps)} lutyuv@a${k} a val*${n(a)}`);
  });
  return [`sendcmd=c='${commands.join(";")}'`, `lutyuv@a${k}=a='val*${n(layer.alpha[0]!)}'`];
}

/** Where a boxed layer goes: overlay x and y, constant or per frame (from `t`, the frame time). */
function placeAt(layer: VisualLayer, frames: ReadonlyArray<Placement>, fps: number): { x: string; y: string } {
  const xs = frames.map((p) => p.x);
  const ys = frames.map((p) => p.y);
  const frame = `floor(t*${fps}+0.5)-${layer.f0}`;
  return { x: same(xs) ? String(xs[0]) : `'${frameLookup(xs, frame)}'`, y: same(ys) ? String(ys[0]) : `'${frameLookup(ys, frame)}'` };
}

/** The ffmpeg graph and arguments for the whole export (the graph goes in a file: -/filter_complex). */
export function exportCommand(plan: ExportPlan, opts: CommandOptions): { inputs: Array<string>; graph: string; outputArgs: Array<string> } {
  const { width: W, height: H, fps } = plan;
  const inputs: Array<string> = ["-i", opts.background];
  const graph: Array<string> = [];
  const toYuv = (alpha: boolean) => `scale=w=${W}:h=${H}:out_color_matrix=bt709:out_range=tv,format=${alpha ? "yuva420p" : "yuv420p"}`;
  graph.push(`[0:v]${toYuv(false)},loop=loop=${plan.frames - 1}:size=1:start=0,settb=1/${fps},setpts=N[b0]`);
  let base = "b0";
  plan.visuals.forEach((layer, k) => {
    const index = k + 1;
    const frames = layer.f1 - layer.f0;
    // A ramp can't start before frame 0 in ffmpeg; one that would (a fade-out as long as an item
    // at 0) starts at 0 instead, a frame's worth off.
    const fades = fadeFilters(layer.ramps, fps);
    const opacity = alphaFilters(layer, k, fps);
    const geo = layer.kind !== "raster" ? layer.geometry?.frames : undefined;
    let chain: Array<string>;
    if (layer.kind === "video") {
      // Seek a second early and let fps pick, for each frame, the last source frame that starts at
      // or before its source time (round=up), like the preview's <video> (D38).
      const pre = layer.cycle ? 0 : Math.min(1, layer.source);
      const length = layer.cycle ? layer.cycle.length / fps + 1 : pre + (frames / fps) * layer.speed + 1;
      inputs.push(...(opts.caps.videotoolboxDecode ? ["-hwaccel", "videotoolbox"] : []), ...(layer.cycle ? [] : ["-ss", n(layer.source - pre)]), "-t", n(length), "-i", layer.file);
      const decoded = `[${index}:v:0]${untaggedFilter(opts.untagged?.get(layer.file))}setpts=(PTS-${n(pre + 0.0001)}/TB)/${n(layer.speed)}`;
      let picked = [decoded, `fps=${fps}:start_time=0:round=up`, `trim=end_frame=${frames}`];
      if (layer.cycle) {
        // The media's frames once, made only as large as they're drawn, then repeated from `offset`.
        const { length: L, offset } = layer.cycle;
        const shrink = geo
          ? `scale=w=${Math.max(...geo.map((p) => p.cw))}:h=${Math.max(...geo.map((p) => p.ch))}`
          : `scale=w=${W}:h=${H}:force_original_aspect_ratio=decrease:force_divisible_by=2`;
        picked = [decoded, `fps=${fps}:start_time=0:round=up`, `trim=end_frame=${L}`, `${shrink}:out_color_matrix=bt709:out_range=tv`, `loop=loop=-1:size=${L}:start=0`, `trim=start_frame=${offset}:end_frame=${offset + frames}`, `settb=1/${fps}`, "setpts=N"];
      }
      if (geo) {
        // A box (D75): the picture made into its box, then placed by the overlay.
        graph.push(`${picked.join(",")}[p${k}]`, ...boxGraph(geo, `p${k}`, `q${k}`, fps));
        chain = [`[q${k}]setpts=PTS-STARTPTS+${layer.f0}`, ...fades, ...opacity];
      } else {
        const alpha = !layer.fills || fades.length > 0 || !!layer.wipe || opacity.length > 0;
        chain = [
          ...picked,
          `scale=w=${W}:h=${H}:force_original_aspect_ratio=decrease:force_divisible_by=2:out_color_matrix=bt709:out_range=tv`,
          `format=${alpha ? "yuva420p" : "yuv420p"}`,
          ...(layer.fills ? [] : [`pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black@0`]),
          `setpts=PTS-STARTPTS+${layer.f0}`,
          ...fades,
          ...opacity,
        ];
      }
    } else if (layer.kind === "image") {
      inputs.push("-f", "image2", "-pattern_type", "none", "-i", layer.file);
      const looped = [`loop=loop=${frames - 1}:size=1:start=0`, `settb=1/${fps}`];
      if (geo && same(geo.map((p) => p.cw)) && same(geo.map((p) => p.ch))) {
        // A still in a box of one size: made into its box once, then repeated.
        graph.push(...boxGraph(geo, `${index}:v:0`, `q${k}`, fps));
        chain = [`[q${k}]${looped.join(",")}`, `setpts=N+${layer.f0}`, ...fades, ...opacity];
      } else if (geo) {
        // A keyed zoom: repeated first, then sized frame by frame.
        graph.push(`[${index}:v:0]${looped.join(",")},setpts=N[p${k}]`, ...boxGraph(geo, `p${k}`, `q${k}`, fps));
        chain = [`[q${k}]setpts=PTS-STARTPTS+${layer.f0}`, ...fades, ...opacity];
      } else {
        chain = [
          `[${index}:v:0]scale=w=${W}:h=${H}:force_original_aspect_ratio=decrease:force_divisible_by=2:out_color_matrix=bt709:out_range=tv`,
          "format=yuva420p",
          ...(layer.fills ? [] : [`pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black@0`]),
          ...looped,
          `setpts=N+${layer.f0}`,
          ...fades,
          ...opacity,
        ];
      }
    } else {
      const raster = opts.rasters.get(layer);
      if (!raster) throw new Error(`no raster for ${layer.item.id}`);
      if (raster.kind === "still") {
        inputs.push("-f", "image2", "-pattern_type", "none", "-i", raster.png);
        chain = [`[${index}:v:0]${toYuv(true)}`, `loop=loop=${frames - 1}:size=1:start=0`, `settb=1/${fps}`, `setpts=N+${layer.f0}`, ...fades];
      } else {
        inputs.push("-f", "image2", "-framerate", String(fps), "-start_number", "0", "-i", raster.pattern);
        chain = [`[${index}:v:0]${toYuv(true)}`, `trim=end_frame=${frames}`, `settb=1/${fps}`, `setpts=N+${layer.f0}`, ...fades];
      }
    }
    // A wipe: the layer shows only its left X pixels (X even, the chroma grid): padded with W
    // transparent pixels on the left, a W-wide window at X holds the hidden part then the shown
    // one, and overlaying it X − W to the left puts the shown part back where it was. Both
    // expressions see the same frame time, so they agree on X.
    let at = "";
    let fmt = "auto";
    if (geo && layer.wipe) {
      // A boxed layer is put on a transparent canvas first: a wipe reveals the canvas from the left.
      const place = placeAt(layer, geo, fps);
      graph.push(`${chain.join(",")}[x${k}]`);
      graph.push(`color=c=black@0:s=${W}x${H}:r=${fps},format=yuva444p,trim=end_frame=${frames},setpts=N+${layer.f0}[c${k}]`);
      graph.push(`[c${k}][x${k}]overlay=x=${place.x}:y=${place.y}:format=yuv444:eof_action=pass:repeatlast=0[y${k}]`);
      chain = [`[y${k}]null`];
    } else if (geo) {
      const place = placeAt(layer, geo, fps);
      // Overlaid in 4:4:4: on 4:2:0 an odd x or y would snap to even (2-pixel steps on a slow pan).
      at = `:x=${place.x}:y=${place.y}`;
      fmt = "yuv444";
    }
    if (layer.wipe) {
      const x = `2*floor(${W}*clip((t*${fps}+0.0001-${n(layer.wipe.st)})/${n(layer.wipe.d)},0,1)/2)`;
      chain.push(`pad=${2 * W}:${H}:${W}:0:color=black@0`, `crop=w=${W}:h=${H}:x='${x}':y=0`);
      at = `:x='${x}-${W}':y=0`;
    }
    graph.push(`${chain.join(",")}[l${k}]`);
    graph.push(`[${base}][l${k}]overlay=eof_action=pass:format=${fmt}:repeatlast=0${at}[b${k + 1}]`);
    base = `b${k + 1}`;
  });
  // fps on frames already on the 1/fps grid passes them through one to one; it gives the stream its rate.
  graph.push(`[${base}]format=yuv420p,fps=${fps},trim=end_frame=${plan.frames}[vout]`);
  const audio = audioGraph(plan, plan.visuals.length + 1, opts.loudnorm);
  inputs.push(...audio.inputs);
  graph.push(...audio.filters);
  const outputArgs = [
    "-map",
    "[vout]",
    "-map",
    "[aout]",
    ...videoCodec(opts.quality, opts.caps, plan, fps),
    "-pix_fmt",
    "yuv420p",
    "-colorspace",
    "bt709",
    "-color_primaries",
    "bt709",
    "-color_trc",
    "bt709",
    "-color_range",
    "tv",
    // The graph already makes one frame per 1/fps; ffmpeg's own constant-frame-rate pass would
    // shift the picture by a frame when inputs are seeked (seen on the DJI clip), so it's off.
    "-fps_mode",
    "passthrough",
    "-c:a",
    "aac",
    "-b:a",
    opts.quality === "draft" ? "128k" : "192k",
    "-ar",
    "48000",
    "-t",
    n(plan.frames / fps),
    "-movflags",
    "+faststart",
    "-f",
    "mp4",
    opts.output,
  ];
  return { inputs, graph: graph.join(";\n"), outputArgs };
}

/**
 * A problem ffmpeg reported but didn't stop for (it exits 0): a scaler or filter that failed on
 * some frames leaves a picture missing (seen with too many inputs at once). The export fails then.
 */
export function silentFailure(stderr: string): string | undefined {
  const line = stderr.split("\n").find((l) => /\[swscaler[^\]]*\].*(error|fail|cannot|invalid)/i.test(l) || /Error while (filtering|processing)|Failed to inject frame/i.test(l));
  return line?.trim();
}

/** The first pass of two-pass loudnorm: measure the mix (audio only, nothing written). */
export function loudnessCommand(plan: ExportPlan, target: number): { inputs: Array<string>; graph: string; outputArgs: Array<string> } {
  const audio = audioGraph(plan, 0, `loudnorm=I=${target}:TP=-1:LRA=11:print_format=json`);
  return { inputs: audio.inputs, graph: audio.filters.join(";\n"), outputArgs: ["-map", "[aout]", "-f", "null", "-"] };
}

export interface LoudnessMeasure {
  readonly input_i: string;
  readonly input_tp: string;
  readonly input_lra: string;
  readonly input_thresh: string;
  readonly target_offset: string;
}

/** loudnorm's JSON from the first pass's stderr, or undefined (e.g. silence: nothing to normalise). */
export function parseLoudness(stderr: string): LoudnessMeasure | undefined {
  const m = /\{[^{}]*"input_i"[^{}]*\}/s.exec(stderr);
  if (!m) return undefined;
  try {
    const j = JSON.parse(m[0]) as LoudnessMeasure;
    return Number.isFinite(Number(j.input_i)) && Number(j.input_i) > -70 ? j : undefined;
  } catch {
    return undefined;
  }
}

/** The second pass's loudnorm filter, linear (one gain for the whole mix) when the measure allows it. */
export const loudnormFilter = (target: number, m: LoudnessMeasure) =>
  `loudnorm=I=${target}:TP=-1:LRA=11:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true:print_format=none`;
