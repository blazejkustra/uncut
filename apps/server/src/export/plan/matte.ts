import { type BlendMode, blendInfo, type ChromaKey, type ClipMask, keyAlphaExpr, maskCoverageExpr, spillChannel } from "@uncut/core";
import { frameLookup } from "./video.ts";
import { n } from "./num.ts";

// D326: a clip's alpha path and blend mode in ffmpeg, core fx/matte.ts's maths.

/**
 * Graph lines that key the picture at `input` (core keyAlpha: lut2 on its BT.709 U and V at w×h,
 * multiplied into any alpha it has), then pull the spill off (despill), to 8-bit RGB with alpha at `output`.
 */
export function keyGraph(key: ChromaKey, input: string, output: string, w: number, h: number): Array<string> {
  const o = output;
  const ch = spillChannel(key);
  const despill =
    ch && key.spill > 0
      ? `,despill=type=${ch}:mix=0.5:expand=0:red=0:green=${ch === "green" ? n(-key.spill) : 0}:blue=${ch === "blue" ? n(-key.spill) : 0}:brightness=0:alpha=0`
      : "";
  return [
    `[${input}]scale=w=${w}:h=${h}:out_color_matrix=bt709:out_range=tv,format=yuva444p,split=3[${o}kc][${o}kp][${o}ka]`,
    `[${o}kp]extractplanes=u+v[${o}ku][${o}kv]`,
    `[${o}ku][${o}kv]lut2=c0='${keyAlphaExpr(key)}'[${o}km]`,
    `[${o}ka]alphaextract[${o}ke]`,
    `[${o}ke][${o}km]blend=all_mode=multiply[${o}kk]`,
    `[${o}kc][${o}kk]alphamerge,scale=in_color_matrix=bt709:in_range=tv:out_range=pc,format=gbrap${despill}[${output}]`,
  ];
}

/** The mask's coverage as a geq expression giving 0–255; a keyed mask looks its x, y, w and h up by frame (N). */
function maskExpr(masks: ReadonlyArray<ClipMask>): string {
  const m = masks[0]!;
  if (masks.length === 1) return `255*${maskCoverageExpr(m, "(X+0.5)", "(Y+0.5)")}`;
  const slots = (["x", "y", "w", "h"] as const).map(
    (p, i) =>
      `st(${i + 1},${frameLookup(
        masks.map((k) => k[p]),
        "N",
        9,
      )})`,
  );
  return `${slots.join(";")};255*${maskCoverageExpr(m, "(X+0.5)", "(Y+0.5)", 1, { x: "ld(1)", y: "ld(2)", w: "ld(3)", h: "ld(4)" })}`;
}

/**
 * Graph lines that multiply a clip's shape mask into the alpha of its box at `input` (w×h, the
 * box's own px, frames numbered from 0): one grey frame when it never moves, else one per frame.
 */
export function maskGraph(masks: ReadonlyArray<ClipMask>, w: number, h: number, input: string, output: string, fps: number, frames: number): Array<string> {
  const o = output;
  const length = masks.length === 1 ? 1 : frames;
  return [
    `color=c=black:s=${w}x${h}:r=${fps},format=gray,trim=end_frame=${length},settb=1/${fps},setpts=N,geq=lum='${maskExpr(masks)}'[${o}mm]`,
    `[${input}]split=2[${o}mc][${o}ma]`,
    `[${o}ma]alphaextract[${o}me]`,
    `[${o}me][${o}mm]blend=all_mode=multiply[${o}mk]`,
    `[${o}mc][${o}mk]alphamerge[${output}]`,
  ];
}

export interface BlendPlace {
  readonly mode: BlendMode;
  /** The overlay position of the layer on the canvas (":x=…:y=…" or ""). */
  readonly at: string;
  /** The frames the layer covers [f0, f1), and how many frames the graph has. */
  readonly f0: number;
  readonly f1: number;
  readonly frames: number;
  /** The pixel format the result is made in. */
  readonly format: string;
  /** The layer and base are RGB already (render_frames), else BT.709 limited-range YUV. */
  readonly rgb?: boolean;
}

/**
 * Graph lines that blend the layer at `layer` onto `base` (both W×H once placed) at `output`: the
 * layer placed on a transparent canvas, both made RGB, ffmpeg blend with the backdrop as its first
 * input (so overlay keys on the backdrop, as CSS), the result shown through the layer's alpha.
 */
export function blendGraph(p: BlendPlace, base: string, layer: string, output: string, W: number, H: number, fps: number): Array<string> {
  const o = output;
  const mode = blendInfo(p.mode)?.ffmpeg ?? "normal";
  const toRgb = p.rgb ? "" : "scale=in_color_matrix=bt709:in_range=tv:out_range=pc,";
  const back = p.rgb ? "" : "scale=out_color_matrix=bt709:out_range=tv,";
  return [
    `color=c=black@0:s=${W}x${H}:r=${fps},format=${p.rgb ? "rgba" : "yuva444p"},trim=end_frame=${p.frames},settb=1/${fps},setpts=N[${o}z]`,
    `[${o}z][${layer}]overlay=eof_action=pass:format=${p.rgb ? "rgb" : "yuv444"}:repeatlast=0${p.at}[${o}f]`,
    `[${o}f]${toRgb}format=gbrap,split=2[${o}c][${o}a]`,
    `[${o}c]format=gbrp[${o}s]`,
    `[${o}a]alphaextract[${o}m]`,
    `[${base}]${toRgb}format=gbrp,split=2[${o}b][${o}d]`,
    `[${o}b][${o}s]blend=all_mode=${mode}:enable='between(n,${p.f0},${p.f1 - 1})'[${o}x]`,
    `[${o}x][${o}m]alphamerge[${o}y]`,
    `[${o}d][${o}y]overlay=eof_action=pass:format=gbrp:repeatlast=0,${back}format=${p.format}[${output}]`,
  ];
}
