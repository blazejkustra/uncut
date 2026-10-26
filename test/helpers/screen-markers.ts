// What the preview really shows of HTML graphics while it plays: each graphic of a test project
// draws a small square of its own colour (a "marker", in canvas pixels) and the page is recorded
// with CDP's screencast (the composited pixels, iframes included, as they reach the window). A
// recorded frame is matched to the playhead at its time (the glitch probe's samples), and a layer
// the playhead is inside whose marker isn't there is missing on screen; one whose marker is there
// while the playhead is outside it is a ghost (a check on the marker colours). The first SETTLE_MS
// of playback and after each jump aren't judged. The preview's own signals (preview-glitches.ts)
// can't see this: an iframe that drew its render(t) may not have painted yet.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CDPSession, Page } from "puppeteer-core";
import type { GlitchSample } from "./preview-glitches.ts";

export interface MarkerSlot {
  readonly x: number;
  readonly y: number;
  readonly rgb: readonly [number, number, number];
}

export const MARKER_SIZE = 48;
/** Not judged: the first this many ms of playback and after a jump (the window shows the new frame a little after the page has it). */
const SETTLE_MS = 300;

/** The marker's element, to append to a graphic's HTML. */
export const markerHtml = (slot: MarkerSlot) =>
  `<div style="position:absolute;z-index:99;left:${slot.x}px;top:${slot.y}px;width:${MARKER_SIZE}px;height:${MARKER_SIZE}px;background:rgb(${slot.rgb.join(",")})"></div>`;

export interface MarkedLayer {
  readonly id: string;
  readonly slot: MarkerSlot;
  readonly start: number;
  readonly duration: number;
}

interface ScreenFrame {
  readonly data: string;
  readonly at: number;
  readonly width: number;
  readonly offsetTop: number;
}

export interface ScreenRecord {
  readonly frames: Array<ScreenFrame>;
  readonly session: CDPSession;
  /** Date.now() minus performance.now() in the page. */
  readonly clockOffset: number;
  /** The canvas's box on the page (CSS px) and the page's width (CSS px). */
  readonly canvasBox: { x: number; y: number; width: number; height: number };
  readonly pageWidth: number;
}

export async function startScreenRecord(page: Page, maxWidth = 1200): Promise<ScreenRecord> {
  const session = await page.createCDPSession();
  const { clockOffset, canvasBox, pageWidth } = await page.evaluate(() => {
    const r = document.querySelector<HTMLElement>("[data-testid=preview-frame]")!.getBoundingClientRect();
    return { clockOffset: Date.now() - performance.now(), canvasBox: { x: r.x, y: r.y, width: r.width, height: r.height }, pageWidth: innerWidth };
  });
  const record: ScreenRecord = { frames: [], session, clockOffset, canvasBox, pageWidth };
  session.on("Page.screencastFrame", (e) => {
    record.frames.push({ data: e.data, at: (e.metadata.timestamp ?? 0) * 1000, width: e.metadata.deviceWidth, offsetTop: e.metadata.offsetTop });
    void session.send("Page.screencastFrameAck", { sessionId: e.sessionId }).catch(() => {});
  });
  await session.send("Page.startScreencast", { format: "jpeg", quality: 85, maxWidth, everyNthFrame: 1 });
  return record;
}

export async function stopScreenRecord(record: ScreenRecord) {
  await record.session.send("Page.stopScreencast").catch(() => {});
  await record.session.detach().catch(() => {});
}

export interface MarkerScore {
  /** Recorded frames, and how many fell while playing. */
  readonly frames: number;
  readonly judged: number;
  /** Per layer and recorded frame: inside the layer but its marker not on screen (ms summed over layers, and frames). */
  readonly missingMs: number;
  readonly missingFrames: number;
  /** Layers never seen on screen while the playhead was inside them. */
  readonly neverShown: Array<string>;
  /** Marker seen while the playhead was outside its layer (frames): should stay 0. */
  readonly ghosts: number;
  readonly details: Array<string>;
}

/** Each recorded frame's marker pixels (the average of the middle of each slot), read with ffmpeg from the band of the screen the markers are in. */
function markerColours(record: ScreenRecord, slots: ReadonlyArray<MarkerSlot>, canvasWidth: number) {
  const dir = mkdtempSync(join(tmpdir(), "uncut-screen-"));
  try {
    record.frames.forEach((f, i) => writeFileSync(join(dir, `${String(i).padStart(6, "0")}.jpg`), Buffer.from(f.data, "base64")));
    const first = execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=width,height", "-of", "csv=p=0", join(dir, "000000.jpg")], {
      encoding: "utf8",
    });
    const [w, h] = first.trim().split(",").map(Number) as [number, number];
    const k = w / record.pageWidth;
    const toCanvas = record.canvasBox.width / canvasWidth;
    const offsetTop = record.frames[0]!.offsetTop;
    const centres = slots.map((slot) => ({
      x: Math.round((record.canvasBox.x + (slot.x + MARKER_SIZE / 2) * toCanvas) * k),
      y: Math.round((record.canvasBox.y + (slot.y + MARKER_SIZE / 2) * toCanvas - offsetTop) * k),
    }));
    const box = {
      x: Math.max(0, Math.min(...centres.map((c) => c.x)) - 4),
      y: Math.max(0, Math.min(...centres.map((c) => c.y)) - 4),
    };
    const bw = Math.min(w - box.x, Math.max(...centres.map((c) => c.x)) - box.x + 5);
    const bh = Math.min(h - box.y, Math.max(...centres.map((c) => c.y)) - box.y + 5);
    const raw = execFileSync(
      "ffmpeg",
      ["-v", "error", "-i", join(dir, "%06d.jpg"), "-vf", `format=rgb24,crop=${bw}:${bh}:${box.x}:${box.y}`, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
      { maxBuffer: 2 ** 31 },
    );
    return record.frames.map((_, i) =>
      centres.map((centre) => {
        const sum = [0, 0, 0];
        let n = 0;
        for (let dy = -2; dy <= 2; dy++)
          for (let dx = -2; dx <= 2; dx++) {
            const x = centre.x - box.x + dx;
            const y = centre.y - box.y + dy;
            if (x < 0 || y < 0 || x >= bw || y >= bh) continue;
            const o = i * bw * bh * 3 + (y * bw + x) * 3;
            for (let c = 0; c < 3; c++) sum[c]! += raw[o + c]!;
            n++;
          }
        return sum.map((v) => (n ? v / n : 0));
      }),
    );
  } finally {
    if (process.env.UNCUT_SCREEN_KEEP)
      console.log(
        `# screen frames kept in ${dir}: ${JSON.stringify({ box: record.canvasBox, pageWidth: record.pageWidth, offsetTop: record.frames[0]?.offsetTop })}`,
      );
    else rmSync(dir, { recursive: true, force: true });
  }
}

export function scoreMarkers(
  record: ScreenRecord,
  samples: ReadonlyArray<GlitchSample>,
  layers: ReadonlyArray<MarkedLayer>,
  { canvasWidth, edgeFrames = 3, tolerance = 40 }: { canvasWidth: number; edgeFrames?: number; tolerance?: number },
): MarkerScore {
  const slots = [...new Set(layers.map((l) => l.slot))];
  const colours = record.frames.length ? markerColours(record, slots, canvasWidth) : [];
  const playing = samples.filter((s) => s.playing);
  const jumps = playing.filter((s, i) => i > 0 && Math.abs(s.frame - playing[i - 1]!.frame) > 3).map((s) => s.t);
  const details: Array<string> = [];
  const seen = new Set<string>();
  const inside = new Set<string>();
  let judged = 0;
  let missingMs = 0;
  let missingFrames = 0;
  let ghosts = 0;
  let j = 0;
  record.frames.forEach((f, i) => {
    const t = f.at - record.clockOffset;
    while (j + 1 < playing.length && playing[j + 1]!.t <= t) j++;
    const s = playing[j];
    if (!s || t < playing[0]!.t + SETTLE_MS || t > playing.at(-1)!.t) return;
    while (jumps.length && jumps[0]! + SETTLE_MS < t) jumps.shift();
    if (jumps.length && jumps[0]! <= t) return;
    judged++;
    const dt = i + 1 < record.frames.length ? Math.min(100, record.frames[i + 1]!.at - f.at) : 0;
    for (const l of layers) {
      const c = colours[i]![slots.indexOf(l.slot)]!;
      const on = l.slot.rgb.every((v, k) => Math.abs(v - c[k]!) <= tolerance);
      const within = s.frame >= l.start + edgeFrames && s.frame < l.start + l.duration - edgeFrames;
      const outside = s.frame < l.start - edgeFrames || s.frame >= l.start + l.duration + edgeFrames;
      const other = layers.some((o) => o !== l && o.slot === l.slot && s.frame >= o.start - edgeFrames && s.frame < o.start + o.duration + edgeFrames);
      if (within) {
        inside.add(l.id);
        if (on) seen.add(l.id);
        else {
          missingMs += dt;
          missingFrames++;
          if (details.length < 60) details.push(`missing ${l.id} @f${s.frame} #${i} ${c.map(Math.round).join("/")}`);
        }
      } else if (outside && !other && on) {
        ghosts++;
        if (details.length < 60) details.push(`ghost ${l.id} @f${s.frame} #${i}`);
      }
    }
  });
  return { frames: record.frames.length, judged, missingMs, missingFrames, neverShown: [...inside].filter((id) => !seen.has(id)), ghosts, details };
}
