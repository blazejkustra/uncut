// The WebSocket RPC endpoint. Same shape as t3code's ws.ts: authenticate the upgrade,
// then run an RpcServer for that one socket.
import { homedir, hostname } from "node:os";

import { LibraryError, PluginError, ProjectError, RPC_METHODS, WS_PATH, WsRpcGroup } from "@uncut/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { RpcSerialization, RpcServer } from "effect/rpc";

import { Agent } from "../agent/agent.ts";
import { brandRpc } from "../brand/brandRpc.ts";
import { Analysis } from "../analysis/analysis.ts";
import { presentedToken, tokensMatch } from "./auth.ts";
import { defaultParentDir, listFolder } from "./files.ts";
import { ServerConfig } from "./config.ts";
import { Exporter } from "../export/exporter.ts";
import { graphicToken } from "../export/graphicToken.ts";
import { MediaLibrary } from "../media/media.ts";
import { importablePath, MediaIndex, shownEntry } from "../media/mediaIndex.ts";
import { MediaCore } from "../media/mediaCore.ts";
import { copyLibraryTrack } from "../media/music.ts";
import { Plugins } from "../plugins/plugins.ts";
import { copyComponent } from "../plugins/contributions.ts";
import { Capture } from "../capture/capture.ts";
import { Generator } from "../generate/generate.ts";
import { Keys } from "../generate/keys.ts";
import { Library } from "../library/library.ts";
import { Projects } from "../project/projects.ts";
import { Proxies } from "../media/proxies.ts";
import { Recents } from "../project/recents.ts";
import { Settings } from "./settings.ts";
import { Setup } from "./setup.ts";
import { Whisper } from "../analysis/whisper.ts";

export { tokensMatch } from "./auth.ts";

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
  readonly capture: typeof Capture.Service;
  readonly generator: typeof Generator.Service;
  readonly keys: typeof Keys.Service;
  readonly sounds: typeof Library.Service;
  readonly mediaIndex: typeof MediaIndex.Service;
  readonly proxies: typeof Proxies.Service;
}

// Handlers stay thin: decode (done by the RPC layer), call one service method.
const handlersLayer = ({ config, mediaCore, projects, recents, setup, settings, library, agent, exporter, analysis, whisper, plugins, capture, generator, keys, sounds, mediaIndex, proxies }: Services) => {
  const brand = brandRpc(config.dataDir, projects.view);
  return WsRpcGroup.toLayer({
    [RPC_METHODS.serverHello]: () =>
      Effect.map(mediaCore.version, (version) => ({
        version: config.version,
        node: process.versions.node,
        pid: process.pid,
        mediaCore: { version },
        graphicToken: graphicToken(config.token),
        home: homedir(),
        defaultParentDir: defaultParentDir(),
        hostname: hostname(),
      })),
    [RPC_METHODS.filesList]: ({ dir }) => listFolder(dir),
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
    [RPC_METHODS.mediaImport]: ({ paths, drop }) => library.startImport(paths, drop),
    [RPC_METHODS.mediaJobs]: () => library.jobs,
    [RPC_METHODS.mediaThumbnails]: () => library.thumbnails,
    [RPC_METHODS.mediaProxies]: () => proxies.states,
    [RPC_METHODS.musicAdd]: ({ track }) =>
      Effect.gen(function* () {
        const open = yield* projects.current;
        if (!open) return yield* new ProjectError({ reason: "no-project", message: "No project is open", details: [] });
        const copied = yield* Effect.promise(() => copyLibraryTrack(config.musicDir, open.dir, track));
        if ("problem" in copied) return yield* new ProjectError({ reason: "io", message: copied.problem, details: [] });
        return { path: copied.path };
      }),
    // The sound library (D134): online search (Openverse, Freesound with the user's key) and add.
    [RPC_METHODS.librarySearch]: (query) => sounds.search(query),
    [RPC_METHODS.libraryState]: () => sounds.state,
    [RPC_METHODS.libraryAdd]: ({ id }) =>
      Effect.gen(function* () {
        const open = yield* projects.current;
        if (!open) return yield* new LibraryError({ reason: "no-project", message: "No project is open" });
        const added = yield* sounds.add(id, open.dir);
        return { path: added.path, seconds: added.seconds, name: added.name, source: { ...added.source } as Record<string, unknown> };
      }),
    // D208: the user's sound folders.
    [RPC_METHODS.libraryFolders]: ({ rescan }) => sounds.folders.list(rescan),
    [RPC_METHODS.libraryFolderAdd]: ({ path }) => sounds.folders.add(path),
    [RPC_METHODS.libraryFolderRemove]: ({ id }) => sounds.folders.remove(id),
    [RPC_METHODS.setupCheck]: () => setup.check,
    [RPC_METHODS.setupState]: () => Effect.map(settings.onboarded, (onboarded) => ({ onboarded })),
    [RPC_METHODS.setupComplete]: () => settings.setOnboarded,
    [RPC_METHODS.agentSubscribe]: () => agent.changes,
    [RPC_METHODS.agentSend]: (input) => agent.send(input),
    [RPC_METHODS.agentCancel]: () => agent.cancel,
    [RPC_METHODS.agentUndoTurn]: ({ turnId }) => agent.undoTurn(turnId),
    [RPC_METHODS.agentApprove]: ({ id, allow, source, answer, beats, note, always }) => agent.approve(id, allow, source, { answer, beats, note, always }),
    [RPC_METHODS.agentPlanSave]: (input) => agent.planSave(input),
    [RPC_METHODS.brandGet]: () => brand.get,
    [RPC_METHODS.brandSaveKit]: ({ kit }) => brand.saveKit(kit),
    [RPC_METHODS.brandDeleteKit]: ({ id, scope }) => brand.deleteKit(id, scope),
    [RPC_METHODS.brandSaveSkill]: ({ skill }) => brand.saveSkill(skill),
    [RPC_METHODS.brandDeleteSkill]: ({ id, scope }) => brand.deleteSkill(id, scope),
    [RPC_METHODS.brandSetActive]: (active) => brand.setActive(active),
    [RPC_METHODS.brandAddFile]: ({ kit, scope, path }) => brand.addFile(kit, scope, path),
    [RPC_METHODS.brandImport]: ({ kit, scope, source }) => brand.importFiles(kit, scope, source),
    [RPC_METHODS.agentScreenTake]: (answer) => agent.screenTake(answer),
    [RPC_METHODS.agentRestoreCleanup]: ({ turnId }) => agent.restoreCleanup(turnId),
    // D205: the user's media index (other projects' captures, imports and generations).
    [RPC_METHODS.mediaRecent]: (opts) => Effect.map(mediaIndex.search(opts), (found) => ({ entries: found.map(shownEntry) })),
    [RPC_METHODS.mediaRecentImport]: ({ id }) =>
      Effect.gen(function* () {
        const entry = yield* mediaIndex.get(id);
        if (!entry) return yield* new ProjectError({ reason: "missing", message: "That file isn't in the media index any more.", details: [] });
        const open = yield* projects.current;
        if (!open) return yield* new ProjectError({ reason: "no-project", message: "No project is open", details: [] });
        const target = yield* Effect.tryPromise({ try: () => importablePath(entry.path, open.dir), catch: (e) => new ProjectError({ reason: "io", message: `Couldn't copy ${entry.name}: ${(e as Error).message}`, details: [] }) });
        const imported = yield* library.importCapture({ openId: open.openId, dir: open.dir, path: target.path, name: entry.name, source: { module: "media.reuse", origin: entry.origin, from: entry.project.name, ...(entry.device ? { device: entry.device } : {}), ...(entry.app ? { app: entry.app } : {}) } });
        return { ...(imported.entries[0] ? { mediaId: imported.entries[0].id } : {}), name: entry.name, copied: target.copied };
      }),
    [RPC_METHODS.exportStart]: (input) => exporter.start(input),
    [RPC_METHODS.exportJobs]: () => exporter.jobs,
    [RPC_METHODS.exportCancel]: ({ jobId }) => exporter.cancel(jobId),
    [RPC_METHODS.exportSubtitles]: (input) => exporter.saveSubtitles(input),
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
    [RPC_METHODS.pluginsInstall]: (input) => plugins.install(input),
    [RPC_METHODS.pluginsUninstall]: ({ id }) => plugins.uninstall(id),
    [RPC_METHODS.pluginsContributions]: () =>
      Effect.map(Effect.andThen(plugins.refresh, plugins.contributions), (c) => ({
        looks: c.looks,
        components: c.components.map(({ id, name, description, plugin, pluginName, params, defaults }) => ({ id, name, description, plugin, pluginName, params, defaults })),
        rules: c.rules,
      })),
    [RPC_METHODS.pluginsCheck]: () =>
      Effect.gen(function* () {
        const open = yield* projects.current;
        if (!open) return { checks: [], notes: [] };
        return yield* plugins.processChecks(open.project, open.dir);
      }),
    [RPC_METHODS.pluginsAddComponent]: ({ id }) =>
      Effect.gen(function* () {
        const component = (yield* plugins.contributions).components.find((c) => c.id === id);
        if (!component) return yield* new PluginError({ reason: "unknown-plugin", message: `There's no component ${id} from an allowed plugin.` });
        const open = yield* projects.current;
        if (!open) return yield* new PluginError({ reason: "io", message: "Open a project first." });
        const copied = yield* Effect.tryPromise({ try: () => copyComponent(open.dir, component), catch: (error) => new PluginError({ reason: "io", message: `Couldn't copy ${component.name} into the project: ${(error as Error).message}` }) });
        if ("problem" in copied) return yield* new PluginError({ reason: "io", message: copied.problem });
        return { src: copied.src, name: component.name, props: component.defaults };
      }),
    [RPC_METHODS.pluginsCatalog]: () => plugins.catalog,
    [RPC_METHODS.pluginsEnable]: ({ id }) => plugins.enable(id),
    [RPC_METHODS.pluginsDisable]: ({ id }) => plugins.disable(id),
    [RPC_METHODS.captureDevices]: () => capture.state,
    [RPC_METHODS.captureStart]: ({ device, ...options }) => capture.start(device, options),
    [RPC_METHODS.captureBoot]: ({ device }) => capture.boot(device),
    [RPC_METHODS.captureRecord]: (input) => capture.record(input),
    [RPC_METHODS.captureStop]: ({ device }) => capture.stop(device),
    [RPC_METHODS.captureSave]: (input) => capture.save(input),
    [RPC_METHODS.captureSaveMulti]: (input) => capture.saveMulti(input),
    [RPC_METHODS.generateList]: () => generator.list,
    [RPC_METHODS.generateStart]: (input) => generator.start(input),
    [RPC_METHODS.generateJobs]: () => generator.jobs,
    [RPC_METHODS.generateCancel]: ({ jobId }) => generator.cancel(jobId),
    [RPC_METHODS.keysList]: () => keys.list,
    [RPC_METHODS.keysSet]: ({ provider, key }) => keys.set(provider, key),
    [RPC_METHODS.keysRemove]: ({ provider }) => keys.remove(provider),
  });
};

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
    const capture = yield* Capture;
    const generator = yield* Generator;
    const keys = yield* Keys;
    const sounds = yield* Library;
    const mediaIndex = yield* MediaIndex;
    const proxies = yield* Proxies;
    const rpcLayer = handlersLayer({ config, mediaCore, projects, recents, setup, settings, library, agent, exporter, analysis, whisper, plugins, capture, generator, keys, sounds, mediaIndex, proxies }).pipe(
      Layer.provideMerge(RpcSerialization.layerJson),
    );

    return HttpRouter.add(
      "GET",
      WS_PATH,
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const url = HttpServerRequest.toURL(request);
        const token = presentedToken(request.headers, Option.isSome(url) ? url.value : undefined);
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
