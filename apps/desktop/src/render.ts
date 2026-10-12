// The export rasteriser (D55): an offscreen, transparent Chromium page that draws HTML at a given
// size and saves it as a PNG. The server starts it (this binary with --uncut-render) for an
// export or the agent's frame renders and talks to it in JSON lines:
//   stdin  ← { id, width, height, css, html, out }   one request at a time
//   stdout → { uncut: "render", id, ok: true } | { uncut: "render", id, ok: false, error }
//   stdout → { uncut: "render", ready: true }          once, when the page is loaded
// It knows nothing about projects: the server builds the HTML with core's textHtml / solidHtml
// and RENDER_CSS (D39, D53). It quits when stdin closes, i.e. when the server is done with it or
// gone. Its Chromium profile is a temp folder (see below).
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as readline from "node:readline";

import { app, BrowserWindow } from "electron";

interface Request {
  readonly id: number;
  readonly width: number;
  readonly height: number;
  readonly css: string;
  readonly html: string;
  readonly out: string;
}

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
// is set from here), no network, no images.
const PAGE = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<style>html,body{margin:0;padding:0;background:transparent;overflow:hidden;width:100%;height:100%}
.frame{position:absolute;inset:0;overflow:hidden;container-type:size}</style>
<style id="css"></style></head><body><div class="frame" id="frame"></div></body></html>`;

const isRequest = (v: unknown): v is Request => {
  const r = v as Partial<Request>;
  return (
    typeof r === "object" &&
    r !== null &&
    Number.isInteger(r.id) &&
    Number.isInteger(r.width) &&
    Number.isInteger(r.height) &&
    r.width! > 0 &&
    r.height! > 0 &&
    r.width! <= 8192 &&
    r.height! <= 8192 &&
    typeof r.css === "string" &&
    typeof r.html === "string" &&
    typeof r.out === "string"
  );
};

async function main() {
  await app.whenReady();
  const win = new BrowserWindow({
    show: false,
    width: 1920,
    height: 1080,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    useContentSize: true,
    enableLargerThanScreen: true,
    webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(PAGE)}`);
  win.webContents.setZoomFactor(1);
  reply({ ready: true });

  const render = async (r: Request) => {
    const [w, h] = win.getContentSize();
    if (w !== r.width || h !== r.height) win.setContentSize(r.width, r.height);
    // Set the content, then wait for fonts and two frames so what's captured is what was set.
    await win.webContents.executeJavaScript(
      `(() => { document.getElementById("css").textContent = ${JSON.stringify(r.css)}; document.getElementById("frame").innerHTML = ${JSON.stringify(r.html)};
        return document.fonts.ready.then(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(innerWidth + "x" + innerHeight))))); })()`,
    );
    let image = await win.webContents.capturePage({ x: 0, y: 0, width: r.width, height: r.height });
    const size = image.getSize();
    if (size.width !== r.width || size.height !== r.height) image = image.resize({ width: r.width, height: r.height, quality: "best" });
    writeFileSync(r.out, image.toPNG());
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
