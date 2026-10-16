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
//   stdin  ← { id, kind: "shader", width, height, code, frame, params?, input, out }   a shader effect's
//                                                    frame (D213): `input` a width×height RGBA file, drawn
//                                                    with WebGPU (core shaderModuleCode `code`, the
//                                                    uniforms' floats `frame` and `params`) in a window
//                                                    of its own, read back; `out` .rgba (raw) or .png.
//                                                    No WebGPU here: fails with "no-webgpu: <why>".
//   stdin  ← { id, kind: "shader-probe" }            fails with "no-webgpu: <why>" when there's no WebGPU
// It knows nothing about projects: the server builds the HTML with core's textHtml / solidHtml /
// componentHtml and RENDER_CSS (D39, D53, D76). The bundled DM Sans and DM Mono (D77) are loaded
// once with the page, from data: URLs, with the preview's @font-face rules; the brand kit's fonts
// (D198) come in a request's css. Nothing may load from
// the network: every request that isn't a data: URL is cancelled. It quits when stdin closes,
// i.e. when the server is done with it or gone. Its Chromium profile is a temp folder (see below).
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as readline from "node:readline";

import { app, BrowserWindow, nativeImage, protocol, session } from "electron";

import { fontFaceCss, type FontFile } from "../../../packages/core/src/visual/render.ts";
import dmSans from "../../../assets/fonts/DMSans-Variable.woff2";
import dmMonoRegular from "../../../assets/fonts/DMMono-Regular.woff2";
import dmMonoMedium from "../../../assets/fonts/DMMono-Medium.woff2";

const FONT_URLS: Record<FontFile, string> = { "DMSans-Variable.woff2": dmSans, "DMMono-Regular.woff2": dmMonoRegular, "DMMono-Medium.woff2": dmMonoMedium };
/** How long a graphic's render(t) may take (core GRAPHIC_FRAME_MS). */
const GRAPHIC_FRAME_MS = 5000;
/** How many times a capture is tried when Chromium has no frame to copy yet (see capturePage). */
const CAPTURE_ATTEMPTS = 6;
/** How long a capture waits for the frame it asked for (see nextPaint). */
const PAINT_WAIT_MS = 1000;

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
type Request = HtmlRequest | GraphicRequest | ShaderRequest | ProbeRequest;

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
protocol.registerSchemesAsPrivileged([{ scheme: SHADER_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
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
.frame{position:absolute;inset:0;overflow:hidden;container-type:size}</style>
<style id="css"></style></head><body><div class="frame" id="frame"></div></body></html>`;

const isRequest = (v: unknown): v is Request => {
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
  if (r.kind === "graphic") return typeof r.doc === "string" && typeof r.t === "number" && Number.isFinite(r.t) && (r.name === undefined || typeof r.name === "string");
  if ((r.kind as unknown) === "shader") {
    const sr = v as Partial<ShaderRequest>;
    const floats = (a: unknown, max: number) => Array.isArray(a) && a.length <= max && a.every((x) => typeof x === "number" && Number.isFinite(x));
    return typeof sr.code === "string" && sr.code.length <= 64 * 1024 && floats(sr.frame, 4) && sr.frame!.length === 4 && (sr.params === undefined || floats(sr.params, 256)) && typeof sr.input === "string" && (sr.name === undefined || typeof sr.name === "string");
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
  session.defaultSession.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (details, callback) => callback({ cancel: !details.url.startsWith("data:") && !details.url.startsWith(`${SHADER_SCHEME}://uncut/`) }));
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
  const capture = async (target: BrowserWindow, r: HtmlRequest | GraphicRequest) => {
    await nextPaint(target);
    let image = await capturePage(target, { x: 0, y: 0, width: r.width, height: r.height });
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
      await Promise.race([work, new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(`${name}the shader took longer than ${SHADER_FRAME_MS / 1000} s to draw a frame`)), SHADER_FRAME_MS)))]);
    } catch (error) {
      work.catch(() => {});
      shaderInput = undefined;
      const message = (error as Error).message.replace(/^Error invoking remote method[^:]*: /, "").replace(/^(Uncaught )?Error: /, "");
      if (!/^no-webgpu: /.test(message) && shaderWin && !shaderWin.isDestroyed()) {
        shaderWin.destroy();
        shaderWin = undefined;
      }
      throw new Error(/^no-webgpu: /.test(message) || message.startsWith(name) ? message : `${name}${message}`);
    } finally {
      clearTimeout(timer);
    }
  };

  // The CSS of the last request: set again only when it changes (D198: it may carry the brand
  // kit's fonts as data: URLs, which shouldn't be parsed and loaded again for every frame).
  let lastCss: string | undefined;
  const render = async (r: Request) => {
    if (r.kind === "graphic") return renderGraphic(r);
    if (r.kind === "shader") return renderShader(r);
    if (r.kind === "shader-probe") return probeShader().catch((error: Error) => {
      throw new Error((error.message.match(/no-webgpu: .*/) ?? [`no-webgpu: ${error.message}`])[0]);
    });
    const [w, h] = win.getContentSize();
    if (w !== r.width || h !== r.height) win.setContentSize(r.width, r.height);
    const css = lastCss === r.css ? "" : `document.getElementById("css").textContent = ${JSON.stringify(r.css)};`;
    lastCss = r.css;
    // Set the content, then wait for fonts, images and two frames so what's captured is what was set.
    await win.webContents.executeJavaScript(
      `(() => { ${css} document.getElementById("frame").innerHTML = ${JSON.stringify(r.html)}; void document.body.offsetHeight;
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
