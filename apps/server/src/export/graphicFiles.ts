// GET /media/graphic/<file name>?token=…: a graphic item's document (D78) for the preview. The
// preview shows it in an <iframe sandbox="allow-scripts"> and calls render(t) by postMessage; the
// export loads the same document (core graphicDocument) in the rasteriser. Only a file in the open
// project's graphics/ folder that one of its graphic items uses (readGraphics: by realpath, size
// capped). The response's CSP is the document's own (inline script and styles, data: images and
// fonts, nothing from the network) plus a sandbox, so even opened directly it can't reach anything.
import { GRAPHIC_PATH, TOKEN_QUERY_PARAM } from "@uncut/contracts";
import { GRAPHIC_CSP, graphicDocument, type Project } from "@uncut/core";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { ServerConfig } from "../app/config.ts";
import { readGraphics } from "./exporter.ts";
import { graphicToken } from "./graphicToken.ts";
import { Projects } from "../project/projects.ts";
import { tokensMatch } from "../app/auth.ts";

// The preview asks for the document (fetch, CORS from its file:// page) before showing it; the token protects the route.
const notFound = () => HttpServerResponse.text("Not found", { status: 404, headers: { "access-control-allow-origin": "*" } });

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const projects = yield* Projects;
    return HttpRouter.add(
      "GET",
      `${GRAPHIC_PATH}/*`,
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const url = HttpServerRequest.toURL(request);
        if (Option.isNone(url) || !tokensMatch(url.value.searchParams.get(TOKEN_QUERY_PARAM), graphicToken(config.token))) return HttpServerResponse.text("Unauthorized", { status: 401 });
        let name: string;
        try {
          name = decodeURIComponent(url.value.pathname.slice(GRAPHIC_PATH.length + 1));
        } catch {
          return notFound();
        }
        const open = yield* projects.current;
        if (!open) return notFound();
        const project = open.project as Project;
        const html = (yield* Effect.promise(() => readGraphics(open.dir, project))).get(`graphics/${name}`);
        if (html === undefined) return notFound();
        return HttpServerResponse.text(graphicDocument(html, project.canvas), {
          contentType: "text/html; charset=utf-8",
          headers: { "access-control-allow-origin": "*", "cache-control": "no-store", "content-security-policy": `${GRAPHIC_CSP}; sandbox allow-scripts`, "x-content-type-options": "nosniff" },
        });
      }),
    );
  }),
);
