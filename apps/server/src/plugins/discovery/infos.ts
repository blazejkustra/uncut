import { createHash } from "node:crypto";
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

/**
 * D248: what a plugin's skills are, as one string (name, title, description, instructions of each):
 * an approval is for these skills, so a plugin whose skills change needs allowing again. Undefined
 * when it has none.
 */
export const skillsHash = (c: Pick<Contributions, "skills"> | undefined): string | undefined =>
  c?.skills?.length ? createHash("sha256").update(JSON.stringify(c.skills.map((x) => [x.name, x.title, x.description, x.instructions]))).digest("hex").slice(0, 32) : undefined;

/** D248: what skills mean, for the approval (the agent follows them, with the access the user gives it). */
const SKILLS_ASK = "Its skills are instructions the agent follows when they fit, without asking you first. With the access you give the agent, a skill can lead it to run commands and change your files. Allow it only if you trust where it came from.";

/** What allowing a plugin means, in plain sentences (shown before the user allows it). */
export function pluginAsks(plugin: Pick<FoundPlugin, "capabilities" | "source"> & { readonly runs?: boolean; readonly contributions?: Pick<Contributions, "skills"> & Partial<Contributions> }): Array<string> {
  const skills = plugin.contributions?.skills?.length ?? 0;
  if (plugin.runs === false) {
    // A data plugin (D103): looks and checks are numbers and rules Uncut reads; components are
    // templates drawn in the graphics sandbox. Still the user's call, as it changes what they see.
    // D248: skills aren't harmless data: the agent follows them, so they lead.
    if (skills) {
      const c = plugin.contributions!;
      const other = (c.looks?.length ?? 0) + (c.components?.length ?? 0) + (c.rules?.length ?? 0) + (c.filters?.length ?? 0) + (c.shaders?.length ?? 0);
      return [`It doesn't run a program itself, but it adds ${skills === 1 ? "a skill" : `${skills} skills`}. ${SKILLS_ASK}`, ...(other ? ["Its text looks, components and checks are data Uncut reads, and its components are drawn in a sandbox with no network."] : [])];
    }
    return ["It doesn't run a program: it only adds text looks, components and checks, and its components are drawn in a sandbox with no network. Allow it if you want them in Uncut."];
  }
  const asks = [
    plugin.source === "bundled"
      ? "It ships with Uncut and runs as a program on this Mac."
      : "It runs as a program on this Mac with your rights: it can do anything you can, including reading and changing your files. Allow it only if you trust where it came from.",
  ];
  const words = plugin.capabilities.map((c) => CAPABILITY_WORDS[c] ?? c);
  if (words.length) asks.push(`It says it will ${words.length > 1 ? `${words.slice(0, -1).join(", ")} and ${words.at(-1)}` : words[0]}.`);
  if (skills && plugin.source !== "bundled") asks.push(SKILLS_ASK.replace(/ Allow it only if you trust where it came from\.$/, ""));
  return asks;
}

/** Shipped with the app, or allowed by the user for this folder, at least these capabilities and (D248) these skills. */
export const isApproved = (plugin: Pick<FoundPlugin, "source" | "dir" | "capabilities" | "spec"> & { readonly contributions?: Pick<Contributions, "skills"> }, approval: PluginApproval | undefined) =>
  plugin.source === "bundled" ||
  (!!approval &&
    approval.dir === plugin.dir &&
    approval.command === plugin.spec.command &&
    JSON.stringify(approval.args) === JSON.stringify(plugin.spec.args) &&
    plugin.capabilities.every((c) => approval.capabilities.includes(c)) &&
    // A plugin with skills: the ones allowed (an approval from before D248 has none, so it asks again).
    (skillsHash(plugin.contributions) === undefined || approval.skills === skillsHash(plugin.contributions)));

/** D248: a skill as Settings and the approval list it: its title and the /name the user types. */
const skillLabel = (x: { readonly name: string; readonly title: string }) => (x.title && x.title !== x.name ? `${x.title} (/${x.name})` : `/${x.name}`);

/** A plugin's contributions in words for Settings (names), or undefined when it has none. */
export const contributesOf = (c: Contributions) =>
  c.looks.length || c.components.length || c.rules.length || c.filters.length || c.shaders?.length || c.skills?.length
    ? { looks: c.looks.map((l) => l.name), components: c.components.map((x) => x.name), rules: c.rules.map((r) => r.title), ...(c.filters.length ? { filters: c.filters.map((f) => f.name) } : {}), ...(c.shaders?.length ? { shaders: c.shaders.map((x) => x.name) } : {}), ...(c.skills?.length ? { skills: c.skills.map(skillLabel) } : {}) }
    : undefined;

/** A plugin's contributions for the agent's modules_list (ids, names and what each is). */
export const contributesFor = (c: Contributions) => ({
  looks: c.looks.map((l) => ({ id: l.id, name: l.name, description: l.description })),
  components: c.components.map((x) => ({ id: x.id, name: x.name, description: x.description, params: x.params })),
  checks: c.rules.map((r) => ({ id: r.id, title: r.title, description: r.description, severity: r.severity })),
  ...(c.filters.length ? { filters: c.filters.map((f) => ({ id: f.id, name: f.name, description: f.description, note: `effect.look with look "${f.id}" and its definition as custom (the clip carries it)`, custom: f.look })) } : {}),
  ...(c.shaders?.length ? { shaders: c.shaders.map((x) => shaderForAgent(x)) } : {}),
  ...(c.skills?.length ? { skills: c.skills.map((x) => ({ name: x.name, description: x.description, note: `skill_read {"name": "${x.name}"} gives its instructions` })) } : {}),
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
      ...(skillsHash(p.contributions) ? { skillsHash: skillsHash(p.contributions)! } : {}),
      ...(typeof p.manifest.author === "string" && p.manifest.author ? { author: p.manifest.author } : {}),
      runs: p.runs,
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
