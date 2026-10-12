// What an export draws and plays, and the ffmpeg command that makes it (D39, D55). Pure: no
// processes, no files; the export service (exporter.ts) rasterises the text, runs ffmpeg and
// reports progress. Everything here follows the preview's maths in @uncut/core:
// - Picture: every layer visualsAt would return, composited bottom-up in visualsAt's order
//   (tracks from the bottom, items in order), from frame ceil(from) to ceil(to) of its span.
//   Footage and stills are scaled to fit like the preview's object-fit: contain, over transparent
//   bars. Text and backgrounds are PNGs Chromium drew from core's textHtml / solidHtml with
//   RENDER_CSS; a text whose position moves (rise, slide, wipe) gets one PNG per distinct state.
//   Opacity (a transition's crossfade, fade/rise/slide in and out) is linear in frames, so it is
//   ffmpeg's fade on the layer's alpha, evaluated at the same frames (time mode).
// - Sound: every item audibleAt would return, from its media at the same source time, with the
//   gain of core itemGain (combined dB with the −60 dB cutoff, gainKeys, fades, transition
//   crossfades) as one volume expression per item, mixed with amix normalize=0 (D54).
// - A frame f is the moment f / fps (D38); a clip shows the source frame on screen at its source
//   time, as the preview's <video> does (the last frame that starts at or before it).
import {
  animationAt,
  audioSpan,
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

interface LayerBase {
  readonly item: Item;
  readonly track: Track;
  /** First frame drawn and the frame after the last (integers). */
  readonly f0: number;
  readonly f1: number;
  readonly ramps: ReadonlyArray<Ramp>;
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
    })
  | (LayerBase & { readonly kind: "image"; readonly file: string; readonly fills: boolean })
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
 * The opacity ramps of an item as visualsAt computes its opacity: the transition's crossfade
 * (0 at `from` → 1 at start + half), then the in and out animations (fade, rise and slide-left
 * change opacity; wipe doesn't), skipped on a side where a main-track transition blends.
 */
export function opacityRamps(item: Item, start: number, half: number, nextHalf: number): Array<Ramp> {
  const ramps: Array<Ramp> = [];
  if (half > 0) ramps.push({ type: "in", st: start - half, d: 2 * half });
  const a = item.animation;
  if (!(half > 0) && a?.in && a.in.duration > 0 && OPACITY_MOVES.has(a.in.module)) ramps.push({ type: "in", st: start, d: a.in.duration });
  if (!(nextHalf > 0) && a?.out && a.out.duration > 0 && OPACITY_MOVES.has(a.out.module)) ramps.push({ type: "out", st: start + item.duration - 1 - a.out.duration, d: a.out.duration });
  return ramps;
}

/** The ramps' opacity at frame f, as ffmpeg's fade computes it (the tests compare it with visualsAt). */
export const rampsAt = (ramps: ReadonlyArray<Ramp>, f: number) =>
  ramps.reduce((o, r) => {
    const p = Math.min(1, Math.max(0, (f - r.st) / r.d));
    return o * (r.type === "in" ? p : 1 - p);
  }, 1);

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
      const half = item.transitionIn ? item.transitionIn.duration / 2 : 0;
      const next = track.items[i + 1];
      const nextHalf = track.role === "main" && next?.transitionIn ? next.transitionIn.duration / 2 : 0;
      const f0 = Math.max(0, Math.ceil(start - half));
      const f1 = Math.min(duration, Math.ceil(start + item.duration + nextHalf));
      if (f1 <= f0) return;
      const ramps = opacityRamps(item, start, half, nextHalf);
      const base = { item, track, f0, f1, ramps };
      if (isMedia) {
        const path = fileOf(media);
        if (media.kind === "image") visuals.push({ ...base, kind: "image", file: path, fills: fills(media) });
        else {
          const speed = item.speed ?? 1;
          visuals.push({ ...base, kind: "video", file: path, source: ((item.in ?? 0) + (f0 - start) * speed) / fps, speed, fills: fills(media) });
        }
        return;
      }
      // Text moves (rise, slide, wipe) are drawn by Chromium frame by frame; opacity is a ramp.
      const states: Array<string> = [];
      const index = new Map<string, number>();
      const frames: Array<number> = [];
      for (let f = f0; f < f1; f++) {
        const motion = isText ? animationAt(item, f - start, project.canvas, { skipIn: half > 0, skipOut: nextHalf > 0 }).motion : {};
        const html = isText ? textHtml(item, project, { motion }) : solidHtml(item, project);
        let k = index.get(html);
        if (k === undefined) {
          k = states.length;
          states.push(html);
          index.set(html, k);
        }
        frames.push(k);
      }
      visuals.push({ ...base, kind: "raster", states, frames });
    });
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
        fadeIn: item.fadeIn ?? 0,
        fadeOut: item.fadeOut ?? 0,
      };
      if (constantGain(gain) === 0) return;
      const from = Math.max(0, span.from);
      audio.push({ item, file: fileOf(media), from, to: span.to, source: Math.max(0, sourceAt(project, item, from - start)), speed: item.speed ?? 1, loop: item.loop === true, gain });
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
    inputs.push(...(layer.loop ? ["-stream_loop", "-1"] : []), "-ss", n(layer.source), "-t", n(seconds * layer.speed + 0.05), "-i", layer.file);
    const constant = constantGain(layer.gain);
    const volume = constant !== undefined ? `volume=${n(constant)}` : `asetnsamples=n=${AUDIO_BLOCK}:p=0,volume=eval=frame:volume='${gainExpr(layer.gain, plan.fps)}'`;
    const delay = Math.round((layer.from / plan.fps) * 48000);
    filters.push(
      [
        `[${index}:a:0]aresample=48000`,
        // Mono plays at full level in both ears, as Web Audio up-mixes it in the preview.
        "pan=stereo|FL<FL+FC+BL+SL|FR<FR+FC+BR+SR",
        "aformat=sample_fmts=fltp:channel_layouts=stereo",
        `atrim=duration=${n(seconds * layer.speed)}`,
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
    let chain: Array<string>;
    if (layer.kind === "video") {
      // Seek a second early and let fps pick, for each frame, the last source frame that starts at
      // or before its source time (round=up), like the preview's <video> (D38).
      const pre = Math.min(1, layer.source);
      inputs.push(...(opts.caps.videotoolboxDecode ? ["-hwaccel", "videotoolbox"] : []), "-ss", n(layer.source - pre), "-t", n(pre + (frames / fps) * layer.speed + 1), "-i", layer.file);
      const alpha = !layer.fills || fades.length > 0;
      chain = [
        `[${index}:v:0]${untaggedFilter(opts.untagged?.get(layer.file))}setpts=(PTS-${n(pre + 0.0001)}/TB)/${n(layer.speed)}`,
        `fps=${fps}:start_time=0:round=up`,
        `trim=end_frame=${frames}`,
        `scale=w=${W}:h=${H}:force_original_aspect_ratio=decrease:force_divisible_by=2:out_color_matrix=bt709:out_range=tv`,
        `format=${alpha ? "yuva420p" : "yuv420p"}`,
        ...(layer.fills ? [] : [`pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black@0`]),
        `setpts=PTS-STARTPTS+${layer.f0}`,
        ...fades,
      ];
    } else if (layer.kind === "image") {
      inputs.push("-f", "image2", "-pattern_type", "none", "-i", layer.file);
      chain = [
        `[${index}:v:0]scale=w=${W}:h=${H}:force_original_aspect_ratio=decrease:force_divisible_by=2:out_color_matrix=bt709:out_range=tv`,
        "format=yuva420p",
        ...(layer.fills ? [] : [`pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black@0`]),
        `loop=loop=${frames - 1}:size=1:start=0`,
        `settb=1/${fps}`,
        `setpts=N+${layer.f0}`,
        ...fades,
      ];
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
    graph.push(`${chain.join(",")}[l${k}]`);
    graph.push(`[${base}][l${k}]overlay=eof_action=pass:format=auto:repeatlast=0[b${k + 1}]`);
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
