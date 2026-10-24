import { readFile, rm } from "node:fs/promises";
import { join, dirname, basename } from "node:path";
import { type SheetLayout, sheetHtml } from "../../agent/agentFootage.ts";
import { sourceFramePick } from "../exportPlan.ts";
import { rasterizerCommand, type Rasterizer, startRasterizer } from "../rasterizer.ts";
import { makeTemp } from "./files.ts";
import { capsOf, run, ffmpegError } from "./ffmpeg.ts";

/** The contact sheet's grid drawn by a rasteriser of its own, as a JPEG. */
export async function drawSheet(cells: ReadonlyArray<{ readonly jpeg: Buffer; readonly caption: string }>, layout: SheetLayout): Promise<Buffer> {
  const command = rasterizerCommand();
  if ("problem" in command) throw new Error(command.problem);
  const temp = await makeTemp();
  let raster: Rasterizer | undefined;
  try {
    raster = await startRasterizer(command);
    const out = join(temp, "sheet.jpg");
    await raster.render({ width: layout.width, height: layout.height, css: "", html: sheetHtml(cells, layout), out });
    return await readFile(out);
  } finally {
    await raster?.close().catch(() => {});
    await rm(temp, { recursive: true, force: true }).catch(() => {});
  }
}

/** At most this many ffmpeg runs at once when pulling a contact sheet's frames from footage. */
const SHEET_CONCURRENCY = 4;

/** A frame pulled from a media file for a contact sheet, and the moment (seconds) it was taken at. */
export interface MediaFrame {
  readonly jpeg: Buffer;
  readonly seconds: number;
}

/**
 * One JPEG per moment of a media file, `width` px wide (height kept to the picture's shape), a
 * few at a time, each the source frame the preview and export show at that moment in a `fps`
 * project (sourceFramePick, D38). Always the file's first video stream (0:v:0): DJI clips also
 * carry an mjpeg cover picture and data streams, and ffmpeg's own pick is the largest picture.
 * A moment past the end of the video stream (its probed length can include longer sound) shows
 * the stream's last frame, and says so through `seconds`.
 */
export async function mediaFramesWith(
  bin: string,
  path: string,
  seconds: ReadonlyArray<number>,
  width: number,
  fps: number,
  signal: AbortSignal,
): Promise<Array<MediaFrame>> {
  const caps = await capsOf(bin);
  const temp = await makeTemp();
  let streamEnd: Promise<number | undefined> | undefined;
  const videoEnd = () =>
    (streamEnd ??= run(
      join(dirname(bin), "ffprobe"),
      ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=duration:format=duration", "-of", "json", path],
      signal,
    ).then(
      (r) => {
        try {
          const j = JSON.parse(r.stdout) as { streams?: Array<{ duration?: string }>; format?: { duration?: string } };
          const d = Number(j.streams?.[0]?.duration ?? j.format?.duration);
          return Number.isFinite(d) && d > 0 ? d : undefined;
        } catch {
          return undefined;
        }
      },
      () => undefined,
    ));
  try {
    const out: Array<MediaFrame> = new Array(seconds.length);
    const grab = async (i: number) => {
      const file = join(temp, `cell-${i}.jpg`);
      const pullAt = async (at: number) => {
        const pick = sourceFramePick(at, fps);
        const r = await run(
          bin,
          [
            "-hide_banner",
            "-nostdin",
            "-y",
            "-v",
            "error",
            ...(caps.videotoolboxDecode ? ["-hwaccel", "videotoolbox"] : []),
            ...pick.seekArgs,
            "-i",
            path,
            "-map",
            "0:v:0",
            "-vf",
            `${pick.filter},scale=${Math.max(16, Math.round(width / 2) * 2)}:-2`,
            "-frames:v",
            "1",
            "-q:v",
            "4",
            "-update",
            "1",
            file,
          ],
          signal,
        );
        // Past the end of the picture ffmpeg writes nothing (and, since 7, exits with an error saying so).
        if (r.code !== 0 && /Nothing was written into output file|received no packets/.test(r.stderr)) return undefined;
        if (r.code !== 0) throw new Error(`Couldn't read ${basename(path)} at ${at.toFixed(2)} s: ${ffmpegError(r.stderr) || `ffmpeg exited with ${r.code}`}`);
        return readFile(file).catch(() => undefined);
      };
      const got = await pullAt(seconds[i]!);
      if (got?.length) return void (out[i] = { jpeg: got, seconds: seconds[i]! });
      // No frame and no error: the moment is past the end of the video stream. Show its last frame.
      const end = await videoEnd();
      const last = end !== undefined ? Math.max(0, end - 0.001) : undefined;
      const tail = last !== undefined && last < seconds[i]! ? await pullAt(last) : undefined;
      if (!tail?.length) throw new Error(`No picture at ${seconds[i]!.toFixed(2)} s of ${basename(path)}.`);
      out[i] = { jpeg: tail, seconds: last! };
    };
    let next = 0;
    let stopped = false;
    const worker = async () => {
      try {
        while (next < seconds.length && !stopped) await grab(next++);
      } catch (error) {
        stopped = true; // the other workers finish the frame they're on, then stop
        throw error;
      }
    };
    // All settled before the temp folder goes, so no ffmpeg is still writing into it.
    const settled = await Promise.allSettled(Array.from({ length: Math.min(SHEET_CONCURRENCY, seconds.length) }, worker));
    const failure = settled.find((r): r is PromiseRejectedResult => r.status === "rejected");
    if (failure) throw failure.reason;
    return out;
  } finally {
    await rm(temp, { recursive: true, force: true }).catch(() => {});
  }
}
