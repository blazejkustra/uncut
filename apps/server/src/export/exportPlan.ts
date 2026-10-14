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
//   RENDER_CSS; a text whose look moves (rise, slide, wipe, word by word, zoom: D81) gets one PNG per distinct state, capped like a component's.
//   Components (D76) are PNGs of core's componentHtml, one per distinct look (an animated one, a
//   terminal typing, gets one per frame its look changes; past MAX_RASTER_STATES looks it holds
//   frames, with a warning), their box's opacity baked into the HTML. SVG images are drawn by
//   Chromium at their box's size (ffmpeg can't decode SVG). A graphic item (D78) is its document
//   drawn frame by frame (render(t) called), capped the same way. Captions (D82) are one raster
//   layer per captions item from its first card to its last: core captionAt's text item at each
//   frame drawn by textHtml (an empty state between cards), one PNG per distinct card / speaking
//   word. Not capped: each card has at most its words + 1 looks, so a long talk is many small sets.
//   Opacity (a transition's crossfade, fade/rise/slide in and out) is linear in frames, so it is
//   ffmpeg's fade on the layer's alpha, evaluated at the same frames (time mode). A dip to black
//   is core's black layer over the main track (a raster with two ramps); a wipe crops the
//   incoming layer from the left at the same frames (pad + crop + overlay x, per frame); an iris
//   multiplies a growing disc (a per-frame geq mask) into its alpha (D79). A push or zoom moves the
//   item's box (core moveBox: per-frame boxes as for keys); text, backgrounds and graphics get the
//   canvas as a box. The frames a transition reveals or moves are a layer of their own, so the rest
//   of the item keeps the plain chain.
// - Sound: every item audibleAt would return, from its media at the same source time, with the
//   gain of core itemGain (combined dB with the −60 dB cutoff, gainKeys, fades, transition
//   crossfades) as one volume expression per item, panned by its track (D83), mixed with amix
//   normalize=0 (D54), then the master volume (D83). Ducking (D85) is core's duck curve folded into
//   each item's volume expression on the ducked track (the same dB the preview adds). A track with
//   effects (D84: EQ, compressor, voice, noise removal) is summed on its own first (amix over a
//   silent base), run through its stages in list order (core trackStages → stageFilter) and panned
//   after them; then the tracks are summed. After the master volume: the loudness gain (D87) and
//   the master limiter last (D86: alimiter at 4× oversampling, a small true-peak margin).
// - A frame f is the moment f / fps (D38); a clip shows the source frame on screen at its source
//   time, as the preview's <video> does (the last frame that starts at or before it).
import {
  animationAt,
  moveFades,
  audioSpan,
  baseBox,
  canvasBox,
  clipBox,
  blurs,
  fadesIn,
  IRIS,
  maskGeq,
  maskOf,
  moveBox,
  movesIncoming,
  movesOutgoing,
  reveals,
  type MaskShape,
  transitionAt,
  isPlainBox,
  type ClipBox,
  type Rect,
  dipsOf,
  spanOf,
  canvasBackground,
  captionSegments,
  isPlainCue,
  isSubtitleTrack,
  componentBox,
  componentParts,
  wrapComponent,
  graphicDocument,
  graphicInfo,
  isDrawnComponent,
  isSvg,
  layout,
  MAX_RASTER_STATES,
  outputSize,
  RENDER_CSS,
  SILENCE_DB,
  SOLID,
  solidHtml,
  soundMedia,
  heldPast,
  sourceAt,
  textHtml,
  trackAudible,
  mixNote,
  masterGain,
  panGains,
  trackPan,
  type ExportQuality,
  type Item,
  duckCurves,
  duckKeysIn,
  pwlAt,
  duckNote,
  masterLimiter,
  LIMITER_MARGIN_DB,
  noiseFloorDb,
  trackStages,
  DENOISE_FLOOR_DB,
  type DuckKey,
  type SpeechEnvelope,
  type Stage,
  type Span,
  type Media,
  type Project,
  type Track,
  clipFx,
  colourLut,
  fitRect,
  fxBox,
  fxOverlayHtml,
  hasOverlay,
  needsPicturePass,
  shakeExpr,
  shakeZoom,
  type ClipFx,
  type ColourLut,
} from "@uncut/core";

export type Quality = ExportQuality;
export { outputSize };


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
  /** An iris transition into it (D79): shown inside a circle at the canvas's centre, radius 0 at frame `st` to the half diagonal at st + d. */
  readonly iris?: { readonly st: number; readonly d: number };
  /** A reveal shape into it (D133): shown inside core's maskDistance shape, share 0 at frame `st` to 1 at st + d. */
  readonly mask?: { readonly shape: MaskShape; readonly st: number; readonly d: number };
  /** A blur dissolve (D133): the Gaussian sigma in output px for each frame from f0; absent when never blurred. */
  readonly blur?: ReadonlyArray<number>;
  /**
   * Its box for each frame from f0 (D75): a clip's (absent: the plain full frame, drawn as before
   * D75), or the canvas moved by a push or zoom for text, backgrounds and graphics (D79).
   */
  readonly geometry?: Geometry;
  /** The box's opacity (transform.opacity, opacity keys) for each frame from f0; absent when always 1. */
  readonly alpha?: ReadonlyArray<number>;
}

/**
 * A clip's picture effects (D136): what they draw (core clipFx), the clip's start (frame), the size
 * (output px) the picture is made before them, and output px per canvas px. They run on the picture
 * before its box (fxGraph); the box (geometry) is always there when they are.
 */
export interface LayerFx {
  readonly fx: ClipFx;
  readonly start: number;
  readonly w: number;
  readonly h: number;
  readonly k: number;
  /** The colour table (core colourLut), when the colour changes. */
  readonly lut?: ColourLut;
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
      /**
       * A looped clip played from one input (D75 review): the media's first `length` project frames
       * are decoded once and repeated (ffmpeg's loop filter), frame f0 showing frame `offset` of them.
       */
      readonly cycle?: { readonly length: number; readonly offset: number };
      /** A held clip (D94): the source time (s) of its media's last frame, where its source stops. */
      readonly last?: number;
      readonly fx?: LayerFx;
    })
  | (LayerBase & { readonly kind: "image"; readonly file: string; readonly fills: boolean; readonly fx?: LayerFx })
  | (LayerBase & {
      readonly kind: "raster";
      /** HTML of each distinct look, at canvas size. */
      readonly states: ReadonlyArray<string>;
      /** For each frame from f0, the index of its look. */
      readonly frames: ReadonlyArray<number>;
    })
  | (LayerBase & {
      readonly kind: "graphic";
      /** The graphic's document (core graphicDocument), drawn at canvas size. */
      readonly doc: string;
      /** For each frame from f0, the frame from the item's start drawn there (held frames repeat one). */
      readonly frames: ReadonlyArray<number>;
    });

/** The placeholder a component's media reference becomes in the plan's HTML; the exporter swaps in a data: URL. */
export const MEDIA_TOKEN = "uncut-media:";
export const mediaToken = (id: string) => `${MEDIA_TOKEN}${id}`;

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
  /** The track's ducking over this item (D85): core's duck keys, frames from the item's start; absent when none. */
  readonly duck?: ReadonlyArray<DuckKey>;
}

export interface AudioLayer {
  readonly item: Item;
  /** The item's track id (a track with effects is summed on its own bus first). */
  readonly track: string;
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
  /** The track's pan as left / right factors on the stereo sound (core panGains, D83); 1/1 at centre. */
  readonly pan: { readonly left: number; readonly right: number };
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
  /** The master volume after the tracks are summed (core masterGain, D83), as a linear factor. */
  readonly masterGain: number;
  /**
   * Tracks with effects (D84): their items are summed first, run through `stages` in order, then
   * panned (`pan`, as each item would have been). Other tracks' items go straight into the mix.
   */
  readonly buses: ReadonlyArray<{ readonly track: string; readonly stages: ReadonlyArray<Stage>; readonly pan: { readonly left: number; readonly right: number } }>;
  /** The master limiter (D86), last in the chain; absent when bypassed. */
  readonly limiter?: { readonly ceilingDb: number } | undefined;
  /** Every media file the export reads. */
  readonly files: ReadonlyArray<{ readonly media: Media; readonly path: string }>;
  /** What the export draws differently from the preview (a capped animation), as sentences. */
  readonly warnings: ReadonlyArray<string>;
}

/** The CSS every rasterised layer gets: the preview's (D53). */
export const RASTER_CSS = RENDER_CSS;

// ---- opacity ----


/**
 * The opacity ramps of an item as visualsAt computes its opacity: a crossfade's (0 at `from` → 1
 * at start + half, a zoom's too; a wipe, iris or push changes no opacity), then the in and out animations (core
 * moveFades: fade, rise, slide-left and a fading text zoom change opacity; wipe and word by word don't), skipped on a side where a main-track transition blends.
 */
export function opacityRamps(item: Item, start: number, span: Pick<Span, "half" | "skipIn" | "skipOut" | "into">): Array<Ramp> {
  const ramps: Array<Ramp> = [];
  // A crossfade or zoom fades the incoming clip in; a wipe, iris or push doesn't (core incomingFx).
  if (span.half > 0 && fadesIn(span.into ?? "")) ramps.push({ type: "in", st: start - span.half, d: 2 * span.half });
  const a = item.animation;
  if (!span.skipIn && a?.in && a.in.duration > 0 && moveFades(item, a.in)) ramps.push({ type: "in", st: start, d: a.in.duration });
  if (!span.skipOut && a?.out && a.out.duration > 0 && moveFades(item, a.out)) ramps.push({ type: "out", st: start + item.duration - 1 - a.out.duration, d: a.out.duration });
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

/** An iris's mask is computed at 1/this of the output size, then scaled up (D79 review: geq per pixel is costly). */
export const IRIS_MASK_STEP = 4;

/** gblur's passes for a blur dissolve (D133): more is closer to a true Gaussian (Chromium's CSS blur). */
export const BLUR_STEPS = 3;

/** The transparent margin a blurred layer gets (px, even): 3 sigma, where a Gaussian has all but 0.3 % of its weight. */
export const blurPad = (sigma: number) => 2 * Math.ceil((3 * sigma + 1) / 2);

/** A blur dissolve's filters at one sigma (output px), as the export's (render_frames). */
export const blurFilters = (sigma: number) => {
  const pad = blurPad(sigma);
  return `pad=w=iw+${2 * pad}:h=ih+${2 * pad}:x=${pad}:y=${pad}:color=black@0,premultiply=inplace=1,gblur=sigma=${n(sigma)}:steps=${BLUR_STEPS},unpremultiply=inplace=1,crop=w=iw-${2 * pad}:h=ih-${2 * pad}:x=${pad}:y=${pad}`;
};

/** The share of the half diagonal an iris shows at frame f (core visualsAt's `iris`; 1 when whole). */
export const irisAt = (iris: VisualLayer["iris"], f: number) => (iris ? Math.min(1, Math.max(0, (f - iris.st) / iris.d)) : 1);

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
  const common = { f0: from, f1: to, ...(layer.alpha ? { alpha: layer.alpha.slice(a, b) } : {}), ...(layer.blur ? { blur: layer.blur.slice(a, b) } : {}), ...(layer.geometry ? { geometry: { frames: layer.geometry.frames.slice(a, b) } } : {}) };
  if (layer.kind === "raster") return { ...layer, ...common, ...compactStates(layer.states, layer.frames.slice(a, b)) };
  if (layer.kind === "graphic") return { ...layer, ...common, frames: layer.frames.slice(a, b) };
  if (layer.kind === "video" && layer.cycle) return { ...layer, ...common, cycle: { ...layer.cycle, offset: (layer.cycle.offset + a) % layer.cycle.length }, source: (((layer.cycle.offset + a) % layer.cycle.length) / fps) };
  if (layer.kind === "video") return { ...layer, ...common, source: Math.min(source ?? layer.source + (a * layer.speed) / fps, layer.last ?? Infinity) };
  return { ...layer, ...common };
}

/** A slice's looks: only the ones its frames use (in first-use order), the frames renumbered (D79 review). */
export function compactStates(states: ReadonlyArray<string>, frames: ReadonlyArray<number>): { states: Array<string>; frames: Array<number> } {
  const index = new Map<number, number>();
  const kept: Array<string> = [];
  const renumbered = frames.map((k) => {
    let j = index.get(k);
    if (j === undefined) {
      j = kept.length;
      index.set(k, j);
      kept.push(states[k]!);
    }
    return j;
  });
  return { states: kept, frames: renumbered };
}

/** The distinct looks the rasteriser draws for a plan: each raster state once, however many layers or slices share it. */
export const rasterLooks = (plan: Pick<ExportPlan, "visuals">) => [...new Set(plan.visuals.flatMap((l) => (l.kind === "raster" ? l.states : [])))];

/**
 * Where an item's layer is cut so a transition's frames are a layer of their own (D73, D79): the
 * end of a wipe or iris into it (`revealEnd`: the reveal is dropped after it; always cut) and the
 * end of a push into it or the start of a push or zoom out of it (`moves`: cut only where the
 * geometry stops or starts being needed, so a boxed clip isn't cut for nothing). The
 * pad/crop/mask/box work runs only over those frames.
 */
interface Cuts {
  readonly revealEnd?: number;
  /** Always cut here too (D133: where a blur starts or stops). */
  readonly always?: ReadonlyArray<number>;
  readonly moves: ReadonlyArray<number>;
  /** The item's frames whose box is plain (no geometry needed), when it has geometry. */
  readonly plain?: (f: number) => boolean;
}

function splitAt(layer: VisualLayer, cuts: Cuts, fps: number): Array<VisualLayer> {
  const allPlain = (a: number, b: number) => {
    for (let f = a; f < b; f++) if (!cuts.plain!(f)) return false;
    return true;
  };
  const inside = (c: number) => c > layer.f0 && c < layer.f1;
  const reveal = [...(cuts.revealEnd !== undefined && inside(cuts.revealEnd) && (layer.wipe || layer.iris || layer.mask) ? [cuts.revealEnd] : []), ...(layer.blur ? (cuts.always ?? []).filter(inside) : [])];
  const candidates = [...new Set([...reveal, ...cuts.moves.filter(inside)])].sort((a, b) => a - b);
  // A move's cut is kept only where the frames on its two sides differ in needing geometry.
  const kept: Array<number> = [];
  for (const [i, c] of candidates.entries()) {
    if (reveal.includes(c)) {
      kept.push(c);
      continue;
    }
    if (!layer.geometry || !cuts.plain) continue;
    const before = kept.at(-1) ?? layer.f0;
    const after = candidates[i + 1] ?? layer.f1;
    if (allPlain(before, c) !== allPlain(c, after)) kept.push(c);
  }
  const points = [layer.f0, ...kept, layer.f1];
  const out: Array<VisualLayer> = [];
  for (let i = 0; i + 1 < points.length; i++) {
    const [a, b] = [points[i]!, points[i + 1]!];
    let slice = points.length === 2 ? layer : sliceLayer(layer, a, b, fps);
    if (cuts.revealEnd !== undefined && a >= cuts.revealEnd && (slice.wipe || slice.iris || slice.mask)) {
      const { wipe, iris, mask, ...rest } = slice;
      slice = rest as VisualLayer;
    }
    if (slice.blur && slice.blur.every((b) => b === 0)) {
      const { blur, ...rest } = slice;
      slice = rest as VisualLayer;
    }
    if (slice.geometry && cuts.plain) {
      let plain = true;
      for (let f = a; f < b && plain; f++) plain = cuts.plain(f);
      if (plain) {
        const { geometry, ...rest } = slice;
        slice = rest as VisualLayer;
      }
    }
    out.push(slice);
  }
  return out;
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

/** core duckDbAt on keys local to the item, held at the first / last key (whose dB is 0 at the curve's real ends): core pwlAt. */
const duckDb = (keys: ReadonlyArray<DuckKey>, local: number) => pwlAt(keys, local);

/** The model's gain at `local` frames from the item's start: core itemGain, restated so it can be turned into an expression. */
export function gainAt(m: GainModel, local: number): number {
  const db = m.baseDb + keyDb(m.keys, Math.min(m.duration, Math.max(0, local))) + (m.duck?.length ? duckDb(m.duck, local) : 0);
  let g = db <= SILENCE_DB ? 0 : 10 ** (db / 20);
  if (!(m.half > 0) && m.fadeIn > 0) g *= clamp01(local / m.fadeIn);
  if (!(m.nextHalf > 0) && m.fadeOut > 0) g *= clamp01((m.duration - local) / m.fadeOut);
  if (m.half > 0) g *= clamp01((local + m.half) / (2 * m.half));
  if (m.nextHalf > 0) g *= clamp01((m.duration + m.nextHalf - local) / (2 * m.nextHalf));
  return g;
}

/** The gain when it never changes over the item (no keys, fades or transitions), else undefined. */
export function constantGain(m: GainModel): number | undefined {
  if (m.keys.length > 1 || m.half > 0 || m.nextHalf > 0 || m.fadeIn > 0 || m.fadeOut > 0 || m.duck?.length) return undefined;
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
  // The duck curve (D85) on the unclamped local frame, as a balanced tree so a long curve stays shallow.
  const duck = m.duck?.length ? `+${pwlExpr(m.duck, "ld(0)")}` : "";
  return [
    `st(0,(t+${n(AUDIO_BLOCK / 2 / 48000)})*${fps}-${n(m.half)})`,
    `st(1,clip(ld(0),0,${n(m.duration)}))`,
    `st(2,${n(m.baseDb)}+${keys}${duck})`,
    parts.join("*"),
  ].join(";");
}

/**
 * A piecewise-linear curve (keys sorted by frame, held at both ends; a step where two keys share a
 * frame, the later one winning from that frame on, as core duckDbAt) as an ffmpeg expression of `x`,
 * nested as a balanced tree of comparisons (depth log2 of the keys).
 */
export function pwlExpr(keys: ReadonlyArray<DuckKey>, x: string): string {
  if (!keys.length) return "0";
  if (keys.length === 1) return n(keys[0]!.db);
  const seg = (i: number) => {
    const a = keys[i]!;
    const b = keys[i + 1]!;
    return b.frame === a.frame || b.db === a.db ? n(b.db) : `(${n(a.db)}+(${n(b.db - a.db)})*(${x}-${n(a.frame)})/${n(b.frame - a.frame)})`;
  };
  const tree = (lo: number, hi: number): string => {
    if (lo === hi) return seg(lo);
    const mid = (lo + hi) >> 1;
    return `if(lt(${x},${n(keys[mid + 1]!.frame)}),${tree(lo, mid)},${tree(mid + 1, hi)})`;
  };
  return `if(lt(${x},${n(keys[0]!.frame)}),${n(keys[0]!.db)},if(gte(${x},${n(keys.at(-1)!.frame)}),${n(keys.at(-1)!.db)},${tree(0, keys.length - 2)}))`;
}

// ---- the plan ----

export interface PlanOptions {
  /** The file of a media item (relative paths resolved against the project folder). */
  readonly mediaPath: (media: Media) => string;
  readonly width: number;
  readonly height: number;
  /** A graphic item's file contents (D78), by its src; undefined when it can't be read. */
  readonly graphic?: ((src: string) => string | undefined) | undefined;
  /**
   * The loudness envelopes (D74) of the media on ducking key tracks (D85), by media id (null:
   * analysed, no sound). A key media missing here ducks nothing, with a warning.
   */
  readonly envelopes?: ReadonlyMap<string, SpeechEnvelope | null> | undefined;
  /** Draw captions and Subtitles tracks into the picture (D105; default true). Off: a soft track or a file carries them instead. */
  readonly burnCaptions?: boolean | undefined;
}

/**
 * Looks per frame, at most `cap` distinct: when there are more, frames are held (every k-th
 * frame's look is shown for k frames, the smallest k that fits). Returns the looks, each frame's
 * index and the hold (1 = every frame drawn).
 */
export function capStates(looks: ReadonlyArray<string>, cap = MAX_RASTER_STATES): { states: Array<string>; frames: Array<number>; hold: number } {
  for (let hold = 1; ; hold++) {
    const states: Array<string> = [];
    const index = new Map<string, number>();
    const frames: Array<number> = [];
    for (let i = 0; i < looks.length; i++) {
      const html = looks[i - (i % hold)]!;
      let k = index.get(html);
      if (k === undefined) {
        k = states.length;
        states.push(html);
        index.set(html, k);
      }
      frames.push(k);
    }
    if (states.length <= cap || hold >= looks.length) return { states, frames, hold };
  }
}

/** An SVG image clip's box as HTML (D76): the picture at its content rect in a box that clips and rounds it, Chromium-drawn at canvas size. */
export function svgClipHtml(item: Item, box: ClipBox, src: string, opacity: number): string {
  const r = (n: number) => `${Math.round(n * 1000) / 1000}px`;
  const c = box.content;
  return `<div data-item="${item.id}" style="position:absolute;left:${r(box.x)};top:${r(box.y)};width:${r(box.w)};height:${r(box.h)};overflow:hidden;opacity:${Math.round(opacity * 10000) / 10000}${box.radius > 0 ? `;border-radius:${r(box.radius)}` : ""}"><img src="${src}" alt="" style="position:absolute;display:block;left:${r(c.x - box.x)};top:${r(c.y - box.y)};width:${r(c.w)};height:${r(c.h)};object-fit:${box.fit}"></div>`;
}

/** A captions layer between cards: nothing drawn (a transparent PNG). */
export const CAPTION_GAP_HTML = "<div></div>";
/** At most this many layers (ffmpeg inputs) per captions item: runs of cards closest together are merged. */
export const MAX_CAPTION_LAYERS = 16;
/** Past this many looks, the export says captions add time (each look is one PNG Chromium draws). */
export const CAPTION_LOOKS_WARN = 1500;
/** Roughly how many caption looks the rasteriser draws a second (for that warning's estimate). */
const CAPTION_LOOKS_PER_S = 25;

/**
 * Captions (D82) as raster layers: core captionSegments gives each stretch with one look (a card, or
 * a card with one speaking word), so textHtml runs once per look, not per frame. Touching segments
 * form a run (one layer: a still when it has one look, else a sequence of its looks); the gaps
 * between runs draw nothing and cost nothing. Past MAX_CAPTION_LAYERS runs, those with the shortest
 * gaps between them are merged (the gap is an empty look). Not capped at MAX_RASTER_STATES: each
 * card has at most its words + 1 looks.
 */
export function captionLayers(project: Project, item: Item, track: Track, duration: number, warnings: Array<string>): Array<VisualLayer> {
  return segmentLayers(project, item, track, captionSegments(project, item), duration, warnings);
}

/**
 * A Subtitles track's plain text items (D105: an imported .srt / .vtt, one item per cue) as the
 * same few layers as captions: each cue a still look over its frames, touching cues one run.
 * Drawn exactly as each text item alone would be (no motion, keys or opacity of their own), without
 * an ffmpeg input per cue.
 */
export function subtitleLayers(project: Project, track: Track, items: ReadonlyArray<Item>, starts: ReadonlyMap<string, number>, duration: number, warnings: Array<string>): Array<VisualLayer> {
  if (!items.length) return [];
  const segs = items.map((it) => ({ from: starts.get(it.id) ?? it.start ?? 0, to: (starts.get(it.id) ?? it.start ?? 0) + it.duration, text: it })).sort((a, b) => a.from - b.from);
  return segmentLayers(project, { ...items[0]!, name: track.name }, track, segs, duration, warnings);
}

/**
 * A Subtitles track's cues that can share layers: plain ones that overlap no other item on the track.
 * Overlapping cues (a user dragged one onto another) each take the normal text path, so both draw, as in the preview.
 */
export function mergeableCues(track: Track, starts: ReadonlyMap<string, number>): Array<Item> {
  const spans = track.items.map((it) => ({ it, from: starts.get(it.id) ?? it.start ?? 0 })).map((x) => ({ ...x, to: x.from + x.it.duration })).sort((a, b) => a.from - b.from);
  const overlapping = new Set<Item>();
  let last: (typeof spans)[number] | undefined;
  for (const x of spans) {
    if (last && x.from < last.to) {
      overlapping.add(x.it);
      overlapping.add(last.it);
    }
    if (!last || x.to > last.to) last = x;
  }
  return track.items.filter((it) => isPlainCue(it) && !overlapping.has(it));
}

/** Stretches of one look each (a card, a speaking word, a cue) as raster layers: touching stretches one run, at most MAX_CAPTION_LAYERS runs. */
function segmentLayers(project: Project, item: Item, track: Track, all: ReadonlyArray<{ readonly from: number; readonly to: number; readonly text: Item }>, duration: number, warnings: Array<string>): Array<VisualLayer> {
  const segs = all
    .map((s) => ({ from: Math.max(0, s.from), to: Math.min(duration, s.to), text: s.text }))
    .filter((s) => s.to > s.from);
  if (!segs.length) return [];
  const runs: Array<Array<(typeof segs)[number]>> = [];
  for (const s of segs) {
    const run = runs.at(-1);
    if (run && run.at(-1)!.to === s.from) run.push(s);
    else runs.push([s]);
  }
  // Merge across the shortest gaps until few enough layers.
  while (runs.length > MAX_CAPTION_LAYERS) {
    let best = 0;
    for (let i = 1; i < runs.length - 1; i++) if (runs[i + 1]![0]!.from - runs[i]!.at(-1)!.to < runs[best + 1]![0]!.from - runs[best]!.at(-1)!.to) best = i;
    runs.splice(best, 2, [...runs[best]!, ...runs[best + 1]!]);
  }
  const html = new Map<Item, string>();
  let looks = 0;
  const layers = runs.map((run): VisualLayer => {
    const f0 = run[0]!.from;
    const f1 = run.at(-1)!.to;
    const states: Array<string> = [];
    const index = new Map<string, number>();
    const at = (h: string) => index.get(h) ?? (index.set(h, states.push(h) - 1), states.length - 1);
    const frames = new Array<number>(f1 - f0);
    let f = f0;
    for (const s of run) {
      if (s.from > f) frames.fill(at(CAPTION_GAP_HTML), f - f0, s.from - f0);
      let h = html.get(s.text);
      if (h === undefined) html.set(s.text, (h = textHtml(s.text, project)));
      frames.fill(at(h), s.from - f0, s.to - f0);
      f = s.to;
    }
    looks += states.length;
    return { item, track, f0, f1, ramps: [], kind: "raster", states, frames };
  });
  if (looks > CAPTION_LOOKS_WARN) warnings.push(`"${item.name ?? item.id}" has ${looks} caption looks to draw, which adds about ${Math.max(1, Math.round(looks / CAPTION_LOOKS_PER_S / 60))} min to the export.`);
  return layers;
}

/** Everything the export draws and plays, or why there's nothing to export. */
export function planExport(project: Project, { mediaPath, width, height, graphic, envelopes, burnCaptions = true }: PlanOptions): ExportPlan | { readonly problem: string } {
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
  const warnings: Array<string> = [];
  // Components' media references: a placeholder each (the exporter swaps in the file as a data: URL).
  const target = { ...project, mediaUrl: (id: string) => {
    const m = project.media.find((x) => x.id === id);
    if (!m || m.kind !== "image") return undefined;
    fileOf(m);
    return mediaToken(id);
  } };
  const name = (item: Item) => `"${item.name ?? item.id}"`;
  const ordinal = (n: number) => `${n}${n === 2 ? "nd" : n === 3 ? "rd" : "th"}`;
  const capped = (item: Item, looks: ReadonlyArray<string>, what = "changes") => {
    const out = capStates(looks);
    if (out.hold > 1) warnings.push(`${name(item)} ${what} on more than ${MAX_RASTER_STATES} frames; the export draws every ${ordinal(out.hold)} frame of it (the preview draws them all).`);
    return out;
  };
  const fills = (media: Media) => !!media.probe?.width && !!media.probe?.height && Math.abs(media.probe.width / media.probe.height - aspect) < 0.002;

  const visuals: Array<VisualLayer> = [];
  for (const track of [...project.tracks].reverse()) {
    if (track.hidden || track.kind === "audio") continue;
    const subtitles = isSubtitleTrack(track) ? mergeableCues(track, starts) : undefined;
    track.items.forEach((item, i) => {
      const media = mediaOf(item);
      const isMedia = item.type === "clip" && media && media.kind !== "audio";
      const isSolid = item.type === "component" && item.component === SOLID;
      const isText = item.type === "text" && typeof item.text === "string";
      const isComponent = isDrawnComponent(item);
      const isGraphic = item.type === "graphic" && typeof item.src === "string";
      if (item.type === "captions") {
        if (burnCaptions) visuals.push(...captionLayers(project, item, track, duration, warnings));
        return;
      }
      // A Subtitles track's cues (D105): its plain ones drawn together (below), all of them off without burn-in.
      if (subtitles && (!burnCaptions || subtitles.includes(item))) {
        if (burnCaptions && item === subtitles[0]) visuals.push(...subtitleLayers(project, track, subtitles, starts, duration, warnings));
        return;
      }
      if (!isMedia && !isSolid && !isText && !isComponent && !isGraphic) return;
      const start = starts.get(item.id)!;
      const span = spanOf(track, i, start);
      const f0 = Math.max(0, Math.ceil(span.from));
      const f1 = Math.min(duration, Math.ceil(span.to));
      if (f1 <= f0) return;
      const ramps = opacityRamps(item, start, span);
      const reveal = { st: span.from, d: 2 * span.half };
      const shape = span.half > 0 ? maskOf(span.into) : undefined;
      // The transitions at its cuts (D79, D133): what they do at each frame, and where its layer is cut.
      const fxAt = (f: number) => transitionAt(span, f, project.canvas);
      // A blur dissolve (D133): sigma per frame in output px (core's blur is in canvas px).
      const sigmas = blurs(span.into) || blurs(span.next) ? Array.from({ length: f1 - f0 }, (_, k) => ((fxAt(f0 + k).blur ?? 0) * height) / project.canvas.height) : undefined;
      const base = { item, track, f0, f1, ramps, ...(span.wipe ? { wipe: reveal } : {}), ...(span.into === IRIS ? { iris: reveal } : {}), ...(shape ? { mask: { shape, ...reveal } } : {}), ...(sigmas?.some((b) => b > 0) ? { blur: sigmas } : {}) };
      const inEnd = span.half > 0 ? Math.ceil(span.from + 2 * span.half) : undefined;
      const revealEnd = inEnd !== undefined && reveals(span.into!) ? inEnd : undefined;
      const moveIn = inEnd !== undefined && movesIncoming(span.into!) ? inEnd : undefined;
      const outStart = span.nextHalf > 0 ? Math.ceil(span.to - 2 * span.nextHalf) : undefined;
      const moves = [moveIn, outStart !== undefined && movesOutgoing(span.next!) ? outStart : undefined].filter((c): c is number => c !== undefined);
      const always = [inEnd !== undefined && blurs(span.into) ? inEnd : undefined, outStart !== undefined && blurs(span.next) ? outStart : undefined].filter((c): c is number => c !== undefined);
      const split = (layer: VisualLayer, plain?: (f: number) => boolean) => splitAt(layer, { moves, always, ...(revealEnd !== undefined ? { revealEnd } : {}), ...(plain ? { plain } : {}) }, fps);
      // Text, backgrounds and graphics have no box: a push or zoom moves the canvas (core canvasBox).
      const kx = width / project.canvas.width;
      const ky = height / project.canvas.height;
      const canvasMoves = Array.from({ length: f1 - f0 }, (_, k) => {
        const fx = fxAt(f0 + k);
        return fx.shift || fx.shiftY || (fx.zoom !== undefined && fx.zoom !== 1) ? moveBox(canvasBox(project.canvas), fx.shift, fx.zoom, fx.shiftY) : undefined;
      });
      const canvasGeometry = canvasMoves.some(Boolean) ? { geometry: { frames: canvasMoves.map((b) => placementOf(b ?? canvasBox(project.canvas), kx, ky, canvasBox(project.canvas))) } } : {};
      const canvasStill = (f: number) => !canvasMoves[f - f0];
      if (isMedia && isSvg(media)) {
        // An SVG (D76): Chromium draws it in its box, one PNG per distinct box (keys).
        fileOf(media);
        const looks: Array<string> = [];
        for (let f = f0; f < f1; f++) {
          const fx = fxAt(f);
          const box = moveBox(clipBox(item, project.canvas, media.probe, f - start), fx.shift, fx.zoom, fx.shiftY);
          looks.push(svgClipHtml(item, box, mediaToken(media.id), box.opacity));
        }
        // Only its box changes (keys): drawn on every frame, like a clip's, never capped.
        const { states, frames } = capStates(looks, Infinity);
        visuals.push(...split({ ...base, kind: "raster", states, frames }));
        return;
      }
      if (isGraphic) {
        const html = graphic?.(item.src!);
        if (html === undefined) {
          warnings.push(`${name(item)}: ${item.src} couldn't be read, so it isn't drawn.`);
          return;
        }
        const looks = Array.from({ length: f1 - f0 }, (_, k) => String(Math.max(0, Math.min(item.duration - 1, f0 + k - start))));
        const { states, frames } = capped(item, looks, "is drawn");
        const opacity = typeof item.transform?.opacity === "number" ? Math.min(1, Math.max(0, item.transform.opacity)) : 1;
        visuals.push(...split({ ...base, ...canvasGeometry, ...(opacity !== 1 ? { alpha: Array.from({ length: f1 - f0 }, () => opacity) } : {}), kind: "graphic", doc: graphicDocument(html, project.canvas), frames: frames.map((k) => Number(states[k])) }, canvasStill));
        return;
      }
      if (isMedia) {
        const path = fileOf(media);
        // The box at every frame (D75), moved by a push or zoom (D79): plain frames (no transform,
        // no move) keep the full-frame chain.
        // A zoom pulse (D136) is in the box too.
        const boxes = Array.from({ length: f1 - f0 }, (_, k) => {
          const fx = fxAt(f0 + k);
          return moveBox(fxBox(item, clipBox(item, project.canvas, media.probe, f0 + k - start), f0 + k - start, fps), fx.shift, fx.zoom, fx.shiftY);
        });
        // Picture effects (D136) run before the box, so a clip with them always has one.
        const effects = clipFx(item);
        const picture = needsPicturePass(effects) || effects?.blur !== undefined;
        const plainAt = boxes.map((b) => !picture && isPlainBox(b, project.canvas));
        const rest = baseBox(item, project.canvas, media.probe);
        const placements = boxes.map((b) => placementOf(b, kx, ky, rest));
        const geometry = plainAt.every(Boolean) ? {} : { geometry: { frames: placements } };
        const alpha = boxes.some((b) => b.opacity !== 1) ? { alpha: boxes.map((b) => b.opacity) } : {};
        let layerFx: { fx?: LayerFx } = {};
        if (picture && effects) {
          // The size the effects work at, as the preview's (core fxPictureSize): the picture's fit before
          // any zoom (a scale, keys, a pulse or a transition zoom scale it after); its placement's size
          // when it's never zoomed (the same within a pixel, so the box's own scale passes it through).
          const fixed = boxes.every((b) => b.scale === 1) && placements.every((p) => p.cw === placements[0]!.cw && p.ch === placements[0]!.ch);
          const fit = fitRect(rest, boxes[0]!.fit, media.probe);
          const w = fixed ? placements[0]!.cw : Math.max(1, Math.round(fit.w * kx));
          const h = fixed ? placements[0]!.ch : Math.max(1, Math.round(fit.h * ky));
          layerFx = { fx: { fx: effects, start, w, h, k: ky, ...(effects.colour ? { lut: colourLut(effects.colour) } : {}) } };
        }
        const layer: VisualLayer =
          media.kind === "image"
            ? { ...base, ...alpha, kind: "image", file: path, fills: fills(media), ...geometry, ...layerFx }
            : { ...base, ...alpha, kind: "video", file: path, source: sourceAt(project, item, f0 - start), speed: item.speed ?? 1, fills: fills(media), ...geometry, ...layerFx, ...(item.hold && !item.loop && media.probe?.frames ? { last: (media.probe.frames - 1) / fps } : {}) };
        // Cut at the transitions first, then each piece into passes through its media (D79 review): a
        // long looped run keeps one looped input (the loop filter) and a transition's few frames seek.
        for (const piece of split(layer, (f) => plainAt[f - f0]!)) visuals.push(...splitLoop(piece, project, start, { width, height }));
        // Vignette, grain and letterbox bars (D136): Chromium draws them over the picture in its box
        // (core fxOverlayHtml, as the preview does), a layer of their own right above the clip with
        // its opacity, transitions and blur.
        if (effects && hasOverlay(effects)) {
          const looks = boxes.map((b, k) => fxOverlayHtml(effects, b, f0 + k - start));
          const { states, frames } = capped(item, looks, "has film grain or a moving box");
          visuals.push(...split({ ...base, ...alpha, kind: "raster", states, frames }));
        }
        return;
      }
      // Text moves (rise, slide, wipe) are drawn by Chromium frame by frame; opacity is a ramp.
      // A component's look (a terminal typing), its box (keys) and its box's opacity too.
      // A component's body (its animation: a terminal typing) is capped; its box (position, size,
      // opacity, scale, the move's offset) changes on every frame it changes, like text's motion.
      const looks: Array<string> = [];
      const wrappers: Array<string> = [];
      for (let f = f0; f < f1; f++) {
        const local = f - start;
        const motion = isText || isComponent ? animationAt(item, local, project.canvas, { skipIn: span.skipIn, skipOut: span.skipOut }).motion : {};
        if (isComponent) {
          // Its box moved by a push or zoom (D79), drawn into the HTML like its keys.
          const own = componentBox(item, project.canvas, local);
          const fx = fxAt(f);
          const parts = componentParts(item, target, local, { opacity: own?.opacity ?? 1, motion, fps, ...(own ? { box: moveBox(own, fx.shift, fx.zoom, fx.shiftY) } : {}) })!;
          wrappers.push(parts.wrapper);
          looks.push(parts.body);
        } else looks.push(isText ? textHtml(item, project, { motion }) : solidHtml(item, project));
      }
      let html = looks;
      if (isComponent) {
        const bodies = capped(item, looks, "changes its look");
        html = wrappers.map((w, i) => wrapComponent(w, bodies.states[bodies.frames[i]!]!));
      }
      // Text's looks (its moves: rise, slide, wipe, word by word, zoom; D81) are capped like a
      // component's body: past MAX_RASTER_STATES distinct looks, frames are held (with a warning).
      const { states, frames } = isText ? capped(item, html, "changes its look") : capStates(html, Infinity);
      visuals.push(...split({ ...base, ...(isComponent ? {} : canvasGeometry), kind: "raster", states, frames }, canvasStill));
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

  // Solo, mutes or a silent master that leave little or nothing audible (D83): the job says so.
  const note = mixNote(project);
  if (note) warnings.push(note);
  const audio: Array<AudioLayer> = [];
  const ducks = duckCurves(project, envelopes ?? new Map());
  const buses: Array<ExportPlan["buses"][number]> = [];
  for (const track of project.tracks) {
    if (!trackAudible(project, track)) continue;
    const curve = ducks.get(track.id);
    const duckWarning = duckNote(project, track, curve);
    if (duckWarning && track.items.some((i) => soundMedia(project, i))) warnings.push(duckWarning.replace("waits for", "isn't applied: it needs"));
    // Noise removal (D88) starts from the track's measured noise floor: the quietest of its media's.
    const floors = track.items.flatMap((i) => {
      const env = i.media && soundMedia(project, i) ? envelopes?.get(i.media) : undefined;
      return env ? [noiseFloorDb(env)] : [];
    });
    const stages = trackStages(track).map((st) => (st.kind === "denoise" ? { ...st, floorDb: floors.length ? Math.min(...floors) : DENOISE_FLOOR_DB } : st));
    if (stages.length && track.items.some((i) => soundMedia(project, i))) buses.push({ track: track.id, stages, pan: panGains(trackPan(track)) });
    track.items.forEach((item, index) => {
      const media = soundMedia(project, item);
      if (!media) return;
      const start = starts.get(item.id) ?? 0;
      const span = audioSpan(track, index, start);
      const duck = curve ? duckKeysIn(curve.keys, span.from, span.to).map((k) => ({ frame: k.frame - start, db: k.db })) : [];
      const gain: GainModel = {
        ...(duck.length ? { duck } : {}),
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
      // A held clip (D94) is silent past its media's end: a piece lying wholly there has no sound.
      if (heldPast(project, item, Math.max(0, span.from) - start)) return;
      const from = Math.max(0, span.from);
      const source = Math.max(0, sourceAt(project, item, from - start));
      const length = item.loop ? media.probe?.frames : undefined;
      const cycle = length && (item.speed ?? 1) === 1 ? { cycle: { samples: Math.round((length * 48000) / fps), offset: Math.round(source * 48000) } } : {};
      audio.push({ item, track: track.id, file: fileOf(media), from, to: span.to, source, speed: item.speed ?? 1, loop: item.loop === true, gain, pan: panGains(trackPan(track)), ...cycle });
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
    masterGain: masterGain(project),
    buses,
    limiter: masterLimiter(project),
    files: [...files.values()],
    warnings,
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

/** What follows the mix (D86, D87): a loudness filter or gain, the limiter, a measuring filter at the very end. */
export interface AudioOptions {
  /** A loudnorm filter (the measuring pass's, or the second pass's when the limiter is bypassed). */
  readonly loudnorm?: string | undefined;
  /** The loudness gain in dB (the second pass with the limiter on). */
  readonly gainDb?: number | undefined;
  /** Leave the limiter out (the first measuring pass measures the mix as it goes into it). */
  readonly noLimiter?: boolean | undefined;
  /** A filter after everything (a measuring pass's loudnorm print or ebur128). */
  readonly tail?: string | undefined;
}

/** True-peak margin (dB) under the ceiling the limiter works to (core, shared with the preview's limiter, D86). */
export { LIMITER_MARGIN_DB };
/** The limiter's lookahead / attack and release (ms): alimiter's defaults. */
export const LIMITER_ATTACK_MS = 5;
export const LIMITER_RELEASE_MS = 50;

/**
 * The master limiter as ffmpeg filters (D86): alimiter at 4× (192 kHz, so inter-sample peaks are
 * seen: "true-peak-ish") with the limit LIMITER_MARGIN_DB under the ceiling, auto-level off and
 * its lookahead delay compensated, then back to 48 kHz.
 */
export const limiterFilter = (ceilingDb: number) =>
  `aresample=192000,alimiter=limit=${n(Math.max(0.0625, 10 ** ((ceilingDb - LIMITER_MARGIN_DB) / 20)))}:attack=${LIMITER_ATTACK_MS}:release=${LIMITER_RELEASE_MS}:level=0:latency=1,aresample=48000`;

const lin = (db: number) => 10 ** (db / 20);
/** One effect stage as an ffmpeg filter (D84; the curves core biquadResponseDb states, the compressor's static curve). */
export function stageFilter(stage: Stage): string {
  switch (stage.kind) {
    case "biquad":
      switch (stage.type) {
        case "highpass":
        case "lowpass":
          return `${stage.type}=f=${n(stage.freq)}:p=2:t=q:w=${n(stage.q)}`;
        case "peaking":
          return `equalizer=f=${n(stage.freq)}:t=q:w=${n(stage.q)}:g=${n(stage.gainDb)}`;
        case "lowshelf":
        case "highshelf":
          return `${stage.type}=f=${n(stage.freq)}:t=s:w=1:g=${n(stage.gainDb)}`;
      }
      break;
    case "compressor":
      return `acompressor=threshold=${n(Math.max(0.000976563, lin(stage.thresholdDb)))}:ratio=${n(stage.ratio)}:attack=${n(stage.attackMs)}:release=${n(stage.releaseMs)}:makeup=${n(lin(stage.makeupDb))}:knee=1:link=maximum:detection=peak`;
    case "denoise":
      return `afftdn=nr=${n(6 + 24 * stage.amount)}:nf=${n(Math.min(-20, Math.max(-80, stage.floorDb ?? DENOISE_FLOOR_DB)))}`;
  }
  return "anull";
}

/**
 * The audio half of the graph. A string is a loudnorm filter appended to the mix (as before D86);
 * options say what follows the mix (AudioOptions).
 */
export function audioGraph(plan: ExportPlan, first: number, options?: string | AudioOptions): AudioGraph {
  const opts: AudioOptions = typeof options === "string" ? { loudnorm: options } : (options ?? {});
  const total = n(plan.frames / plan.fps);
  const inputs: Array<string> = [];
  const filters: Array<string> = [`anullsrc=r=48000:cl=stereo,atrim=duration=${total}[asil]`];
  const labels = ["[asil]"];
  const buses = plan.buses ?? [];
  const busOf = new Map(buses.map((b) => [b.track, [] as Array<string>]));
  plan.audio.forEach((layer, k) => {
    const index = first + k;
    const seconds = (layer.to - layer.from) / plan.fps;
    if (layer.cycle) inputs.push("-t", n(layer.cycle.samples / 48000 + 0.5), "-i", layer.file);
    else inputs.push(...(layer.loop ? ["-stream_loop", "-1"] : []), "-ss", n(layer.source), "-t", n(seconds * layer.speed + 0.05), "-i", layer.file);
    const constant = constantGain(layer.gain);
    const volume = constant !== undefined ? `volume=${n(constant)}` : `asetnsamples=n=${AUDIO_BLOCK}:p=0,volume=eval=frame:volume='${gainExpr(layer.gain, plan.fps)}'`;
    const delay = Math.round((layer.from / plan.fps) * 48000);
    const bus = busOf.get(layer.track);
    filters.push(
      [
        `[${index}:a:0]aresample=48000`,
        // Mono plays at full level in both ears, as Web Audio up-mixes it in the preview.
        "pan=stereo|FL<FL+FC+BL+SL|FR<FR+FC+BR+SR",
        "aformat=sample_fmts=fltp:channel_layouts=stereo",
        // The track's pan (D83): one factor per channel, the law in core panGains. A bussed track pans after its effects.
        ...(!bus && (layer.pan.left !== 1 || layer.pan.right !== 1) ? [`pan=stereo|c0=${n(layer.pan.left)}*c0|c1=${n(layer.pan.right)}*c1`] : []),
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
        // keepPitch false (D125): resampled like tape (the pitch follows the speed), else atempo keeps it.
        ...(layer.item.keepPitch === false && Math.abs(layer.speed - 1) > 1e-9 ? [`asetrate=${n(48000 * layer.speed)}`, "aresample=48000"] : atempo(layer.speed)),
        volume,
        `adelay=delays=${delay}S:all=1`,
      ].join(",") + `[a${k}]`,
    );
    (bus ?? labels).push(`[a${k}]`);
  });
  // Tracks with effects (D84): their items summed over a silent base, the stages in order, then the pan.
  buses.forEach((b, j) => {
    const items = busOf.get(b.track)!;
    if (!items.length) return;
    filters.push(`anullsrc=r=48000:cl=stereo,atrim=duration=${total}[tsil${j}]`);
    const chain = [
      `[tsil${j}]${items.join("")}amix=inputs=${items.length + 1}:duration=first:dropout_transition=0:normalize=0`,
      ...b.stages.map(stageFilter),
      "aformat=sample_fmts=fltp:channel_layouts=stereo",
      ...(b.pan.left !== 1 || b.pan.right !== 1 ? [`pan=stereo|c0=${n(b.pan.left)}*c0|c1=${n(b.pan.right)}*c1`] : []),
    ];
    filters.push(`${chain.join(",")}[t${j}]`);
    labels.push(`[t${j}]`);
  });
  const mix =
    labels.length === 1
      ? `[asil]anull`
      : `${labels.join("")}amix=inputs=${labels.length}:duration=first:dropout_transition=0:normalize=0`;
  // The master volume after the sum (D83), before loudness normalising (which would undo it).
  const master = plan.masterGain !== 1 && labels.length > 1 ? `,volume=${n(plan.masterGain)}` : "";
  const after = [
    ...(opts.loudnorm ? [opts.loudnorm, "aresample=48000"] : []),
    ...(opts.gainDb !== undefined && opts.gainDb !== 0 ? [`volume=${n(opts.gainDb)}dB`] : []),
    // The master limiter, last (D86). Nothing to limit in a silent mix.
    ...(plan.limiter && !opts.noLimiter && labels.length > 1 ? [limiterFilter(plan.limiter.ceilingDb)] : []),
    ...(opts.tail ? [opts.tail] : []),
  ];
  filters.push(`${mix}${master},atrim=duration=${total}${after.map((f) => `,${f}`).join("")},aformat=sample_fmts=fltp:channel_layouts=stereo[aout]`);
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
  /** A second-pass loudnorm filter (the limiter bypassed) — or `loudness`, what follows the mix (D86, D87). */
  readonly loudnorm?: string | undefined;
  readonly loudness?: AudioOptions | undefined;
  readonly output: string;
  /** The colour tables (D136) by key (core colourLut): .cube files the exporter wrote. */
  readonly luts?: ReadonlyMap<string, string> | undefined;
  /** A soft subtitle track (D105): an .srt file muxed as mov_text with an ISO 639-2 language tag. */
  readonly subtitles?: { readonly file: string; readonly language: string; /** Shown by default (when the captions aren't burned in). */ readonly show?: boolean | undefined } | undefined;
}

/**
 * One frame of a video file as the preview and the export show it at `source` seconds (D38): the
 * last source frame that starts at or before that moment. Seek up to a second early, shift the
 * timestamps so the moment is 0, and let fps (round=up) pick, then keep the first frame. Shared by
 * render_frames and contact sheets of media (D65); the export's own chain does the same per layer.
 */
export function sourceFramePick(source: number, fps: number, hold = false): { readonly seekArgs: ReadonlyArray<string>; readonly filter: string } {
  // A held clip (D94) seeks up to 2 s early and clones its last decoded frame, so the frame at or past
  // the stream's end (even when the probe overstates its length) is the last one, as the export shows.
  const pre = Math.min(hold ? 2 : 1, Math.max(0, source));
  return {
    seekArgs: ["-ss", n(source - pre), "-t", n(pre + 0.5)],
    filter: `${hold ? `tpad=stop_mode=clone:stop_duration=${n(pre + 1)},` : ""}setpts=PTS-${n(pre + 0.0001)}/TB,fps=${fps}:start_time=0:round=up,trim=end_frame=1,setpts=0`,
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

/** The colour tables (D136) a plan's layers use, each once: what the exporter writes as .cube files. */
export const planLuts = (plan: Pick<ExportPlan, "visuals">): Array<ColourLut> => [...new Map(plan.visuals.flatMap((l) => (l.kind === "video" || l.kind === "image") && l.fx?.lut ? [[l.fx.lut.key, l.fx.lut] as const] : [])).values()];

/** A file path as an ffmpeg filter argument: only plain path characters (the exporter's temp files), so nothing needs escaping. */
const filterPath = (path: string) => {
  if (!/^[\w/.\-]+$/.test(path)) throw new Error(`can't pass ${path} to ffmpeg's lut3d`);
  return path;
};

/**
 * Graph lines that run a clip's picture effects (D136) from `input` to `output`, in core's order:
 * made at the effects' size in 16-bit RGB with alpha, mirror (hflip), shake (zoomed in, then a window moved
 * frame by frame: core shakeExpr of the frame's moment, `n` counting the layer's frames from its
 * first, `f0`), pixelate (pixelize, block averages), colour (lut3d trilinear on core's table),
 * posterize (lutrgb floor), RGB split (rgbashift), sharpen (a 3×3 convolution, weights over 16),
 * glow (a thresholded copy blurred and screened on), back to 4:4:4 YUV with alpha, then blur (D133's
 * premultiplied gblur). The preview's shader (apps/web/src/preview/fx.ts) does the same.
 */
export function fxGraph(lf: LayerFx, input: string, output: string, fps: number, f0: number, luts?: ReadonlyMap<string, string>): Array<string> {
  const { fx, w, h, k } = lf;
  // 16-bit RGB with alpha: a still's transparency is carried through (every step leaves alpha as it is).
  const chain = [`scale=w=${w}:h=${h}:out_range=pc`, "format=gbrap16le"];
  if (fx.mirror) chain.push("hflip");
  if (fx.shake) {
    const z = shakeZoom(fx.shake.amount * k, w, h);
    const zw = Math.max(w, Math.round(w * z));
    const zh = Math.max(h, Math.round(h * z));
    const t = `(n+${f0 - lf.start})/${fps}`;
    const at = (base: number, d: string, max: number) => `'min(max(floor(${n(base)}+${d}+0.5),0),${max})'`;
    chain.push(`scale=w=${zw}:h=${zh}`, `crop=w=${w}:h=${h}:x=${at((zw - w) / 2, shakeExpr(fx.shake, "x", t, k), zw - w)}:y=${at((zh - h) / 2, shakeExpr(fx.shake, "y", t, k), zh - h)}:exact=1`);
  }
  if (fx.pixelate) {
    const b = Math.max(1, Math.round(fx.pixelate * k));
    if (b > 1) chain.push(`pixelize=w=${b}:h=${b}:mode=avg`);
  }
  if (lf.lut) {
    const file = luts?.get(lf.lut.key);
    if (!file) throw new Error(`no colour table for ${lf.lut.key}`);
    chain.push(`lut3d=file=${filterPath(file)}:interp=trilinear`);
  }
  if (fx.posterize) {
    const L = fx.posterize;
    const e = `floor(val*${L}/(maxval+1))*maxval/${L - 1}`;
    chain.push(`lutrgb=r='${e}':g='${e}':b='${e}'`);
  }
  if (fx.rgbSplit) {
    const d = Math.round(fx.rgbSplit * k);
    if (d > 0) chain.push(`rgbashift=rh=${d}:bh=${-d}:edge=smear`);
  }
  if (fx.sharpen) {
    const a = Math.round(fx.sharpen * 16);
    const m = `0 -${a} 0 -${a} ${16 + 4 * a} -${a} 0 -${a} 0`;
    chain.push(`convolution=0m='${m}':1m='${m}':2m='${m}':3m='0 0 0 0 1 0 0 0 0':0rdiv=0.0625:1rdiv=0.0625:2rdiv=0.0625:3rdiv=1`);
  }
  const back = ["scale=out_color_matrix=bt709:out_range=tv", "format=yuva444p", ...(fx.blur ? [blurFilters(fx.blur * k)] : [])];
  if (!fx.glow) return [`[${input}]${[...chain, ...back].join(",")}[${output}]`];
  const g = fx.glow;
  const T = `${n(g.threshold)}*maxval`;
  const e = `clip((val-${T})/(maxval-${T}),0,1)*${n(g.amount)}*maxval`;
  const sigma = Math.max(0.5, g.radius * k);
  return [
    `[${input}]${chain.join(",")},split=2[${output}ga][${output}gb]`,
    `[${output}gb]lutrgb=r='${e}':g='${e}':b='${e}',gblur=sigma=${n(sigma)}:sigmaV=${n(sigma)}:steps=${BLUR_STEPS}[${output}gc]`,
    `[${output}ga][${output}gc]blend=all_mode=screen:c3_expr=A,${back.join(",")}[${output}]`,
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
    const geo = layer.geometry?.frames;
    let chain: Array<string>;
    if (layer.kind === "video") {
      // Seek a second early and let fps pick, for each frame, the last source frame that starts at
      // or before its source time (round=up), like the preview's <video> (D38).
      // A held clip (D94) seeks up to 2 s early, so a probe that overstates the stream still leaves frames to clone.
      const pre = layer.cycle ? 0 : Math.min(layer.last !== undefined ? 2 : 1, layer.source);
      const length = layer.cycle ? layer.cycle.length / fps + 1 : pre + (frames / fps) * layer.speed + 1;
      inputs.push(...(opts.caps.videotoolboxDecode ? ["-hwaccel", "videotoolbox"] : []), ...(layer.cycle ? [] : ["-ss", n(layer.source - pre)]), "-t", n(length), "-i", layer.file);
      const decoded = `[${index}:v:0]${untaggedFilter(opts.untagged?.get(layer.file))}setpts=(PTS-${n(pre + 0.0001)}/TB)/${n(layer.speed)}`;
      // A held clip (D94) shows its media's last frame for the rest of its length: the decoded frames
      // are padded with clones of the last one (before fps picks, so even a slice that starts at or
      // past the stream's end has a frame to show).
      const hold = layer.last !== undefined && !layer.cycle ? [`tpad=stop_mode=clone:stop_duration=${n(pre + (frames / fps) * layer.speed + 1)}`] : [];
      let picked = [decoded, ...hold, `fps=${fps}:start_time=0:round=up`, `trim=end_frame=${frames}`];
      if (layer.cycle) {
        // The media's frames once, made only as large as they're drawn, then repeated from `offset`.
        const { length: L, offset } = layer.cycle;
        const shrink = geo
          ? `scale=w=${Math.max(...geo.map((p) => p.cw))}:h=${Math.max(...geo.map((p) => p.ch))}`
          : `scale=w=${W}:h=${H}:force_original_aspect_ratio=decrease:force_divisible_by=2`;
        picked = [decoded, `fps=${fps}:start_time=0:round=up`, `trim=end_frame=${L}`, `${shrink}:out_color_matrix=bt709:out_range=tv`, `loop=loop=-1:size=${L}:start=0`, `trim=start_frame=${offset}:end_frame=${offset + frames}`, `settb=1/${fps}`, "setpts=N"];
      }
      if (geo && layer.fx) {
        // Picture effects (D136) on the picture, then its box.
        graph.push(`${picked.join(",")}[e${k}]`, ...fxGraph(layer.fx, `e${k}`, `p${k}`, fps, layer.f0, opts.luts), ...boxGraph(geo, `p${k}`, `q${k}`, fps));
        chain = [`[q${k}]setpts=PTS-STARTPTS+${layer.f0}`, ...fades, ...opacity];
      } else if (geo) {
        // A box (D75): the picture made into its box, then placed by the overlay.
        graph.push(`${picked.join(",")}[p${k}]`, ...boxGraph(geo, `p${k}`, `q${k}`, fps));
        chain = [`[q${k}]setpts=PTS-STARTPTS+${layer.f0}`, ...fades, ...opacity];
      } else {
        const alpha = !layer.fills || fades.length > 0 || !!layer.wipe || !!layer.iris || !!layer.mask || opacity.length > 0;
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
      if (geo && layer.fx) {
        // Picture effects (D136): once on the still when nothing in them moves, else per frame.
        if (layer.fx.fx.shake) graph.push(`[${index}:v:0]${looped.join(",")},setpts=N[e${k}]`, ...fxGraph(layer.fx, `e${k}`, `p${k}`, fps, layer.f0, opts.luts), ...boxGraph(geo, `p${k}`, `q${k}`, fps));
        else graph.push(...fxGraph(layer.fx, `${index}:v:0`, `e${k}`, fps, layer.f0, opts.luts), `[e${k}]${looped.join(",")},setpts=N[p${k}]`, ...boxGraph(geo, `p${k}`, `q${k}`, fps));
        chain = [`[q${k}]setpts=PTS-STARTPTS+${layer.f0}`, ...fades, ...opacity];
      } else if (geo && same(geo.map((p) => p.cw)) && same(geo.map((p) => p.ch))) {
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
      // Rasters (text, backgrounds, components, SVG) and graphics: PNGs the rasteriser drew.
      const raster = opts.rasters.get(layer);
      if (!raster) throw new Error(`no raster for ${layer.item.id}`);
      let source: Array<string>;
      if (raster.kind === "still") {
        inputs.push("-f", "image2", "-pattern_type", "none", "-i", raster.png);
        source = [`[${index}:v:0]${toYuv(true)}`, `loop=loop=${frames - 1}:size=1:start=0`, `settb=1/${fps}`];
      } else {
        inputs.push("-f", "image2", "-framerate", String(fps), "-start_number", "0", "-i", raster.pattern);
        source = [`[${index}:v:0]${toYuv(true)}`, `trim=end_frame=${frames}`, `settb=1/${fps}`];
      }
      if (geo) {
        // Pushed or zoomed (D79): the canvas-size picture made into its moved box, then placed.
        graph.push(`${source.join(",")},setpts=N[p${k}]`, ...boxGraph(geo, `p${k}`, `q${k}`, fps));
        chain = [`[q${k}]setpts=PTS-STARTPTS+${layer.f0}`, ...fades, ...opacity];
      } else chain = [...source, `setpts=N+${layer.f0}`, ...fades, ...opacity];
    }
    // A wipe: the layer shows only its left X pixels (X even, the chroma grid): padded with W
    // transparent pixels on the left, a W-wide window at X holds the hidden part then the shown
    // one, and overlaying it X − W to the left puts the shown part back where it was. Both
    // expressions see the same frame time, so they agree on X.
    let at = "";
    let fmt = "auto";
    if (layer.blur) {
      // A blur dissolve (D133): gblur's sigma set frame by frame (sendcmd), as the preview's CSS
      // blur draws it: on premultiplied colour, with transparency past the layer's edges (padded
      // by 3 sigma, cropped back), so its edges soften into what's under it.
      const pad = blurPad(Math.max(...layer.blur));
      const commands: Array<string> = [];
      layer.blur.forEach((b, i) => {
        if (i > 0 && b === layer.blur![i - 1]) return;
        // sigmaV too: gblur copies sigma into it only when it starts.
        const at = n(Math.max(0, layer.f0 + i - 0.5) / fps);
        commands.push(`${at} gblur@g${k} sigma ${n(b)}`, `${at} gblur@g${k} sigmaV ${n(b)}`);
      });
      chain.push(
        "format=yuva444p",
        `pad=w=iw+${2 * pad}:h=ih+${2 * pad}:x=${pad}:y=${pad}:color=black@0`,
        "premultiply=inplace=1",
        `sendcmd=c='${commands.join(";")}'`,
        `gblur@g${k}=sigma=${n(layer.blur[0]!)}:sigmaV=${n(layer.blur[0]!)}:steps=${BLUR_STEPS}`,
        "unpremultiply=inplace=1",
        `crop=w=iw-${2 * pad}:h=ih-${2 * pad}:x=${pad}:y=${pad}`,
      );
    }
    if (geo && (layer.wipe || layer.iris || layer.mask)) {
      // A boxed layer is put on a transparent canvas first: a wipe or iris reveals the canvas.
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
    if (layer.iris) {
      // An iris (D79): a disc at the canvas's centre, radius share · half diagonal (output px; edge
      // pixels by coverage, as the preview's clip-path antialiases), multiplied into the alpha. The
      // mask's frames carry the layer's times, so geq's T is the project frame's moment.
      const { st, d } = layer.iris;
      const r = `${n(Math.hypot(W, H) / 2)}*clip((T*${fps}+0.0001-${n(st)})/${n(d)},0,1)`;
      graph.push(`${chain.join(",")},split=2[ic${k}][ia${k}]`);
      // Computed at 1/IRIS_MASK_STEP of the size (geq is costly per pixel: ~16× less work), a soft
      // edge one coarse pixel wide around the radius, then scaled up bilinearly on the same grid
      // (coarse pixel i covers output pixels [i·s, (i+1)·s)) and cropped: the half-covered contour
      // stays on the radius.
      const step = IRIS_MASK_STEP;
      const mw = Math.ceil(W / step);
      const mh = Math.ceil(H / step);
      graph.push(
        `color=c=black:s=${mw}x${mh}:r=${fps},format=gray,trim=end_frame=${frames},settb=1/${fps},setpts=N+${layer.f0},geq=lum='255*clip((${r}-hypot((X+0.5)*${step}-${n(W / 2)},(Y+0.5)*${step}-${n(H / 2)}))/${step}+0.5,0,1)',scale=w=${mw * step}:h=${mh * step}:flags=bilinear,crop=w=${W}:h=${H}:x=0:y=0[im${k}]`,
      );
      graph.push(`[ia${k}]alphaextract[ie${k}]`, `[ie${k}][im${k}]blend=all_mode=multiply[ik${k}]`, `[ic${k}][ik${k}]alphamerge[ir${k}]`);
      chain = [`[ir${k}]null`];
    } else if (layer.mask) {
      // A reveal shape (D133): core's signed distance as a coverage mask, made like the iris's (at
      // 1/IRIS_MASK_STEP of the size, a soft edge one coarse pixel wide, scaled up on the same grid).
      const { shape, st, d } = layer.mask;
      const step = IRIS_MASK_STEP;
      const mw = Math.ceil(W / step);
      const mh = Math.ceil(H / step);
      const P = `clip((T*${fps}+0.0001-${n(st)})/${n(d)},0,1)`;
      const sd = maskGeq(shape, P, W, H, `(X+0.5)*${step}`, `(Y+0.5)*${step}`);
      graph.push(`${chain.join(",")},split=2[ic${k}][ia${k}]`);
      graph.push(
        `color=c=black:s=${mw}x${mh}:r=${fps},format=gray,trim=end_frame=${frames},settb=1/${fps},setpts=N+${layer.f0},geq=lum='255*clip(${sd}/${step}+0.5,0,1)',scale=w=${mw * step}:h=${mh * step}:flags=bilinear,crop=w=${W}:h=${H}:x=0:y=0[im${k}]`,
      );
      graph.push(`[ia${k}]alphaextract[ie${k}]`, `[ie${k}][im${k}]blend=all_mode=multiply[ik${k}]`, `[ic${k}][ik${k}]alphamerge[ir${k}]`);
      chain = [`[ir${k}]null`];
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
  const audio = audioGraph(plan, plan.visuals.length + 1, opts.loudness ?? opts.loudnorm);
  inputs.push(...audio.inputs);
  graph.push(...audio.filters);
  // The soft subtitle track (D105): the last input, its own stream (cue times are the edit's).
  const subtitleInput = inputs.filter((a) => a === "-i").length;
  if (opts.subtitles) inputs.push("-f", "srt", "-i", opts.subtitles.file);
  const outputArgs = [
    "-map",
    "[vout]",
    "-map",
    "[aout]",
    ...(opts.subtitles ? ["-map", `${subtitleInput}:s:0`, "-c:s", "mov_text", "-metadata:s:s:0", `language=${opts.subtitles.language}`, "-disposition:s:0", opts.subtitles.show ? "default" : "0"] : []),
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

/**
 * A measuring pass (audio only, nothing written): loudnorm's JSON for `target` at the end of the
 * chain. Without `options` it measures the mix as it goes into the limiter (the first pass, D87);
 * with a gain it measures what the limiter puts out (the check when the limiter will work).
 */
export function loudnessCommand(plan: ExportPlan, target: number, options: AudioOptions = { noLimiter: true }): { inputs: Array<string>; graph: string; outputArgs: Array<string> } {
  // ebur128 (integrated loudness and true peak, D87) and loudnorm's JSON (the bypassed limiter's two-pass loudnorm) in one pass.
  const audio = audioGraph(plan, 0, { ...options, tail: `ebur128=peak=true:framelog=quiet,loudnorm=I=${target}:TP=-1:LRA=11:print_format=json` });
  return { inputs: audio.inputs, graph: audio.filters.join(";\n"), outputArgs: ["-map", "[aout]", "-f", "null", "-"] };
}

/** ebur128's summary from a measuring pass: integrated loudness (LUFS) and true peak (dBTP); undefined for silence or none. */
export function parseEbur128(stderr: string): { readonly lufs: number; readonly tp: number } | undefined {
  const at = stderr.lastIndexOf("Summary:");
  if (at < 0) return undefined;
  const tail = stderr.slice(at);
  const i = /I:\s+(-?[\d.]+|-inf) LUFS/.exec(tail);
  const tp = /Peak:\s+(-?[\d.]+|-inf) dBFS/.exec(tail);
  const lufs = i && i[1] !== "-inf" ? Number(i[1]) : -Infinity;
  if (!(lufs > -70)) return undefined;
  return { lufs, tp: tp && tp[1] !== "-inf" ? Number(tp[1]) : -Infinity };
}

/** At most this many measuring passes through the limiter (D87): the gain is corrected (bracketed) until the target holds within LOUDNESS_TOLERANCE_LU. */
export const LOUDNESS_CHECKS = 6;
export const LOUDNESS_TOLERANCE_LU = 0.2;
/** The loudness gain is kept within ±this (dB). */
const MAX_LOUDNESS_GAIN_DB = 40;

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

/**
 * The loudness step of an export (D87, D86), given a way to run a measuring pass (its stderr):
 * with the limiter on, one gain to the target before it (ebur128's integrated loudness of the mix
 * going into the limiter). When the peaks will make the limiter work (true peak + gain over its
 * limit), the result through the limiter is measured and the gain corrected (bracketing the target,
 * at most LOUDNESS_CHECKS passes) until it lands within LOUDNESS_TOLERANCE_LU; the gain used is the
 * closest one measured. With the limiter bypassed:
 * two-pass loudnorm as before D86. Nothing to do for silence.
 */
export async function planLoudness(plan: ExportPlan, target: number, measure: (pass: ReturnType<typeof loudnessCommand>, name: string) => Promise<string>): Promise<{ readonly loudness?: { readonly gainDb: number }; readonly loudnorm?: string }> {
  if (!plan.audio.length) return {};
  const stderr = await measure(loudnessCommand(plan, target), "loudness.txt");
  const norm = parseLoudness(stderr);
  if (!plan.limiter) return norm ? { loudnorm: loudnormFilter(target, norm) } : {};
  const first = parseEbur128(stderr);
  if (!first) return {};
  const clampGain = (g: number) => Math.round(Math.min(MAX_LOUDNESS_GAIN_DB, Math.max(-MAX_LOUDNESS_GAIN_DB, g)) * 100) / 100;
  let gainDb = clampGain(target - first.lufs);
  if (first.tp + gainDb > plan.limiter.ceilingDb - LIMITER_MARGIN_DB) {
    // Every gain tried is measured through the limiter; the closest one measured is kept (never an
    // unmeasured step). Loudness rises with the gain, but slowly and unevenly while the limiter flattens
    // peaks, so the steps bracket the target: below and above, then interpolate inside the bracket
    // (bisect when interpolation would stall at an edge).
    let best: { gain: number; err: number } | undefined;
    let lo: { gain: number; lufs: number } | undefined;
    let hi: { gain: number; lufs: number } | undefined;
    let last: { gain: number; lufs: number } | undefined;
    for (let k = 0; k < LOUDNESS_CHECKS; k++) {
      const check = parseEbur128(await measure(loudnessCommand(plan, target, { gainDb }), `loudness-check-${k}.txt`));
      if (!check) break;
      const err = target - check.lufs;
      if (!best || Math.abs(err) < Math.abs(best.err)) best = { gain: gainDb, err };
      if (Math.abs(err) <= LOUDNESS_TOLERANCE_LU) break;
      const point = { gain: gainDb, lufs: check.lufs };
      if (err > 0 && (!lo || gainDb > lo.gain)) lo = point;
      if (err < 0 && (!hi || gainDb < hi.gain)) hi = point;
      let next: number;
      if (lo && hi) {
        next = lo.gain + ((target - lo.lufs) * (hi.gain - lo.gain)) / (hi.lufs - lo.lufs);
        const span = hi.gain - lo.gain;
        if (!(next > lo.gain + 0.1 * span && next < hi.gain - 0.1 * span)) next = (lo.gain + hi.gain) / 2;
      } else {
        // Not bracketed yet: step along the slope seen so far (at least the full error: the limiter only slows loudness down).
        const slope = last && gainDb !== last.gain ? Math.min(1, Math.max(0.1, (check.lufs - last.lufs) / (gainDb - last.gain))) : 1;
        next = gainDb + err / slope;
      }
      last = point;
      gainDb = clampGain(next);
    }
    if (best) gainDb = best.gain;
  }
  return { loudness: { gainDb } };
}
