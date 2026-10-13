// Phase 6 exit check (D93): the Argent promo "Haiku 4.5 vs Haiku 5.5 on the same Argent test",
// rebuilt in Uncut from the reference video's own files. Shared by test/app/phase6-exit.test.ts (the
// scripted claude) and scripts/phase6-manual-check.ts (the real one).
//
// The reference (~/Documents/devrel/video-editor/argent-haiku45-vs-haiku55, or $UNCUT_ARGENT_REF) is
// READ-ONLY: its recordings and sky background are imported by path (media_import references them in
// place), its copy and numbers are read from its project.json at run time (nothing invented or
// restated), and nothing is ever written there. The Argent wordmark comes from the studio library
// ($UNCUT_ARGENT_LOGO): it is white, and Uncut draws images as they are (no CSS filter), so a dark
// copy (fills and strokes #111111) is written into the run's own folder, as a designer would hand
// over a dark logo.
//
// The reference is 39.47 s (1184 frames at 30 fps; its README says 42 s, its project.json and the
// mp4 say 39.46). Scenes: a white title card over the sky (0–2.9 s), the race (the two recordings
// in phone frames beside their agent logs, a header, 2.9–25.2 s), the dark comparison table over the
// sky (25.2–35.3 s), the white Argent end card wiping in (35.3–39.47 s).
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const FPS = 30;
export const REF_DIR = process.env.UNCUT_ARGENT_REF ?? join(homedir(), "Documents/devrel/video-editor/argent-haiku45-vs-haiku55");
export const LOGO_SVG = process.env.UNCUT_ARGENT_LOGO ?? join(homedir(), "Documents/devrel/video-editor/studio/library/assets/argent-logo.svg");
/** The reference's files this check reads. */
export const REF = {
  project: join(REF_DIR, "project.json"),
  sky: join(REF_DIR, "assets/breathe-sky.mp4"),
  h45: join(REF_DIR, "assets/h45-1-x8.mp4"),
  h55: join(REF_DIR, "assets/h55b-1-x8.mp4"),
  out: join(REF_DIR, "out/argent-haiku45-vs-haiku55-20261009-0929.mp4"),
};
/** Why the check can't run here (the reference or the logo is missing), or false. */
export function referenceMissing(): string | false {
  for (const f of [...Object.values(REF), LOGO_SVG]) if (!existsSync(f)) return `the Argent reference isn't on this machine (${f} is missing; set UNCUT_ARGENT_REF=<dir> and UNCUT_ARGENT_LOGO=<svg>)`;
  return false;
}

/** Size and mtime of every file under the reference folder, to show the check never changed it. */
export function stampReference(): Array<[string, number, number]> {
  const out: Array<[string, number, number]> = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else out.push([p, st.size, st.mtimeMs]);
    }
  };
  walk(REF_DIR);
  return out;
}

/** The run's own folder of brand files: the dark Argent logo. Returns its path. */
export function makeBrandFolder(dir: string): { logo: string } {
  mkdirSync(dir, { recursive: true });
  const logo = join(dir, "argent-logo-dark.svg");
  writeFileSync(logo, readFileSync(LOGO_SVG, "utf8").replace(/(fill|stroke)="white"/g, '$1="#111111"'));
  return { logo };
}

// ---- the reference's own data ----

interface RefElement {
  readonly id: string;
  readonly text?: string;
  readonly props?: Record<string, any>;
  readonly t0: number;
  readonly t1: number;
}
/** The reference's elements by id, read from its project.json. */
export function referenceElements(): Map<string, RefElement> {
  const p = JSON.parse(readFileSync(REF.project, "utf8")) as { elements: Array<RefElement> };
  return new Map(p.elements.map((e) => [e.id, e]));
}

/** Frames at 30 fps. */
const f = (s: number) => Math.round(s * FPS);
/** The video's length: the reference's 39.46 s. */
export const TOTAL = 1184;
/** Scene boundaries (frames), from the reference's scenes: race ends at 25.194 s, the summary at 35.264 s. */
export const SCENES = { titleEnd: 111, raceEnd: f(25.644), summaryStart: f(25.194), endStart: f(35.264), skyEnd: f(35.864) };

/** The media ids media_import and music_add give these files in an empty project. */
export const IDS = { sky: "m-breathe-sky", h45: "m-h45-1-x8", h55: "m-h55b-1-x8", logo: "m-argent-logo-dark", music: "m-lofi-vinyl-e-piano-loop" };

/** A ui_show/timeline_edit step for the fake claude. */
export type Step = { tool: string; args?: unknown } | { text: string };

const DM = "DM Sans";
/** The race items' dim (under the title card, a stand-in for the reference's backdrop blur) then full, and their fade out. */
const dimKeys = [
  { frame: 0, opacity: 0.3 },
  { frame: 100, opacity: 0.3 },
  { frame: 111, opacity: 1 },
];
const fadeOut = (frames: number) => ({ out: { module: "move.fade", duration: frames } });

/**
 * The scripted agent's first turn: import, music, then the promo scene by scene (each edit after a
 * project_read so it carries the revision), project_check, ui_show. Texts go in at the reference's
 * sizes (26 px task line, 20 px footnotes), so project_check finds them small; the user fixes one in
 * the Checks tab and the agent the others in its second turn.
 */
export function buildTurn(paths: { logo: string }): Array<Step> {
  const ref = referenceElements();
  const log = (id: string) => {
    const p = ref.get(id)!.props!;
    return {
      model: p.model,
      title: p.title,
      speed: p.speed,
      srcAt: p.srcAt,
      runStart: p.runStart,
      durationMs: p.durationMs,
      doneLabel: p.doneLabel,
      tokenLabel: String(p.tokenLabel).replace(/<br>/g, "\n"),
      size: p.size,
      lines: p.lines.map((l: { t: number; tool?: string; text: string }) => ({ t: l.t, ...(l.tool ? { tool: l.tool } : {}), text: l.text })),
      tokens: p.tokens,
    };
  };
  const table = ref.get("sum-table")!.props!;
  const phone = (id: string) => ref.get(id)!.props!;
  const text = (id: string) => ref.get(id)!.text!;
  const read = { tool: "project_read" };
  const edit = (summary: string, ops: Array<unknown>) => ({ tool: "timeline_edit", args: { baseRevision: "$rev", summary, ops } });
  const raceEnd = SCENES.raceEnd;
  return [
    { tool: "media_import", args: { paths: [REF.sky, REF.h45, REF.h55, paths.logo] } },
    { tool: "music_list", args: { mood: "lo-fi" } },
    { tool: "music_add", args: { id: "cozy-3" } },
    { tool: "modules_list", args: { kind: "component" } },
    read,
    edit("The sky and the title card", [
      // Tracks, top to bottom: the end card's (over everything), the texts, the race and the summary, main, music.
      { op: "add_track", index: 0, track: { id: "end-text", kind: "text", name: "End text" } },
      { op: "add_track", index: 1, track: { id: "t-end-code", kind: "video", name: "End code" } },
      { op: "add_track", index: 2, track: { id: "t-end-logo", kind: "video", name: "End logo" } },
      { op: "add_track", index: 3, track: { id: "end", kind: "video", name: "End card" } },
      { op: "add_track", index: 5, track: { id: "text-2", kind: "text", name: "Callouts" } },
      { op: "insert_item", track: "main", item: { id: "sky", type: "clip", media: IDS.sky, in: 0, duration: SCENES.skyEnd, loop: true, transform: { fit: "cover" }, keys: [{ frame: 0, scale: 1 }, { frame: SCENES.summaryStart, scale: 1.07 }, { frame: SCENES.endStart, scale: 1.1 }] } },
      {
        op: "insert_item",
        track: "end-text",
        item: {
          id: "title",
          type: "text",
          start: 0,
          duration: SCENES.titleEnd,
          text: `**${text("title-1")}**\n${text("title-2")}`,
          style: { preset: "text.title", font: DM, size: 80, weight: 400, color: "#111111", align: "center", tracking: 0, lineHeight: 1.15, background: { color: "#FFFFFF", opacity: 0.94, padding: 96, radius: 44 } },
          transform: { x: 370, y: 400, w: 1180 },
          animation: { out: { module: "move.zoom", duration: 11, params: { scale: 0.7, ease: "inOut" } } },
        },
      },
    ]),
    read,
    edit("The race: both recordings in phones beside their agent logs", [
      { op: "insert_device_frame", media: IDS.h45, device: "phone", start: 0, duration: raceEnd, in: Math.round(phone("phone-opus").in * FPS), box: { x: 72, y: 200, h: 739 }, frameId: "phone-45", clipId: "screen-45", color: phone("phone-opus").frame, hold: true },
      { op: "insert_device_frame", media: IDS.h55, device: "phone", start: 0, duration: raceEnd, in: Math.round(phone("phone-haiku").in * FPS), box: { x: 1000, y: 200, h: 739 }, frameId: "phone-55", clipId: "screen-55", color: phone("phone-haiku").frame, hold: true },
      { op: "add_track", index: 6, track: { id: "logs", kind: "video", name: "Log 4.5" } },
      { op: "add_track", index: 7, track: { id: "logs-2", kind: "video", name: "Log 5.5" } },
      { op: "insert_item", track: "logs", item: { id: "log-45", type: "component", component: "component.agent-log", start: 0, duration: raceEnd, transform: { x: 450, y: 200, w: 470, h: 739 }, keys: dimKeys, animation: fadeOut(13), props: log("log-opus") } },
      { op: "insert_item", track: "logs-2", item: { id: "log-55", type: "component", component: "component.agent-log", start: 0, duration: raceEnd, transform: { x: 1378, y: 200, w: 470, h: 739 }, keys: dimKeys, animation: fadeOut(13), props: log("log-haiku") } },
      ...["phone-45", "screen-45", "phone-55", "screen-55"].map((item) => ({ op: "update_item", item, set: { keys: dimKeys, animation: fadeOut(13) } })),
      // The header: the Argent wordmark (an image) and the task line, the footnote at the bottom.
      { op: "add_track", index: 8, track: { id: "header", kind: "video", name: "Header" } },
      { op: "insert_item", track: "header", item: { id: "brand", type: "clip", media: IDS.logo, start: 100, duration: SCENES.summaryStart - 100, transform: { x: 72, y: 69, w: 221, h: 42 }, animation: { in: { module: "move.fade", duration: 15 }, out: { module: "move.fade", duration: 9 } } } },
      { op: "insert_item", track: "text", item: { id: "task", type: "text", start: 103, duration: SCENES.summaryStart - 103, text: text("task"), style: { preset: "text.header", font: DM, size: 26, weight: 400, color: "#1E2A44", tracking: 0 }, transform: { x: 72, y: 128 }, animation: { in: { module: "move.rise", duration: 15 }, out: { module: "move.fade", duration: 9 } } } },
      { op: "insert_item", track: "text-2", item: { id: "footnote", type: "text", start: 109, duration: SCENES.summaryStart - 109, text: text("footnote"), style: { preset: "text.footnote", font: DM, size: 20, weight: 400, color: "#1E2A44" }, transform: { x: 72, y: 984 }, animation: { in: { module: "move.fade", duration: 15 }, out: { module: "move.fade", duration: 9 } } } },
      // The reference's sticker and its emoji as one callout over the Haiku 4.5 log while it says "Excellent!" to an empty table.
      { op: "add_track", index: 6, track: { id: "text-3", kind: "text", name: "Sticker" } },
      { op: "insert_item", track: "text-3", item: { id: "sticker", type: "text", start: f(9.78), duration: f(13.5) - f(9.78), text: `\u{1F921} ${text("sticker-0")}`, style: { font: DM, size: 28, weight: 500, color: "#16171B", lineHeight: 1.3, background: { color: "#FFFFFF", opacity: 0.97, padding: 28, radius: 22 } }, transform: { x: 474, y: 432 }, animation: { in: { module: "move.zoom", duration: 11, params: { scale: 0.35, ease: "out" } }, out: { module: "move.fade", duration: 9 } } } },
    ]),
    read,
    edit("The summary: 3 runs each in one table", [
      { op: "add_track", index: 9, track: { id: "summary", kind: "video", name: "Summary" } },
      { op: "insert_item", track: "summary", item: { id: "table", type: "component", component: "component.compare-table", start: SCENES.summaryStart + 3, duration: SCENES.skyEnd - SCENES.summaryStart - 3, transform: { x: 260, y: 240, w: 1400, h: 600 }, keys: [{ frame: 0, scale: 0.9, opacity: 0, ease: "out" }, { frame: 15, scale: 1, opacity: 1 }], props: { names: table.names, rows: table.rows, start: table.start, step: table.step, grow: table.grow, size: table.size } } },
      { op: "insert_item", track: "text", item: { id: "sum-header", type: "text", start: SCENES.summaryStart + 5, duration: SCENES.skyEnd - SCENES.summaryStart - 5, text: text("sum-header"), style: { preset: "text.header", font: DM, size: 46, weight: 600, color: "#0D1424", tracking: -0.01 }, transform: { x: 72, y: 64 }, animation: { in: { module: "move.rise", duration: 15 } } } },
      { op: "insert_item", track: "text-2", item: { id: "sum-note", type: "text", start: 830, duration: SCENES.skyEnd - 830, text: text("sum-note"), style: { preset: "text.footnote", font: DM, size: 20, weight: 400, color: "#1E2A44" }, transform: { x: 72, y: 984 }, animation: { in: { module: "move.fade", duration: 15 } } } },
    ]),
    read,
    edit("The Argent end card, the music and a −16 LUFS target", [
      { op: "insert_item", track: "end", item: { id: "end-bg", type: "component", component: "component.solid", start: SCENES.endStart, duration: TOTAL - SCENES.endStart, props: { color: "#FFFFFF" }, animation: { in: { module: "move.wipe", duration: 18 } } } },
      { op: "insert_item", track: "t-end-logo", item: { id: "end-logo", type: "clip", media: IDS.logo, start: SCENES.endStart + 15, duration: TOTAL - SCENES.endStart - 15, transform: { x: 810, y: 392, w: 300, h: 58 }, animation: { in: { module: "move.fade", duration: 15 } } } },
      { op: "insert_item", track: "t-end-code", item: { id: "end-code", type: "component", component: "component.code-block", start: SCENES.endStart + 22, duration: TOTAL - SCENES.endStart - 22, transform: { x: 606, y: 470, w: 708, h: 126 }, props: { code: ref.get("end-code")!.props!.code, prompt: true }, animation: { in: { module: "move.fade", duration: 15 } } } },
      // The reference's URL line, with the domain swapped for the author's.
      { op: "insert_item", track: "end-text", item: { id: "end-url", type: "text", start: SCENES.skyEnd, duration: TOTAL - SCENES.skyEnd, text: END_URL, style: { preset: "text.footnote", font: DM, size: 28, weight: 400, color: "#555555", align: "center" }, transform: { x: 0, y: 628, w: 1920 }, animation: { in: { module: "move.fade", duration: 15 } } } },
      { op: "insert_item", track: "audio", item: { id: "music", type: "audio", media: IDS.music, in: 0, start: 0, duration: TOTAL, fadeIn: 9, fadeOut: 60 } },
      { op: "update_track", track: "audio", set: { name: "Music" } },
      { op: "update_project", set: { master: { loudness: { targetLufs: -16 } } } },
    ]),
    { tool: "project_check", args: {} },
    { tool: "ui_show", args: { frame: 300, select: ["sticker"], panel: "checks" } },
    { text: "Built the promo: title card, the race with both recordings held on their last frame, the summary table and the end card, with cozy-3 at a −16 LUFS target. Three texts are under 28 px; see the Checks tab." },
  ];
}

/** The end card's URL line: the reference's argent.example.com, swapped for the author's own. */
export const END_URL = "github.com/blazejkustra";

/**
 * The agent's second turn: fix what project_check still finds. The footnotes' fixes make them
 * 28 px; at that size the long footnote wraps, so it also moves up and gets a width, inside the safe area.
 */
export function fixTurn(checks: ReadonlyArray<{ rule: string; items?: ReadonlyArray<string>; fix?: { readonly ops: ReadonlyArray<unknown> } | undefined }>): Array<Step> {
  const ops = checks.filter((c) => c.fix).flatMap((c) => c.fix!.ops);
  const footnote = ops.find((o) => (o as { item?: string }).item === "footnote") as { set: { style: unknown } } | undefined;
  const moved = ops.map((o) => (o === footnote ? { op: "update_item", item: "footnote", set: { ...footnote!.set, transform: { x: 72, y: 950, w: 1776 } } } : o));
  return [{ tool: "project_read" }, { tool: "timeline_edit", args: { baseRevision: "$rev", summary: "Fix the checks: footnotes at 28 px", ops: moved } }, { tool: "project_check", args: {} }, { tool: "ui_show", args: { frame: 840, panel: "checks" } }, { text: "Fixed the remaining checks." }];
}

// ---- comparing the export with the reference ----

const ff = (args: Array<string>) => execFileSync("ffmpeg", ["-v", "error", ...args], { maxBuffer: 256 * 1024 * 1024 });
/** One frame (by time) as gray or RGB bytes at w×h. */
export function frameBytes(file: string, t: number, { w = 1920, h = 1080, crop, gray = true }: { w?: number; h?: number; crop?: [number, number, number, number]; gray?: boolean } = {}) {
  const vf = [crop ? `crop=${crop[2]}:${crop[3]}:${crop[0]}:${crop[1]}` : "", `scale=${w}:${h}:flags=area`, `format=${gray ? "gray" : "rgb24"}`].filter(Boolean).join(",");
  return ff(["-ss", t.toFixed(3), "-i", file, "-frames:v", "1", "-vf", vf, "-f", "rawvideo", "-"]);
}
/** SSIM of two files' frames at times ta, tb (each cropped, both scaled to w×h, gray). */
export function ssimAt(a: string, ta: number, b: string, tb: number, { w = 480, h = 270, cropA, cropB }: { w?: number; h?: number; cropA?: [number, number, number, number]; cropB?: [number, number, number, number] } = {}) {
  const c = (r?: [number, number, number, number]) => (r ? `crop=${r[2]}:${r[3]}:${r[0]}:${r[1]},` : "");
  const r = spawnSync("ffmpeg", ["-hide_banner", "-ss", ta.toFixed(3), "-i", a, "-ss", tb.toFixed(3), "-i", b, "-lavfi", `[0:v]trim=end_frame=1,${c(cropA)}scale=${w}:${h}:flags=area,format=gray[x];[1:v]trim=end_frame=1,${c(cropB)}scale=${w}:${h}:flags=area,format=gray[y];[x][y]ssim`, "-f", "null", "-"], { encoding: "utf8" });
  const m = /All:([\d.]+)/.exec(r.stderr);
  if (!m) throw new Error(`ssim failed: ${r.stderr.slice(-400)}`);
  return Number(m[1]);
}
/** Mean of a byte buffer. */
export const mean = (b: Buffer) => b.reduce((s, v) => s + v, 0) / b.length;
/** Mean RGB of a frame region. */
export function meanRgb(file: string, t: number, crop: [number, number, number, number]): [number, number, number] {
  const b = frameBytes(file, t, { w: 64, h: 36, crop, gray: false });
  const s = [0, 0, 0];
  for (let i = 0; i < b.length; i++) s[i % 3]! += b[i]!;
  const n = b.length / 3;
  return [s[0]! / n, s[1]! / n, s[2]! / n];
}
/** What a frame looks like, in three numbers per region: the scene signature. */
export interface Signature {
  readonly centre: number;
  readonly edges: number;
  readonly phones: number;
  /** Between the Haiku 4.5 log and the Haiku 5.5 phone: sky in the race, the table's panel in the summary. */
  readonly gap: number;
  readonly sky: [number, number, number];
}
/** Luma of the card area (centre), the frame's edges, the two phone screens; the sky's colour at the top right. */
export function signature(file: string, t: number): Signature {
  return {
    centre: mean(frameBytes(file, t, { w: 64, h: 32, crop: [560, 450, 800, 160] })),
    edges: mean(frameBytes(file, t, { w: 64, h: 36, crop: [0, 0, 1920, 40] })),
    phones: (mean(frameBytes(file, t, { w: 32, h: 64, crop: [90, 260, 300, 600] })) + mean(frameBytes(file, t, { w: 32, h: 64, crop: [1018, 260, 300, 600] }))) / 2,
    gap: mean(frameBytes(file, t, { w: 16, h: 64, crop: [928, 300, 64, 500] })),
    sky: meanRgb(file, t, [1500, 60, 380, 100]),
  };
}
/** Which scene a signature is: the white title card, the race (dark phones on the sky), the dark table on the sky, the white end card. */
export function sceneOf(s: Signature): "title" | "race" | "table" | "end" | "?" {
  const blue = s.sky[2] > s.sky[0] + 40;
  if (s.edges > 235 && s.sky.every((c) => c > 235)) return "end";
  if (blue && s.centre > 170) return "title";
  if (blue && s.gap < 80 && s.centre < 120) return "table";
  if (blue && s.gap > 100 && s.centre < 140) return "race";
  return "?";
}

/** Integrated loudness and true peak (ebur128 with peak=true). */
export function loudness(file: string): { lufs: number; truePeak: number } {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-nostats", "-i", file, "-af", "ebur128=peak=true", "-f", "null", "-"], { encoding: "utf8" });
  const tail = r.stderr.slice(r.stderr.lastIndexOf("Summary:"));
  const value = (re: RegExp) => {
    const m = re.exec(tail)?.[1];
    return m === undefined ? NaN : /inf/.test(m) ? -Infinity : Number(m);
  };
  return { lufs: value(/I:\s+(-?inf|-?[\d.]+) LUFS/), truePeak: value(/Peak:\s+(-?inf|-?[\d.]+) dBFS/) };
}

/** ffprobe of the first video stream and the format. */
export function probe(file: string): { width: number; height: number; fps: string; codec: string; duration: number; frames: number; audio: string | undefined } {
  const j = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-count_packets", "-show_entries", "stream=codec_type,codec_name,width,height,r_frame_rate,nb_read_packets:format=duration", "-of", "json", file], { encoding: "utf8" }));
  const v = j.streams.find((s: any) => s.codec_type === "video");
  return { width: v.width, height: v.height, fps: v.r_frame_rate, codec: v.codec_name, duration: Number(j.format.duration), frames: Number(v.nb_read_packets), audio: j.streams.find((s: any) => s.codec_type === "audio")?.codec_name };
}

/** A contact sheet (one frame a second, tiled) of a video. */
export function contactSheet(file: string, out: string, { cols = 8, width = 480 } = {}) {
  ff(["-y", "-i", file, "-vf", `fps=1,scale=${width}:-2,tile=${cols}x${Math.ceil(40 / cols)}`, "-frames:v", "1", "-update", "1", out]);
}
/** Reference (left) and export (right) side by side at the given times, one row each. */
export function compareSheet(reference: string, exported: string, times: ReadonlyArray<number>, out: string) {
  const inputs = times.flatMap((t) => ["-ss", t.toFixed(2), "-i", reference, "-ss", t.toFixed(2), "-i", exported]);
  const parts = times.map((_, i) => `[${2 * i}:v]trim=end_frame=1,scale=640:360[r${i}];[${2 * i + 1}:v]trim=end_frame=1,scale=640:360[e${i}];[r${i}][e${i}]hstack[row${i}]`);
  const graph = `${parts.join(";")};${times.map((_, i) => `[row${i}]`).join("")}vstack=inputs=${times.length}`;
  ff(["-y", ...inputs, "-filter_complex", graph, "-frames:v", "1", "-update", "1", out]);
}

/** Where each phone's screen is in the reference (its bezel is 9 px inside a 350×739 box at x 72 / 1000, y 200). */
export const REF_SCREENS: Array<[number, number, number, number]> = [
  [81, 209, 332, 721],
  [1009, 209, 332, 721],
];
