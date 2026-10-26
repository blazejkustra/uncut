// A decoded VideoFrame copied into an ImageBitmap at the cached size, turned upright: the scrub cache
// (D221) and the playback engine (D311) keep these instead of VideoFrames, so a decoder's frames go
// back to it at once and paused and played frames are the same pixels.
import { cachedSize } from "./scrub/frames.ts";

export interface FrameCopy {
  readonly bitmap: ImageBitmap;
  readonly w: number;
  readonly h: number;
}

/** Copies `frame` (it stays open: the caller closes it), `turn` degrees clockwise, its long side at most `maxSide`, through `scratch`. */
export function frameBitmap(frame: VideoFrame, turn: number, scratch: OffscreenCanvas, maxSide?: number): FrameCopy {
  const dw = turn % 180 ? frame.displayHeight : frame.displayWidth;
  const dh = turn % 180 ? frame.displayWidth : frame.displayHeight;
  const { w, h } = cachedSize(dw, dh, maxSide);
  if (scratch.width !== w) scratch.width = w;
  if (scratch.height !== h) scratch.height = h;
  const ctx = scratch.getContext("2d")!;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (turn) {
    ctx.translate(w / 2, h / 2);
    ctx.rotate((turn * Math.PI) / 180);
    const [rw, rh] = turn % 180 ? [h, w] : [w, h];
    ctx.drawImage(frame, -rw / 2, -rh / 2, rw, rh);
  } else ctx.drawImage(frame, 0, 0, w, h);
  return { bitmap: scratch.transferToImageBitmap(), w, h };
}

/** HDR footage, which the <video> tone-maps differently: left to the <video>. */
export const isHdr = (frame: VideoFrame) => {
  const transfer = frame.colorSpace?.transfer as string | null | undefined;
  return transfer === "pq" || transfer === "hlg";
};
