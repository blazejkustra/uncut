// D194: media_download, a file from the web into the project's media/downloads/ (a logo, a product
// screenshot, a demo video the agent found). Every hop goes through the library's guarded GET
// (library/net.ts: https only, public addresses only, the checked address is the one connected
// to); redirects are followed by hand, at most MAX_HOPS, each one checked again. Only pictures,
// video and sound by their content type (or, for a generic type, the address's extension), at
// most MAX_BYTES (Content-Length up front and the bytes as they stream). Written to a .part file
// and renamed when complete, under a name that doesn't overwrite anything.
import { createWriteStream } from "node:fs";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { getOnce, retryOnReset } from "../library/net.ts";

export const MAX_BYTES = 300 * 1024 * 1024;
const MAX_HOPS = 5;

/** Content types media_download takes, and the extension the file gets. */
export const DOWNLOAD_TYPES: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/svg+xml": ".svg",
  "image/avif": ".avif",
  "video/mp4": ".mp4",
  "video/quicktime": ".mov",
  "video/webm": ".webm",
  "audio/mpeg": ".mp3",
  "audio/mp3": ".mp3",
  "audio/wav": ".wav",
  "audio/x-wav": ".wav",
  "audio/wave": ".wav",
  "audio/mp4": ".m4a",
  "audio/x-m4a": ".m4a",
  "audio/aac": ".aac",
  "audio/ogg": ".ogg",
  "audio/flac": ".flac",
};
/** D198: what a brand kit import takes from the web: logos (pictures) and font files. */
export const BRAND_DOWNLOAD_TYPES: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/svg+xml": ".svg",
  "font/woff2": ".woff2",
  "font/woff": ".woff",
  "font/ttf": ".ttf",
  "font/otf": ".otf",
  "font/sfnt": ".ttf",
  "application/font-woff": ".woff",
  "application/font-woff2": ".woff2",
  "application/x-font-woff": ".woff",
  "application/x-font-ttf": ".ttf",
  "application/x-font-otf": ".otf",
  "application/x-font-opentype": ".otf",
  "application/vnd.ms-opentype": ".otf",
};
const GENERIC = new Set(["application/octet-stream", "binary/octet-stream", ""]);

/** A file name that is safe on disk: letters, digits, spaces, dots, dashes and underscores; at most 80 characters. */
export function safeName(raw: string): string {
  const cleaned = raw
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9 ._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[.\s-]+|[.\s-]+$/g, "")
    .slice(0, 80);
  return cleaned || "download";
}

async function exists(p: string) {
  return stat(p).then(
    () => true,
    () => false,
  );
}

export type Downloaded = { readonly path: string; readonly bytes: number; readonly type: string; readonly url: string } | { readonly problem: string };

/** Fetch `url` into `<projectDir>/media/downloads/`. `name`: the file's base name (else the address's). */
export function downloadToProject(url: string, projectDir: string, name: string | undefined, signal: AbortSignal, budget = MAX_BYTES): Promise<Downloaded> {
  return downloadToFolder(url, join(projectDir, "media", "downloads"), name, signal, budget);
}

/** Fetch `url` into `folder` (made when missing), taking only `types` (content type → extension). */
export async function downloadToFolder(
  url: string,
  folder: string,
  name: string | undefined,
  signal: AbortSignal,
  budget = MAX_BYTES,
  types: Readonly<Record<string, string>> = DOWNLOAD_TYPES,
): Promise<Downloaded> {
  const cap = Math.min(MAX_BYTES, budget);
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return { problem: `${url.slice(0, 200)} isn't a web address.` };
  }
  let res: Response | undefined;
  for (let hop = 0; ; hop++) {
    try {
      const at = target;
      res = await retryOnReset(
        () => getOnce(at, { "user-agent": "Mozilla/5.0 (Macintosh) Uncut", accept: "image/*,video/*,audio/*;q=0.9,*/*;q=0.5" }, signal),
        signal,
      );
    } catch (error) {
      return { problem: `Couldn't download ${target.host}: ${(error as Error).message}` };
    }
    if (res.status >= 300 && res.status < 400) {
      const next = res.headers.get("location");
      if (!next) return { problem: `${target.host} answered ${res.status} with nowhere to go.` };
      if (hop >= MAX_HOPS) return { problem: `Too many redirects from ${url.slice(0, 200)}.` };
      target = new URL(next, target);
      continue;
    }
    break;
  }
  if (res.status !== 200) {
    await res.body?.cancel().catch(() => {});
    return { problem: `${target.host} answered ${res.status} for ${target.pathname.slice(0, 120)}.` };
  }
  const type = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  const urlExt = extname(target.pathname).toLowerCase();
  const fromUrl = Object.values(types).includes(urlExt === ".jpeg" ? ".jpg" : urlExt) ? (urlExt === ".jpeg" ? ".jpg" : urlExt) : undefined;
  const ext = types[type] ?? (GENERIC.has(type) ? fromUrl : undefined);
  if (!ext) {
    await res.body?.cancel().catch(() => {});
    return {
      problem: `${target.host} sent ${type || "a file of no type"}, not ${types === BRAND_DOWNLOAD_TYPES ? "a logo picture or a font file" : types === DOWNLOAD_TYPES ? "a picture, video or sound" : "a picture, video or sound (or a font file)"}${type === "text/html" ? " (that's a web page: find the file's own address in it)" : ""}.`,
    };
  }
  const length = Number(res.headers.get("content-length"));
  if (Number.isFinite(length) && length > cap) {
    await res.body?.cancel().catch(() => {});
    return { problem: `The file is ${Math.round(length / 1024 / 1024)} MB; media_download takes at most ${Math.floor(cap / 1024 / 1024)} MB now.` };
  }
  if (!res.body) return { problem: `${target.host} sent an empty file.` };

  await mkdir(folder, { recursive: true });
  const base = safeName((name ?? "").trim() || decodeURIComponent(target.pathname.split("/").pop() ?? "").replace(/\.[A-Za-z0-9]{1,5}$/, ""));
  let file = join(folder, `${base}${ext}`);
  for (let n = 2; await exists(file); n++) file = join(folder, `${base} ${n}${ext}`);
  const part = `${file}.${process.pid}.part`;
  let bytes = 0;
  try {
    const counted = Readable.fromWeb(res.body as never).on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > cap) counted.destroy(new Error(`the file is over ${Math.floor(cap / 1024 / 1024)} MB`));
    });
    await pipeline(counted, createWriteStream(part, { flags: "wx" }), { signal });
    if (!bytes) throw new Error("the file is empty");
    const wrong = await sniff(part, ext);
    if (wrong) throw new Error(wrong);
    if (await exists(file)) throw new Error(`${file} appeared while downloading`);
    await rename(part, file);
  } catch (error) {
    await rm(part, { force: true });
    return { problem: `Couldn't download ${target.host}${target.pathname.slice(0, 80)}: ${(error as Error).message}` };
  }
  return { path: file, bytes, type: type || ext.slice(1), url: target.href };
}

/**
 * Why a downloaded file isn't what its type says (D194), or undefined: its first bytes must be the
 * format's own (a text playlist or a web page labelled as video is refused); an SVG must be plain
 * drawing: no scripts, event handlers, foreignObject, javascript: or outside references, DOCTYPE or
 * entities.
 */
export async function sniff(file: string, ext: string): Promise<string | undefined> {
  if (ext === ".svg") {
    const text = (await readFile(file)).subarray(0, 5 * 1024 * 1024).toString("utf8");
    if (!/<svg[\s>]/i.test(text)) return "the file isn't an SVG";
    if (
      /<script|<foreignObject|<!DOCTYPE|<!ENTITY|\son[a-z]+\s*=|javascript:|(?:xlink:)?href\s*=\s*["']\s*(?:https?:|\/\/|file:|data:text)|@import|url\(\s*["']?\s*(?:https?:|\/\/)/i.test(
        text,
      )
    )
      return "the SVG has scripts or outside references; find a PNG of it";
    return undefined;
  }
  const handle = await open(file, "r");
  const head = Buffer.alloc(16);
  try {
    await handle.read(head, 0, 16, 0);
  } finally {
    await handle.close();
  }
  const at = (offset: number, sig: string) => head.subarray(offset, offset + sig.length).toString("latin1") === sig;
  const ok: Record<string, () => boolean> = {
    ".png": () => at(0, "\x89PNG"),
    ".jpg": () => head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff,
    ".gif": () => at(0, "GIF8"),
    ".webp": () => at(0, "RIFF") && at(8, "WEBP"),
    ".avif": () => at(4, "ftyp"),
    ".mp4": () => at(4, "ftyp"),
    ".mov": () => at(4, "ftyp") || at(4, "moov") || at(4, "wide") || at(4, "mdat") || at(4, "free"),
    ".m4a": () => at(4, "ftyp"),
    ".webm": () => head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3,
    ".mp3": () => at(0, "ID3") || (head[0] === 0xff && (head[1]! & 0xe0) === 0xe0),
    ".aac": () => head[0] === 0xff && (head[1]! & 0xf0) === 0xf0,
    ".wav": () => at(0, "RIFF") && at(8, "WAVE"),
    ".ogg": () => at(0, "OggS"),
    ".flac": () => at(0, "fLaC"),
    // D198: font files.
    ".woff2": () => at(0, "wOF2"),
    ".woff": () => at(0, "wOFF"),
    ".ttf": () => at(0, "\x00\x01\x00\x00") || at(0, "true") || at(0, "ttcf"),
    ".otf": () => at(0, "OTTO") || at(0, "\x00\x01\x00\x00"),
  };
  return ok[ext]?.() ? undefined : `the file's content isn't ${ext.slice(1).toUpperCase()} (it may be a web page or a playlist)`;
}
