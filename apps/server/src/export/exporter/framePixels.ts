// A rendered frame's pixels (the agent's colour readout): the JPEG decoded by ffmpeg to a binary PPM.
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { run, ffmpegError } from "./ffmpeg.ts";
import { makeTemp } from "./files.ts";

/** 8-bit sRGB pixels, three bytes each, row by row. */
export interface RgbImage {
  readonly width: number;
  readonly height: number;
  readonly rgb: Uint8Array;
}

/** A binary PPM (P6, maxval 255) as an RgbImage. */
export function parsePpm(data: Uint8Array): RgbImage {
  const fields: Array<number> = [];
  let i = 2;
  while (fields.length < 3) {
    while (data[i] === 0x20 || data[i] === 0x0a || data[i] === 0x0d || data[i] === 0x09) i++;
    if (data[i] === 0x23) {
      while (data[i] !== 0x0a) i++;
      continue;
    }
    let n = 0;
    while (data[i]! >= 0x30 && data[i]! <= 0x39) n = n * 10 + data[i++]! - 0x30;
    fields.push(n);
  }
  const [width, height, max] = fields as [number, number, number];
  if (data[0] !== 0x50 || data[1] !== 0x36 || max !== 255) throw new Error("Not an 8-bit binary PPM.");
  const start = i + 1;
  return { width, height, rgb: data.subarray(start, start + width * height * 3) };
}

/** The JPEGs' pixels, in order. */
export async function jpegPixels(bin: string, jpegs: ReadonlyArray<Buffer>, signal?: AbortSignal): Promise<Array<RgbImage>> {
  const temp = await makeTemp();
  try {
    const out: Array<RgbImage> = [];
    for (const [k, jpeg] of jpegs.entries()) {
      const input = join(temp, `${k}.jpg`);
      const output = join(temp, `${k}.ppm`);
      await writeFile(input, jpeg);
      const r = await run(
        bin,
        ["-hide_banner", "-nostdin", "-y", "-v", "error", "-i", input, "-frames:v", "1", "-pix_fmt", "rgb24", "-update", "1", output],
        signal,
      );
      if (r.code !== 0) throw new Error(`Couldn't read the frame's pixels: ${ffmpegError(r.stderr)}`);
      out.push(parsePpm(await readFile(output)));
    }
    return out;
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
