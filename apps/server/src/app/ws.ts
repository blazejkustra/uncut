// The WebSocket RPC endpoint. Same shape as t3code's ws.ts: authenticate the upgrade,
// then run an RpcServer for that one socket.
import { timingSafeEqual } from "node:crypto";

import { ProjectError, RPC_METHODS, TOKEN_QUERY_PARAM, WS_PATH, WsRpcGroup } from "@uncut/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { RpcSerialization, RpcServer } from "effect/rpc";

import { Agent } from "../agent/agent.ts";
import { Analysis } from "../analysis/analysis.ts";
import { ServerConfig } from "./config.ts";
import { Exporter } from "../export/exporter.ts";
import { graphicToken } from "../export/graphicToken.ts";
import { MediaLibrary } from "../media/media.ts";
import { MediaCore } from "../media/mediaCore.ts";
import { copyLibraryTrack } from "../media/music.ts";
import { Plugins } from "../plugins/plugins.ts";
import { Projects } from "../project/projects.ts";
import { Recents } from "../project/recents.ts";
import { Settings } from "./settings.ts";
import { Setup } from "./setup.ts";
import { Whisper } from "../analysis/whisper.ts";

export const tokensMatch = (given: string | null, expected: string) => {
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
  readonly setup: typeof Setup.Service;
  readonly settings: typeof Settings.Service;
  readonly library: typeof MediaLibrary.Service;
  readonly agent: typeof Agent.Service;
  readonly exporter: typeof Exporter.Service;
  readonly analysis: typeof Analysis.Service;
  readonly whisper: typeof Whisper.Service;
  readonly plugins: typeof Plugins.Service;
}

// Handlers stay thin: decode (done by the RPC layer), call one service method.
const handlersLayer = ({ config, mediaCore, projects, recents, setup, settings, library, agent, exporter, analysis, whisper, plugins }: Services) =>
  WsRpcGroup.toLayer({
    [RPC_METHODS.serverHello]: () =>
      Effect.map(mediaCore.version, (version) => ({
        version: config.version,
        node: process.versions.node,
        pid: process.pid,
        mediaCore: { version },
        graphicToken: graphicToken(config.token),
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
    [RPC_METHODS.mediaImport]: ({ paths }) => library.startImport(paths),
    [RPC_METHODS.mediaJobs]: () => library.jobs,
    [RPC_METHODS.mediaThumbnails]: () => library.thumbnails,
    [RPC_METHODS.musicAdd]: ({ track }) =>
      Effect.gen(function* () {
        const open = yield* projects.current;
        if (!open) return yield* new ProjectError({ reason: "no-project", message: "No project is open", details: [] });
        const copied = yield* Effect.promise(() => copyLibraryTrack(config.musicDir, open.dir, track));
        if ("problem" in copied) return yield* new ProjectError({ reason: "io", message: copied.problem, details: [] });
        return { path: copied.path };
      }),
    [RPC_METHODS.setupCheck]: () => setup.check,
    [RPC_METHODS.setupState]: () => Effect.map(settings.onboarded, (onboarded) => ({ onboarded })),
    [RPC_METHODS.setupComplete]: () => settings.setOnboarded,
    [RPC_METHODS.agentSubscribe]: () => agent.changes,
    [RPC_METHODS.agentSend]: (input) => agent.send(input),
    [RPC_METHODS.agentCancel]: () => agent.cancel,
    [RPC_METHODS.agentUndoTurn]: ({ turnId }) => agent.undoTurn(turnId),
    [RPC_METHODS.exportStart]: (input) => exporter.start(input),
    [RPC_METHODS.exportJobs]: () => exporter.jobs,
    [RPC_METHODS.exportCancel]: ({ jobId }) => exporter.cancel(jobId),
    [RPC_METHODS.analysisStart]: ({ mediaId, analyzers }) => analysis.start(mediaId, analyzers),
    [RPC_METHODS.analysisJobs]: () => analysis.jobs,
    [RPC_METHODS.analysisCancel]: ({ jobId }) => analysis.cancel(jobId),
    [RPC_METHODS.analysisCached]: ({ mediaId, analyzer, omit }) => analysis.cached(mediaId, analyzer, omit),
    [RPC_METHODS.historySubscribe]: () => projects.historyChanges,
    [RPC_METHODS.historyPreview]: ({ revision }) => projects.historyPreview(revision),
    [RPC_METHODS.historyJump]: ({ revision }) => projects.historyJump(revision),
    [RPC_METHODS.transcriptionState]: () => whisper.state,
    [RPC_METHODS.transcriptionDownload]: ({ model }) => whisper.download(model),
    [RPC_METHODS.transcriptionCancelDownload]: ({ model }) => whisper.cancelDownload(model),
    [RPC_METHODS.transcriptionSelectModel]: ({ model }) => whisper.select(model),
    [RPC_METHODS.pluginsList]: () => plugins.list,
    [RPC_METHODS.pluginsApprove]: (input) => plugins.approve(input),
    [RPC_METHODS.pluginsRevoke]: ({ id }) => plugins.revoke(id),
  });

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const mediaCore = yield* MediaCore;
    const projects = yield* Projects;
    const recents = yield* Recents;
    const setup = yield* Setup;
    const settings = yield* Settings;
    const library = yield* MediaLibrary;
    const agent = yield* Agent;
    const exporter = yield* Exporter;
    const analysis = yield* Analysis;
    const whisper = yield* Whisper;
    const plugins = yield* Plugins;
    const rpcLayer = handlersLayer({ config, mediaCore, projects, recents, setup, settings, library, agent, exporter, analysis, whisper, plugins }).pipe(
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
