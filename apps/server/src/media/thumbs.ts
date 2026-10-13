// GET /media/thumb/<id>?token=…: the poster for a media item of the open project. Same token
// as the WebSocket. Only `<project>/.cache/thumbs/<id>.jpg` can be served: the id must be a
// media id (no dots or slashes), and the resolved file must still sit inside that folder.
import { readFile, realpath } from "node:fs/promises";
import { sep } from "node:path";

import { THUMB_PATH } from "@uncut/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { ServerConfig } from "../app/config.ts";
import { MediaLibrary, thumbDir } from "./media.ts";
import { Projects } from "../project/projects.ts";
import { presentedToken, tokensMatch } from "../app/auth.ts";

const decode = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return undefined; // a malformed % escape
  }
};

const MEDIA_ID = /^[a-z0-9][a-z0-9-]{0,80}$/;
const notFound = HttpServerResponse.text("Not found", { status: 404 });

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const projects = yield* Projects;
    const library = yield* MediaLibrary;
    return HttpRouter.add(
      "GET",
      `${THUMB_PATH}/*`,
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const url = HttpServerRequest.toURL(request);
        if (Option.isNone(url) || !tokensMatch(presentedToken(request.headers, url.value), config.token)) {
          return HttpServerResponse.text("Unauthorized", { status: 401 });
        }
        const id = decode(url.value.pathname.slice(THUMB_PATH.length + 1));
        const dir = yield* projects.currentDir;
        if (!dir || !id || !MEDIA_ID.test(id)) return notFound;
        // Only the poster made from this media item's current file, looked up by id.
        const poster = yield* library.posterFor(id);
        if (!poster) return notFound;
        const bytes = yield* Effect.promise(async () => {
          try {
            const folder = await realpath(thumbDir(dir));
            const file = await realpath(poster);
            if (!file.startsWith(folder + sep)) return undefined; // a symlink pointing out
            return await readFile(file);
          } catch {
            return undefined;
          }
        });
        if (!bytes) return notFound;
        return HttpServerResponse.uint8Array(bytes, { contentType: "image/jpeg", headers: { "cache-control": "no-store" } });
      }),
    );
  }),
);
