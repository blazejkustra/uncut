// Draws the DMG window's background (D288): build/background.png (660×420) and background@2x.png
// (1320×840); electron-builder's dmg target joins them into one retina TIFF and sizes the window from
// it. A light installer page: Uncut's wordmark top left, "Drag Uncut into Applications." over the two
// icons, a thin curved arrow from the app (left) to the Applications link (right) at the icon
// positions in electron-builder.yml's `dmg.contents`, soft lighter waves below them, and a quiet line
// at the bottom. Finder draws icon labels black over a background picture (dark mode too), which a
// light page reads well with.
// The window is the picture's size including its ~32 pt title bar, so only the top ~388 pt show (~360 with Finder's path bar on): the
// layout lives there and the rest is spare wave.
// Text is set in DM Sans (assets/fonts, OFL) by rendering this SVG in Electron's Chromium, offscreen,
// at 1x and 2x. Run: node apps/desktop/scripts/make-dmg-background.ts (the outputs are committed;
// rerun to change). Electron comes from the workspace (node_modules/.bin/electron).
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const DMG_WINDOW = { width: 660, height: 420 } as const;
/** Icon centres, in window points; electron-builder.yml's dmg.contents uses the same. */
export const DMG_ICONS = { app: { x: 180, y: 190 }, applications: { x: 480, y: 190 } } as const;
export const DMG_HEADING = "Drag Uncut into Applications.";
export const DMG_FOOTER = "Once copied, open it from Applications.";

const repo = new URL("../../../", import.meta.url).pathname;
const out = new URL("../build/", import.meta.url).pathname;

/**
 * The arrow between the icons, as one SVG path: a cubic with a gentle rise (up, then down into the
 * folder), centred in the gap with clear margins from both 128 pt icons, and an open chevron whose
 * apex is the curve's end point and whose barbs sit symmetrically about the end tangent.
 */
export function arrowPath(): string {
  const { app, applications: apps } = DMG_ICONS;
  const gapL = app.x + 64, gapR = apps.x - 64; // the icons' edges
  const margin = (gapR - gapL - 100) / 2; // a 100 pt arrow, centred
  const p0 = { x: gapL + margin, y: app.y - 6 };
  const p1 = { x: gapR - margin, y: app.y - 8 };
  const c1 = { x: p0.x + 30, y: p0.y - 17 };
  const c2 = { x: p1.x - 34, y: p1.y - 16 };
  // End tangent of a cubic: p1 − c2.
  const t = Math.atan2(p1.y - c2.y, p1.x - c2.x);
  const HEAD = 11, SPREAD = (32 * Math.PI) / 180;
  const barb = (a: number) => ({ x: p1.x - HEAD * Math.cos(t + a), y: p1.y - HEAD * Math.sin(t + a) });
  const b1 = barb(SPREAD), b2 = barb(-SPREAD);
  const f = (n: number) => n.toFixed(2);
  return `M${f(p0.x)} ${f(p0.y)} C${f(c1.x)} ${f(c1.y)} ${f(c2.x)} ${f(c2.y)} ${f(p1.x)} ${f(p1.y)} M${f(b1.x)} ${f(b1.y)} L${f(p1.x)} ${f(p1.y)} L${f(b2.x)} ${f(b2.y)}`;
}

/** The page as one SVG (DMG_WINDOW points), with DM Sans embedded. */
export function backgroundSvg(fontWoff2Base64: string): string {
  const { width: w, height: h } = DMG_WINDOW;
  const { app, applications: apps } = DMG_ICONS;
  const arrow = arrowPath();
  // The Uncut mark: the icon's U with its cut (as apps/web/src/editor/Wordmark.tsx), 1024 grid.
  const mark = `
    <g transform="translate(28 23) scale(0.032) translate(-280 -230)">
      <mask id="cut" maskUnits="userSpaceOnUse" x="0" y="0" width="1024" height="1024">
        <rect width="1024" height="1024" fill="#fff"/><path d="M270 506 L466 403" stroke="#000" stroke-width="56"/>
      </mask>
      <path d="M368 318 V560 A144 144 0 0 0 656 560 V318" fill="none" stroke="#1d1d1f" stroke-width="128" stroke-linecap="round" mask="url(#cut)"/>
    </g>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <defs>
    <style>
      @font-face { font-family: "DM Sans"; src: url(data:font/woff2;base64,${fontWoff2Base64}) format("woff2"); font-weight: 100 1000; }
      text { font-family: "DM Sans"; }
    </style>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ececee"/><stop offset="1" stop-color="#e3e3e6"/>
    </linearGradient>
    <linearGradient id="wave" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.55"/><stop offset="1" stop-color="#ffffff" stop-opacity="0.15"/>
    </linearGradient>
  </defs>
  <rect width="${w}" height="${h}" fill="url(#bg)"/>
  <!-- Soft lighter waves behind and below the icons. -->
  <path d="M0 226 C 140 190, 250 250, 380 234 S 580 186, ${w} 212 V ${h} H 0 Z" fill="url(#wave)" opacity="0.7"/>
  <path d="M0 290 C 120 270, 230 306, 360 296 S 560 262, ${w} 280 V ${h} H 0 Z" fill="url(#wave)" opacity="0.8"/>
  <path d="M0 318 C 160 304, 300 334, 430 322 S 600 302, ${w} 312 V ${h} H 0 Z" fill="#ffffff" opacity="0.28"/>
  ${mark}
  <text x="49" y="37.5" font-size="15" font-weight="700" letter-spacing="-0.3" fill="#1d1d1f">Uncut</text>
  <text x="${w / 2}" y="86" text-anchor="middle" font-size="22" font-weight="700" letter-spacing="-0.4" fill="#1d1d1f">${DMG_HEADING}</text>
  <!-- The arrow: one smooth curve and an open head on its end tangent, one stroke. -->
  <path d="${arrow}" fill="none" stroke="#2b2b2e" stroke-opacity="0.85" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  <text x="${w / 2}" y="344" text-anchor="middle" font-size="12" font-weight="400" fill="#7c7c80">${DMG_FOOTER}</text>
</svg>`;
}

/** Electron main script: renders the SVG file in argv at the scale factor in argv to a PNG. */
const renderMain = `
const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const [svgFile, scale, outFile, w, h] = process.argv.slice(-5);
app.commandLine.appendSwitch("force-device-scale-factor", scale);
app.dock?.hide();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: +w, height: +h, show: false, frame: false, useContentSize: true, webPreferences: { offscreen: false } });
  await win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent('<!doctype html><style>html,body{margin:0;overflow:hidden}</style>' + fs.readFileSync(svgFile, "utf8")));
  await win.webContents.executeJavaScript("document.fonts.ready.then(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))))");
  const img = await win.webContents.capturePage();
  fs.writeFileSync(outFile, img.toPNG());
  app.quit();
});`;

if (import.meta.main) {
  const font = readFileSync(join(repo, "assets/fonts/DMSans-Variable.woff2")).toString("base64");
  const work = mkdtempSync(join(tmpdir(), "uncut-dmg-bg-"));
  try {
    const svg = join(work, "background.svg");
    writeFileSync(svg, backgroundSvg(font));
    writeFileSync(join(work, "main.cjs"), renderMain);
    const { width: w, height: h } = DMG_WINDOW;
    for (const scale of [1, 2]) {
      const file = `${out}background${scale === 2 ? "@2x" : ""}.png`;
      execFileSync(join(repo, "node_modules/.bin/electron"), [`--force-device-scale-factor=${scale}`, join(work, "main.cjs"), svg, String(scale), file, String(w), String(h)], { stdio: "inherit" });
      const png = readFileSync(file);
      const size = `${png.readUInt32BE(16)}×${png.readUInt32BE(20)}`;
      if (size !== `${w * scale}×${h * scale}`) throw new Error(`${file} is ${size}, expected ${w * scale}×${h * scale}`);
      console.log(`wrote ${file} (${size})`);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
