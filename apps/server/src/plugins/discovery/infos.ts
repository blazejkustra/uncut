import type { PluginInfo } from "@uncut/contracts";
import type { Contributions, PluginShader } from "@uncut/core";
import type { PluginApproval, PluginInstall } from "../../app/settings.ts";
import type { FoundPlugin, Discovery } from "./manifest.ts";

// ---- approval (D97) ----

const CAPABILITY_WORDS: Record<string, string> = {
  network: "use the network",
  "project:read": "read your project",
  "project:write": "suggest changes to your project",
  "media:read": "read your media files",
  "media:write": "add media files",
  "process:spawn": "start other programs",
  gpu: "use the graphics card",
  microphone: "use the microphone",
  screen: "record the screen",
  "api-key": "use an API key",
};

/** What allowing a plugin means, in plain sentences (shown before the user allows it). */
export function pluginAsks(plugin: Pick<FoundPlugin, "capabilities" | "source"> & { readonly runs?: boolean }): Array<string> {
  if (plugin.runs === false) {
    // A data plugin (D103): looks and checks are numbers and rules Uncut reads; components are
    // templates drawn in the graphics sandbox. Still the user's call, as it changes what they see.
    return ["It doesn't run a program: it only adds text looks, components and checks, and its components are drawn in a sandbox with no network. Allow it if you want them in Uncut."];
  }
  const asks = [
    plugin.source === "bundled"
      ? "It ships with Uncut and runs as a program on this Mac."
      : "It runs as a program on this Mac with your rights: it can do anything you can, including reading and changing your files. Allow it only if you trust where it came from.",
  ];
  const words = plugin.capabilities.map((c) => CAPABILITY_WORDS[c] ?? c);
  if (words.length) asks.push(`It says it will ${words.length > 1 ? `${words.slice(0, -1).join(", ")} and ${words.at(-1)}` : words[0]}.`);
  return asks;
}

/** Shipped with the app, or allowed by the user for this folder and at least these capabilities. */
export const isApproved = (plugin: Pick<FoundPlugin, "source" | "dir" | "capabilities" | "spec">, approval: PluginApproval | undefined) =>
  plugin.source === "bundled" ||
  (!!approval &&
    approval.dir === plugin.dir &&
    approval.command === plugin.spec.command &&
    JSON.stringify(approval.args) === JSON.stringify(plugin.spec.args) &&
    plugin.capabilities.every((c) => approval.capabilities.includes(c)));

/** A plugin's contributions in words for Settings (names), or undefined when it has none. */
export const contributesOf = (c: Contributions) =>
  c.looks.length || c.components.length || c.rules.length || c.filters.length || c.shaders?.length
    ? { looks: c.looks.map((l) => l.name), components: c.components.map((x) => x.name), rules: c.rules.map((r) => r.title), ...(c.filters.length ? { filters: c.filters.map((f) => f.name) } : {}), ...(c.shaders?.length ? { shaders: c.shaders.map((x) => x.name) } : {}) }
    : undefined;

/** A plugin's contributions for the agent's modules_list (ids, names and what each is). */
export const contributesFor = (c: Contributions) => ({
  looks: c.looks.map((l) => ({ id: l.id, name: l.name, description: l.description })),
  components: c.components.map((x) => ({ id: x.id, name: x.name, description: x.description, params: x.params })),
  checks: c.rules.map((r) => ({ id: r.id, title: r.title, description: r.description, severity: r.severity })),
  ...(c.filters.length ? { filters: c.filters.map((f) => ({ id: f.id, name: f.name, description: f.description, note: `effect.look with look "${f.id}" and its definition as custom (the clip carries it)`, custom: f.look })) } : {}),
  ...(c.shaders?.length ? { shaders: c.shaders.map((x) => shaderForAgent(x)) } : {}),
});

/** A shader effect (D213) as the agent sees it: its params, and how to apply it (Uncut fills in the rest). */
export const shaderForAgent = (x: Pick<PluginShader, "id" | "name" | "description" | "params">) => ({
  id: x.id,
  name: x.name,
  description: x.description,
  params: x.params.map((p) => ({ key: p.key, label: p.label, type: p.type, ...(p.type === "number" ? { min: p.min, max: p.max } : {}), default: p.default })),
  note: `A GPU shader effect: timeline_edit update_item effects [... the clip's other effects, {"module": "effect.shader", "params": {"shader": "${x.id}", "values": {<param>: <value>}}}]; Uncut fills in its code. One per clip; drawn with WebGPU (an export refuses on a Mac without it).`,
});

export function pluginInfos(
  discovery: Discovery,
  approvals: Readonly<Record<string, PluginApproval>>,
  installs: Readonly<Record<string, PluginInstall>> = {},
  removable: ReadonlySet<string> = new Set(),
): Array<PluginInfo> {
  const originOf = (id: string | undefined, dir: string) => {
    const i = id ? installs[id] : undefined;
    return i && i.dir === dir ? { origin: { kind: i.kind, source: i.source, ...(i.ref ? { ref: i.ref } : {}), ...(i.commit ? { commit: i.commit } : {}) } } : {};
  };
  return [
    ...discovery.plugins.map((p): PluginInfo => ({
      id: p.id,
      name: p.name,
      version: p.version,
      ...(p.description ? { description: p.description } : {}),
      source: p.source,
      dir: p.dir,
      status: isApproved(p, approvals[p.id]) ? "ready" : "needs-approval",
      capabilities: [...p.capabilities],
      asks: pluginAsks(p),
      tools: p.tools.map((t) => t.name),
      warnings: [...p.warnings],
      ...(contributesOf(p.contributions) ? { contributes: contributesOf(p.contributions)! } : {}),
      ...originOf(p.id, p.dir),
      ...(removable.has(p.dir) ? { removable: true } : {}),
    })),
    ...discovery.broken.map((b): PluginInfo => ({
      id: b.id ?? b.dir.split("/").at(-1) ?? b.dir,
      name: b.name ?? b.dir.split("/").at(-1) ?? b.dir,
      source: b.source,
      dir: b.dir,
      status: "broken",
      capabilities: [],
      asks: [],
      tools: [],
      warnings: [],
      problem: b.problem,
      ...originOf(b.id, b.dir),
      ...(removable.has(b.dir) ? { removable: true } : {}),
    })),
  ];
}
