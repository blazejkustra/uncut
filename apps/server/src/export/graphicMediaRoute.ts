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

/** How long the preview's source stays open with nothing asked of it (its decoders and cache go with it). */
export const PREVIEW_IDLE_MS = 60_000;

/**
 * The preview's one source of media pictures (its decoders stay warm while a graphic plays): made
 * for the open project's folder and ffmpeg, closed when the project or ffmpeg changes, when no
 * project is open, and after `idleMs` with nothing asked (never while a request is in flight).
 */
export function previewSource(make: (dir: string, bin: string, media: () => ReadonlyArray<Media>) => Promise<GraphicMediaSource>, idleMs = PREVIEW_IDLE_MS) {
  let source: { readonly dir: string; readonly bin: string; readonly media: { current: ReadonlyArray<Media> }; readonly src: Promise<GraphicMediaSource> } | undefined;
  let inFlight = 0;
  let idle: NodeJS.Timeout | undefined;
  const close = () => {
    clearTimeout(idle);
    idle = undefined;
    const gone = source;
    source = undefined;
    void gone?.src.then((s) => s.close(), () => {});
  };
  return {
    /** `ask` with the source for this project (made if need be). */
    use: async <T>(dir: string, bin: string, media: ReadonlyArray<Media>, ask: (src: GraphicMediaSource) => Promise<T>): Promise<T> => {
      clearTimeout(idle);
      idle = undefined;
      if (source && (source.dir !== dir || source.bin !== bin)) close();
      if (!source) {
        const holder = { current: media };
        const src = make(dir, bin, () => holder.current);
        source = { dir, bin, media: holder, src };
        src.catch(() => source?.src === src && (source = undefined));
      }
      source.media.current = media;
      const mine = source;
      inFlight++;
      try {
        return await ask(await mine.src);
      } finally {
        if (--inFlight === 0 && source) {
          idle = setTimeout(close, idleMs);
          idle.unref?.();
        }
      }
    },
    close,
    /** Whether a source is open (tests). */
    open: () => !!source,
  };
}

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const projects = yield* Projects;
    const preview = previewSource(async (dir, bin, media) => {
      const caps = await capsOf(bin);
      const mediaPath = (m: Media) => (isAbsolute(m.path) ? m.path : resolve(dir, m.path));
      return graphicMediaSource({ bin, media, mediaPath, videotoolbox: caps.videotoolboxDecode });
    });
    yield* Effect.addFinalizer(() => Effect.sync(() => preview.close()));
    const ffmpeg = async () => {
      await config.shellReady;
      return which("ffmpeg", process.env.PATH ?? "");
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
        if (!open) {
          preview.close();
          return failed(404, "no project is open");
        }
        const bin = yield* Effect.promise(ffmpeg);
        if (!bin) return failed(503, "ffmpeg isn't installed, so project media can't be drawn in graphics");
        const got = yield* Effect.promise(() => preview.use(open.dir, bin, (open.project as Project).media, (src) => src.picture(ask)).then((p) => ({ p }), (error: Error) => ({ error: error.message })));
        if ("error" in got) return failed(404, got.error);
        return HttpServerResponse.uint8Array(new Uint8Array(got.p.bytes), { contentType: got.p.type, headers });
      }),
    );
  }),
);
