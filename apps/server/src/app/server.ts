import * as NodeHttp from "node:http";
import type { Duplex } from "node:stream";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServer } from "effect/http";

import * as Agent from "../agent/agent.ts";
import * as AgentBridge from "../agent/agentBridge.ts";
import * as Analysis from "../analysis/analysis.ts";
import * as Config from "./config.ts";
import * as Exporter from "../export/exporter.ts";
import * as Format from "../project/format.ts";
import * as Media from "../media/media.ts";
import * as MediaFiles from "../media/mediaFiles.ts";
import * as GraphicFiles from "../export/graphicFiles.ts";
import * as Thumbs from "../media/thumbs.ts";
import * as Waveforms from "../media/waveforms.ts";
import * as MediaCore from "../media/mediaCore.ts";
import * as Projects from "../project/projects.ts";
import * as Recents from "../project/recents.ts";
import * as Plugins from "../plugins/plugins.ts";
import * as Settings from "./settings.ts";
import * as Setup from "./setup.ts";
import * as Whisper from "../analysis/whisper.ts";
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
  const layerRoutes = HttpRouter.serve(Layer.mergeAll(Ws.layer, Thumbs.layer, MediaFiles.layer, GraphicFiles.layer, Waveforms.layer, AgentBridge.layer), { disableLogger: true, disableListenLog: true });
  return Layer.mergeAll(layerRoutes, layerReadyLine).pipe(
    // The agent's media_import goes through the Library's import jobs (D65).
    Layer.provide(Agent.layer),
    // media_analyze and analysis.* (D66); analysis waits for exports.
    Layer.provide(Analysis.layer),
    // whisper-cli and the speech models (D68), for transcripts and the Setup row.
    Layer.provideMerge(Whisper.layer),
    Layer.provide(Media.layer),
    Layer.provide(Exporter.layer),
    Layer.provideMerge(MediaCore.layer),
    Layer.provide(Setup.layer),
    // Plugin folders, approvals and processes (D97), for the agent and the plugins.* RPCs.
    Layer.provideMerge(Plugins.layer),
    Layer.provide(Settings.layer),
    Layer.provide(Projects.layer.pipe(Layer.provideMerge(Format.layer), Layer.provideMerge(Recents.layer))),
    Layer.provideMerge(layerHttpServer),
    Layer.provideMerge(Config.layer(config)),
    Layer.provideMerge(NodeServices.layer),
  );
};
