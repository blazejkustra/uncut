// measure what "position": where the content of a rendered frame sits, read from its pixels.
import type { RgbImage } from "../export/exporter/framePixels.ts";

export interface Region {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** A channel this far from the background is content (JPEG noise stays well under it). */
const CONTENT_DELTA = 32;
/** A row or column needs this many content pixels, so a stray speck doesn't move the box. */
const MIN_PIXELS = 2;

const pixel = (image: RgbImage, x: number, y: number) => {
  const at = (y * image.width + x) * 3;
  return [image.rgb[at]!, image.rgb[at + 1]!, image.rgb[at + 2]!] as const;
};

/** The commonest colour on the region's edge (to 16 levels a channel). */
function edgeColour(image: RgbImage, r: Region) {
  const counts = new Map<number, { count: number; rgb: readonly [number, number, number] }>();
  const add = (x: number, y: number) => {
    const rgb = pixel(image, x, y);
    const key = ((rgb[0] >> 4) << 8) | ((rgb[1] >> 4) << 4) | (rgb[2] >> 4);
    const seen = counts.get(key);
    if (seen) seen.count++;
    else counts.set(key, { count: 1, rgb });
  };
  for (let x = r.x; x < r.x + r.width; x++) {
    add(x, r.y);
    add(x, r.y + r.height - 1);
  }
  for (let y = r.y; y < r.y + r.height; y++) {
    add(r.x, y);
    add(r.x + r.width - 1, y);
  }
  return [...counts.values()].reduce((a, b) => (b.count > a.count ? b : a)).rgb;
}

const firstFrom = (counts: ReadonlyArray<number>) => counts.findIndex((n) => n >= MIN_PIXELS);
const lastFrom = (counts: ReadonlyArray<number>) => counts.findLastIndex((n) => n >= MIN_PIXELS);
const hex = (rgb: readonly [number, number, number]) => `#${rgb.map((c) => c.toString(16).padStart(2, "0")).join("")}`;

/** The box of what differs from the region's background, in the image's pixels; undefined for an empty region. */
function contentBox(image: RgbImage, r: Region, background: readonly [number, number, number]): Region | undefined {
  const columns = new Array<number>(r.width).fill(0);
  const rows = new Array<number>(r.height).fill(0);
  for (let y = 0; y < r.height; y++)
    for (let x = 0; x < r.width; x++) {
      const rgb = pixel(image, r.x + x, r.y + y);
      if (rgb.some((c, k) => Math.abs(c - background[k]!) > CONTENT_DELTA)) {
        columns[x]!++;
        rows[y]!++;
      }
    }
  const left = firstFrom(columns);
  const top = firstFrom(rows);
  if (left < 0 || top < 0) return undefined;
  return { x: r.x + left, y: r.y + top, width: lastFrom(columns) - left + 1, height: lastFrom(rows) - top + 1 };
}

/**
 * Where the content of `region` sits, in canvas pixels. `scale` is canvas pixels per image pixel.
 * offset is the content's centre from the region's centre: + is right and down, 0 is centred.
 */
export function positionReadout(image: RgbImage, region: Region, scale: number) {
  const inImage = {
    x: Math.max(0, Math.min(image.width - 1, Math.round(region.x / scale))),
    y: Math.max(0, Math.min(image.height - 1, Math.round(region.y / scale))),
    width: 0,
    height: 0,
  };
  const r = {
    ...inImage,
    width: Math.max(1, Math.min(image.width - inImage.x, Math.round(region.width / scale))),
    height: Math.max(1, Math.min(image.height - inImage.y, Math.round(region.height / scale))),
  };
  const background = edgeColour(image, r);
  const box = contentBox(image, r, background);
  if (!box) return { background: hex(background), box: null, note: "Nothing in this region differs from its background." };
  const round = (n: number) => Math.round(n * scale);
  const offset = (start: number, size: number, areaStart: number, areaSize: number) => round(start + size / 2 - (areaStart + areaSize / 2));
  return {
    background: hex(background),
    box: { x: round(box.x), y: round(box.y), width: round(box.width), height: round(box.height) },
    offset: { x: offset(box.x, box.width, r.x, r.width), y: offset(box.y, box.height, r.y, r.height) },
  };
}

/** Whether a region from the tool's arguments is usable: whole numbers inside the canvas. */
export function regionOf(raw: unknown, canvas: { readonly width: number; readonly height: number }): Region | undefined {
  if (raw === undefined) return { x: 0, y: 0, width: canvas.width, height: canvas.height };
  const r = raw as Partial<Region> | null;
  if (!r || typeof r !== "object") return undefined;
  const { x, y, width, height } = r;
  if (![x, y, width, height].every((n) => Number.isInteger(n))) return undefined;
  if (x! < 0 || y! < 0 || width! < 4 || height! < 4 || x! + width! > canvas.width || y! + height! > canvas.height) return undefined;
  return { x: x!, y: y!, width: width!, height: height! };
}
