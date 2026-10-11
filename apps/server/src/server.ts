import * as NodeHttp from "node:http";
import type { Duplex } from "node:stream";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServer } from "effect/http";

import * as Config from "./config.ts";
import * as Format from "./format.ts";
import * as MediaCore from "./mediaCore.ts";
import * as Projects from "./projects.ts";
import * as Recents from "./recents.ts";
import * as Settings from "./settings.ts";
import * as Setup from "./setup.ts";
import * as Ws from "./ws.ts";

// stdout is a protocol channel: exactly one JSON line once the port is bound. The desktop
// shell (and the tests) read it to learn where to connect. Logs go to stderr.
const layerReadyLine = Layer.effectDiscard(
  Effect.gen(function* () {
    const config = yield* Config.ServerConfig;
    const { address } = yield* HttpServer.HttpServer;
    const port = "port" in address ? address.port : config.port;
    const line = { ready: true, port, ...(config.tokenGenerated ? { token: config.token } : {}) };
    process.stdout.write(`${JSON.stringify(line)}\n`);
  }),
);

// Upgraded WebSockets leave the HTTP server's connection tracking, so keep our own list
// to close them on shutdown.
const upgraded = new Set<Duplex>();
export const openSockets = {
  destroyAll: () => {
    for (const socket of upgraded) socket.destroy();
    httpServer?.closeAllConnections();
  },
};
let httpServer: NodeHttp.Server | undefined;
const createServer = () => {
  httpServer = NodeHttp.createServer();
  httpServer.on("upgrade", (_request, socket) => {
    upgraded.add(socket);
    socket.once("close", () => upgraded.delete(socket));
  });
  return httpServer;
};

export const makeServerLayer = (config: Config.ServerConfigShape) => {
  const layerHttpServer = NodeHttpServer.layer(createServer, {
    host: config.host,
    port: config.port,
  });
  const layerRoutes = HttpRouter.serve(Ws.layer, { disableLogger: true, disableListenLog: true });
  return Layer.mergeAll(layerRoutes, layerReadyLine).pipe(
    Layer.provide(MediaCore.layer),
    Layer.provide(Setup.layer),
    Layer.provide(Settings.layer),
    Layer.provide(Projects.layer.pipe(Layer.provide(Format.layer), Layer.provideMerge(Recents.layer))),
    Layer.provideMerge(layerHttpServer),
    Layer.provideMerge(Config.layer(config)),
    Layer.provideMerge(NodeServices.layer),
  );
};
