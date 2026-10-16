// The plugin host (D97). A plugin is a folder with an uncut.module.json (the module manifest,
// spec/schema/module.schema.json) whose runtime is "process": a stdio MCP server Uncut starts on
// the first call to one of its tools. The manifest's agentTools are what the agent sees (listed
// before the process exists); a call is forwarded 1:1 as an MCP tools/call and its result passed
// back. Folders are searched in order (config.pluginDirs): UNCUT_PLUGINS_DIR, <dataDir>/plugins,
// then the app's own (Resources/plugins); the first plugin with an id wins.
//
// A process plugin runs with the user's rights, so a user plugin's tools are refused until the
// user allows it (settings.json pluginApprovals: that folder, those capabilities); plugins shipped
// with the app are allowed. Plugins return data; changes to the project go through the agent's
// timeline_edit, never by a plugin writing project.json.
import { join } from "node:path";

import { PluginError, type CatalogEntry, type PluginInfo } from "@uncut/contracts";
import { parseFindings, CHECK_TIMEOUT_MS } from "./contributions.ts";
import type { Check } from "@uncut/core";
import { mergeContributions, mergeSkills, NO_CONTRIBUTIONS, type Contributions, type PluginSkill } from "@uncut/core";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";

import { TOOL_NAMES, type McpTool } from "../agent/agentTools.ts";
import { ServerConfig } from "../app/config.ts";
import { ProjectFormat } from "../project/format.ts";
import { Settings, type PluginApproval } from "../app/settings.ts";
import { which } from "../app/setup.ts";
import { InstallError, installPlugin, isRemovable, removePluginFolder, sweepLeftovers } from "./install.ts";
import { type PluginResult, errorResult, pluginContext } from "./runtime/result.ts";
import { type CallExtra, PluginHost } from "./runtime/host.ts";
import { type FoundPlugin, type Discovery, messageOf } from "./discovery/manifest.ts";
import { discoverPlugins } from "./discovery/discover.ts";
import { isApproved, pluginInfos, contributesOf, contributesFor, skillsHash, pluginAsks } from "./discovery/infos.ts";
export { MANIFEST_FILE, DEFAULT_TIMEOUT_S, checkManifest } from "./discovery/manifest.ts";
export type { PluginSource, ProcessSpec, FoundPlugin, BrokenPlugin, Discovery } from "./discovery/manifest.ts";
export { MAX_LINE, PluginTimeout, PluginCancelled, DEFAULT_SDK_DIR, PluginProcess } from "./runtime/process.ts";
export { MAX_IMAGE_BYTES, toMcpResult, CAPTURE_DIR, FLOWS_DIR, pluginContext } from "./runtime/result.ts";
export type { PluginResult, PluginContext } from "./runtime/result.ts";
export { discoverPlugins } from "./discovery/discover.ts";
export { pluginAsks, isApproved, shaderForAgent, pluginInfos, skillsHash } from "./discovery/infos.ts";
export { PluginHost } from "./runtime/host.ts";
export type { CallExtra } from "./runtime/host.ts";

// ---- the service ----

export interface PluginsShape {
  /** Scans the plugin folders again (and stops plugins that went away or changed). */
  readonly refresh: Effect.Effect<void>;
  /** Every plugin found, with its status (after a fresh scan). */
  readonly list: Effect.Effect<ReadonlyArray<PluginInfo>>;
  readonly approve: (input: { readonly id: string; readonly dir: string; readonly capabilities: ReadonlyArray<string>; readonly skills?: string | undefined }) => Effect.Effect<ReadonlyArray<PluginInfo>, PluginError>;
  readonly revoke: (id: string) => Effect.Effect<ReadonlyArray<PluginInfo>, PluginError>;
  /** Installs a plugin from a folder or git URL into <dataDir>/plugins/<id> (D102); it needs allowing afterwards. */
  readonly install: (input: { readonly source: string; readonly ref?: string | undefined; readonly replaceBundled?: boolean | undefined; readonly catalog?: boolean }) => Effect.Effect<{ readonly id: string; readonly note?: string; readonly plugins: ReadonlyArray<PluginInfo> }, PluginError>;
  /** Stops and removes a plugin Uncut installed (one in <dataDir>/plugins), with its approval. */
  readonly uninstall: (id: string) => Effect.Effect<ReadonlyArray<PluginInfo>, PluginError>;
  /** The allowed plugins' agent tools, from the last scan. */
  readonly tools: Effect.Effect<ReadonlyArray<McpTool>>;
  /** The plugin that owns a tool name, from the last scan. */
  readonly owner: (tool: string) => { readonly id: string; readonly name: string } | undefined;
  /**
   * Runs a plugin's tool; undefined when no plugin has a tool by that name. `projectDir` is the
   * open project's folder, passed to the plugin as context (D98) by what it may do.
   */
  readonly call: (tool: string, args: unknown, turn?: AbortSignal, projectDir?: string) => Effect.Effect<(PluginResult & { readonly plugin: PluginCaller }) | undefined>;
  /**
   * Runs a tool of the plugin `id` for Uncut itself (the Capture tab): any tool the process serves,
   * also those it doesn't list for the agent. Refused (an error result) when it isn't allowed.
   */
  readonly callPlugin: (id: string, tool: string, args: unknown, options?: { readonly projectDir?: string | undefined; readonly signal?: AbortSignal | undefined } & CallExtra) => Effect.Effect<PluginResult & { readonly plugin: PluginCaller | undefined }>;
  /** modules_list entries for the plugins (D97). */
  readonly modules: (kind?: string) => Effect.Effect<ReadonlyArray<Record<string, unknown>>>;
  /** The allowed plugins' looks, components and check rules (D103), from the last scan; an unallowed plugin's never show. */
  readonly contributions: Effect.Effect<Contributions>;
  /**
   * D232 (issue #60): the allowed plugins' skills (the first plugin with a name has it), as of the
   * last scan or approval change; synchronous so the brand store's callers can pass them along.
   */
  readonly skillsNow: () => ReadonlyArray<PluginSkill>;
  /** Uncut's catalog (D103): the plugins in config.pluginCatalogDir, each with whether it's enabled (copied in). */
  readonly catalog: Effect.Effect<{ readonly plugins: ReadonlyArray<CatalogEntry>; readonly problems: ReadonlyArray<string> }>;
  /** Enables a catalog plugin: a folder install of its catalog folder (D102), recorded as "catalog"; it still needs allowing. */
  /** Disables a catalog plugin (D103): uninstall, but only a copy Uncut made from the catalog (install kind "catalog"). */
  readonly disable: (id: string) => Effect.Effect<ReadonlyArray<PluginInfo>, PluginError>;
  readonly enable: (id: string) => Effect.Effect<{ readonly id: string; readonly note?: string; readonly plugins: ReadonlyArray<PluginInfo> }, PluginError>;
  /**
   * The allowed process plugins' own checks (D103): each one with "process" rules gets its
   * `check` tool called with the project (in parallel, CHECK_TIMEOUT_MS each); findings for rules
   * it declared become Checks. A plugin that fails or is too slow adds a note instead.
   */
  readonly processChecks: (project: unknown, projectDir: string | undefined) => Effect.Effect<{ readonly checks: ReadonlyArray<Check>; readonly notes: ReadonlyArray<string> }>;
  /** The running process of a plugin (tests). */
  readonly host: PluginHost;
}

/** Who answered a plugin call: what Uncut needs to decide what to do with its declaration. */
export interface PluginCaller {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly capabilities: ReadonlyArray<string>;
}

const callerOf = (p: FoundPlugin): PluginCaller => ({ id: p.id, name: p.name, kind: p.kind, capabilities: p.capabilities });

export class Plugins extends Context.Service<Plugins, PluginsShape>()("uncut/Plugins") {}

export const layer = Layer.effect(
  Plugins,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const settings = yield* Settings;
    const format = yield* ProjectFormat;
    const host = new PluginHost(config.pluginSdkDir);
    const reserved = { moduleIds: new Set(format.modules.keys()), toolNames: new Set<string>(TOOL_NAMES) };
    let discovery: Discovery = { plugins: [], broken: [] };
    const scanLock = yield* Semaphore.make(1);
    // Plugins being installed right now: their calls are refused until the new copy is in place.
    const installing = new Set<string>();
    const busy = (id: string) => (installing.has(id) ? `The plugin ${id} is being installed right now. Try again in a moment.` : undefined);
    // One install or removal at a time (they rename folders in <dataDir>/plugins).
    const installLock = yield* Semaphore.make(1);
    const reported = new Set<string>();
    // D232: the allowed plugins' skills, kept with each scan and approval change.
    let skills: ReadonlyArray<PluginSkill> = [];
    const keepSkills = Effect.map(settings.pluginApprovals, (approvals) => {
      // D248: the plugins that ship with Uncut first, so their skill names are theirs whatever the order of the folders.
      const allowed = discovery.plugins.filter((p) => isApproved(p, approvals[p.id]) && !installing.has(p.id));
      skills = mergeSkills([...allowed.filter((p) => p.source === "bundled"), ...allowed.filter((p) => p.source !== "bundled")].map((p) => p.contributions));
    });

    const refresh = scanLock.withPermits(1)(
      Effect.gen(function* () {
        discovery = yield* Effect.promise(() => discoverPlugins(config.pluginDirs, reserved));
        const approvals = yield* settings.pluginApprovals;
        // Plugins that went away, changed how they start or lost their approval stop now.
        const keep = new Map(discovery.plugins.filter((p) => p.runs && isApproved(p, approvals[p.id])).map((p) => [p.id, p.spec]));
        yield* Effect.promise(() => host.retain(keep));
        yield* keepSkills;
        // stderr: stdout carries the ready line. Each problem once, not on every scan.
        for (const b of discovery.broken) {
          const line = `[uncut] plugin skipped (${b.dir}): ${b.problem}`;
          if (!reported.has(line)) console.error(line);
          reported.add(line);
        }
      }),
    );
    const userRoot = config.pluginDirs.find((r) => r.source === "user" && r.dir === join(config.dataDir, "plugins"))?.dir ?? join(config.dataDir, "plugins");
    const removableDirs = () =>
      Effect.promise(async () => {
        const dirs = [...discovery.plugins.filter((p) => p.source === "user").map((p) => p.dir), ...discovery.broken.filter((b) => b.source === "user").map((b) => b.dir)];
        const ok = await Promise.all(dirs.map((d) => isRemovable(userRoot, d)));
        return new Set(dirs.filter((_, i) => ok[i]));
      });
    const infos = Effect.gen(function* () {
      const approvals = yield* settings.pluginApprovals;
      const installs = yield* settings.pluginInstalls;
      return pluginInfos(discovery, approvals, installs, yield* removableDirs());
    });
    const list = Effect.andThen(refresh, infos);
    const find = (id: string) =>
      Effect.gen(function* () {
        yield* refresh;
        const plugin = discovery.plugins.find((p) => p.id === id);
        if (plugin) return plugin;
        if (discovery.broken.some((b) => b.id === id)) return yield* new PluginError({ reason: "broken", message: `The plugin ${id} can't be used: ${discovery.broken.find((b) => b.id === id)!.problem}` });
        return yield* new PluginError({ reason: "unknown-plugin", message: `There's no plugin ${id}.` });
      });

    // The catalog (D103); D258: in development, bundled.json's install-only plugins wherever they are in the repo.
    const catalogRoot = { source: "user" as const, dir: config.pluginCatalogDir, folders: config.pluginCatalogFolders };
    const byTool = (tool: string) => discovery.plugins.find((p) => p.tools.some((t) => t.name === tool));

    // What an interrupted install or removal left behind (D102).
    yield* Effect.promise(() => sweepLeftovers(userRoot));
    yield* refresh;
    // Plugins stop with the server: on a normal shutdown (the finalizer) and on any exit that
    // skips it, synchronously. A plugin also exits when its stdin closes (the MCP stdio
    // contract), which covers a server that was killed outright.
    const killAll = () => host.killAllNow();
    process.on("exit", killAll);
    yield* Effect.addFinalizer(() =>
      Effect.promise(() => host.stopAll()).pipe(
        Effect.ensuring(Effect.sync(() => process.off("exit", killAll))),
      ),
    );

    const refusal = (plugin: FoundPlugin, approval: PluginApproval | undefined) =>
      isApproved(plugin, approval)
        ? undefined
        : `${plugin.name} (${plugin.id}) isn't allowed to run yet.${approval ? " It changed since the user allowed it (another folder or command, other skills, or it asks for more), so it needs allowing again." : ""} The user has to allow it first: Uncut > Settings…, the Capture step, Plugins, Allow. Ask them to, and say it runs as a program on their Mac with their rights. Don't retry until they have.`;

    const self: PluginsShape = Plugins.of({
      host,
      refresh,
      list,
      approve: ({ id, dir, capabilities, skills }) =>
        Effect.gen(function* () {
          const plugin = yield* find(id);
          // Only what the user was shown: the same folder, nothing asked for beyond it, and (D248) the same skills.
          const hash = skillsHash(plugin.contributions);
          if (plugin.dir !== dir || plugin.capabilities.some((c) => !capabilities.includes(c)) || (hash !== undefined && skills !== hash)) {
            return yield* new PluginError({ reason: "changed", message: `${plugin.name} changed since it was shown (another folder, other skills, or it asks for more). Look at it again before allowing it.` });
          }
          if (plugin.source !== "bundled") {
            yield* settings
              .setPluginApproval(id, { dir: plugin.dir, version: plugin.version, command: plugin.spec.command, args: [...plugin.spec.args], capabilities: [...plugin.capabilities], ...(hash ? { skills: hash } : {}), approvedAt: new Date().toISOString() })
              .pipe(Effect.mapError((error) => new PluginError({ reason: "io", message: `Couldn't save that ${plugin.name} is allowed: ${error.message}` })));
          }
          yield* keepSkills;
          return yield* infos;
        }),
      revoke: (id) =>
        Effect.gen(function* () {
          const plugin = yield* find(id);
          if (plugin.source === "bundled") return yield* new PluginError({ reason: "bundled", message: `${plugin.name} ships with Uncut and is always allowed.` });
          yield* settings
            .setPluginApproval(id, undefined)
            .pipe(Effect.mapError((error) => new PluginError({ reason: "io", message: `Couldn't save that ${plugin.name} is no longer allowed: ${error.message}` })));
          yield* Effect.promise(() => host.stop(id));
          yield* keepSkills;
          return yield* infos;
        }),
      install: (input) =>
        installLock.withPermits(1)(Effect.gen(function* () {
          // The plugins that ship with Uncut, found on their own (a user plugin may shadow one).
          const shipped = yield* Effect.promise(() => discoverPlugins(config.pluginDirs.filter((r) => r.source === "bundled"), { moduleIds: reserved.moduleIds, toolNames: new Set() }));
          const bundled = new Map(shipped.plugins.map((p) => [p.id, p.name]));
          // Right before the new copy replaces the old (D102 review M1): no calls start it from now
          // on, its approval goes (a failed write aborts the install) and the old process stops.
          let swapping: string | undefined;
          const beforeSwap = async (id: string) => {
            swapping = id;
            installing.add(id);
            await Effect.runPromise(settings.setPluginApproval(id, undefined));
            await host.stop(id);
          };
          const installed = yield* Effect.tryPromise({
            try: () => installPlugin(input, { pluginsRoot: userRoot, builtinIds: reserved.moduleIds, bundled, git: () => which("git", process.env.PATH ?? ""), beforeSwap }),
            catch: (error) =>
              error instanceof InstallError
                ? new PluginError({ reason: error.reason, message: error.message })
                : new PluginError({ reason: "io", message: `Couldn't install it: ${messageOf(error)}` }),
          }).pipe(Effect.ensuring(Effect.sync(() => swapping && installing.delete(swapping))));
          // A new copy: the user allows it again (D97), whatever was allowed before.
          yield* settings
            .setPluginInstall(installed.id, { dir: installed.dir, source: installed.source, kind: input.catalog ? "catalog" : installed.kind, ...(installed.ref ? { ref: installed.ref } : {}), ...(installed.commit ? { commit: installed.commit } : {}), installedAt: new Date().toISOString() })
            .pipe(Effect.mapError((error) => new PluginError({ reason: "io", message: `${installed.name} was copied, but Uncut couldn't record where it came from: ${error.message}` })));
          yield* refresh;
          const winner = discovery.plugins.find((p) => p.id === installed.id);
          const note = winner && winner.dir !== installed.dir ? `Another plugin with the id ${installed.id} comes first (${winner.dir}), so the one you installed isn't used until that one is removed.` : undefined;
          return { id: installed.id, ...(note ? { note } : {}), plugins: yield* infos };
        })),
      uninstall: (id) =>
        installLock.withPermits(1)(Effect.gen(function* () {
          yield* refresh;
          const dir = discovery.plugins.find((p) => p.id === id && p.source === "user")?.dir ?? discovery.broken.find((b) => b.id === id && b.source === "user")?.dir;
          if (!dir) {
            if (discovery.plugins.some((p) => p.id === id && p.source === "bundled")) return yield* new PluginError({ reason: "bundled", message: `That plugin ships with Uncut and can't be removed.` });
            return yield* new PluginError({ reason: "unknown-plugin", message: `There's no plugin ${id}.` });
          }
          if (!(yield* Effect.promise(() => isRemovable(userRoot, dir)))) {
            return yield* new PluginError({ reason: "not-removable", message: `Uncut didn't install that plugin (it's in ${dir}), so it doesn't remove it: delete the folder yourself.` });
          }
          yield* Effect.promise(() => host.stop(id));
          yield* Effect.tryPromise({ try: () => removePluginFolder(userRoot, dir), catch: (error) => new PluginError({ reason: "io", message: `Couldn't remove it: ${messageOf(error)}` }) });
          yield* settings.setPluginInstall(id, undefined).pipe(Effect.mapError((error) => new PluginError({ reason: "io", message: `It was removed, but Uncut couldn't update its settings: ${error.message}` })));
          yield* refresh;
          return yield* infos;
        })),
      // Only allowed plugins' tools reach the agent's list (D97): an unapproved plugin's manifest
      // text never gets into the prompt; modules_list says it's installed and waits for approval.
      tools: Effect.map(settings.pluginApprovals, (approvals) =>
        discovery.plugins.filter((p) => isApproved(p, approvals[p.id])).flatMap((p) => p.tools.map((t) => ({ ...t, description: `${t.description} (Plugin: ${p.name}.)` }))),
      ),
      owner: (tool) => {
        const p = byTool(tool);
        return p ? { id: p.id, name: p.name } : undefined;
      },
      call: (tool, args, turn, projectDir) =>
        Effect.gen(function* () {
          const plugin = byTool(tool);
          if (!plugin) return undefined;
          const installingNow = busy(plugin.id);
          if (installingNow) return { ...errorResult(installingNow), plugin: callerOf(plugin) };
          // Read now, so allowing it mid-turn counts at once.
          const refused = refusal(plugin, (yield* settings.pluginApprovals)[plugin.id]);
          if (refused) return { ...errorResult(refused), plugin: callerOf(plugin) };
          // ...and again once the process is up, in case it was revoked while it started.
          const allowed = () => Effect.runPromise(Effect.map(settings.pluginApprovals, (approvals) => busy(plugin.id) ?? refusal(plugin, approvals[plugin.id])));
          const context = yield* Effect.promise(() => pluginContext(plugin, projectDir).catch(() => ({})));
          const result = yield* Effect.promise((signal) => host.call(plugin.spec, tool, args, turn ? AbortSignal.any([signal, turn]) : signal, allowed, context));
          return { ...result, plugin: callerOf(plugin) };
        }),
      callPlugin: (id, tool, args, options = {}) =>
        Effect.gen(function* () {
          yield* refresh;
          const plugin = discovery.plugins.find((p) => p.id === id);
          if (!plugin) {
            const broken = discovery.broken.find((b) => b.id === id);
            return { ...errorResult(broken ? `The plugin ${id} can't be used: ${broken.problem}` : `There's no plugin ${id}.`), plugin: undefined };
          }
          if (!plugin.runs) return { ...errorResult(`${plugin.name} doesn't run a program, so it has no tools to call.`), plugin: callerOf(plugin) };
          const installingNow = busy(plugin.id);
          if (installingNow) return { ...errorResult(installingNow), plugin: callerOf(plugin) };
          const refused = refusal(plugin, (yield* settings.pluginApprovals)[plugin.id]);
          if (refused) return { ...errorResult(`${plugin.name} isn't allowed to run yet: allow it in Settings, the Capture step.`), plugin: callerOf(plugin) };
          const allowed = () => Effect.runPromise(Effect.map(settings.pluginApprovals, (approvals) => busy(plugin.id) ?? (refusal(plugin, approvals[plugin.id]) ? `${plugin.name} isn't allowed to run.` : undefined)));
          const context = yield* Effect.promise(() => pluginContext(plugin, options.projectDir).catch(() => ({})));
          const result = yield* Effect.promise((signal) => host.call(plugin.spec, tool, args, options.signal ? AbortSignal.any([signal, options.signal]) : signal, allowed, context, { timeoutMs: options.timeoutMs, onProgress: options.onProgress }));
          return { ...result, plugin: callerOf(plugin) };
        }),
      catalog: Effect.gen(function* () {
        yield* refresh;
        const installs = yield* settings.pluginInstalls;
        // Enabled: the plugin in use under that id is the copy Uncut made from the catalog (a
        // same-id plugin from git or a folder doesn't count).
        const fromCatalog = (id: string) => installs[id]?.kind === "catalog" && discovery.plugins.some((d) => d.id === id && d.source === "user" && d.dir === installs[id]!.dir);
        const found = yield* Effect.promise(() => discoverPlugins([catalogRoot], { moduleIds: reserved.moduleIds, toolNames: new Set() }));
        const approvals = yield* settings.pluginApprovals;
        return {
          plugins: found.plugins.map((p): CatalogEntry => ({
            id: p.id,
            name: p.name,
            description: p.description ?? "",
            version: p.version,
            kind: p.kind,
            capabilities: [...p.capabilities],
            tools: p.tools.map((t) => t.name),
            runs: p.runs,
            ...(contributesOf(p.contributions) ? { contributes: contributesOf(p.contributions)! } : {}),
            enabled: fromCatalog(p.id),
            // D258: what the marketplace card shows: who made it, what allowing it means, and whether the copy in use is allowed.
            ...(typeof p.manifest.author === "string" && p.manifest.author ? { author: p.manifest.author } : {}),
            asks: pluginAsks(p),
            ...(fromCatalog(p.id) ? { status: discovery.plugins.some((d) => d.id === p.id && d.source === "user" && isApproved(d, approvals[p.id])) ? ("ready" as const) : ("needs-approval" as const) } : {}),
          })),
          problems: found.broken.map((b) => `${b.id ?? b.dir}: ${b.problem}`),
        };
      }),
      disable: (id) =>
        Effect.gen(function* () {
          const install = (yield* settings.pluginInstalls)[id];
          if (install?.kind !== "catalog") return yield* new PluginError({ reason: "not-removable", message: `${id} wasn't enabled from Uncut's catalog, so Disable doesn't remove it (Remove does, in its row).` });
          return yield* self.uninstall(id);
        }),
      enable: (id) =>
        Effect.gen(function* () {
          const found = yield* Effect.promise(() => discoverPlugins([catalogRoot], { moduleIds: reserved.moduleIds, toolNames: new Set() }));
          const entry = found.plugins.find((p) => p.id === id);
          if (!entry) return yield* new PluginError({ reason: "unknown-plugin", message: `There's no plugin ${id} in Uncut's catalog.` });
          return yield* self.install({ source: entry.dir, catalog: true });
        }),
      contributions: Effect.map(settings.pluginApprovals, (approvals) => {
        const allowed = discovery.plugins.filter((p) => isApproved(p, approvals[p.id]) && !installing.has(p.id));
        return allowed.length ? mergeContributions(allowed.map((p) => p.contributions)) : NO_CONTRIBUTIONS;
      }),
      skillsNow: () => skills,
      processChecks: (project, projectDir) =>
        Effect.gen(function* () {
          const approvals = yield* settings.pluginApprovals;
          const askers = discovery.plugins.filter((p) => p.runs && isApproved(p, approvals[p.id]) && p.contributions.rules.some((r) => r.rule.type === "process"));
          if (!askers.length) return { checks: [], notes: [] };
          const results = yield* Effect.forEach(
            askers,
            (plugin) =>
              Effect.gen(function* () {
                const allowed = () => Effect.runPromise(Effect.map(settings.pluginApprovals, (now) => busy(plugin.id) ?? (refusal(plugin, now[plugin.id]) ? `${plugin.name} isn't allowed to run.` : undefined)));
                const context = yield* Effect.promise(() => pluginContext(plugin, projectDir).catch(() => ({})));
                const result = yield* Effect.promise((signal) => host.call(plugin.spec, "check", { project }, signal, allowed, context, { timeoutMs: CHECK_TIMEOUT_MS }));
                return parseFindings(plugin, result);
              }),
            { concurrency: "unbounded" },
          );
          return { checks: results.flatMap((r) => r.checks), notes: results.flatMap((r) => r.notes) };
        }),
      modules: (kind) =>
        Effect.map(settings.pluginApprovals, (approvals) => [
          ...discovery.plugins
            .filter((p) => !kind || p.kind === kind || kind === "plugin")
            .map((p) =>
              isApproved(p, approvals[p.id])
                ? {
                    id: p.id,
                    kind: p.kind,
                    name: p.name,
                    ...(p.description ? { description: p.description } : {}),
                    version: p.version,
                    source: p.source,
                    plugin: true,
                    approved: true,
                    capabilities: p.capabilities,
                    tools: p.tools.map((t) => t.name),
                    ...(contributesOf(p.contributions) ? { contributes: contributesFor(p.contributions) } : {}),
                    ...(p.warnings.length ? { warnings: p.warnings } : {}),
                  }
                : { id: p.id, kind: p.kind, name: p.name.slice(0, 80), source: p.source, plugin: true, approved: false, note: "Installed, but the user hasn't allowed it yet: its tools aren't available until they do (Uncut > Settings…, the Capture step, Plugins)." },
            ),
          // An allowed plugin's looks and components among the built-ins of that kind (D103).
          ...discovery.plugins
            .filter((p) => (kind === "text-style" || kind === "component") && isApproved(p, approvals[p.id]))
            .flatMap((p): Array<Record<string, unknown>> =>
              kind === "text-style"
                ? p.contributions.looks.map((l) => ({ id: l.id, kind, name: l.name, description: l.description, source: p.source, plugin: p.id, note: `From the plugin ${p.name}: insert_text with look ${l.id}; the text carries the whole look, so it keeps drawing if the plugin goes.` }))
                : p.contributions.components.map((c) => ({ id: c.id, kind, name: c.name, description: c.description, source: p.source, plugin: p.id, params: c.params, note: `From the plugin ${p.name}: the user adds it from the Elements tab (it becomes a graphic item whose props are these params; you can change them with update_item).` })),
            ),
          ...(!kind || kind === "plugin"
            ? discovery.broken.map((b) => ({ id: (b.id ?? b.dir.split("/").at(-1))?.slice(0, 80), source: b.source, plugin: true, skipped: true, warnings: [b.problem.slice(0, 300)] }))
            : []),
        ]),
    });
    return self;
  }),
);
