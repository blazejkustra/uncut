// The key-free generator, generate.svg (D99): pictures and short animations drawn from SVG or
// HTML, on the user's Claude subscription alone. The agent writes the markup itself and passes it
// to generate_media (content); from the Generate tab, Uncut asks Claude Code for it once (claude -p
// with no tools and no MCP servers, the same login and environment as the agent, D41).
//
// What comes out: an SVG still stays an SVG image (D76: drawn sharp at any size). An HTML still is
// drawn once by the sandboxed rasteriser (D78's graphic document: strict CSP, no network) into a
// PNG. An animation (kind video, HTML with render(t, info), or SVG/HTML with CSS or SMIL
// animations, which Uncut seeks to t) is drawn frame by frame at 30 fps by the same rasteriser and
// encoded to an H.264 MP4 by ffmpeg (opaque: transparent areas come out black).
import { spawn } from "node:child_process";
import { constants, copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { graphicDocument } from "@uncut/core";

import { agentEnv } from "../app/shellEnv.ts";
import { which } from "../app/setup.ts";
import { rasterizerCommand, startRasterizer } from "../export/rasterizer.ts";
import { svgSize } from "../export/svg.ts";

export const SVG_GENERATOR = "generate.svg";
export const SVG_SIZES = ["canvas", "1920x1080", "1080x1920", "1080x1350", "1024x1024"];
export const SVG_SECONDS = [3, 5, 8, 10];
export const SVG_FPS = 30;
/** The longest animation it draws (360 frames at 30 fps: the export's per-item raster cap, D78). */
export const SVG_MAX_SECONDS = 12;
/** The most markup it takes (bytes). */
export const MAX_MARKUP_BYTES = 512 * 1024;
const CLAUDE_TIMEOUT_MS = 4 * 60 * 1000;

export type MarkupKind = "svg" | "html";

/** The markup's kind, or undefined when it's neither an SVG document nor HTML. */
export function markupKind(markup: string): MarkupKind | undefined {
  const head = markup.trimStart().replace(/^<\?xml[^>]*>\s*/i, "").replace(/^<!--[\s\S]*?-->\s*/, "");
  if (/^<svg\b/i.test(head) && /<\/svg>\s*$/i.test(markup.trimEnd())) return "svg";
  if (/^<(!doctype html|html|head|body|div|canvas|svg|style|script|main|section)\b/i.test(head)) return "html";
  return undefined;
}

/** The markup inside Claude's answer: a fenced block, an <svg>…</svg> or an HTML page; undefined when there's none. */
export function extractMarkup(answer: string): string | undefined {
  const fenced = /```(?:svg|html|xml)?\s*\n([\s\S]*?)```/i.exec(answer)?.[1];
  const text = (fenced ?? answer).trim();
  const html = /<!doctype html[\s\S]*<\/html>/i.exec(text)?.[0] ?? /<html[\s\S]*<\/html>/i.exec(text)?.[0];
  if (html) return html;
  const svg = /<svg\b[\s\S]*<\/svg>/i.exec(text)?.[0];
  if (svg) return svg;
  return markupKind(text) ? text : undefined;
}

/** "canvas" (or nothing) is the project's canvas; else "WxH", 16 to 4096 a side. */
export function svgPixels(size: string | undefined, canvas: { readonly width: number; readonly height: number }): { width: number; height: number } | undefined {
  if (!size || size === "canvas") return { width: canvas.width, height: canvas.height };
  const m = /^(\d{2,4})x(\d{2,4})$/.exec(size);
  if (!m) return undefined;
  const width = Number(m[1]);
  const height = Number(m[2]);
  return width >= 16 && height >= 16 && width <= 4096 && height <= 4096 ? { width, height } : undefined;
}

/**
 * Seeks CSS and SMIL animations to t when the markup has no render(t) of its own, so an animated
 * SVG or a CSS animation can be drawn frame by frame. Goes after the author's markup.
 */
const SEEK_SCRIPT = `<script>(() => {
  if (typeof window.render === "function") return;
  window.render = (t) => {
    for (const a of document.getAnimations()) { a.pause(); a.currentTime = t * 1000; }
    for (const s of document.querySelectorAll("svg")) { try { s.pauseAnimations(); s.setCurrentTime(t); } catch {} }
  };
})();</script>`;

/** The page the rasteriser loads: the markup (an SVG fills the page) in D78's graphic document. */
export function markupDocument(markup: string, size: { width: number; height: number }) {
  const kind = markupKind(markup);
  const body = kind === "svg" ? `<style>body>svg{display:block;width:${size.width}px;height:${size.height}px}</style>${markup.replace(/^\s*<\?xml[^>]*>/i, "")}` : markup;
  return graphicDocument(`${body}\n${SEEK_SCRIPT}`, size);
}

const run = (bin: string, args: ReadonlyArray<string>, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr!.on("data", (d) => (stderr = (stderr + d).slice(-2000)));
    const onAbort = () => child.kill("SIGKILL");
    signal.addEventListener("abort", onAbort, { once: true });
    child.once("error", (e) => (signal.removeEventListener("abort", onAbort), reject(e)));
    child.once("close", (code) => {
      signal.removeEventListener("abort", onAbort);
      if (signal.aborted) return reject(signal.reason ?? new Error("cancelled"));
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg failed: ${stderr.trim().split("\n").at(-1) ?? `code ${code}`}`));
    });
  });

/**
 * Turns markup into a file at outBase.{svg,png,mp4}: an SVG still is kept as it is; an HTML still
 * and any animation are drawn by the rasteriser.
 */
export async function renderMarkup(
  markup: string,
  options: { readonly kind: "image" | "video"; readonly width: number; readonly height: number; readonly seconds: number; readonly outBase: string; readonly signal: AbortSignal; readonly status: (text: string) => void },
): Promise<{ path: string }> {
  const kind = markupKind(markup);
  if (!kind) throw new Error("content must be an SVG document (<svg …>…</svg>) or an HTML page.");
  if (Buffer.byteLength(markup) > MAX_MARKUP_BYTES) throw new Error(`content is over ${MAX_MARKUP_BYTES / 1024} KB; keep it simple (no embedded videos or large images).`);
  if (options.kind === "image" && kind === "svg") {
    if (!svgSize(markup)) throw new Error("content isn't an SVG document.");
    const path = `${options.outBase}.svg`;
    // A viewBox-less SVG gets the asked size, so it isn't drawn at 300×150.
    const sized = /<svg\b[^>]*\bviewBox\s*=/i.test(markup) || /<svg\b[^>]*\bwidth\s*=/i.test(markup) ? markup : markup.replace(/<svg\b/i, `<svg width="${options.width}" height="${options.height}"`);
    await writeFile(path, sized, { flag: "wx" });
    return { path };
  }
  const command = rasterizerCommand();
  if ("problem" in command) throw new Error(command.problem);
  const ffmpeg = options.kind === "video" ? await which("ffmpeg", process.env.PATH ?? "") : undefined;
  if (options.kind === "video" && !ffmpeg) throw new Error("Animations need ffmpeg, which isn't installed (Settings shows how to get it).");
  const size = { width: options.width, height: options.height };
  const doc = markupDocument(markup, size);
  const temp = await mkdtemp(join(tmpdir(), "uncut-generate-"));
  const raster = await startRasterizer(command);
  const onAbort = () => void raster.close();
  options.signal.addEventListener("abort", onAbort, { once: true });
  try {
    if (options.kind === "image") {
      options.status("Drawing it…");
      const path = `${options.outBase}.png`;
      const png = join(temp, "still.png");
      await raster.render({ kind: "graphic", width: size.width, height: size.height, doc, t: 0, info: { frame: 0, fps: SVG_FPS, duration: 1, width: size.width, height: size.height, props: {} }, out: png, name: "the picture" });
      await copyFile(png, path, constants.COPYFILE_EXCL);
      return { path };
    }
    const frames = Math.max(1, Math.round(Math.min(SVG_MAX_SECONDS, options.seconds) * SVG_FPS));
    for (let f = 0; f < frames; f++) {
      if (options.signal.aborted) throw options.signal.reason ?? new Error("cancelled");
      if (f % 15 === 0) options.status(`Drawing frame ${f + 1} of ${frames}…`);
      await raster.render({ kind: "graphic", width: size.width, height: size.height, doc, t: f / SVG_FPS, info: { frame: f, fps: SVG_FPS, duration: frames, width: size.width, height: size.height, props: {} }, out: join(temp, `f${String(f).padStart(5, "0")}.png`), name: "the animation" });
    }
    options.status("Encoding the video…");
    const path = `${options.outBase}.mp4`;
    // A cancelled or failed encode leaves no half file behind.
    const cleanup = () => rm(path, { force: true });
    const W = Math.round(size.width / 2) * 2;
    const H = Math.round(size.height / 2) * 2;
    await run(ffmpeg!, ["-v", "error", "-n", "-framerate", String(SVG_FPS), "-i", join(temp, "f%05d.png"), "-vf", `scale=${W}:${H},format=yuv420p`, "-c:v", "libx264", "-crf", "18", "-movflags", "+faststart", path], options.signal).catch(async (error) => {
      await cleanup();
      throw error;
    });
    return { path };
  } finally {
    options.signal.removeEventListener("abort", onAbort);
    await raster.close();
    await rm(temp, { recursive: true, force: true });
  }
}

const SYSTEM = `You write one self-contained graphic for a video editor and answer with the markup only: no explanation, no code fences.
Rules: no external resources (no links, fonts, images or scripts from the network; images only as data: URLs), system fonts only (-apple-system, Helvetica, Arial, monospace).
A still: an SVG document with a viewBox of the given size (or an HTML page of that size).
An animation: either an SVG with CSS or SMIL animations, or an HTML page that defines window.render = (t, info) => { ... } drawing the frame at t seconds (0 to the given length) synchronously; it must look right at any t, drawn out of order. Fill the whole frame with a background colour.`;

/** Asks Claude Code (the subscription, no tools) for the markup. */
export async function askClaude(input: { readonly prompt: string; readonly kind: "image" | "video"; readonly width: number; readonly height: number; readonly seconds: number }, signal: AbortSignal): Promise<string> {
  const bin = process.env.UNCUT_CLAUDE || (await which("claude", process.env.PATH ?? ""));
  if (!bin) throw new Error("Claude Code isn't installed: the SVG generator writes its pictures with your Claude subscription (Settings shows how to install it).");
  const ask = `${input.kind === "video" ? `An animation, ${input.seconds} seconds long` : "A still picture"}, ${input.width}x${input.height} pixels.\nWhat to draw: ${input.prompt}`;
  const cwd = await mkdtemp(join(tmpdir(), "uncut-svg-"));
  const args = ["-p", "--output-format", "json", "--tools", "", "--strict-mcp-config", "--permission-mode", "dontAsk", "--append-system-prompt", SYSTEM];
  if (process.env.UNCUT_AGENT_MODEL) args.push("--model", process.env.UNCUT_AGENT_MODEL);
  try {
    const out = await new Promise<string>((resolve, reject) => {
      const child = spawn(bin, args, { cwd, env: agentEnv(process.env), stdio: ["pipe", "pipe", "pipe"], detached: true });
      let stdout = "";
      let stderr = "";
      const kill = () => {
        try {
          if (child.pid) process.kill(-child.pid, "SIGKILL");
        } catch {}
      };
      const timer = setTimeout(() => (kill(), reject(new Error("Claude didn't answer in 4 minutes."))), CLAUDE_TIMEOUT_MS);
      const onAbort = () => (kill(), reject(signal.reason ?? new Error("cancelled")));
      signal.addEventListener("abort", onAbort, { once: true });
      child.stdout!.on("data", (d) => (stdout = (stdout + d).slice(-4 * MAX_MARKUP_BYTES)));
      child.stderr!.on("data", (d) => (stderr = (stderr + d).slice(-2000)));
      child.stdin!.on("error", () => {});
      child.stdin!.end(ask);
      child.once("error", (e) => (clearTimeout(timer), signal.removeEventListener("abort", onAbort), reject(new Error(`Couldn't start Claude Code: ${e.message}`))));
      child.once("close", (code) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        if (code === 0) resolve(stdout);
        else reject(new Error(`Claude Code stopped (code ${code}): ${stderr.trim().split("\n").at(-1) ?? ""}`.trim()));
      });
    });
    let answer: { is_error?: unknown; result?: unknown };
    try {
      answer = JSON.parse(out.trim().split("\n").at(-1) ?? "");
    } catch {
      throw new Error("Claude Code's answer wasn't readable.");
    }
    if (answer.is_error === true || typeof answer.result !== "string") throw new Error(`Claude couldn't write it: ${String(answer.result ?? "no answer").slice(0, 300)}`);
    const markup = extractMarkup(answer.result);
    if (!markup) throw new Error("Claude's answer had no SVG or HTML in it. Try again, or say more about what to draw.");
    return markup;
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}
