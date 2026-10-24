// The looks-and-effects fixture (D136): Colours.mp4, a static colourful clip (BT.709, 30 fps, 2 s
// or longer): a hue sweep left to right, dark to light top to bottom, a skin tone, white, near
// black and teal blocks and a thin white bar (hard edges), drawn at any size.
import { execFileSync } from "node:child_process";

export function makeColours(path: string, w = 640, h = 360, seconds = 2) {
  const geq =
    "geq=r='255*clip(abs(6*X/W-3)-1,0,1)*(0.25+0.75*Y/H)':g='255*clip(2-abs(6*X/W-2),0,1)*(0.25+0.75*Y/H)':b='255*clip(2-abs(6*X/W-4),0,1)*(0.25+0.75*Y/H)'";
  const s = (v: number) => Math.round((v * w) / 640);
  const t = (v: number) => Math.round((v * h) / 360);
  const blocks = [
    `drawbox=x=${s(40)}:y=${t(40)}:w=${s(80)}:h=${t(60)}:color=0xE0AC8A:t=fill`,
    `drawbox=x=${s(140)}:y=${t(40)}:w=${s(80)}:h=${t(60)}:color=white:t=fill`,
    `drawbox=x=${s(240)}:y=${t(40)}:w=${s(80)}:h=${t(60)}:color=0x111111:t=fill`,
    `drawbox=x=${s(340)}:y=${t(250)}:w=${s(200)}:h=${t(8)}:color=white:t=fill`,
    `drawbox=x=${s(420)}:y=${t(40)}:w=${s(60)}:h=${t(180)}:color=0x2a9d8f:t=fill`,
  ];
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    `color=c=black:s=${w}x${h}:r=30,format=rgb24,${geq},${blocks.join(",")}`,
    "-t",
    String(seconds),
    "-vf",
    "scale=out_color_matrix=bt709:out_range=tv,format=yuv420p",
    "-colorspace",
    "bt709",
    "-color_primaries",
    "bt709",
    "-color_trc",
    "bt709",
    "-c:v",
    "libx264",
    "-crf",
    "6",
    path,
  ]);
}
