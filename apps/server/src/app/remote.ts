// The HTTP routes a remote environment needs beyond the WebSocket (Phase 9). All take the server
// token (checked by the gate, auth.ts, and again here):
//   GET  /api/ping              → { ok, version, hostname }: Settings' Test connection (D106)
//   POST /api/upload?name=<n>   → a dropped file into the open project's media/uploads/ (D108)
//   GET  /api/export/<job id>   → a finished export's video, for Download (D109)
import { randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { link, mkdir, open as openFile, realpath, rename, rm, stat } from "node:fs/promises";
import { hostname } from "node:os";
import { basename, extname, join, sep } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import { EXPORT_FILE_PATH, PING_PATH, UPLOAD_PATH } from "@uncut/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { presentedToken, tokensMatch } from "./auth.ts";
import { ServerConfig } from "./config.ts";
import { Exporter } from "../export/exporter.ts";
import { serveFile } from "../media/mediaFiles.ts";
import { Projects } from "../project/projects.ts";

/** The largest upload (D108): UNCUT_UPLOAD_MAX_BYTES, else 16 GiB (a long 4K take fits). */
export const uploadLimit = (env: NodeJS.ProcessEnv = process.env) => {
  const n = Number(env.UNCUT_UPLOAD_MAX_BYTES);
  return Number.isFinite(n) && n > 0 ? n : 16 * 1024 ** 3;
};

const CORS = { "access-control-allow-origin": "*" };
const text = (status: number, body: string) => HttpServerResponse.text(body, { status, headers: CORS });
const json = (value: unknown, status = 200) => HttpServerResponse.text(JSON.stringify(value), { status, contentType: "application/json", headers: CORS });

export const MAX_NAME_BYTES = 200;

/**
 * A file name safe to create in a folder: its last path part, no control characters, no leading
 * dot (nothing hidden), at most 200 bytes of UTF-8 with its extension kept; "upload" if nothing's left.
 */
export function safeUploadName(raw: string | null | undefined): string {
  const last = basename(String(raw ?? "").replace(/\\/g, "/"));
  // Control characters and the path separators out, and no leading dots (nothing hidden, no "..").
  // eslint-disable-next-line no-control-regex
  let name = last
    .replace(/[\u0000-\u001f\u007f/:]/g, "")
    .replace(/^\.+/, "")
    .trim();
  // At most MAX_NAME_BYTES of UTF-8 (file systems count bytes), the extension kept, no character cut in half.
  if (Buffer.byteLength(name) > MAX_NAME_BYTES) {
    const ext = extname(name).slice(0, 12);
    let stem = name.slice(0, name.length - ext.length);
    while (Buffer.byteLength(stem + ext) > MAX_NAME_BYTES) stem = [...stem].slice(0, -1).join("");
    name = `${stem}${ext}`;
  }
  return name || "upload";
}

/** `name`, else "name 2.ext", "name 3.ext"… */
const candidate = (name: string, n: number) => {
  if (n === 1) return name;
  const ext = extname(name);
  return `${name.slice(0, name.length - ext.length)} ${n}${ext}`;
};

type UploadResult = { readonly path: string } | { readonly status: number; readonly message: string };

/** Streams `req` into `<project>/media/uploads/<name>` (D108): capped, never over a file, never outside the project. */
export async function receiveUpload(req: IncomingMessage, projectDir: string, rawName: string | null, limit: number): Promise<UploadResult> {
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > limit)
    return { status: 413, message: `That file is larger than this server takes (${Math.round(limit / 1024 ** 2)} MB).` };
  // media/ or uploads/ as a symlink out of the project would put the file somewhere the user
  // didn't pick: each is checked before anything is created through it.
  const outside = { status: 403, message: "The project's media folder points outside the project, so nothing was uploaded." };
  const realProject = await realpath(projectDir);
  const inside = (p: string) => p.startsWith(realProject + sep);
  const media = join(projectDir, "media");
  await mkdir(media, { recursive: true });
  if (!inside(await realpath(media))) return outside;
  const folder = join(projectDir, "media", "uploads");
  await mkdir(folder, { recursive: true });
  const realFolder = await realpath(folder);
  if (!inside(realFolder)) return outside;
  const part = join(realFolder, `.upload-${randomBytes(8).toString("hex")}.part`);
  const handle = await openFile(part, "wx", 0o644);
  let received = 0;
  let tooBig = false;
  const counter = new Transform({
    transform(chunk: Buffer, _enc, done) {
      received += chunk.length;
      if (received > limit) {
        tooBig = true;
        return done(new Error("too big"));
      }
      done(null, chunk);
    },
  });
  try {
    await pipeline(req, counter, handle.createWriteStream());
  } catch (error) {
    await handle.close().catch(() => {});
    await rm(part, { force: true });
    if (tooBig) return { status: 413, message: `That file is larger than this server takes (${Math.round(limit / 1024 ** 2)} MB).` };
    return { status: 400, message: `The upload stopped: ${(error as Error).message}` };
  }
  await handle.close().catch(() => {});
  const name = safeUploadName(rawName);
  for (let n = 1; n < 1000; n++) {
    const target = join(realFolder, candidate(name, n));
    try {
      // link refuses an existing name (a file or a symlink): no file is ever replaced.
      await link(part, target);
      await rm(part, { force: true });
      return { path: target };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST") continue;
      // A file system without hard links: a checked rename instead.
      if (code === "EPERM" || code === "ENOTSUP" || code === "EXDEV") {
        const there = await stat(target).then(
          () => true,
          () => false,
        );
        if (there) continue;
        await rename(part, target);
        return { path: target };
      }
      await rm(part, { force: true });
      throw error;
    }
  }
  await rm(part, { force: true });
  return { status: 409, message: "Too many files with that name in media/uploads." };
}

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const projects = yield* Projects;
    const exporter = yield* Exporter;
    const authorised = (request: HttpServerRequest.HttpServerRequest) => {
      const url = HttpServerRequest.toURL(request);
      return Option.isSome(url) && tokensMatch(presentedToken(request.headers, url.value), config.token) ? url.value : undefined;
    };
    return Layer.mergeAll(
      HttpRouter.add(
        "GET",
        PING_PATH,
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          if (!authorised(request)) return text(401, "Unauthorized");
          return json({ ok: true, version: config.version, hostname: hostname() });
        }),
      ),
      HttpRouter.add(
        "POST",
        UPLOAD_PATH,
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const url = authorised(request);
          if (!url) return text(401, "Unauthorized");
          const open = yield* projects.current;
          if (!open) return text(409, "Open a project first: uploads go into its media folder.");
          const source = (request as unknown as { readonly source: IncomingMessage }).source;
          const result = yield* Effect.promise(() =>
            receiveUpload(source, open.dir, url.searchParams.get("name"), uploadLimit()).catch((error: Error): UploadResult => ({
              status: 500,
              message: `Couldn't save the upload: ${error.message}`,
            })),
          );
          return "path" in result ? json({ path: result.path }) : text(result.status, result.message);
        }),
      ),
      HttpRouter.add(
        "GET",
        `${EXPORT_FILE_PATH}/*`,
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const url = authorised(request);
          if (!url) return text(401, "Unauthorized");
          const id = url.pathname.slice(EXPORT_FILE_PATH.length + 1);
          // Only a finished export this server made: never an arbitrary path.
          const job = (yield* exporter.jobList).find((j) => j.id === id && j.phase === "done");
          if (!job) return text(404, "No finished export with that id on this server.");
          const response = yield* serveFile(request, job.output);
          return HttpServerResponse.setHeader(response, "content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(basename(job.output))}`);
        }),
      ),
    );
  }),
);
