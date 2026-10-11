// The WebSocket RPC endpoint. Same shape as t3code's ws.ts: authenticate the upgrade,
// then run an RpcServer for that one socket.
import { timingSafeEqual } from "node:crypto";

import { RPC_METHODS, TOKEN_QUERY_PARAM, WS_PATH, WsRpcGroup } from "@uncut/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { RpcSerialization, RpcServer } from "effect/rpc";

import { ServerConfig } from "./config.ts";
import { MediaCore } from "./mediaCore.ts";
import { Projects } from "./projects.ts";
import { Recents } from "./recents.ts";

const tokensMatch = (given: string | null, expected: string) => {
  if (given === null) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};

interface Services {
  readonly config: typeof ServerConfig.Service;
  readonly mediaCore: typeof MediaCore.Service;
  readonly projects: typeof Projects.Service;
  readonly recents: typeof Recents.Service;
}

// Handlers stay thin: decode (done by the RPC layer), call one service method.
const handlersLayer = ({ config, mediaCore, projects, recents }: Services) =>
  WsRpcGroup.toLayer({
    [RPC_METHODS.serverHello]: () =>
      Effect.map(mediaCore.version, (version) => ({
        version: config.version,
        node: process.versions.node,
        pid: process.pid,
        mediaCore: { version },
      })),
    [RPC_METHODS.projectCreate]: (input) => projects.create(input),
    [RPC_METHODS.projectOpen]: ({ dir }) => projects.open(dir),
    [RPC_METHODS.projectGet]: () => projects.get,
    [RPC_METHODS.projectReload]: () => projects.reload,
    [RPC_METHODS.projectClose]: () => projects.close,
    [RPC_METHODS.projectSubscribe]: () => projects.changes,
    [RPC_METHODS.projectEdit]: (input) => projects.edit(input),
    [RPC_METHODS.projectUndo]: () => projects.undo,
    [RPC_METHODS.projectRedo]: () => projects.redo,
    [RPC_METHODS.recentsList]: () => recents.list,
  });

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const mediaCore = yield* MediaCore;
    const projects = yield* Projects;
    const recents = yield* Recents;
    const rpcLayer = handlersLayer({ config, mediaCore, projects, recents }).pipe(
      Layer.provideMerge(RpcSerialization.layerJson),
    );

    return HttpRouter.add(
      "GET",
      WS_PATH,
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const url = HttpServerRequest.toURL(request);
        const token = Option.isSome(url) ? url.value.searchParams.get(TOKEN_QUERY_PARAM) : null;
        if (!tokensMatch(token, config.token)) {
          return HttpServerResponse.text("Unauthorized", { status: 401 });
        }
        const { protocol, httpEffect } = yield* RpcServer.makeProtocolWithHttpEffectWebsocket;
        // A defect in one handler fails only its own request, not every request on the socket.
        yield* RpcServer.make(WsRpcGroup, { disableTracing: true, disableFatalDefects: true }).pipe(
          Effect.provideService(RpcServer.Protocol, protocol),
          Effect.forkScoped,
        );
        return yield* httpEffect;
      }).pipe(Effect.provide(rpcLayer)),
    );
  }),
);
