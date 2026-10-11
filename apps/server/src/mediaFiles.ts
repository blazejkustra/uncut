// GET /media/file/<id>?token=…: the original file of a media item of the open project, for the
// preview's <video> and <img> (D37). Same token as the WebSocket. Only files the open project
// references can be served, looked up by media id; the footage is streamed from where it is
// (D12), never copied. Single byte ranges are honoured (206), which <video> needs to seek.
import { open as openFile, type FileHandle } from "node:fs/promises";
import { extname, isAbsolute, resolve } from "node:path";

import { MEDIA_FILE_PATH, TOKEN_QUERY_PARAM } from "@uncut/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { ServerConfig } from "./config.ts";
import { Projects } from "./projects.ts";
import { tokensMatch } from "./ws.ts";

// The lookup is an exact match against the project's media ids; this only rejects junk early.
const MEDIA_ID = /^[a-z0-9][a-z0-9-]*$/;
const notFound = () => HttpServerResponse.text("Not found", { status: 404 });

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
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".heic": "image/heic",
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

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const projects = yield* Projects;
    return HttpRouter.add(
      "GET",
      `${MEDIA_FILE_PATH}/*`,
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const url = HttpServerRequest.toURL(request);
        if (Option.isNone(url) || !tokensMatch(url.value.searchParams.get(TOKEN_QUERY_PARAM), config.token)) {
          return HttpServerResponse.text("Unauthorized", { status: 401 });
        }
        const id = decode(url.value.pathname.slice(MEDIA_FILE_PATH.length + 1));
        const open = yield* projects.current;
        if (!open || !id || !MEDIA_ID.test(id)) return notFound();
        // Only a file the open project references, found by its media id.
        const media = (open.project as { media?: ReadonlyArray<{ id: string; path: string }> }).media ?? [];
        const entry = media.find((m) => m.id === id);
        if (!entry || typeof entry.path !== "string") return notFound();
        const path = isAbsolute(entry.path) ? entry.path : resolve(open.dir, entry.path);
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
        if (opened === "forbidden") return HttpServerResponse.text("Forbidden", { status: 403 });
        if (!opened) return notFound();
        const { file, size } = opened;

        const headers = { "accept-ranges": "bytes", "cache-control": "no-store" };
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
      }),
    );
  }),
);
