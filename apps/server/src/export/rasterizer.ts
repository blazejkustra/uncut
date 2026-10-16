// Starts and talks to the export rasteriser (D55): the desktop's Electron binary in its
// --uncut-render mode (apps/desktop/src/render.ts), an offscreen Chromium that turns HTML into
// PNGs. The desktop says how to start it when it starts the server: UNCUT_RENDER_BIN (its own
// binary) and UNCUT_RENDER_ENTRY (empty when packaged, where the binary always runs its bundled
// main; apps/desktop/dist/main.cjs under `pnpm dev`, where a bare Electron would open its welcome
// app). Without them (the server run by hand or by the tests, on Node or Electron-as-Node) the
// workspace's Electron runs apps/desktop/dist/main.cjs.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import * as readline from "node:readline";
import { besideServer } from "../paths.ts";

export interface RasterizerCommand {
  readonly bin: string;
  readonly args: ReadonlyArray<string>;
}

/** How to start the rasteriser here, or a sentence saying why it can't be. */
export function rasterizerCommand(
  env: NodeJS.ProcessEnv = process.env,
  runtime: { readonly electron?: string | undefined; readonly execPath: string; readonly platform?: NodeJS.Platform } = { electron: process.versions.electron, execPath: process.execPath },
): RasterizerCommand | { readonly problem: string } {
  // A headless Linux server (D106): Chromium keeps captured frames in /dev/shm, which Docker caps at
  // 64 MB, and a 1080p export's captures then fail ("UnknownVizError", the GPU process gone). The
  // switch puts them in the temp folder instead.
  const render = [...((runtime.platform ?? process.platform) === "linux" ? ["--uncut-render", "--disable-dev-shm-usage"] : ["--uncut-render"]), ...(env.UNCUT_TEST_NO_GPU === "1" ? ["--uncut-no-gpu"] : [])];
  if (env.UNCUT_RENDER_BIN) return { bin: env.UNCUT_RENDER_BIN, args: [...(env.UNCUT_RENDER_ENTRY ? [env.UNCUT_RENDER_ENTRY] : []), ...render] };
  const entry = env.UNCUT_RENDER_ENTRY || besideServer("../../desktop/dist/main.cjs");
  if (!existsSync(entry)) return { problem: `Can't draw text for the export: ${entry} isn't built (pnpm build).` };
  // On Electron-as-Node the binary itself can run the entry; on Node, the workspace's Electron.
  if (runtime.electron) return { bin: runtime.execPath, args: [entry, ...render] };
  let bin: unknown;
  try {
    bin = createRequire(import.meta.url)("electron");
  } catch {
    return { problem: "Can't find Electron to draw text for the export (development setup)." };
  }
  if (typeof bin !== "string") return { problem: "Can't find Electron to draw text for the export (development setup)." };
  return { bin, args: [entry, ...render] };
}

/** Draw `html` (with `css`) on a transparent width×height page, or a frame of a graphic's document (D78: render(t, info) called), and save it to `out`. */
export type RasterJob =
  | { readonly kind?: undefined; readonly width: number; readonly height: number; readonly css: string; readonly html: string; readonly out: string }
  | { readonly kind: "graphic"; readonly width: number; readonly height: number; readonly doc: string; readonly t: number; readonly info: unknown; readonly out: string; readonly name?: string }
  /** A shader effect's frame (D213): `input` a width×height RGBA file, `out` .rgba or .png; "no-webgpu: <why>" without WebGPU. */
  | { readonly kind: "shader"; readonly width: number; readonly height: number; readonly code: string; readonly frame: ReadonlyArray<number>; readonly params?: ReadonlyArray<number>; readonly input: string; readonly out: string; readonly name?: string }
  /** Whether WebGPU works there: fails with "no-webgpu: <why>" when it doesn't. */
  | { readonly kind: "shader-probe" };

export interface Rasterizer {
  /** Draw a job (see RasterJob) and save it to `out` as a PNG (or a JPEG for .jpg). */
  readonly render: (job: RasterJob) => Promise<void>;
  /** Stop it (SIGKILL if it doesn't go within a second). Resolves once it's gone. */
  readonly close: () => Promise<void>;
  readonly pid: number | undefined;
}

const READY_TIMEOUT_MS = 20_000;
const RENDER_TIMEOUT_MS = 30_000;

/** The environment it runs in: ours without the server's own settings and the test hooks. */
const rasterizerEnv = (env: NodeJS.ProcessEnv) => {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined || k === "ELECTRON_RUN_AS_NODE" || k.startsWith("UNCUT_") || k === "ANTHROPIC_API_KEY") continue;
    out[k] = v;
  }
  return out;
};

/** D290: a graphic's media picture as a file the rasteriser reads (export/graphicMedia.ts GraphicMediaSource.file). */
export type RasterMedia = (req: { readonly id: string; readonly t: number; readonly w?: number; readonly h?: number }) => Promise<{ readonly file: string; readonly type: string }>;

/** Start a rasteriser and wait until its page is ready. `media` answers the pictures its graphics ask for (D290); without it they fail. */
export async function startRasterizer(command: RasterizerCommand, env: NodeJS.ProcessEnv = process.env, options: { readonly media?: RasterMedia } = {}): Promise<Rasterizer> {
  // Its Chromium profile: ours to remove once it's gone, however it ends.
  const profile = mkdtempSync(join(tmpdir(), `uncut-render-profile-${process.pid}-`));
  let child: ChildProcess;
  try {
    child = spawn(command.bin, [...command.args, `--uncut-profile=${profile}`], { env: rasterizerEnv(env), stdio: ["pipe", "pipe", "pipe"] });
  } catch (error) {
    rmSync(profile, { recursive: true, force: true });
    throw error;
  }
  const exited = new Promise<void>((resolve) => {
    const gone = () => {
      rmSync(profile, { recursive: true, force: true });
      resolve();
    };
    child.once("close", gone);
    // A binary that can't start emits "error" and maybe never "close".
    child.once("error", gone);
  });
  let stderr = "";
  child.stderr!.on("data", (d) => (stderr = (stderr + d).slice(-2000)));
  child.stdin!.on("error", () => {});
  const pending = new Map<number, { resolve: () => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  let failed: Error | undefined;
  const failAll = (error: Error) => {
    failed ??= error;
    for (const [id, p] of pending) {
      clearTimeout(p.timer);
      p.reject(failed);
      pending.delete(id);
    }
  };
  let onReady: () => void = () => {};
  let readyTimer: NodeJS.Timeout | undefined;
  const ready = new Promise<void>((resolve, reject) => {
    onReady = resolve;
    readyTimer = setTimeout(() => reject(new Error("The text renderer didn't start in time.")), READY_TIMEOUT_MS);
    child.once("error", (e) => reject(new Error(`Can't start the text renderer: ${e.message}`)));
    child.once("exit", (code, signal) => reject(new Error(`The text renderer stopped before it was ready (${signal ?? `code ${code}`}). ${stderr.trim().split("\n").at(-1) ?? ""}`.trim())));
  });
  readline.createInterface({ input: child.stdout! }).on("line", (line) => {
    let msg: { uncut?: unknown; ready?: unknown; id?: unknown; ok?: unknown; error?: unknown; media?: unknown };
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg?.uncut !== "render") return;
    if (msg.media) return void answerMedia(child, msg.media, options.media);
    if (msg.ready === true) return onReady();
    const p = pending.get(Number(msg.id));
    if (!p) return;
    pending.delete(Number(msg.id));
    clearTimeout(p.timer);
    if (msg.ok === true) p.resolve();
    else p.reject(new Error(`The text renderer failed: ${String(msg.error)}`));
  });
  child.once("exit", (code, signal) => failAll(new Error(`The text renderer stopped (${signal ?? `code ${code}`}).`)));

  const close = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.stdin!.end();
      const timer = setTimeout(() => child.kill("SIGKILL"), 1000);
      await exited;
      clearTimeout(timer);
    }
  };
  try {
    await ready;
  } catch (error) {
    child.kill("SIGKILL");
    await exited;
    throw error;
  } finally {
    clearTimeout(readyTimer);
  }

  let next = 0;
  return {
    pid: child.pid,
    close,
    render: (job) =>
      new Promise<void>((resolve, reject) => {
        if (failed) return reject(failed);
        const id = ++next;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error("The text renderer took too long."));
        }, RENDER_TIMEOUT_MS);
        pending.set(id, { resolve, reject, timer });
        child.stdin!.write(`${JSON.stringify({ id, ...job })}\n`);
      }),
  };
}

/** D290: answer a graphic's media request ({ sub, id, t, w, h }) on the rasteriser's stdin: { mediaReply: sub, file, type } or { mediaReply: sub, error }. */
function answerMedia(child: ChildProcess, ask: unknown, media: RasterMedia | undefined) {
  const r = ask as { sub?: unknown; id?: unknown; t?: unknown; w?: unknown; h?: unknown };
  const sub = Number(r?.sub);
  if (!Number.isInteger(sub)) return;
  const send = (reply: Record<string, unknown>) => {
    if (child.exitCode === null && child.signalCode === null && child.stdin!.writable) child.stdin!.write(`${JSON.stringify({ mediaReply: sub, ...reply })}\n`);
  };
  const size = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v >= 1 ? v : undefined);
  if (!media) return send({ error: "project media can't be drawn here" });
  if (typeof r.id !== "string" || typeof r.t !== "number" || !Number.isFinite(r.t)) return send({ error: "bad media request" });
  const w = size(r.w);
  const h = size(r.h);
  media({ id: r.id, t: r.t, ...(w ? { w } : {}), ...(h ? { h } : {}) }).then(
    (got) => send({ file: got.file, type: got.type }),
    (error: Error) => send({ error: error.message }),
  );
}
