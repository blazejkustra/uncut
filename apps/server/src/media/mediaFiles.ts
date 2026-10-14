// GET /media/file/<id>?token=…: the original file of a media item of the open project, for the
// preview's <video> and <img> (D37). Same token as the WebSocket. Only files the open project
// references can be served, looked up by media id; the footage is streamed from where it is
// (D12), never copied. Single byte ranges are honoured (206), which <video> needs to seek.
import { open as openFile, type FileHandle } from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { extname, isAbsolute, join, resolve } from "node:path";

import { AGENT_IMAGE_NAME, AGENT_IMAGE_PATH, BRAND_FILE_PATH, LIBRARY_FOLDER_PATH, LIBRARY_PREVIEW_PATH, MEDIA_FILE_PATH, MUSIC_FILE_PATH, SFX_FILE_PATH } from "@uncut/contracts";
import { MUSIC_TRACKS } from "@uncut/core/music";
import { SFX_SOUNDS } from "@uncut/core/library";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { ServerConfig } from "../app/config.ts";
import { readBrand } from "../brand/store.ts";
import { Projects } from "../project/projects.ts";
import { Library, MAX_PREVIEW_BYTES } from "../library/library.ts";
import { presentedToken, tokensMatch } from "../app/auth.ts";

// The lookup is an exact match against the project's media ids; this only rejects junk early.
const MEDIA_ID = /^[a-z0-9][a-z0-9-]*$/;
const CORS = { "access-control-allow-origin": "*", "access-control-expose-headers": "Content-Range, Accept-Ranges, Content-Length" };
const notFound = () => HttpServerResponse.text("Not found", { status: 404, headers: CORS });

const TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".aif": "audio/aiff",
  ".aiff": "audio/aiff",
  ".flac": "audio/flac",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".opus": "audio/ogg",
  ".caf": "audio/x-caf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".heic": "image/heic",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
};
// The DJI clips are ".MP4": the lookup is by lowercased extension.
const contentType = (path: string) => TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";

const decode = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return undefined; // a malformed % escape
  }
};

/**
 * One `bytes=` range against a file of `size` bytes: [start, end] inclusive, "unsatisfiable",
 * or undefined (no usable Range header: serve the whole file). Several ranges get the whole
 * file too, which is allowed and what <video> never asks for anyway.
 */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | "unsatisfiable" | undefined {
  if (!header) return undefined;
  const m = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(header);
  if (!m) return undefined;
  const [, a, b] = m as unknown as [string, string, string];
  if (a === "" && b === "") return undefined;
  if (a === "") {
    // The last N bytes.
    const n = Number(b);
    if (n === 0 || size === 0) return "unsatisfiable";
    return { start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(a);
  // "bytes=5-2" is not a valid range: ignored, like any other malformed header.
  if (b !== "" && Number(b) < start) return undefined;
  if (start >= size) return "unsatisfiable";
  const end = b === "" ? size - 1 : Math.min(Number(b), size - 1);
  return { start, end };
}

/** A file streamed with Range support (see the header), or 403/404 when it can't be opened. */
export const serveFile = (request: HttpServerRequest.HttpServerRequest, path: string) =>
      Effect.gen(function* () {
        // Opened before any header goes out, so an unreadable file is a clean 403/404, not a
        // connection reset halfway through a response.
        const opened = yield* Effect.promise(async (): Promise<{ file: FileHandle; size: number } | "forbidden" | undefined> => {
          let file: FileHandle | undefined;
          try {
            file = await openFile(path, "r");
            const s = await file.stat();
            if (!s.isFile()) throw new Error("not a regular file");
            return { file, size: s.size };
          } catch (error) {
            await file?.close().catch(() => {});
            return (error as NodeJS.ErrnoException).code === "EACCES" || (error as NodeJS.ErrnoException).code === "EPERM" ? "forbidden" : undefined;
          }
        });
        if (opened === "forbidden") return HttpServerResponse.text("Forbidden", { status: 403, headers: CORS });
        if (!opened) return notFound();
        const { file, size } = opened;

        // CORS (D54): the preview routes the sound through Web Audio, which needs the file fetched
        // in CORS mode (crossOrigin="anonymous") from the file:// renderer, an opaque origin. The
        // token in the URL protects the route, so any origin may read it.
        // An SVG opened as a document (not as the preview's <img>) runs nothing and loads nothing.
        const sandbox = extname(path).toLowerCase() === ".svg" ? { "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox" } : {};
        const headers = { "accept-ranges": "bytes", "cache-control": "no-store", ...CORS, ...sandbox };
        const range = parseRange(request.headers["range"], size);
        if (range === "unsatisfiable") {
          yield* Effect.promise(() => file.close().catch(() => {}));
          return HttpServerResponse.text("Range not satisfiable", { status: 416, headers: { ...headers, "content-range": `bytes */${size}` } });
        }
        const { start, end } = range ?? { start: 0, end: size - 1 };
        const length = end - start + 1;
        if (size === 0) {
          yield* Effect.promise(() => file.close().catch(() => {}));
          return HttpServerResponse.uint8Array(new Uint8Array(0), { contentType: contentType(path), headers });
        }
        // A stream per request (it closes the file when done); the HTTP server destroys it if
        // the client hangs up, which <video> does on every seek.
        const body = file.createReadStream({ start, end, autoClose: true });
        return HttpServerResponse.raw(body, {
          status: range ? 206 : 200,
          contentType: contentType(path),
          headers: {
            ...headers,
            "content-length": String(length),
            ...(range ? { "content-range": `bytes ${start}-${end}/${size}` } : {}),
          },
        });
      });

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const projects = yield* Projects;
    const sounds = yield* Library;
    const authorised = (request: HttpServerRequest.HttpServerRequest) => {
      const url = HttpServerRequest.toURL(request);
      return Option.isSome(url) && tokensMatch(presentedToken(request.headers, url.value), config.token) ? url.value : undefined;
    };
    const unauthorized = () => HttpServerResponse.text("Unauthorized", { status: 401, headers: CORS });
    return Layer.mergeAll(
      HttpRouter.add(
        "GET",
        `${MEDIA_FILE_PATH}/*`,
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const url = authorised(request);
          if (!url) return unauthorized();
          const id = decode(url.pathname.slice(MEDIA_FILE_PATH.length + 1));
          const open = yield* projects.current;
          if (!open || !id || !MEDIA_ID.test(id)) return notFound();
          // Only a file the open project references, found by its media id.
          const media = (open.project as { media?: ReadonlyArray<{ id: string; path: string }> }).media ?? [];
          const entry = media.find((m) => m.id === id);
          if (!entry || typeof entry.path !== "string") return notFound();
          return yield* serveFile(request, isAbsolute(entry.path) ? entry.path : resolve(open.dir, entry.path));
        }),
      ),
      // D184: an image attached to an agent message, from the open project's .cache/agent-images/.
      HttpRouter.add(
        "GET",
        `${AGENT_IMAGE_PATH}/*`,
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const url = authorised(request);
          if (!url) return unauthorized();
          const name = decode(url.pathname.slice(AGENT_IMAGE_PATH.length + 1));
          const open = yield* projects.current;
          if (!open || !name || !AGENT_IMAGE_NAME.test(name)) return notFound();
          return yield* serveFile(request, join(open.dir, ".cache", "agent-images", name));
        }),
      ),
      // D198: a brand kit's file (a logo, a font), only one listed for a kit the open project sees.
      HttpRouter.add(
        "GET",
        `${BRAND_FILE_PATH}/*`,
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const url = authorised(request);
          if (!url) return unauthorized();
          const [kit, name, ...rest] = url.pathname.slice(BRAND_FILE_PATH.length + 1).split("/").map((x) => decode(x));
          if (!kit || !name || rest.length) return notFound();
          const open = yield* projects.current;
          const files = (yield* Effect.promise(() => readBrand({ dataDir: config.dataDir, projectDir: open?.dir }).catch(() => undefined)))?.files ?? {};
          const path = Object.hasOwn(files, kit) && Object.hasOwn(files[kit]!, name) ? files[kit]![name] : undefined;
          if (!path) return notFound();
          return yield* serveFile(request, path);
        }),
      ),
      // The bundled music library (D91), for the Audio tab's preview: only the files it lists.
      HttpRouter.add(
        "GET",
        `${MUSIC_FILE_PATH}/*`,
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const url = authorised(request);
          if (!url) return unauthorized();
          const file = decode(url.pathname.slice(MUSIC_FILE_PATH.length + 1));
          const track = MUSIC_TRACKS.find((t) => t.file === file);
          if (!track) return notFound();
          return yield* serveFile(request, join(config.musicDir, track.file));
        }),
      ),
      // The bundled sound-effects pack (D134), for the Sound effects tab's preview: only its files.
      HttpRouter.add(
        "GET",
        `${SFX_FILE_PATH}/*`,
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const url = authorised(request);
          if (!url) return unauthorized();
          const file = decode(url.pathname.slice(SFX_FILE_PATH.length + 1));
          const sound = SFX_SOUNDS.find((s) => s.file === file);
          if (!sound) return notFound();
          return yield* serveFile(request, join(config.sfxDir, sound.file));
        }),
      ),
      // A file of the user's sound folders (D208), for the Folders view's preview: only a file the
      // folder's index lists, still inside the folder (the id is all the client names).
      HttpRouter.add(
        "GET",
        `${LIBRARY_FOLDER_PATH}/*`,
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const url = authorised(request);
          if (!url) return unauthorized();
          const id = decode(url.pathname.slice(LIBRARY_FOLDER_PATH.length + 1)) ?? "";
          const found = yield* Effect.promise(() => sounds.folders.resolve(id).catch(() => undefined));
          if (!found) return notFound();
          return yield* serveFile(request, found.path);
        }),
      ),
      // An online library hit's preview (D134): streamed through from the file URL its search gave
      // (only hits of a recent search, so nothing else can be fetched through it), never saved.
      HttpRouter.add(
        "GET",
        `${LIBRARY_PREVIEW_PATH}/*`,
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const url = authorised(request);
          if (!url) return unauthorized();
          const [source, id] = (decode(url.pathname.slice(LIBRARY_PREVIEW_PATH.length + 1)) ?? "").split("/");
          if ((source !== "openverse" && source !== "freesound") || !id || !/^[A-Za-z0-9-]{1,64}$/.test(id)) return notFound();
          const controller = new AbortController();
          const res = yield* Effect.promise(() => sounds.preview(`${source}:${id}`, request.headers["range"], controller.signal).catch(() => "failed" as const));
          if (res === undefined) return notFound();
          if (res === "failed" || !res.body || (res.status !== 200 && res.status !== 206)) {
            if (res !== "failed") void res.body?.cancel().catch(() => {});
            return HttpServerResponse.text("The preview couldn't be loaded", { status: 502, headers: CORS });
          }
          const type = res.headers.get("content-type") ?? "";
          const pass: Record<string, string> = { "cache-control": "no-store", ...CORS };
          for (const h of ["content-length", "content-range", "accept-ranges"]) {
            const v = res.headers.get(h);
            if (v) pass[h] = v;
          }
          // At most MAX_PREVIEW_BYTES go through (a preview, not a download).
          let sent = 0;
          const body = Readable.fromWeb(res.body as import("node:stream/web").ReadableStream).pipe(
            new Transform({
              transform(chunk: Buffer, _e, done) {
                sent += chunk.length;
                done(sent > MAX_PREVIEW_BYTES ? new Error("preview too large") : null, chunk);
              },
            }),
          );
          body.on("close", () => controller.abort());
          return HttpServerResponse.raw(body, { status: res.status, contentType: type, headers: pass });
        }),
      ),
    );
  }),
);
