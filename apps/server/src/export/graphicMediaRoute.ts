// GET /media/graphic-media/<media id>?t=&w=&h=&token=… (D290): a picture of the open project's media
// for a graphic in the preview. The graphic's sandboxed iframe can't fetch anything (its CSP), so it
// asks the editor by postMessage and the editor fetches it here (apps/web preview/graphicMedia.ts),
// with the server token like any of its requests (the graphic never sees this URL; the gate checks
// the token). The bytes come from the same source the export's rasteriser gets them from
// (graphicMedia.ts), so preview == export.
import { isAbsolute, resolve } from "node:path";

import { GRAPHIC_MEDIA_PATH } from "@uncut/contracts";
import { parseGraphicMediaRequest, type Media, type Project } from "@uncut/core";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { ServerConfig } from "../app/config.ts";
import { which } from "../app/setup.ts";
import { capsOf } from "./exporter/ffmpeg.ts";
import { graphicMediaSource, type GraphicMediaSource } from "./graphicMedia.ts";
import { Projects } from "../project/projects.ts";

const headers = { "access-control-allow-origin": "*", "cache-control": "no-store", "x-content-type-options": "nosniff" };
const failed = (status: number, message: string) => HttpServerResponse.text(message, { status, headers });

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const projects = yield* Projects;
    // One source for the open project (its decoders stay warm while the preview plays a graphic).
    let source: { readonly dir: string; readonly bin: string; readonly media: { current: ReadonlyArray<Media> }; readonly src: GraphicMediaSource } | undefined;
    yield* Effect.addFinalizer(() => Effect.sync(() => source?.src.close()));
    const sourceFor = async (dir: string, media: ReadonlyArray<Media>) => {
      await config.shellReady;
      const bin = await which("ffmpeg", process.env.PATH ?? "");
      if (!bin) return undefined;
      if (source && (source.dir !== dir || source.bin !== bin)) {
        source.src.close();
        source = undefined;
      }
      if (!source) {
        const holder = { current: media };
        const caps = await capsOf(bin);
        const mediaPath = (m: Media) => (isAbsolute(m.path) ? m.path : resolve(dir, m.path));
        source = { dir, bin, media: holder, src: graphicMediaSource({ bin, media: () => holder.current, mediaPath, videotoolbox: caps.videotoolboxDecode }) };
      }
      source.media.current = media;
      return source.src;
    };
    return HttpRouter.add(
      "GET",
      `${GRAPHIC_MEDIA_PATH}/*`,
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const url = HttpServerRequest.toURL(request);
        if (Option.isNone(url)) return failed(400, "bad request");
        let id: string;
        try {
          id = decodeURIComponent(url.value.pathname.slice(GRAPHIC_MEDIA_PATH.length + 1));
        } catch {
          return failed(400, "bad media id");
        }
        const ask = parseGraphicMediaRequest(id, url.value.searchParams);
        if ("problem" in ask) return failed(400, ask.problem);
        const open = yield* projects.current;
        if (!open) return failed(404, "no project is open");
        const src = yield* Effect.promise(() => sourceFor(open.dir, (open.project as Project).media));
        if (!src) return failed(503, "ffmpeg isn't installed, so project media can't be drawn in graphics");
        const got = yield* Effect.promise(() => src.picture(ask).then((p) => ({ p }), (error: Error) => ({ error: error.message })));
        if ("error" in got) return failed(404, got.error);
        return HttpServerResponse.uint8Array(new Uint8Array(got.p.bytes), { contentType: got.p.type, headers });
      }),
    );
  }),
);
