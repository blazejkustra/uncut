// The export rasteriser (D55): an offscreen, transparent Chromium page that draws HTML at a given
// size and saves it as a PNG. The server starts it (this binary with --uncut-render) for an
// export or the agent's frame renders and talks to it in JSON lines:
//   stdin  ← { id, width, height, css, html, out }   one request at a time (out: .png, or .jpg for
//                                                    an opaque JPEG such as the agent's contact sheet)
//   stdout → { uncut: "render-started", id }          when it starts on a request (they queue; a server
//                                                    that doesn't know it skips it: not "render")
//   stdout → { uncut: "render", id, ok: true } | { uncut: "render", id, ok: false, error }
//   stdout → { uncut: "render", ready: true }          once, when the page is loaded
//   stdin  ← { id, kind: "graphic", width, height, doc, t, info, out }   a graphic item's frame (D78):
//                                                    its document (core graphicDocument) loaded in a
//                                                    window of its own, render(t, info) called, captured
//                                                    with `ts` (motion blur's sub-frames, at most 64): their
//                                                    pictures averaged as seq-graphic averages them (D291)
//   stdin  ← { id, kind: "graphic-run", width, height, doc, info, frames, ts?, name?, fresh? }   a rehearsal:
//                                                    render(t, info) at each frame of `frames` (the graphic's
//                                                    own frames, info.frame set to each) and, with `ts`, at
//                                                    each of its sub-frames, in order, in the graphic window
//                                                    as the export calls it, nothing captured (`fresh`: the
//                                                    document loaded anew first); fails with
//                                                    "at its frame <n>: <why>" at the first that throws
//   either of the first two with outWidth and outHeight: laid out at width × height, the capture shrunk
//                                                    to outWidth × outHeight before it's encoded (D292)
//   stdin  ← { id, kind: "graphic-scan", width, height, doc, info, ts, name? }   what the page shows at each
//                                                    t of `ts` (core GRAPHIC_SCAN), nothing captured; the
//                                                    reply carries `scan`
//   stdin  ← { id, kind: "shader", width, height, code, frame, params?, input, out }   a shader effect's
//                                                    frame (D213): `input` a width×height RGBA file, drawn
//                                                    with WebGPU (core shaderModuleCode `code`, the
//                                                    uniforms' floats `frame` and `params`) in a window
//                                                    of its own, read back; `out` .rgba (raw) or .png.
//                                                    No WebGPU here: fails with "no-webgpu: <why>".
//   stdin  ← { id, kind: "shader-probe" }            fails with "no-webgpu: <why>" when there's no WebGPU
//   stdin  ← { id, kind: "seq-open", width, height, out }   a frame sequence (D291): every frame after it
//                                                    is written to `out` (a FIFO an ffmpeg reads) as raw
//                                                    width×height BGRA, straight alpha, no PNG between
//   stdin  ← { id, kind: "seq-graphic", doc, ts, info, name? }   one frame of a graphic: render(t, info)
//                                                    at each t of `ts` (motion blur's sub-frames: their
//                                                    pictures averaged, premultiplied, into the frame written)
//   stdin  ← { id, kind: "seq-html", css, html }     one frame drawn from HTML, as a plain request draws it
//   stdin  ← { id, kind: "seq-hold", count }         the last frame written again `count` times
//   stdin  ← { id, kind: "seq-close" }               the sequence's end: `out` closed once all is written
// It knows nothing about projects: the server builds the HTML with core's textHtml / solidHtml /
// componentHtml and RENDER_CSS (D39, D53, D76). The bundled DM Sans and DM Mono (D77) are loaded
// once with the page, from data: URLs, with the preview's @font-face rules; the brand kit's fonts
// (D198) come in a request's css. Nothing may load from
// the network: every request that isn't a data: URL is cancelled. It quits when stdin closes,
// i.e. when the server is done with it or gone. Its Chromium profile is a temp folder (see below).
import { createWriteStream, mkdtempSync, readFileSync, rmSync, writeFileSync, type WriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as readline from "node:readline";

import { app, BrowserWindow, nativeImage, protocol, session } from "electron";
import { handleMedia, isMediaUrl, MEDIA_MS, MEDIA_SCHEME_PRIVILEGES, mediaActive, mediaAnswered, mediaWaiting, takeMediaReply } from "./renderMedia.ts";

import { fontFaceCss, type FontFile } from "../../../packages/core/src/visual/render.ts";
import { GRAPHIC_CENSUS } from "../../../packages/core/src/visual/census.ts";
import { GRAPHIC_SCAN } from "../../../packages/core/src/visual/graphicScan.ts";
import { isScanRequest, type ScanRequest } from "./renderScan.ts";
import {
  BLUR_REFINE,
  blurFarPairs,
  blurLevels,
  blurMoving,
  blurRefinable,
  blurSignature,
  blurStep,
  type BlurSignature,
} from "../../../packages/core/src/visual/motionBlur.ts";
import dmSans from "../../../assets/fonts/DMSans-Variable.woff2";
import dmMonoRegular from "../../../assets/fonts/DMMono-Regular.woff2";
import dmMonoMedium from "../../../assets/fonts/DMMono-Medium.woff2";

const FONT_URLS: Record<FontFile, string> = { "DMSans-Variable.woff2": dmSans, "DMMono-Regular.woff2": dmMonoRegular, "DMMono-Medium.woff2": dmMonoMedium };
/** How long a graphic's render(t) may take (core GRAPHIC_FRAME_MS). */
const GRAPHIC_FRAME_MS = 5000;
/**
 * Past GRAPHIC_FRAME_MS a frame still fetching project media (a request in flight, or one asked or
 * answered within MEDIA_IDLE_MS: pictures fetched one after another) keeps going, up to MEDIA_MS
 * more but never past GRAPHIC_CAP_MS, under the server's own 30 s (rasterizer.ts
 * RENDER_TIMEOUT_MS), so the error naming the slow phase is the one that comes back.
 */
const MEDIA_IDLE_MS = 1500;
const GRAPHIC_CAP_MS = 27_000;
/** How long the page gets to answer "what are you doing?" once a frame is late: no answer is a script that never yields. */
const PROBE_MS = 400;
/**
 * Motion blur's refinement (D309, see `blurred`): a finer grid starts only if it would end by
 * REFINE_MS from the request's start at the first grid's cost per sub-frame, and is cut off at
 * REFINE_LIMIT_MS; both well under GRAPHIC_CAP_MS and the server's 30 s.
 */
const REFINE_MS = 12_000;
const REFINE_LIMIT_MS = 18_000;
/** How many times a capture is tried when Chromium has no frame to copy yet (see capturePage). */
const CAPTURE_ATTEMPTS = 6;
/** How long a capture waits for the frame it asked for (see nextPaint). */
const PAINT_WAIT_MS = 1000;
/**
 * The offscreen windows' frame rate (D291): a capture waits for the page's next frames (two
 * animation frames, then a paint), so at Chromium's default 60 that wait alone is ~33 ms a frame;
 * at 240 it is ~8. What is drawn doesn't change, only how soon it's there to copy.
 */
const FRAME_RATE = 240;
/**
 * The sentinel (D291): every capture is one row taller than the picture, and that row is a colour
 * the page sets once what was asked for is drawn (after render(t) and its frames, or the HTML's
 * fonts, images and frames). A capture whose row isn't that colour copied an older frame (a busy
 * machine: Chromium's compositor a frame or two behind, #88), so it's taken again; the row is cut
 * off. The windows are one pixel taller than the canvas: the HTML page's frame stays canvas-sized,
 * a graphic's innerHeight (and 100vh) is one more (its size comes from info.width and info.height).
 */
const SENTINEL_ID = "__uncut_sentinel";
/** How long a capture may wait for the sentinel before the frame fails (ms). */
const SENTINEL_WAIT_MS = 4000;
/** JS that sets the sentinel row (at y = `height`) to mark `mark` (1–7: three channels on or off). */
const setSentinel = (height: number, mark: number) =>
  `(() => { let s = document.getElementById("${SENTINEL_ID}"); if (!s) { s = document.createElement("div"); s.id = "${SENTINEL_ID}"; s.style.cssText = "position:fixed;left:0;right:0;height:1px;margin:0;padding:0;border:0;z-index:2147483647;pointer-events:none;opacity:1;transform:none;filter:none"; document.documentElement.appendChild(s); }
    s.style.top = "${height}px"; s.style.background = "rgb(${mark & 4 ? 255 : 0},${mark & 2 ? 255 : 0},${mark & 1 ? 255 : 0})"; })()`;
/** Straight alpha from Chromium's premultiplied BGRA, in place (the PNG path's toPNG does the same). */
function unpremultiply(px: Uint8Array) {
  for (let i = 3; i < px.length; i += 4) {
    const a = px[i]!;
    if (a === 255 || a === 0) continue;
    const k = 255 / a;
    px[i - 3] = Math.min(255, px[i - 3]! * k + 0.5);
    px[i - 2] = Math.min(255, px[i - 2]! * k + 0.5);
    px[i - 1] = Math.min(255, px[i - 1]! * k + 0.5);
  }
}

interface HtmlRequest {
  readonly id: number;
  readonly kind?: undefined;
  readonly width: number;
  readonly height: number;
  readonly css: string;
  readonly html: string;
  readonly out: string;
  /** D292: shrink the capture to this size before it's saved (the page still lays out at width × height). */
  readonly outWidth?: number;
  readonly outHeight?: number;
}
interface GraphicRequest {
  readonly id: number;
  readonly kind: "graphic";
  readonly width: number;
  readonly height: number;
  readonly doc: string;
  readonly t: number;
  /** Motion blur's sub-frames (over the shutter from t; D309: refined on a fast move as the export's): their pictures averaged into the one saved, as the export's. */
  readonly ts?: ReadonlyArray<number>;
  readonly info: unknown;
  readonly out: string;
  /** What to call it in an error ("intro" (graphics/intro.html)). */
  readonly name?: string;
  /** D292: as HtmlRequest's. */
  readonly outWidth?: number;
  readonly outHeight?: number;
  /** The text census (packages/core census.ts) after the frame: words whose letters stand under this share of the height come back with the reply. */
  readonly census?: number;
}
interface ShaderRequest {
  readonly id: number;
  readonly kind: "shader";
  readonly width: number;
  readonly height: number;
  /** core shaderModuleCode. */
  readonly code: string;
  /** core shaderFrameBytes as floats (4). */
  readonly frame: ReadonlyArray<number>;
  /** core shaderParamBytes as floats, when it has params. */
  readonly params?: ReadonlyArray<number>;
  /** The picture: width × height RGBA, rows from the top. */
  readonly input: string;
  readonly out: string;
  readonly name?: string;
}
interface ProbeRequest {
  readonly id: number;
  readonly kind: "shader-probe";
}
/** A frame sequence (D291), see the header: open, frames (graphic, html, hold), close. */
type SeqRequest =
  | { readonly id: number; readonly kind: "seq-open"; readonly width: number; readonly height: number; readonly out: string }
  | {
      readonly id: number;
      readonly kind: "seq-graphic";
      readonly doc: string;
      readonly ts: ReadonlyArray<number>;
      readonly info: unknown;
      readonly name?: string;
    }
  | { readonly id: number; readonly kind: "seq-html"; readonly css: string; readonly html: string }
  | { readonly id: number; readonly kind: "seq-hold"; readonly count: number }
  | { readonly id: number; readonly kind: "seq-close" };
/** A rehearsal (see the header): the graphic's frames called in order, nothing captured. */
interface RunRequest {
  readonly id: number;
  readonly kind: "graphic-run";
  readonly width: number;
  readonly height: number;
  readonly doc: string;
  readonly info: Record<string, unknown>;
  readonly frames: ReadonlyArray<number>;
  readonly ts?: ReadonlyArray<ReadonlyArray<number>>;
  readonly name?: string;
  readonly fresh?: boolean;
}
/** The most frames one rehearsal request takes. */
const MAX_RUN_FRAMES = 2000;
const isRunRequest = (v: unknown): v is RunRequest => {
  const r = v as Partial<RunRequest> | null;
  if (typeof r !== "object" || r === null || r.kind !== "graphic-run" || !Number.isInteger(r.id)) return false;
  const size = (n: unknown) => Number.isInteger(n) && (n as number) > 0 && (n as number) <= 8192;
  const num = (x: unknown) => typeof x === "number" && Number.isFinite(x);
  if (!size(r.width) || !size(r.height) || typeof r.doc !== "string" || typeof r.info !== "object" || r.info === null) return false;
  if (!Array.isArray(r.frames) || r.frames.length < 1 || r.frames.length > MAX_RUN_FRAMES || !r.frames.every(num)) return false;
  if (
    r.ts !== undefined &&
    (!Array.isArray(r.ts) ||
      r.ts.length !== r.frames.length ||
      !r.ts.every((x) => Array.isArray(x) && x.length >= 1 && x.length <= MAX_SUBFRAMES && x.every(num)))
  )
    return false;
  return (r.name === undefined || typeof r.name === "string") && (r.fresh === undefined || typeof r.fresh === "boolean");
};
type Request = HtmlRequest | GraphicRequest | ShaderRequest | ProbeRequest | SeqRequest | RunRequest | ScanRequest;
/** The most sub-frames one sequence frame may average (motion blur). */
const MAX_SUBFRAMES = 64;

const isSeqRequest = (v: unknown): v is SeqRequest => {
  const r = v as {
    id?: unknown;
    kind?: unknown;
    width?: unknown;
    height?: unknown;
    out?: unknown;
    doc?: unknown;
    ts?: unknown;
    name?: unknown;
    css?: unknown;
    html?: unknown;
    count?: unknown;
  };
  if (typeof r !== "object" || r === null || !Number.isInteger(r.id) || typeof r.kind !== "string" || !r.kind.startsWith("seq-")) return false;
  const size = (n: unknown) => Number.isInteger(n) && (n as number) > 0 && (n as number) <= 8192;
  switch (r.kind) {
    case "seq-open":
      return size(r.width) && size(r.height) && typeof r.out === "string";
    case "seq-graphic":
      return (
        typeof r.doc === "string" &&
        Array.isArray(r.ts) &&
        r.ts.length >= 1 &&
        r.ts.length <= MAX_SUBFRAMES &&
        r.ts.every((t) => typeof t === "number" && Number.isFinite(t)) &&
        (r.name === undefined || typeof r.name === "string")
      );
    case "seq-html":
      return typeof r.css === "string" && typeof r.html === "string";
    case "seq-hold":
      return Number.isInteger(r.count) && (r.count as number) >= 1;
    case "seq-close":
      return true;
    default:
      return false;
  }
};

/** A thrown value as a sentence: an Error's message, a DOMException-like object's name and message, else String() of it. */
const messageOf = (error: unknown): string => {
  const e = error as { name?: unknown; message?: unknown } | null | undefined;
  if (e && typeof e === "object" && typeof e.message === "string" && e.message)
    return `${typeof e.name === "string" && e.name && e.name !== "Error" && !(error instanceof Error) ? `${e.name}: ` : ""}${e.message}`;
  const s = error === undefined || error === null ? "" : String(error);
  return s && s !== "[object Object]" ? s : "it failed without saying why";
};

const reply = (msg: Record<string, unknown>) => process.stdout.write(`${JSON.stringify({ uncut: "render", ...msg })}\n`);

// Never share the app's profile (Chromium locks it) and never write to the user's. The server
// passes a folder it removes once this process is gone (--uncut-profile=…, so even a SIGKILL
// leaves nothing); without one, a temp folder of our own goes on quit.
const given = process.argv.find((a) => a.startsWith("--uncut-profile="))?.slice("--uncut-profile=".length);
const profile = given || mkdtempSync(join(tmpdir(), "uncut-render-profile-"));
app.setPath("userData", profile);
app.setPath("sessionData", profile);
// One CSS pixel is one PNG pixel, whatever the screen.
app.commandLine.appendSwitch("force-device-scale-factor", "1");
// Tests of the no-WebGPU path (D213): no GPU at all, as on a Mac without a usable one.
if (process.argv.includes("--uncut-no-gpu")) app.commandLine.appendSwitch("disable-gpu");
// Shader effects (D213) draw with WebGPU, which Chromium gives only to secure pages: their window
// loads Uncut's own page from this scheme (data: pages aren't secure contexts).
const SHADER_SCHEME = "uncut-shader";
protocol.registerSchemesAsPrivileged([{ scheme: SHADER_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } }, MEDIA_SCHEME_PRIVILEGES]);
/** The shader page: nothing of its own but the runner (apps/web/src/preview/shaderRunner.ts, bundled as shader-runner.js). */
const SHADER_PAGE = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src ${SHADER_SCHEME}:; connect-src ${SHADER_SCHEME}:">
<script src="${SHADER_SCHEME}://uncut/runner.js"></script></head><body></body></html>`;
/** How long a shader frame may take (upload, draw, read back). */
const SHADER_FRAME_MS = 5000;
app.dock?.hide();
app.on("window-all-closed", () => {});
if (!given) app.on("will-quit", () => rmSync(profile, { recursive: true, force: true }));

// Nothing in the page may load anything: inline styles only, no scripts of its own (the content
// is set from here), no network. Images only as data: URLs (the contact sheet's frames, D65).
const PAGE = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:">
<style>${fontFaceCss((f) => FONT_URLS[f])}</style>
<style>html,body{margin:0;padding:0;background:transparent;overflow:hidden;width:100%;height:100%}
.frame{position:absolute;inset:0 0 1px 0;overflow:hidden;container-type:size}</style>
<style id="css"></style></head><body><div class="frame" id="frame"></div></body></html>`;

const isRequest = (v: unknown): v is Request => {
  if (isSeqRequest(v) || isRunRequest(v) || isScanRequest(v)) return true;
  if (typeof v === "object" && v !== null && (v as { kind?: unknown }).kind === "shader-probe") return Number.isInteger((v as { id?: unknown }).id);
  const r = v as Partial<HtmlRequest> & Partial<Omit<GraphicRequest, "kind">> & { kind?: unknown };
  const sized =
    typeof r === "object" &&
    r !== null &&
    Number.isInteger(r.id) &&
    Number.isInteger(r.width) &&
    Number.isInteger(r.height) &&
    r.width! > 0 &&
    r.height! > 0 &&
    r.width! <= 8192 &&
    r.height! <= 8192 &&
    typeof r.out === "string";
  if (!sized) return false;
  // D292: an output size is both or neither, and no bigger than the page.
  if (r.outWidth !== undefined || r.outHeight !== undefined) {
    const within = (n: unknown, max: number) => Number.isInteger(n) && (n as number) > 0 && (n as number) <= max;
    if ((r.kind !== undefined && r.kind !== "graphic") || !within(r.outWidth, r.width!) || !within(r.outHeight, r.height!)) return false;
  }
  if (r.kind === "graphic")
    return (
      typeof r.doc === "string" &&
      typeof r.t === "number" &&
      Number.isFinite(r.t) &&
      (r.name === undefined || typeof r.name === "string") &&
      (r.census === undefined || (typeof r.census === "number" && r.census > 0 && r.census < 1)) &&
      (r.ts === undefined ||
        (Array.isArray(r.ts) && r.ts.length >= 1 && r.ts.length <= MAX_SUBFRAMES && r.ts.every((t) => typeof t === "number" && Number.isFinite(t))))
    );
  if ((r.kind as unknown) === "shader") {
    const sr = v as Partial<ShaderRequest>;
    const floats = (a: unknown, max: number) => Array.isArray(a) && a.length <= max && a.every((x) => typeof x === "number" && Number.isFinite(x));
    return (
      typeof sr.code === "string" &&
      sr.code.length <= 64 * 1024 &&
      floats(sr.frame, 4) &&
      sr.frame!.length === 4 &&
      (sr.params === undefined || floats(sr.params, 256)) &&
      typeof sr.input === "string" &&
      (sr.name === undefined || typeof sr.name === "string")
    );
  }
  return r.kind === undefined && typeof r.css === "string" && typeof r.html === "string";
};

const windowOptions = {
  show: false,
  width: 1920,
  height: 1080,
  frame: false,
  transparent: true,
  backgroundColor: "#00000000",
  useContentSize: true,
  enableLargerThanScreen: true,
  webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
} as const;

async function main() {
  await app.whenReady();
  // No permissions (camera, microphone, clipboard, …) for anything drawn here.
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  // No network for anything drawn here (a graphic's script included): only data: URLs load.
  // The shader page loads only from Uncut's own scheme (served here, from nothing a page names).
  session.defaultSession.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (details, callback) =>
    callback({ cancel: !details.url.startsWith("data:") && !details.url.startsWith(`${SHADER_SCHEME}://uncut/`) && !isMediaUrl(details.url) }),
  );
  // D290: a graphic's project media, asked of the server (renderMedia.ts).
  handleMedia(protocol, reply);
  // The picture of the shader frame being drawn (its input file), fetched by the shader page.
  let shaderInput: Buffer | undefined;
  let runnerJs: string | undefined;
  protocol.handle(SHADER_SCHEME, (request) => {
    const path = new URL(request.url).pathname;
    if (path === "/page") return new Response(SHADER_PAGE, { headers: { "content-type": "text/html; charset=utf-8" } });
    if (path === "/runner.js") {
      try {
        runnerJs ??= readFileSync(join(__dirname, "shader-runner.js"), "utf8");
      } catch {
        return new Response("", { status: 404 });
      }
      return new Response(runnerJs, { headers: { "content-type": "text/javascript; charset=utf-8" } });
    }
    if (path === "/frame" && shaderInput) return new Response(new Uint8Array(shaderInput), { headers: { "content-type": "application/octet-stream" } });
    return new Response("", { status: 404 });
  });
  const win = new BrowserWindow(windowOptions);
  win.webContents.setFrameRate(FRAME_RATE);
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(PAGE)}`);
  win.webContents.setZoomFactor(1);
  // Every bundled face loaded up front, so the first text drawn in DM Sans isn't the fallback.
  await win.webContents.executeJavaScript("Promise.all([...document.fonts].map((f) => f.load().catch(() => {}))).then(() => true)");
  reply({ ready: true });

  // Graphics (D78) draw in a window of their own, which keeps the last document loaded (one item's
  // frames come one after another). A render(t) that doesn't finish in time takes the window with it.
  let graphicWin: BrowserWindow | undefined;
  let graphicDoc = "";
  // A capture can fail with "UnknownVizError" when the offscreen view has no frame of its current
  // size to copy yet: just after a resize, on a busy machine or a VM's paravirtual GPU (GitHub's
  // macOS runners, #88). The page is already what was asked for, so ask for a fresh frame and try
  // again, a few times, before giving up.
  const capturePage = async (target: BrowserWindow, rect: { x: number; y: number; width: number; height: number }) => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await target.webContents.capturePage(rect);
      } catch (error) {
        if (attempt >= CAPTURE_ATTEMPTS || !/UnknownVizError/.test((error as Error).message ?? String(error))) throw error;
        target.webContents.invalidate();
        await new Promise((done) => setTimeout(done, 40 * attempt));
      }
    }
  };
  // The two animation frames the page waits for don't promise the browser has a frame with what
  // was set: on a busy machine (a CI VM, #88) the capture could copy the one before it. So ask for
  // a fresh frame now and capture once it has painted (capped: a view that never paints still
  // gets its capture).
  const nextPaint = (target: BrowserWindow) =>
    new Promise<void>((done) => {
      const finish = () => {
        clearTimeout(timer);
        target.webContents.off("paint", finish);
        done();
      };
      const timer = setTimeout(finish, PAINT_WAIT_MS);
      target.webContents.on("paint", finish);
      target.webContents.invalidate();
    });
  // The sentinel's mark for the next frame (1–7, never the one before it).
  let mark = 0;
  const nextMark = () => (mark = (mark % 7) + 1);
  /** The page as it is drawn now, width × height, once its sentinel row shows `expected` (see SENTINEL_ID). */
  const grab = async (target: BrowserWindow, width: number, height: number, expected: number) => {
    const until = Date.now() + SENTINEL_WAIT_MS;
    for (;;) {
      await nextPaint(target);
      let image = await capturePage(target, { x: 0, y: 0, width, height: height + 1 });
      const size = image.getSize();
      if (size.width !== width || size.height !== height + 1) image = image.resize({ width, height: height + 1, quality: "best" });
      const row = image.crop({ x: 0, y: height, width: 1, height: 1 }).toBitmap();
      const seen = (row[2]! > 127 ? 4 : 0) + (row[1]! > 127 ? 2 : 0) + (row[0]! > 127 ? 1 : 0);
      if (seen === expected) return image.crop({ x: 0, y: 0, width, height });
      if (Date.now() > until) throw new Error("the frame drawn never reached the capture (the machine too busy?)");
    }
  };
  // D292: an output size shrinks the capture (laid out and checked at full size) before it's encoded.
  const save = (out: string, size?: { readonly outWidth?: number; readonly outHeight?: number }) => (full: Electron.NativeImage) => {
    const image =
      size?.outWidth && size.outHeight && (size.outWidth !== full.getSize().width || size.outHeight !== full.getSize().height)
        ? full.resize({ width: size.outWidth, height: size.outHeight, quality: "best" })
        : full;
    writeFileSync(out, /\.jpe?g$/i.test(out) ? image.toJPEG(85) : image.toPNG());
  };
  const capture = async (target: BrowserWindow, r: HtmlRequest | GraphicRequest, expected: number) =>
    save(r.out, r)(await grab(target, r.width, r.height, expected));
  const newGraphicWindow = () => {
    const gw = new BrowserWindow(windowOptions);
    gw.webContents.setFrameRate(FRAME_RATE);
    gw.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    // A graphic can't navigate away (its document is all it gets) nor reach anyone over WebRTC
    // (CSP has no webrtc directive Chromium honours; without a proxy this keeps UDP off).
    gw.webContents.on("will-navigate", (event) => event.preventDefault());
    gw.webContents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
    return gw;
  };
  // The frame's load, size and render(t) are under one deadline (GRAPHIC_FRAME_MS): a document
  // whose top-level script never ends stalls its load, not just render. The capture after render(t)
  // isn't the graphic's time: it has its own bound (grab's SENTINEL_WAIT_MS) and doesn't count, so a
  // busy machine slow to paint (a CI VM) doesn't fail a graphic that drew in time. On expiry the
  // window goes and the next frame starts from a fresh one.
  // `ts`: the times drawn (a sequence frame's sub-frames, D291), each picture handed to `take`; a
  // time equal to the one before it is not drawn again. The deadline grows with them.
  // Without `take` (a rehearsal) nothing is captured: render(t) runs as the export calls it, without
  // the frames a capture waits for.
  // `limitMs` (a motion-blur refinement, D309): the whole call ends by then, whatever it's doing.
  const renderGraphic = async (
    r: Pick<GraphicRequest, "width" | "height" | "doc" | "info" | "name">,
    ts: ReadonlyArray<number>,
    take?: (image: Electron.NativeImage) => void | Promise<void>,
    limitMs?: number,
  ) => {
    if (!graphicWin || graphicWin.isDestroyed()) {
      graphicWin = newGraphicWindow();
      graphicDoc = "";
    }
    const gw = graphicWin;
    const name = r.name ? `${r.name}: ` : "";
    // Where the frame is, for the error when it's late: the first frame of a document just loaded
    // runs the graphic's own setup (fonts, libraries, thumbnails fetched), the usual slow one.
    let phase: "load" | "first" | "render" | "capture" = "render";
    let fresh = false;
    let current: number | undefined;
    // Time spent capturing (ours, not the graphic's): the GRAPHIC_FRAME_MS budget is the graphic's
    // load and render(t), so a busy machine slow to hand back the painted frame doesn't use it up.
    // grab is bounded on its own (SENTINEL_WAIT_MS, then its own error); GRAPHIC_CAP_MS caps it all.
    let captured = 0;
    let captureFrom = 0;
    const work = (async () => {
      const [w, h] = gw.getContentSize();
      if (w !== r.width || h !== r.height + 1) gw.setContentSize(r.width, r.height + 1);
      if (graphicDoc !== r.doc) {
        graphicDoc = "";
        fresh = true;
        phase = "load";
        await gw.loadURL(`data:text/html;base64,${Buffer.from(r.doc).toString("base64")}`);
        gw.webContents.setZoomFactor(1);
        graphicDoc = r.doc;
      }
      if (!take) {
        for (const [i, t] of ts.entries()) {
          if (i > 0 && t === ts[i - 1]) continue;
          current = t;
          phase = fresh && i === 0 ? "first" : "render";
          await gw.webContents.executeJavaScript(`window.__uncutRender(${JSON.stringify(t)}, ${JSON.stringify(r.info ?? {})}, true).then(() => true)`);
        }
        return;
      }
      let image: Electron.NativeImage | undefined;
      for (const [i, t] of ts.entries()) {
        if (!image || t !== ts[i - 1]) {
          current = t;
          const expected = nextMark();
          phase = fresh && !image ? "first" : "render";
          await gw.webContents.executeJavaScript(
            `window.__uncutRender(${JSON.stringify(t)}, ${JSON.stringify(r.info ?? {})}).then(() => ${setSentinel(r.height, expected)})`,
          );
          phase = "capture";
          captureFrom = Date.now();
          try {
            image = await grab(gw, r.width, r.height, expected);
          } finally {
            captured += Date.now() - captureFrom;
            captureFrom = 0;
          }
        }
        await take(image);
      }
    })();
    let timer: NodeJS.Timeout | undefined;
    // Round 3's A2: a frame fetching project media (uncut.frame of footage not decoded yet: a
    // timeline of thumbnails) keeps going while it does (see MEDIA_IDLE_MS, GRAPHIC_CAP_MS). A late
    // frame asks the page what it's doing, and the error names the phase: the page loading, its
    // script never yielding, pictures still coming, or a promise that never settles.
    const limit = limitMs ?? Infinity;
    const budget = Math.min(GRAPHIC_FRAME_MS * ts.length, limit);
    const cap = Math.min(Math.max(budget, Math.min(budget + MEDIA_MS, GRAPHIC_CAP_MS)), limit);
    const started = Date.now();
    const answeredBefore = mediaAnswered();
    type Probe = { readonly fonts?: string; readonly doc?: string; readonly pending?: number } | undefined;
    const probe = (): Promise<Probe> => {
      if (gw.isDestroyed()) return Promise.resolve(undefined);
      const asked = gw.webContents
        .executeJavaScript(
          `({ fonts: document.fonts.status, doc: document.readyState, pending: window.__uncutMedia && window.__uncutMedia.stats ? window.__uncutMedia.stats().pending : 0 })`,
        )
        .then(
          (x: Probe) => x ?? {},
          () => undefined,
        );
      let wait: NodeJS.Timeout | undefined;
      return Promise.race([asked, new Promise<undefined>((done) => (wait = setTimeout(() => done(undefined), PROBE_MS)))]).finally(() => clearTimeout(wait));
    };
    let settled = false;
    const hardCap = Math.min(Math.max(cap, GRAPHIC_CAP_MS), limit);
    const expired = async (reject: (e: Error) => void) => {
      if (settled) return;
      const now = Date.now();
      const own = now - started - captured - (captureFrom ? now - captureFrom : 0);
      if (own < budget && now - started < hardCap) {
        timer = setTimeout(() => void expired(reject), Math.max(250, budget - own));
        return;
      }
      const page = await probe();
      if (settled) return;
      const elapsed = Date.now() - started;
      const fetching = mediaActive(MEDIA_IDLE_MS) || (page?.pending ?? 0) > 0;
      if (fetching && elapsed < cap) {
        timer = setTimeout(() => void expired(reject), 250);
        return;
      }
      const media = mediaWaiting();
      const got = mediaAnswered() - answeredBefore;
      // The sub-frame it was drawing (D309: not the frame's first).
      const at = ts.length ? ` at ${(current ?? ts[0]!).toFixed(ts.length > 1 ? 4 : 2)} s` : "";
      const which = phase === "load" || phase === "first" ? `${at} (its first frame, the document just loaded)` : at;
      const pictures = got ? `; ${got} project picture${got === 1 ? "" : "s"} (uncut.frame) came in during it` : "";
      const pendingList = media.length
        ? `${media
            .slice(0, 3)
            .map((x) => `${x.id} at ${x.t.toFixed(2)} s`)
            .join(", ")}${media.length > 3 ? ` and ${media.length - 3} more` : ""}`
        : "";
      const why = fetching
        ? `: it was still fetching project media${pendingList ? ` (${pendingList})` : ""}${pictures}: ask uncut.frame for fewer or smaller pictures, fetch them together (Promise.all) rather than one after another, or fetch them once and reuse them`
        : !page
          ? `: its script never yielded (an endless loop, or heavy synchronous work${phase === "load" ? " in a top-level script" : " in render(t)"})${pictures}`
          : phase === "load"
            ? `: the page was still loading (document ${page.doc ?? "?"}, fonts ${page.fonts ?? "?"})`
            : phase === "capture" // only past hardCap: grab gives up with its own error first
              ? ": render(t) was done but the frame never reached the capture (the machine too busy?)"
              : page.fonts === "loading"
                ? `: render(t) was waiting for fonts to load${pictures}`
                : `: render(t) was waiting on a promise that never settled, with no project picture pending${pictures} (a script that never ends, or a frame waiting on too many uncut.frame pictures?)`;
      const secs = elapsed > budget + 1000 ? Math.floor(elapsed / 1000) : budget / 1000;
      reject(new Error(`${name}the graphic took longer than ${secs} s to load and draw a frame${which}${why}`));
    };
    try {
      await Promise.race([work, new Promise<never>((_, reject) => (timer = setTimeout(() => void expired(reject), budget)))]);
    } catch (error) {
      // Stuck or broken: the next frame starts from a fresh window.
      work.catch(() => {});
      if (!gw.isDestroyed()) gw.destroy();
      graphicWin = undefined;
      graphicDoc = "";
      const message = messageOf(error);
      throw message.startsWith(name) ? (error instanceof Error ? error : new Error(message)) : new Error(`${name}${message}`);
    } finally {
      settled = true;
      clearTimeout(timer);
    }
  };

  // Shader effects (D213): one window on Uncut's secure page, its runner (one WebGPU device) kept
  // between frames. A frame that doesn't finish in time takes the window (and its device) with it.
  let shaderWin: BrowserWindow | undefined;
  const shaderWindow = async () => {
    if (shaderWin && !shaderWin.isDestroyed()) return shaderWin;
    const sw = new BrowserWindow({ ...windowOptions, width: 16, height: 16 });
    sw.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    sw.webContents.on("will-navigate", (event) => event.preventDefault());
    await sw.loadURL(`${SHADER_SCHEME}://uncut/page`);
    shaderWin = sw;
    return sw;
  };
  /** The runner, made once per window: "no-webgpu: <why>" when there's none. */
  const RUNNER = `(async () => {
    if (!window.UncutShader) throw new Error("no-webgpu: the shader runner didn't load");
    if (!window.__uncutRunner || window.__uncutRunner.lost) {
      const r = await window.UncutShader.ShaderRunner.create();
      if ("problem" in r) throw new Error("no-webgpu: " + r.problem);
      window.__uncutRunner = r;
    }
    return window.__uncutRunner;
  })()`;
  const probeShader = async () => {
    const sw = await shaderWindow();
    await sw.webContents.executeJavaScript(`${RUNNER}.then(() => true)`);
  };
  const renderShader = async (r: ShaderRequest) => {
    const name = r.name ? `${r.name}: ` : "";
    const work = (async () => {
      const sw = await shaderWindow();
      const input = readFileSync(r.input);
      if (input.length !== r.width * r.height * 4) throw new Error(`the picture is ${input.length} bytes, not ${r.width}×${r.height} RGBA`);
      shaderInput = input;
      const args = JSON.stringify({ code: r.code, frame: r.frame, params: r.params ?? null, width: r.width, height: r.height });
      const pixels: unknown = await sw.webContents.executeJavaScript(`(async () => {
        const a = ${args};
        const runner = await ${RUNNER};
        const data = new Uint8Array(await (await fetch("${SHADER_SCHEME}://uncut/frame")).arrayBuffer());
        return runner.drawToPixels({ kind: "rgba", data, width: a.width, height: a.height }, { code: a.code, frame: new Float32Array(a.frame).buffer, params: a.params ? new Float32Array(a.params).buffer : undefined, width: a.width, height: a.height });
      })()`);
      shaderInput = undefined;
      if (!(pixels instanceof Uint8Array) || pixels.length !== r.width * r.height * 4) throw new Error("the shader window gave back no picture");
      if (/\.png$/i.test(r.out)) {
        // nativeImage takes BGRA.
        const bgra = Buffer.from(pixels);
        for (let i = 0; i < bgra.length; i += 4) {
          const red = bgra[i]!;
          bgra[i] = bgra[i + 2]!;
          bgra[i + 2] = red;
        }
        writeFileSync(r.out, nativeImage.createFromBitmap(bgra, { width: r.width, height: r.height }).toPNG());
      } else writeFileSync(r.out, pixels);
    })();
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        work,
        new Promise(
          (_, reject) =>
            (timer = setTimeout(() => reject(new Error(`${name}the shader took longer than ${SHADER_FRAME_MS / 1000} s to draw a frame`)), SHADER_FRAME_MS)),
        ),
      ]);
    } catch (error) {
      work.catch(() => {});
      shaderInput = undefined;
      const message = messageOf(error)
        .replace(/^Error invoking remote method[^:]*: /, "")
        .replace(/^(Uncaught )?Error: /, "");
      if (!message.startsWith("no-webgpu: ") && shaderWin && !shaderWin.isDestroyed()) {
        shaderWin.destroy();
        shaderWin = undefined;
      }
      throw new Error(message.startsWith("no-webgpu: ") || message.startsWith(name) ? message : `${name}${message}`);
    } finally {
      clearTimeout(timer);
    }
  };

  // The CSS of the last request: set again only when it changes (D198: it may carry the brand
  // kit's fonts as data: URLs, which shouldn't be parsed and loaded again for every frame).
  let lastCss: string | undefined;
  // A frame sequence (D291): raw frames into the open sequence's file, waiting while its reader
  // (an ffmpeg) catches up, so at most a frame or two is held here however long the sequence.
  let seq: { readonly width: number; readonly height: number; readonly stream: WriteStream; failed?: Error; last?: Buffer; sum?: Uint16Array } | undefined;
  const seqWrite = async (frame: Buffer) => {
    const s = seq;
    if (!s) throw new Error("no frame sequence is open");
    if (s.failed) throw s.failed;
    s.last = frame;
    if (s.stream.write(frame)) return;
    await new Promise<void>((done, fail) => {
      const drained = () => {
        s.stream.off("error", failed);
        done();
      };
      const failed = (error: Error) => {
        s.stream.off("drain", drained);
        fail(error);
      };
      s.stream.once("drain", drained);
      s.stream.once("error", failed);
    });
  };
  const seqClose = async () => {
    const s = seq;
    seq = undefined;
    if (!s) return;
    if (!s.failed) await new Promise<void>((done) => s.stream.end(done));
    if (s.failed) throw s.failed;
  };
  const bitmapOf = (image: Electron.NativeImage, s: { width: number; height: number }) => {
    const bitmap = image.toBitmap();
    if (bitmap.length !== s.width * s.height * 4) throw new Error(`the frame is ${bitmap.length} bytes, not ${s.width}×${s.height} BGRA`);
    return bitmap;
  };
  /** The page as `html` (with `css`) draws it: content set, fonts, images and two frames waited for; the sentinel's mark. */
  const drawHtml = async (r: { width: number; height: number; css: string; html: string }) => {
    const [w, h] = win.getContentSize();
    if (w !== r.width || h !== r.height + 1) win.setContentSize(r.width, r.height + 1);
    const expected = nextMark();
    const css = lastCss === r.css ? "" : `document.getElementById("css").textContent = ${JSON.stringify(r.css)};`;
    lastCss = r.css;
    // Set the content, then wait for fonts, images and two frames so what's captured is what was set.
    await win.webContents.executeJavaScript(
      `(() => { ${css} document.getElementById("frame").innerHTML = ${JSON.stringify(r.html)}; void document.body.offsetHeight;
        // An image counts once decoded or loaded (D292: decode() in this offscreen page sometimes waits
        // ~5 s for no reason). A loaded image is decoded in the paint that first shows it (decoding
        // "sync": never a placeholder filled in a frame later), so the frames waited for below have it.
        for (const i of document.images) i.decoding = "sync";
        const loaded = (i) => (i.complete ? Promise.resolve() : new Promise((done) => { i.addEventListener("load", done, { once: true }); i.addEventListener("error", done, { once: true }); }));
        const images = Promise.all([...document.images].map((i) => Promise.race([i.decode().catch(() => {}), loaded(i)])));
        const settled = Promise.all([document.fonts.ready, images]).then(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(innerWidth + "x" + innerHeight)))));
        // A frame that never comes (a busy machine) mustn't hang the request: capture after 5 s regardless.
        return Promise.race([settled, new Promise((done) => setTimeout(done, 5000))]).then(() => ${setSentinel(r.height, expected)}); })()`,
    );
    return expected;
  };
  const renderSeq = async (r: SeqRequest) => {
    if (r.kind === "seq-open") {
      if (seq) await seqClose().catch(() => {});
      const stream = createWriteStream(r.out);
      const s: NonNullable<typeof seq> = { width: r.width, height: r.height, stream };
      // A reader gone (its ffmpeg failed or was stopped) fails the next frame instead of hanging it.
      stream.on("error", (error) => (s.failed ??= error));
      await new Promise<void>((done, fail) => {
        stream.once("open", () => done());
        stream.once("error", fail);
      });
      seq = s;
      return;
    }
    if (r.kind === "seq-close") return seqClose();
    const s = seq;
    if (!s) throw new Error("no frame sequence is open");
    if (r.kind === "seq-hold") {
      if (!s.last) throw new Error("no frame to hold yet");
      for (let i = 0; i < r.count; i++) await seqWrite(s.last);
      return;
    }
    if (r.kind === "seq-html") {
      const expected = await drawHtml({ width: s.width, height: s.height, css: r.css, html: r.html });
      const frame = bitmapOf(await grab(win, s.width, s.height, expected), s);
      unpremultiply(frame);
      return seqWrite(frame);
    }
    // A graphic's frame: its picture, or motion blur's sub-frames averaged on premultiplied colour
    // (the right mean where it's transparent), then made straight like the PNG path's.
    if (r.ts.length === 1) {
      let frame: Buffer | undefined;
      await renderGraphic(
        { width: s.width, height: s.height, doc: r.doc, info: r.info, ...(r.name !== undefined ? { name: r.name } : {}) },
        r.ts,
        (image) => void (frame = bitmapOf(image, s)),
      );
      unpremultiply(frame!);
      return seqWrite(frame!);
    }
    const sum = (s.sum ??= new Uint16Array(s.width * s.height * 4));
    const { frame, samples } = await blurred(
      { width: s.width, height: s.height, doc: r.doc, info: r.info, ...(r.name !== undefined ? { name: r.name } : {}) },
      r.ts,
      sum,
    );
    unpremultiply(frame);
    await seqWrite(frame);
    return { samples };
  };

  // Motion blur's frame (D291, D309): the mean of its sub-frames' pictures on premultiplied colour.
  // The sub-frames asked for are drawn first. When the first and last are far apart and most
  // consecutive ones are (core blurFarPairs, blurMoving: a fast move that would average into
  // stacked copies), the frame is drawn again on core blurLevels' next finer grid (the same slots
  // split: the same span and centre; each grid in time order, as the rehearsal calls it) and so on
  // up to BLUR_REFINE.max; the finest complete grid's mean is the frame. A calm frame is drawn with
  // exactly the sub-frames asked for. Refining is optional quality: a grid isn't started when, at
  // the cost per sub-frame the first grid took, it would end past REFINE_MS from the request's start,
  // and one that fails or runs past REFINE_LIMIT_MS is dropped (said on stderr), the last complete
  // grid kept; only the asked-for grid can fail the frame, so the request ends well inside the
  // server's 30 s (rasterizer.ts RENDER_TIMEOUT_MS, counted from when it starts here) and
  // GRAPHIC_CAP_MS's named errors come first. `sum` is reused (Uint16: 64 × 255 fits).
  const blurred = async (r: Pick<GraphicRequest, "width" | "height" | "doc" | "info" | "name">, ts: ReadonlyArray<number>, sum: Uint16Array) => {
    const started = Date.now();
    const s = { width: r.width, height: r.height };
    const mean = (n: number) => {
      const half = n >> 1;
      const frame = Buffer.allocUnsafe(sum.length);
      for (let i = 0; i < sum.length; i++) frame[i] = (sum[i]! + half) / n;
      return frame;
    };
    const refine = blurRefinable(ts);
    // The asked-for sub-frames' pictures until it's known whether the frame moves (their signatures
    // are needed only when the first and last are far apart: a calm frame pays for two).
    const pictures: Array<Buffer> = [];
    sum.fill(0);
    await renderGraphic(r, ts, (image) => {
      const px = bitmapOf(image, s);
      for (let i = 0; i < px.length; i++) sum[i]! += px[i]!;
      if (refine) pictures.push(px);
    });
    let frame = mean(ts.length);
    let samples = ts.length;
    if (!refine || pictures.length !== ts.length) return { frame, samples };
    const perSub = (Date.now() - started) / ts.length;
    const first = blurSignature(pictures[0]!, s.width, s.height);
    const last = blurSignature(pictures.at(-1)!, s.width, s.height);
    if (blurStep(first, last) < BLUR_REFINE.points) return { frame, samples };
    let sigs = pictures.map((px, i) => (i === 0 ? first : i === pictures.length - 1 ? last : blurSignature(px, s.width, s.height)));
    pictures.length = 0;
    for (const level of blurLevels(ts, Math.max(BLUR_REFINE.max, ts.length))) {
      if (!blurMoving(blurFarPairs(sigs), sigs.length)) break;
      const elapsed = Date.now() - started;
      if (elapsed + perSub * level.length > REFINE_MS) break;
      const next: Array<BlurSignature> = [];
      sum.fill(0);
      try {
        await renderGraphic(
          r,
          level,
          (image) => {
            const px = bitmapOf(image, s);
            for (let i = 0; i < px.length; i++) sum[i]! += px[i]!;
            next.push(blurSignature(px, s.width, s.height));
          },
          REFINE_LIMIT_MS - elapsed,
        );
      } catch (error) {
        process.stderr.write(`[uncut-render] motion blur kept ${samples} sub-frames at ${ts[0]!.toFixed(4)} s: ${level.length} failed: ${messageOf(error)}\n`);
        break;
      }
      if (next.length !== level.length) break;
      frame = mean(level.length);
      samples = level.length;
      sigs = next;
    }
    return { frame, samples };
  };

  /** A rehearsal (see the header): every frame's render(t) in order, nothing captured; the first failure names its frame. */
  const runGraphic = async (r: RunRequest) => {
    if (r.fresh) graphicDoc = "";
    for (const [i, local] of r.frames.entries()) {
      try {
        await renderGraphic(
          { width: r.width, height: r.height, doc: r.doc, info: { ...r.info, frame: local }, ...(r.name !== undefined ? { name: r.name } : {}) },
          r.ts?.[i] ?? [local / Number(r.info.fps || 30)],
        );
      } catch (error) {
        throw new Error(`at its frame ${local}: ${messageOf(error)}`);
      }
    }
  };

  /** What the page shows at each t (core GRAPHIC_SCAN): the document loaded and drawn once, then read by the page function. */
  const scanGraphic = async (r: ScanRequest) => {
    await renderGraphic({ width: r.width, height: r.height, doc: r.doc, info: r.info, ...(r.name !== undefined ? { name: r.name } : {}) }, [r.ts[0]!]);
    const gw = graphicWin;
    if (!gw || gw.isDestroyed()) return undefined;
    const scan: unknown = await gw.webContents.executeJavaScript(`(${GRAPHIC_SCAN})(${JSON.stringify(r.ts)}, ${JSON.stringify(r.info)})`);
    return { scan };
  };
  const render = async (r: Request) => {
    if (r.kind === "graphic-scan") return scanGraphic(r);
    if (r.kind !== undefined && r.kind !== "graphic" && r.kind !== "graphic-run" && r.kind !== "shader" && r.kind !== "shader-probe") return renderSeq(r);
    if (r.kind === "graphic-run") return runGraphic(r);
    if (r.kind === "graphic" && r.census !== undefined) {
      // The census reads the page as the frame left it (the last sub-frame's state with blur).
      const drawn = await drawGraphic(r);
      const gw = graphicWin;
      if (!gw || gw.isDestroyed()) return undefined;
      const census: unknown = await gw.webContents.executeJavaScript(`(${GRAPHIC_CENSUS})(${r.width}, ${r.height}, ${r.census})`).catch(() => undefined);
      return { census, ...(drawn ? drawn : {}) };
    }
    return drawGraphic(r);
  };
  const drawGraphic = async (r: HtmlRequest | GraphicRequest | ShaderRequest | ProbeRequest): Promise<{ readonly samples: number } | void> => {
    if (r.kind === "graphic" && r.ts && r.ts.length > 1) {
      // Motion blur's sub-frames averaged on premultiplied colour, as seq-graphic does (the export's frame).
      const { frame, samples } = await blurred(r, r.ts, new Uint16Array(r.width * r.height * 4));
      save(r.out, r)(nativeImage.createFromBitmap(frame, { width: r.width, height: r.height }));
      return { samples };
    }
    if (r.kind === "graphic") return renderGraphic(r, [r.t], save(r.out, r));
    if (r.kind === "shader") return renderShader(r);
    if (r.kind === "shader-probe")
      return probeShader().catch((error: Error) => {
        throw new Error((error.message.match(/no-webgpu: .*/) ?? [`no-webgpu: ${error.message}`])[0]);
      });
    await capture(win, r, await drawHtml(r));
  };

  // One request at a time, in order.
  let chain: Promise<void> = Promise.resolve();
  readline.createInterface({ input: process.stdin }).on("line", (line) => {
    let request: unknown;
    try {
      request = JSON.parse(line);
    } catch {
      return;
    }
    if (takeMediaReply(request)) return;
    if (!isRequest(request)) return void reply({ id: (request as { id?: unknown })?.id ?? null, ok: false, error: "bad request" });
    // "render-started" first: the server's deadline for a request counts from here, not from when it was
    // sent (the export sends a few ahead, D309).
    chain = chain.then(() =>
      (process.stdout.write(`${JSON.stringify({ uncut: "render-started", id: request.id })}\n`), render(request)).then(
        (done) =>
          void reply({
            id: request.id,
            ok: true,
            ...(done && typeof done === "object" && "census" in done && done.census ? { census: done.census } : {}),
            ...(done && typeof done === "object" && "scan" in done ? { scan: done.scan } : {}),
            ...(done && typeof done === "object" && "samples" in done ? { samples: done.samples } : {}),
          }),
        (error: unknown) => void reply({ id: request.id, ok: false, error: messageOf(error) }),
      ),
    );
  });
  // Finish what was asked, then go.
  const done = () => void chain.finally(() => app.quit());
  process.stdin.once("end", done);
  process.stdin.once("close", done);
}

main().catch((error: Error) => {
  process.stderr.write(`[uncut-render] ${error.message}\n`);
  app.exit(1);
});
