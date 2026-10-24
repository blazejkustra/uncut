import * as NodeHttp from "node:http";
import type { Duplex } from "node:stream";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { WS_PATH } from "@uncut/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServer } from "effect/http";

import * as Agent from "../agent/agent.ts";
import { installGate } from "./auth.ts";
import { pairingText } from "./pairing.ts";
import * as Remote from "./remote.ts";
import * as AgentBridge from "../agent/agentBridge.ts";
import * as Analysis from "../analysis/analysis.ts";
import * as Capture from "../capture/capture.ts";
import * as Config from "./config.ts";
import * as Exporter from "../export/exporter.ts";
import * as Format from "../project/format.ts";
import * as Generate from "../generate/generate.ts";
import * as Keys from "../generate/keys.ts";
import * as SoundLibrary from "../library/library.ts";
import * as Media from "../media/media.ts";
import * as LinkImport from "../media/linkImport.ts";
import * as Proxies from "../media/proxies.ts";
import * as MediaFiles from "../media/mediaFiles.ts";
import * as MediaIndex from "../media/mediaIndex.ts";
import * as GraphicFiles from "../export/graphicFiles.ts";
import * as GraphicMedia from "../export/graphicMediaRoute.ts";
import * as Thumbs from "../media/thumbs.ts";
import * as Waveforms from "../media/waveforms.ts";
import * as Filmstrips from "../media/filmstrips.ts";
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
    // A headless server's token goes to stderr only (with the pairing text), never stdout (D106).
    const line = {
      ready: true,
      port,
      ...(config.tokenGenerated && !config.headless ? { token: config.token } : {}),
      ...(config.headless ? { host: config.host } : {}),
    };
    process.stdout.write(`${JSON.stringify(line)}\n`);
    // A headless server (D106) says where it is and how to pair, for whoever started it.
    if (config.headless) process.stderr.write(pairingText(config.host, port, config.token, config.tokenFile));
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
const createServer = (config: Config.ServerConfigShape) => () => {
  httpServer = NodeHttp.createServer();
  // Origin, token and failed-attempt limits for every request and upgrade (D110), before the router.
  installGate(httpServer, { token: config.token, host: config.host, allowedOrigins: config.allowedOrigins ?? [] });
  httpServer.on("upgrade", (request, socket) => {
    upgraded.add(socket);
    // The window's socket (never its query: the token is there): when it drops, and after how long.
    const path = (request.url ?? "").split("?")[0];
    const opened = Date.now();
    socket.once("close", () => {
      upgraded.delete(socket);
      if (path === WS_PATH) console.error(`[uncut] a window's socket closed after ${Math.round((Date.now() - opened) / 1000)} s`);
    });
  });
  return httpServer;
};

export const makeServerLayer = (config: Config.ServerConfigShape) => {
  const layerHttpServer = NodeHttpServer.layer(createServer(config), {
    host: config.host,
    port: config.port,
  });
  const layerRoutes = HttpRouter.serve(
    Layer.mergeAll(
      Ws.layer,
      Thumbs.layer,
      Thumbs.recentLayer,
      MediaFiles.layer,
      GraphicFiles.layer,
      GraphicMedia.layer,
      Waveforms.layer,
      Filmstrips.layer,
      AgentBridge.layer,
      Remote.layer,
    ),
    { disableLogger: true, disableListenLog: true },
  );
  return Layer.mergeAll(layerRoutes, layerReadyLine).pipe(
    // The agent's media_import goes through the Library's import jobs (D65).
    Layer.provide(Agent.layer),
    Layer.provide(Capture.layer),
    // D205: the user's media index across projects (media_search, Media › Recent from other projects).
    Layer.provideMerge(MediaIndex.layer),
    // Generators (D99): the Generate tab and generate_media; keys through the desktop's safeStorage.
    Layer.provideMerge(Generate.layer),
    // The sound library (D134): Openverse and Freesound search, previews and downloads.
    Layer.provideMerge(SoundLibrary.layer),
    Layer.provideMerge(Keys.layer),
    // media_analyze and analysis.* (D66); analysis waits for exports.
    Layer.provide(Analysis.layer),
    // whisper-cli and the speech models (D68), for transcripts and the Setup row.
    Layer.provideMerge(Whisper.layer),
    Layer.provideMerge(Proxies.layer),
    // D259: Import from link (the user's own yt-dlp), into Media through the import jobs.
    Layer.provideMerge(LinkImport.layer),
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
