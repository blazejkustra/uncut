// Generates assets/graphic-libs/ui.js (uncutUI): Uncut's own UI as parts a graphic can animate.
// The real editor (apps/web, its components and CSS) is built with a harness entry
// (apps/web/uiparts.html → src/uiparts/harness.tsx) that mounts it on fixture data, loaded in a
// hidden offscreen Electron window at a fixed size; each part's DOM is lifted as the app draws it
// (canvases as images), with the CSS rules that apply to it (scoped under .uncut-ui), and written
// out with the runtime (apps/web/src/uiparts/runtime.ts, its types stripped). The header carries a
// hash of the inputs, so test/core/ui-parts.test.ts fails when the parts go stale.
//
//   node scripts/ui-parts.ts            regenerate ui.js
//   node scripts/ui-parts.ts --shots D  also save a screenshot of each harness scene in D
//   --capture F / --from F              keep the window's capture in F / build from F (no window)
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { buildUiLib, uiPartsInputHash, type Capture } from "./ui-parts-lib.ts";

const ROOT = resolve(import.meta.dirname, "..");
const WEB = join(ROOT, "apps/web");
const OUT = process.env.UNCUT_UIPARTS_OUT ?? join(ROOT, "assets/graphic-libs/ui.js");

/** The window the editor is drawn in (CSS px): the app's usual size on a laptop. */
export const WINDOW = { width: 1920, height: 900 };

async function buildHarness(outDir: string) {
  const vite = await import(createRequire(join(WEB, "package.json")).resolve("vite"));
  await vite.build({
    root: WEB,
    configFile: join(WEB, "vite.config.ts"),
    logLevel: "warn",
    build: { outDir, emptyOutDir: true, rollupOptions: { input: join(WEB, "uiparts.html") } },
  });
}

/** What the Electron window runs: each scene in turn, its parts lifted (page.ts's extract). */
const MAIN = String.raw`
const { app, BrowserWindow } = require("electron");
const { writeFileSync, readFileSync } = require("fs");
const { url, width, height, out, shots, profile, extract } = JSON.parse(process.env.UNCUT_UIPARTS);
app.setPath("userData", profile);
app.commandLine.appendSwitch("force-device-scale-factor", "1");
app.dock && app.dock.hide();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width, height, useContentSize: true, frame: false, backgroundColor: "#0a0a0a", webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.setContentSize(width, height);
  win.webContents.on("console-message", (_e, level, message) => level >= 2 && console.error("page:", message));
  await win.loadURL(url);
  for (let i = 0; i < 200; i++) { if (await win.webContents.executeJavaScript("document.body.dataset.ready === '1'")) break; await new Promise((r) => setTimeout(r, 50)); }
  const result = {};
  for (const scene of ["compose", "plan", "done", "export", "exporting", "effects"]) {
    await win.webContents.executeJavaScript("window.__uiparts.scene(" + JSON.stringify(scene) + ")");
    if (shots) writeFileSync(shots + "/" + scene + ".png", (await win.webContents.capturePage()).toPNG());
    result[scene] = await win.webContents.executeJavaScript("(" + readFileSync(extract, "utf8") + ")(" + JSON.stringify(scene) + ")");
  }
  writeFileSync(out, JSON.stringify(result));
  app.exit(0);
}).catch((e) => { console.error(e); app.exit(1); });
`;

async function capture(shots: string | undefined): Promise<Capture> {
  const tmp = mkdtempSync(join(tmpdir(), "uncut-uiparts-"));
  try {
    const dist = join(tmp, "dist");
    await buildHarness(dist);
    const main = join(tmp, "main.cjs");
    writeFileSync(main, MAIN);
    const extract = join(tmp, "extract.js");
    const { stripTypeScriptTypes } = await import("node:module");
    writeFileSync(extract, stripTypeScriptTypes(readFileSync(join(ROOT, "apps/web/src/uiparts/extract.ts"), "utf8")).replace(/^export /m, "").replace(/;\s*$/, ""));
    const out = join(tmp, "capture.json");
    if (shots) mkdirSync(shots, { recursive: true });
    const electron = createRequire(import.meta.url)("electron") as unknown as string;
    const env: NodeJS.ProcessEnv = { ...process.env, UNCUT_UIPARTS: JSON.stringify({ url: `file://${join(dist, "uiparts.html")}`, ...WINDOW, out, shots: shots && resolve(shots), profile: join(tmp, "profile"), extract }) };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(electron, [main], { env, stdio: ["ignore", "inherit", "inherit"] });
    const code = await new Promise<number | null>((done) => child.on("exit", done));
    if (code !== 0) throw new Error(`the harness window failed (exit ${code})`);
    return JSON.parse(readFileSync(out, "utf8")) as Capture;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const at = process.argv.indexOf("--shots");
  const shots = at > 0 ? process.argv[at + 1] : undefined;
  // --capture F: keep what the window lifted in F; --from F: build from F without the window (for runtime work).
  const arg = (flag: string) => (process.argv.includes(flag) ? process.argv[process.argv.indexOf(flag) + 1] : undefined);
  const from = arg("--from");
  const captured = from ? (JSON.parse(readFileSync(from, "utf8")) as Capture) : await capture(shots);
  const keep = arg("--capture");
  if (keep) writeFileSync(keep, JSON.stringify(captured));
  const lib = buildUiLib(captured, uiPartsInputHash(ROOT), readFileSync(join(ROOT, "apps/web/src/uiparts/runtime.ts"), "utf8"));
  writeFileSync(OUT, lib);
  console.log(`wrote ${OUT}: ${Math.round(Buffer.byteLength(lib) / 1024)} KB`);
}
