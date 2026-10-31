// GET /media/graphic-elements/<file name>?token=… (D316): the elements of a graphic of the open
// project, for the timeline and the Inspector. The server token, as any of the editor's requests.
import { GRAPHIC_ELEMENTS_PATH } from "@uncut/contracts";
import { type Project } from "@uncut/core";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { ServerConfig } from "../app/config.ts";
import { which } from "../app/setup.ts";
import { graphicElementsOf } from "./graphicElements.ts";
import { Projects } from "../project/projects.ts";

const headers = { "access-control-allow-origin": "*", "cache-control": "no-store" };
const failed = (status: number, message: string) => HttpServerResponse.text(message, { status, headers });

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const projects = yield* Projects;
    const ffmpeg = async () => {
      await config.shellReady;
      return which("ffmpeg", process.env.PATH ?? "");
    };
    return HttpRouter.add(
      "GET",
      `${GRAPHIC_ELEMENTS_PATH}/*`,
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const url = HttpServerRequest.toURL(request);
        if (Option.isNone(url)) return failed(400, "bad request");
        let name: string;
        try {
          name = decodeURIComponent(url.value.pathname.slice(GRAPHIC_ELEMENTS_PATH.length + 1));
        } catch {
          return failed(400, "bad file name");
        }
        const open = yield* projects.current;
        if (!open) return failed(404, "no project is open");
        const bin = yield* Effect.promise(ffmpeg);
        const result = yield* Effect.promise(() => graphicElementsOf(config, bin, open.dir, open.project as Project, `graphics/${name}`));
        return HttpServerResponse.text(JSON.stringify(result), { contentType: "application/json", headers });
      }),
    );
  }),
);
