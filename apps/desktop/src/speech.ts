// The offline voice's runner (Reverb, plugins/reverb-tts): an offscreen Chromium page that runs
// Reverb on WebGPU (speechRunner.ts, bundled as speech-runner.js). The Reverb plugin starts it
// (this binary with --uncut-speech) and talks to it in JSON lines:
//   stdin  ← { id, kind: "speak", files: { model, codec, tokenizer }, voice, text, language, out, seed? }
//            the text read in the voice (a voice .json file) and saved as a 24 kHz mono WAV at out
//   stdin  ← { id, kind: "clone", files: { codec }, audio, sampleRate, transcript, language, out }
//            a voice made from audio (raw mono float32 samples) and saved as .json at out
//   stdout → { uncut: "speech", ready: true }                      once, when the page has loaded
//   stdout → { uncut: "speech", id, loading: 0..1 }                while the weights load onto the GPU
//   stdout → { uncut: "speech", id, ok: true, seconds? } | { uncut: "speech", id, ok: false, error }
// Requests run one at a time, in order. The page loads only from Uncut's own scheme, and that serves
// only the files the running request names. It quits when stdin closes.
import { createReadStream, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import * as readline from "node:readline";

import { app, BrowserWindow, protocol, session } from "electron";

const SCHEME = "uncut-speech";
const ORIGIN = `${SCHEME}://uncut`;
const PAGE = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src ${SCHEME}:; connect-src ${SCHEME}:">
<script src="${ORIGIN}/runner.js"></script></head><body></body></html>`;
const LOADING_POLL_MS = 500;

interface SpeakRequest {
  readonly id: number;
  readonly kind: "speak";
  readonly files: { readonly model: string; readonly codec: string; readonly tokenizer: string };
  readonly voice: string;
  readonly text: string;
  readonly language: string;
  readonly out: string;
  readonly seed?: number;
}
interface CloneRequest {
  readonly id: number;
  readonly kind: "clone";
  readonly files: { readonly codec: string };
  readonly audio: string;
  readonly sampleRate: number;
  readonly transcript: string;
  readonly language: string;
  readonly out: string;
}
type Request = SpeakRequest | CloneRequest;

const isText = (v: unknown) => typeof v === "string" && v.length > 0;
function isRequest(v: unknown): v is Request {
  type Fields = Omit<SpeakRequest, "kind" | "files"> & Omit<CloneRequest, "kind" | "files">;
  const r = v as (Partial<Fields> & { kind?: unknown; files?: Partial<SpeakRequest["files"]> }) | null;
  if (!r || typeof r !== "object" || !Number.isInteger(r.id) || !isText(r.out) || !isText(r.language) || !r.files || !isText(r.files.codec)) return false;
  if (r.kind === "speak")
    return isText(r.files.model) && isText(r.files.tokenizer) && isText(r.voice) && isText(r.text) && (r.seed === undefined || Number.isInteger(r.seed));
  return r.kind === "clone" && isText(r.audio) && isText(r.transcript) && Number.isInteger(r.sampleRate) && r.sampleRate! > 0;
}

const messageOf = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method[^:]*: /, "").replace(/^(Uncaught )?(\w*Error: )?/, "");

const reply = (msg: Record<string, unknown>) => process.stdout.write(`${JSON.stringify({ uncut: "speech", ...msg })}\n`);
process.stdout.on("error", () => app.exit(0));

const profile = mkdtempSync(join(tmpdir(), "uncut-speech-profile-"));
app.setPath("userData", profile);
app.setPath("sessionData", profile);
app.on("will-quit", () => rmSync(profile, { recursive: true, force: true }));
app.dock?.hide();
app.on("window-all-closed", () => {});
protocol.registerSchemesAsPrivileged([{ scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

/** The files the running request may read, by the name the page asks for. */
let served = new Map<string, string>();

/** A file's bytes, or the part a Range header asks for (the weights are read in chunks). */
function fileResponse(path: string, range: string | null) {
  const size = statSync(path).size;
  const asked = range?.match(/^bytes=(\d+)-(\d*)$/);
  if (!asked) return new Response(Readable.toWeb(createReadStream(path)) as ReadableStream, { headers: { "content-length": String(size) } });
  const start = Number(asked[1]);
  const end = Math.min(size - 1, asked[2] ? Number(asked[2]) : size - 1);
  if (start > end) return new Response("", { status: 416, headers: { "content-range": `bytes */${size}` } });
  return new Response(Readable.toWeb(createReadStream(path, { start, end })) as ReadableStream, {
    status: 206,
    headers: { "content-length": String(end - start + 1), "content-range": `bytes ${start}-${end}/${size}` },
  });
}

function serve(runnerJs: string) {
  protocol.handle(SCHEME, (request) => {
    const path = new URL(request.url).pathname;
    if (path === "/page") return new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8" } });
    if (path === "/runner.js") return new Response(runnerJs, { headers: { "content-type": "text/javascript; charset=utf-8" } });
    const file = path.startsWith("/file/") ? served.get(path.slice("/file/".length)) : undefined;
    if (!file) return new Response("", { status: 404 });
    try {
      return fileResponse(file, request.headers.get("range"));
    } catch {
      return new Response("", { status: 404 });
    }
  });
}

const fileUrl = (name: string) => `${ORIGIN}/file/${name}`;

async function speak(win: BrowserWindow, r: SpeakRequest) {
  served = new Map([
    ["model.safetensors", r.files.model],
    ["codec.safetensors", r.files.codec],
    ["tokenizer.json", r.files.tokenizer],
  ]);
  const voice = JSON.parse(await readFile(r.voice, "utf8")) as unknown;
  const args = {
    urls: { model: fileUrl("model.safetensors"), codec: fileUrl("codec.safetensors"), tokenizer: fileUrl("tokenizer.json") },
    voice,
    text: r.text,
    language: r.language,
    ...(r.seed !== undefined ? { seed: r.seed } : {}),
  };
  const made = (await win.webContents.executeJavaScript(`window.UncutSpeech.speak(${JSON.stringify(args)})`)) as { wav?: unknown; seconds?: unknown };
  if (!(made?.wav instanceof Uint8Array)) throw new Error("the voice page gave back no audio");
  writeFileSync(r.out, made.wav);
  return { seconds: made.seconds };
}

async function clone(win: BrowserWindow, r: CloneRequest) {
  served = new Map([
    ["codec.safetensors", r.files.codec],
    ["audio.f32", r.audio],
  ]);
  const args = { codec: fileUrl("codec.safetensors"), audio: fileUrl("audio.f32"), sampleRate: r.sampleRate, transcript: r.transcript, language: r.language };
  const voice: unknown = await win.webContents.executeJavaScript(`window.UncutSpeech.clone(${JSON.stringify(args)})`);
  writeFileSync(r.out, JSON.stringify(voice));
  return {};
}

/** Tells the plugin how far the weights have loaded while `work` runs. */
async function withLoading<T>(win: BrowserWindow, id: number, work: Promise<T>) {
  let last = -1;
  const timer = setInterval(() => {
    void win.webContents
      .executeJavaScript("window.UncutSpeech.progress()")
      .then((fraction: unknown) => {
        if (typeof fraction !== "number" || fraction === last || fraction <= 0) return;
        last = fraction;
        reply({ id, loading: fraction });
      })
      .catch(() => {});
  }, LOADING_POLL_MS);
  try {
    return await work;
  } finally {
    clearInterval(timer);
    served = new Map();
  }
}

async function main() {
  await app.whenReady();
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (details, callback) =>
    callback({ cancel: !details.url.startsWith(`${ORIGIN}/`) }),
  );
  serve(await readFile(join(__dirname, "speech-runner.js"), "utf8"));
  const win = new BrowserWindow({
    show: false,
    width: 16,
    height: 16,
    webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  await win.loadURL(`${ORIGIN}/page`);
  reply({ ready: true });

  let chain: Promise<void> = Promise.resolve();
  readline.createInterface({ input: process.stdin }).on("line", (line) => {
    let request: unknown;
    try {
      request = JSON.parse(line);
    } catch {
      return;
    }
    if (!isRequest(request)) return void reply({ id: (request as { id?: unknown })?.id ?? null, ok: false, error: "bad request" });
    const run = () => withLoading(win, request.id, request.kind === "speak" ? speak(win, request) : clone(win, request));
    chain = chain.then(run).then(
      (done) => void reply({ id: request.id, ok: true, ...done }),
      (error: unknown) => void reply({ id: request.id, ok: false, error: messageOf(error) }),
    );
  });
  const done = () => void chain.finally(() => app.quit());
  process.stdin.once("end", done);
  process.stdin.once("close", done);
}

main().catch((error: Error) => {
  process.stderr.write(`[uncut-speech] ${error.message}\n`);
  app.exit(1);
});
