import { codecExtension, isProRes, maskGeq, type ExportCodec } from "@uncut/core";
import type { ExportPlan, Placement, VisualLayer } from "./types.ts";
import { type CommandOptions, fadeFilters, alphaFilters, boxGraph, videoSource, same, placeAt, rampPts } from "./video.ts";
import { fxGraph, type VisionInputs } from "./fx.ts";
import { blendGraph, maskGraph } from "./matte.ts";
import { blurPad, BLUR_STEPS, IRIS_MASK_STEP } from "./layers.ts";
import { n } from "./num.ts";
import { audioGraph } from "./audio.ts";
import { pictureFormats, videoCodec } from "./codec.ts";

export function exportCommand(plan: ExportPlan, opts: CommandOptions): { inputs: Array<string>; graph: string; outputArgs: Array<string> } {
  const { width: W, height: H, fps } = plan;
  const inputs: Array<string> = ["-i", opts.background];
  const graph: Array<string> = [];
  const pictures = pictureFormats(opts.video);
  const toYuv = (alpha: boolean) => `scale=w=${W}:h=${H}:out_color_matrix=bt709:out_range=tv,format=${alpha ? pictures.alpha : pictures.plain}`;
  const backdrop = opts.video?.alpha ? `${toYuv(true)},lutyuv=a=0` : toYuv(false);
  const first = opts.range?.start ?? 0;
  const frameCount = (opts.range?.end ?? plan.frames) - first;
  graph.push(`[0:v]${backdrop},loop=loop=${frameCount - 1}:size=1:start=0,settb=1/${fps},setpts=N${first ? `+${first}` : ""}[b0]`);
  let base = "b0";
  /** The box (D75) and then the clip's shape mask in it (D326). */
  const boxed = (layer: ExportPlan["visuals"][number], geo: ReadonlyArray<Placement>, input: string, output: string) =>
    layer.clipMask
      ? [...boxGraph(geo, input, `${output}u`, fps), ...maskGraph(layer.clipMask, geo[0]!.w, geo[0]!.h, `${output}u`, output, fps, layer.f1 - layer.f0)]
      : boxGraph(geo, input, output, fps);
  // D328: mattes and face masks are inputs after all the others (their numbers are known at the end).
  const late: Array<{ readonly args: ReadonlyArray<string>; readonly line: (index: number) => string }> = [];
  const visionOf = (layer: VisualLayer, k: number): VisionInputs => {
    const frames = layer.f1 - layer.f0;
    const out: { matte?: string; faces?: string } = {};
    if (layer.kind === "video" && layer.matte && layer.fx?.fx.cutout) {
      const m = layer.matte;
      const pre = Math.min(1, m.source);
      // Half a matte frame of slack: the .mkv's timestamps are rounded to the millisecond.
      const times = m.times.map((t) => t + 0.5 / m.fps);
      late.push({
        args: ["-ss", n(m.source - pre), "-t", n(pre + (m.times.at(-1) ?? 0) + 2 / m.fps + 1), "-i", m.file],
        line: (i) => `[${i}:v:0]setpts='${rampPts(times, pre, fps)}',fps=${fps}:start_time=0:round=up,trim=end_frame=${frames}[xm${k}]`,
      });
      out.matte = `xm${k}`;
    }
    const faces = opts.faceMasks?.get(layer);
    if (faces && (layer.kind === "video" || layer.kind === "image") && layer.fx?.fx.faceBlur) {
      late.push({ args: ["-i", faces], line: (i) => `[${i}:v:0]trim=end_frame=${frames},settb=1/${fps},setpts=N[xf${k}]` });
      out.faces = `xf${k}`;
    }
    return out;
  };
  plan.visuals.forEach((layer, k) => {
    const index = k + 1;
    const frames = layer.f1 - layer.f0;
    // A ramp can't start before frame 0 in ffmpeg; one that would (a fade-out as long as an item
    // at 0) starts at 0 instead, a frame's worth off.
    const fades = fadeFilters(layer.ramps, fps);
    const opacity = alphaFilters(layer, k, fps);
    const geo = layer.geometry?.frames;
    let chain: Array<string>;
    if ((layer.kind === "video" || layer.kind === "image") && layer.fx?.shader) {
      const shaded = opts.shaded?.get(layer);
      // A shader effect (D213): the picture is the frames the rasteriser's WebGPU drew (shadeLayers,
      // at the effects' size), then the other picture effects and the box as for any clip.
      if (!shaded || !geo) throw new Error(`no shader frames for ${layer.item.id}`);
      inputs.push("-i", shaded);
      graph.push(
        `[${index}:v:0]trim=end_frame=${frames},settb=1/${fps},setpts=N[e${k}]`,
        ...fxGraph(layer.fx, `e${k}`, `p${k}`, fps, layer.f0, opts.luts, visionOf(layer, k)),
        ...boxed(layer, geo, `p${k}`, `q${k}`),
      );
      chain = [`[q${k}]setpts=PTS-STARTPTS+${layer.f0}`, ...fades, ...opacity];
    } else if (layer.kind === "video") {
      const source = videoSource(layer, index, opts, W, H, fps);
      inputs.push(...source.inputs);
      const picked = source.picked;
      if (geo && layer.fx) {
        // Picture effects (D136) on the picture, then its box.
        graph.push(
          `${picked.join(",")}[e${k}]`,
          ...fxGraph(layer.fx, `e${k}`, `p${k}`, fps, layer.f0, opts.luts, visionOf(layer, k)),
          ...boxed(layer, geo, `p${k}`, `q${k}`),
        );
        chain = [`[q${k}]setpts=PTS-STARTPTS+${layer.f0}`, ...fades, ...opacity];
      } else if (geo) {
        // A box (D75): the picture made into its box, then placed by the overlay.
        graph.push(`${picked.join(",")}[p${k}]`, ...boxed(layer, geo, `p${k}`, `q${k}`));
        chain = [`[q${k}]setpts=PTS-STARTPTS+${layer.f0}`, ...fades, ...opacity];
      } else {
        const alpha = !layer.fills || fades.length > 0 || !!layer.wipe || !!layer.iris || !!layer.mask || opacity.length > 0;
        chain = [
          ...picked,
          `scale=w=${W}:h=${H}:force_original_aspect_ratio=decrease:force_divisible_by=2:out_color_matrix=bt709:out_range=tv`,
          `format=${alpha ? pictures.alpha : pictures.plain}`,
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
        if (layer.fx.fx.shake)
          graph.push(
            `[${index}:v:0]${looped.join(",")},setpts=N[e${k}]`,
            ...fxGraph(layer.fx, `e${k}`, `p${k}`, fps, layer.f0, opts.luts, visionOf(layer, k)),
            ...boxed(layer, geo, `p${k}`, `q${k}`),
          );
        else
          graph.push(
            ...fxGraph(layer.fx, `${index}:v:0`, `e${k}`, fps, layer.f0, opts.luts, visionOf(layer, k)),
            `[e${k}]${looped.join(",")},setpts=N[p${k}]`,
            ...boxed(layer, geo, `p${k}`, `q${k}`),
          );
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
          `format=${pictures.alpha}`,
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
        // A sequence, or a streamed layer's video (D291): one picture per frame either way, its
        // timestamps made again from the frame count (the video's are rounded to its container's).
        if (raster.kind === "video") inputs.push("-i", raster.file);
        else inputs.push("-f", "image2", "-framerate", String(fps), "-start_number", "0", "-i", raster.pattern);
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
    let fmt = pictures.overlay;
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
    // A blend mode (D326) blends onto everything below; a transparent export draws it normally.
    if (layer.blend && !opts.video?.alpha)
      graph.push(
        ...blendGraph(
          { mode: layer.blend, at, f0: layer.f0, f1: layer.f1, frames: frameCount, start: first, format: "yuv444p" },
          base,
          `l${k}`,
          `b${k + 1}`,
          W,
          H,
          fps,
        ),
      );
    else graph.push(`[${base}][l${k}]overlay=eof_action=pass:format=${fmt}:repeatlast=0${at}[b${k + 1}]`);
    base = `b${k + 1}`;
  });
  // fps on frames already on the 1/fps grid passes them through one to one; it gives the stream its rate.
  // F4 (D171): another output rate resamples the finished picture (the edit is timed in the plan's frames).
  const outFps = opts.video?.fps !== undefined && opts.video.fps > 0 && Math.abs(opts.video.fps - fps) > 1e-6 ? opts.video.fps : undefined;
  const codec = opts.video?.codec ?? "h264";
  // prores_ks takes its colour tags from the frames, unlike the bitstream filters of the delivery codecs.
  const tags = isProRes(codec) ? ",setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv" : "";
  const restart = opts.range ? ",setpts=PTS-STARTPTS" : "";
  graph.push(`[${base}]format=${pictures.output}${tags},fps=${fps},trim=end_frame=${frameCount}${restart}${outFps ? `,fps=${n(outFps)}` : ""}[vout]`);
  const pictureArgs = [
    ...videoCodec(opts.quality, opts.caps, plan, outFps ?? fps, opts.video),
    "-pix_fmt",
    pictures.output,
    ...COLOUR_TAGS,
    // The graph already makes one frame per 1/fps; ffmpeg's own constant-frame-rate pass would
    // shift the picture by a frame when inputs are seeked (seen on the DJI clip), so it's off.
    "-fps_mode",
    "passthrough",
  ];
  const addLateInputs = () => {
    for (const input of late) {
      graph.push(input.line(inputs.filter((a) => a === "-i").length));
      inputs.push(...input.args);
    }
  };
  if (opts.range) {
    addLateInputs();
    return {
      inputs,
      graph: graph.join(";\n"),
      outputArgs: ["-map", "[vout]", ...pictureArgs, "-an", "-t", n(frameCount / fps), "-f", codecExtension(codec), opts.output],
    };
  }
  const sound = soundAndSubtitles(plan, opts, plan.visuals.length + 1);
  inputs.push(...sound.inputs);
  graph.push(...sound.filters);
  addLateInputs();
  const outputArgs = ["-map", "[vout]", ...sound.maps, ...pictureArgs, ...sound.codecArgs, ...containerArgs(plan, codec, opts.output)];
  return { inputs, graph: graph.join(";\n"), outputArgs };
}

const COLOUR_TAGS = ["-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv"];

const containerArgs = (plan: ExportPlan, codec: ExportCodec, output: string) => [
  "-t",
  n(plan.frames / plan.fps),
  "-movflags",
  isProRes(codec) ? "+faststart+write_colr" : "+faststart",
  "-f",
  codecExtension(codec),
  output,
];

/** The mix (audioGraph, its inputs from `first`) and the soft subtitle track (D105) of an export. */
function soundAndSubtitles(plan: ExportPlan, opts: CommandOptions, first: number) {
  const codec = opts.video?.codec ?? "h264";
  const audio = audioGraph(plan, first, opts.loudness ?? opts.loudnorm);
  const inputs = [...audio.inputs];
  // The soft subtitle track: the last input, its own stream (cue times are the edit's).
  const subtitleInput = first + audio.inputs.filter((a) => a === "-i").length;
  if (opts.subtitles) inputs.push("-f", "srt", "-i", opts.subtitles.file);
  const maps = [
    "-map",
    "[aout]",
    ...(opts.subtitles
      ? [
          "-map",
          `${subtitleInput}:s:0`,
          "-c:s",
          "mov_text",
          "-metadata:s:s:0",
          `language=${opts.subtitles.language}`,
          "-disposition:s:0",
          opts.subtitles.show ? "default" : "0",
        ]
      : []),
  ];
  const audioCodec = isProRes(codec) ? ["-c:a", "pcm_s24le"] : ["-c:a", "aac", "-b:a", opts.quality === "draft" ? "128k" : "192k"];
  return { inputs, filters: audio.filters, maps, codecArgs: [...audioCodec, "-ar", "48000"] };
}

/**
 * A split export's last step: its chunks' pictures (`list`, an ffmpeg concat list of the files
 * exportCommand made with `range`) joined as they are, with the whole export's mix and subtitles.
 */
export function muxCommand(plan: ExportPlan, opts: CommandOptions, list: string): { inputs: Array<string>; graph: string; outputArgs: Array<string> } {
  const codec = opts.video?.codec ?? "h264";
  const sound = soundAndSubtitles(plan, opts, 1);
  return {
    inputs: ["-f", "concat", "-safe", "0", "-i", list, ...sound.inputs],
    graph: sound.filters.join(";\n"),
    outputArgs: ["-map", "0:v:0", ...sound.maps, "-c:v", "copy", ...COLOUR_TAGS, ...sound.codecArgs, ...containerArgs(plan, codec, opts.output)],
  };
}

/**
 * A problem ffmpeg reported but didn't stop for (it exits 0): a scaler or filter that failed on
 * some frames leaves a picture missing (seen with too many inputs at once). The export fails then.
 */
export function silentFailure(stderr: string): string | undefined {
  const line = stderr
    .split("\n")
    .find((l) => /\[swscaler[^\]]*\].*(error|fail|cannot|invalid)/i.test(l) || /Error while (filtering|processing)|Failed to inject frame/i.test(l));
  return line?.trim();
}
