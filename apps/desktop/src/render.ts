// The export rasteriser (D55): an offscreen, transparent Chromium page that draws HTML at a given
// size and saves it as a PNG. The server starts it (this binary with --uncut-render) for an
// export or the agent's frame renders and talks to it in JSON lines:
//   stdin  ← { id, width, height, css, html, out }   one request at a time (out: .png, or .jpg for
//                                                    an opaque JPEG such as the agent's contact sheet)
//   stdout → { uncut: "render", id, ok: true } | { uncut: "render", id, ok: false, error }
//   stdout → { uncut: "render", ready: true }          once, when the page is loaded
//   stdin  ← { id, kind: "graphic", width, height, doc, t, info, out }   a graphic item's frame (D78):
//                                                    its document (core graphicDocument) loaded in a
//                                                    window of its own, render(t, info) called, captured
// It knows nothing about projects: the server builds the HTML with core's textHtml / solidHtml /
// componentHtml and RENDER_CSS (D39, D53, D76). The bundled DM Sans and DM Mono (D77) are loaded
// once with the page, from data: URLs, with the preview's @font-face rules. Nothing may load from
// the network: every request that isn't a data: URL is cancelled. It quits when stdin closes,
// i.e. when the server is done with it or gone. Its Chromium profile is a temp folder (see below).
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as readline from "node:readline";

import { app, BrowserWindow, session } from "electron";

import { fontFaceCss, type FontFile } from "../../../packages/core/src/render.ts";
import dmSans from "../../../assets/fonts/DMSans-Variable.woff2";
import dmMonoRegular from "../../../assets/fonts/DMMono-Regular.woff2";
import dmMonoMedium from "../../../assets/fonts/DMMono-Medium.woff2";

const FONT_URLS: Record<FontFile, string> = { "DMSans-Variable.woff2": dmSans, "DMMono-Regular.woff2": dmMonoRegular, "DMMono-Medium.woff2": dmMonoMedium };
/** How long a graphic's render(t) may take (core GRAPHIC_FRAME_MS). */
const GRAPHIC_FRAME_MS = 5000;

interface HtmlRequest {
  readonly id: number;
  readonly kind?: undefined;
  readonly width: number;
  readonly height: number;
  readonly css: string;
  readonly html: string;
  readonly out: string;
}
interface GraphicRequest {
  readonly id: number;
  readonly kind: "graphic";
  readonly width: number;
  readonly height: number;
  readonly doc: string;
  readonly t: number;
  readonly info: unknown;
  readonly out: string;
  /** What to call it in an error ("intro" (graphics/intro.html)). */
  readonly name?: string;
}
type Request = HtmlRequest | GraphicRequest;

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
app.dock?.hide();
app.on("window-all-closed", () => {});
if (!given) app.on("will-quit", () => rmSync(profile, { recursive: true, force: true }));

// Nothing in the page may load anything: inline styles only, no scripts of its own (the content
// is set from here), no network. Images only as data: URLs (the contact sheet's frames, D65).
const PAGE = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:">
<style>${fontFaceCss((f) => FONT_URLS[f])}</style>
<style>html,body{margin:0;padding:0;background:transparent;overflow:hidden;width:100%;height:100%}
.frame{position:absolute;inset:0;overflow:hidden;container-type:size}</style>
<style id="css"></style></head><body><div class="frame" id="frame"></div></body></html>`;

const isRequest = (v: unknown): v is Request => {
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
  if (r.kind === "graphic") return typeof r.doc === "string" && typeof r.t === "number" && Number.isFinite(r.t) && (r.name === undefined || typeof r.name === "string");
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
  session.defaultSession.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (details, callback) => callback({ cancel: !details.url.startsWith("data:") }));
  const win = new BrowserWindow(windowOptions);
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
  const capture = async (target: BrowserWindow, r: Request) => {
    let image = await target.webContents.capturePage({ x: 0, y: 0, width: r.width, height: r.height });
    const size = image.getSize();
    if (size.width !== r.width || size.height !== r.height) image = image.resize({ width: r.width, height: r.height, quality: "best" });
    writeFileSync(r.out, /\.jpe?g$/i.test(r.out) ? image.toJPEG(85) : image.toPNG());
  };
  const newGraphicWindow = () => {
    const gw = new BrowserWindow(windowOptions);
    gw.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    // A graphic can't navigate away (its document is all it gets) nor reach anyone over WebRTC
    // (CSP has no webrtc directive Chromium honours; without a proxy this keeps UDP off).
    gw.webContents.on("will-navigate", (event) => event.preventDefault());
    gw.webContents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
    return gw;
  };
  // The whole frame (load, size, render(t), capture) is under one deadline: a document whose
  // top-level script never ends stalls its load, not just render. On expiry the window goes and
  // the next frame starts from a fresh one.
  const renderGraphic = async (r: GraphicRequest) => {
    if (!graphicWin || graphicWin.isDestroyed()) {
      graphicWin = newGraphicWindow();
      graphicDoc = "";
    }
    const gw = graphicWin;
    const name = r.name ? `${r.name}: ` : "";
    const work = (async () => {
      const [w, h] = gw.getContentSize();
      if (w !== r.width || h !== r.height) gw.setContentSize(r.width, r.height);
      if (graphicDoc !== r.doc) {
        graphicDoc = "";
        await gw.loadURL(`data:text/html;base64,${Buffer.from(r.doc).toString("base64")}`);
        gw.webContents.setZoomFactor(1);
        graphicDoc = r.doc;
      }
      await gw.webContents.executeJavaScript(`window.__uncutRender(${JSON.stringify(r.t)}, ${JSON.stringify(r.info ?? {})})`);
      await capture(gw, r);
    })();
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([work, new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(`${name}the graphic took longer than ${GRAPHIC_FRAME_MS / 1000} s to load and draw a frame (a script that never ends?)`)), GRAPHIC_FRAME_MS)))]);
    } catch (error) {
      // Stuck or broken: the next frame starts from a fresh window.
      work.catch(() => {});
      if (!gw.isDestroyed()) gw.destroy();
      graphicWin = undefined;
      graphicDoc = "";
      throw error instanceof Error && !error.message.startsWith(name) ? new Error(`${name}${error.message}`) : error;
    } finally {
      clearTimeout(timer);
    }
  };

  const render = async (r: Request) => {
    if (r.kind === "graphic") return renderGraphic(r);
    const [w, h] = win.getContentSize();
    if (w !== r.width || h !== r.height) win.setContentSize(r.width, r.height);
    // Set the content, then wait for fonts, images and two frames so what's captured is what was set.
    await win.webContents.executeJavaScript(
      `(() => { document.getElementById("css").textContent = ${JSON.stringify(r.css)}; document.getElementById("frame").innerHTML = ${JSON.stringify(r.html)}; void document.body.offsetHeight;
        const images = Promise.all([...document.images].map((i) => i.decode().catch(() => {})));
        const settled = Promise.all([document.fonts.ready, images]).then(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(innerWidth + "x" + innerHeight)))));
        // A frame that never comes (a busy machine) mustn't hang the request: capture after 5 s regardless.
        return Promise.race([settled, new Promise((done) => setTimeout(done, 5000))]); })()`,
    );
    await capture(win, r);
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
    if (!isRequest(request)) return void reply({ id: (request as { id?: unknown })?.id ?? null, ok: false, error: "bad request" });
    chain = chain.then(() =>
      render(request).then(
        () => void reply({ id: request.id, ok: true }),
        (error: Error) => void reply({ id: request.id, ok: false, error: error.message }),
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
