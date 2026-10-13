// Waveforms on timeline items (D54): the server's peaks for a media item (fetched once per file and
// kept for the session), drawn into a canvas for the part of the media an item plays. Audio items
// get a full-height waveform; clips with sound a compact one along their bottom edge. The drawing
// is scaled by the item's volume, so turning it down shows.
import type { Waveform as WaveformData } from "@uncut/contracts";
import { dbToGain } from "@uncut/core/audio";
import { useEffect, useRef, useState } from "react";

import type { Item, MediaItem } from "../state/project.ts";
import { waveformUrl } from "../state/store.ts";

export interface Peaks {
  /** Peaks per second. */
  readonly rate: number;
  readonly seconds: number;
  /** One byte per 1/rate s: the loudest sample, 0–255 for 0–full scale. */
  readonly data: Uint8Array;
}

// By URL (which carries a tag of the file's path): undefined while loading, null if there are none.
const cache = new Map<string, Peaks | null>();
const listeners = new Set<() => void>();
const notify = () => {
  for (const l of listeners) l();
};
// Asked for one at a time: a first request can be held open while the server decodes, and the
// browser has only six connections to the server, which the preview's footage needs too.
const queue: Array<string> = [];
const queued = new Set<string>();
let fetching = false;
// Failed (server busy, ffmpeg missing, offline): when to try again, with a growing wait.
const retry = new Map<string, { readonly at: number; readonly wait: number }>();

function load(url: string) {
  if (cache.has(url) || queued.has(url)) return;
  const r = retry.get(url);
  if (r && Date.now() < r.at) return;
  queued.add(url);
  queue.push(url);
  void pump();
}

async function pump() {
  if (fetching) return;
  const url = queue.shift();
  if (!url) return;
  fetching = true;
  try {
    const r = await fetch(url);
    // 404: nothing to draw (no sound, unknown media). Anything else may work later.
    if (r.status === 404) cache.set(url, null);
    else if (!r.ok) throw new Error(String(r.status));
    else {
      const json = (await r.json()) as WaveformData;
      const bin = atob(json.peaks);
      const data = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i);
      cache.set(url, { rate: json.rate, seconds: json.seconds, data });
      retry.delete(url);
    }
  } catch {
    const wait = Math.min(60_000, (retry.get(url)?.wait ?? 1000) * 2);
    retry.set(url, { at: Date.now() + wait, wait });
    setTimeout(notify, wait + 50);
  } finally {
    queued.delete(url);
    fetching = false;
    notify();
    void pump();
  }
}

/** The peaks of a media item's sound, once they've arrived. */
export function usePeaks(media: MediaItem | undefined): Peaks | undefined {
  const url = media ? waveformUrl(media.id, media.path) : undefined;
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!url) return;
    // Every change (another waveform arrived, a retry is due) asks again; load ignores what's done.
    const l = () => {
      load(url);
      setTick((n) => n + 1);
    };
    listeners.add(l);
    load(url);
    return () => void listeners.delete(l);
  }, [url]);
  return url ? (cache.get(url) ?? undefined) : undefined;
}

/** The canvas never gets wider than this (Chromium's limit is 32767); wider items stretch it. */
const MAX_CANVAS_PX = 8192;

/**
 * The waveform of `item` (its media from `in`, for its length at its speed) in a box `width` px
 * wide. `compact` draws a short strip from the bottom (clips); otherwise mirrored about the middle.
 */
export function ItemWaveform({ item, media, fps, width, compact }: { item: Item; media: MediaItem; fps: number; width: number; compact: boolean }) {
  const peaks = usePeaks(media);
  const ref = useRef<HTMLCanvasElement>(null);
  const from = (item.in ?? 0) / fps;
  const length = (item.duration * (item.speed ?? 1)) / fps;
  const scale = Math.min(2, dbToGain(item.gainDb ?? 0) || 0);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !peaks) return;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.min(MAX_CANVAS_PX, Math.round(width * dpr)));
    const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = compact ? "rgba(140, 220, 180, 0.75)" : "rgba(120, 230, 170, 0.85)";
    const total = peaks.data.length;
    const loopLength = item.loop ? peaks.seconds : Infinity;
    let drawn = 0;
    for (let x = 0; x < w; x++) {
      // The seconds of media this column covers, wrapping for looped audio.
      let t0 = from + (x / w) * length;
      let t1 = from + ((x + 1) / w) * length;
      if (t0 >= loopLength) {
        const shift = Math.floor(t0 / loopLength) * loopLength;
        t0 -= shift;
        t1 -= shift;
      }
      const i0 = Math.max(0, Math.floor(t0 * peaks.rate));
      const i1 = Math.min(total, Math.max(i0 + 1, Math.ceil(t1 * peaks.rate)));
      let peak = 0;
      for (let i = i0; i < i1; i++) peak = Math.max(peak, peaks.data[i]!);
      const v = Math.min(1, (peak / 255) * scale);
      if (v <= 0) continue;
      drawn++;
      const bar = Math.max(1, v * (compact ? h : h - 2));
      if (compact) ctx.fillRect(x, h - bar, 1, bar);
      else ctx.fillRect(x, (h - bar) / 2, 1, bar);
    }
    canvas.dataset.ready = "true";
    canvas.dataset.drawn = String(drawn);
  }, [peaks, width, from, length, scale, compact, item.loop]);
  return <canvas ref={ref} className={`wave ${compact ? "compact" : ""}`} data-testid="waveform" data-media={media.id} />;
}
