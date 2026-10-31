// Issue #60 (D232): skills come from plugins and nobody picks them. Pure parts: a plugin's
// contributes.skills is read (a data plugin with only skills is a plugin; a name twice in one
// plugin, or one an earlier plugin has, is left out; a name that isn't lowercase-with-dashes is
// refused by the schema), the bundled uncut.skills ships Uncut's own; the system prompt lists every
// skill by name and description; a /name in a message is a skill call (never a path), sent to
// claude as words with the skill's instructions; old builtin- ids read as the names. On the server:
// brand.get lists the bundled plugin's skills, and a user plugin's only once it's allowed.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { BUNDLE, connect, killAll, startServer } from "../helpers/server.ts";
import { discoverPlugins } from "../../apps/server/src/plugins/plugins.ts";
import { sessionArgs } from "../../apps/server/src/agent/agent.ts";
import { calledSkills, skillBlocks, skillCallsAsWords } from "../../apps/server/src/agent/agentPlan.ts";
import { LOOK_TOOLS, mcpTools, skillsPrompt } from "../../apps/server/src/agent/agentTools.ts";
import { normBrief, readActive } from "../../apps/server/src/brand/store.ts";
import { mergeSkills, validateModule } from "../../packages/core/src/index.ts";
import { BUILTIN_IDS, reviewRubric, skillIdOf, soundProfileFor } from "../../packages/core/src/skills/skills.ts";
import { bundledSkills } from "../helpers/skills.ts";

const skip = !existsSync(BUNDLE) ? "server bundle not built (run pnpm build)" : false;
let root = "";
before(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-issue60-")));
});
after(() => {
  killAll();
  if (root) rmSync(root, { recursive: true, force: true });
});

const skillsPlugin = (id: string, skills: Array<Record<string, unknown>>) => ({
  manifest: "uncut.module/0",
  apiVersion: "uncut.module/1",
  id,
  kind: "pack",
  name: `Pack ${id}`,
  version: "1.0.0",
  runtime: { type: "data" },
  contributes: { skills },
});
const skill = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  description: `When ${name} fits.`,
  instructions: `Do ${name}.\n\nReview checklist\n- ${name} is done`,
  ...extra,
});

test("plugin skills are discovered: a skills-only data plugin works, the first plugin with a name has it, a bad name is refused", async () => {
  const dir = join(root, "found");
  for (const [folder, manifest] of [
    ["a", skillsPlugin("acme.pack", [skill("cold-open", { title: "Cold open" }), skill("cold-open"), skill("end-card")])],
    ["b", skillsPlugin("other.pack", [skill("end-card", { description: "Theirs." }), skill("lower-thirds")])],
    ["c", skillsPlugin("bad.pack", [skill("Bad Name")])],
  ] as const) {
    mkdirSync(join(dir, folder), { recursive: true });
    writeFileSync(join(dir, folder, "uncut.module.json"), JSON.stringify(manifest));
  }
  const found = await discoverPlugins([{ source: "user", dir }], { moduleIds: new Set(), toolNames: new Set() });
  const acme = found.plugins.find((p) => p.id === "acme.pack")!;
  assert.deepEqual(
    acme.contributions.skills!.map((x) => [x.name, x.title, x.plugin, x.pluginName]),
    [
      ["cold-open", "Cold open", "acme.pack", "Pack acme.pack"],
      ["end-card", "end-card", "acme.pack", "Pack acme.pack"],
    ],
  );
  assert.match(acme.warnings.join("\n"), /Its skill cold-open is left out: it has another skill with that name\./);
  assert.ok(!acme.warnings.some((w) => /no agent tools/.test(w)), "skills are a contribution");
  const merged = mergeSkills(found.plugins.map((p) => p.contributions));
  assert.deepEqual(
    merged.map((x) => `${x.plugin}:${x.name}`),
    ["acme.pack:cold-open", "acme.pack:end-card", "other.pack:lower-thirds"],
    "the first plugin with a name has it",
  );
  assert.match(found.broken.find((b) => b.id === "bad.pack")!.problem, /doesn't match the module format: \/contributes\/skills\/0\/name/);
  assert.ok(validateModule(skillsPlugin("x.y", [{ name: "x" }])).length > 0, "description and instructions are required");

  // The bundled first-party plugin ships Uncut's own skills.
  const bundled = await discoverPlugins([{ source: "bundled", dir: resolve("plugins") }], { moduleIds: new Set(), toolNames: new Set() });
  const own = bundled.plugins.find((p) => p.id === "uncut.skills")!;
  assert.equal(own.runs, false);
  assert.deepEqual(own.warnings, []);
  assert.deepEqual(
    own.contributions.skills!.map((x) => x.name),
    Object.values(BUILTIN_IDS),
  );
  assert.deepEqual(
    bundledSkills().map((x) => x.name),
    Object.values(BUILTIN_IDS),
  );
});

test("the system prompt lists every installed skill's name and description; skill_read is a tool", () => {
  const skills = bundledSkills();
  const argv = sessionArgs({ cfg: "/tmp/m.json", skills });
  const system = argv[argv.indexOf("--append-system-prompt") + 1]!;
  assert.ok(system.endsWith(skillsPrompt(skills)));
  assert.match(system, /save it as \.claude\/skills\/<name>\/SKILL\.md[\s\S]*\/<name> in the composer[\s\S]*this project only[\s\S]*~\/\.claude\/skills\//);
  assert.match(
    system,
    /\n\nSkills \(installed in Uncut; skill_read \{"name": …\} gives one's instructions; the user calls one with \/name\):\n- launch-promo: A 15 to 30 s launch film/,
  );
  assert.match(system, /\n- make-brand-kit: Builds a brand kit from a link or dropped logos and pictures/);
  for (const x of skills) assert.ok(system.includes(`- ${x.name}: ${x.description}`), x.name);
  assert.ok(!system.includes(skills[0]!.instructions.slice(0, 80)), "instructions only on skill_read (progressive disclosure)");
  const tool = mcpTools().find((t) => t.name === "skill_read")!;
  assert.deepEqual((tool.inputSchema as { required: Array<string> }).required, ["name"]);
  assert.ok((LOOK_TOOLS as ReadonlyArray<string>).includes("skill_read"), "reading a skill is fine in Look only");
  assert.ok(!("use" in (mcpTools().find((t) => t.name === "brief_write")!.inputSchema as { properties: object }).properties), "brief_write turns nothing on");
  const none = sessionArgs({ cfg: "/tmp/m.json" });
  assert.ok(!/\n\nSkills \(installed/.test(none[none.indexOf("--append-system-prompt") + 1]!));
});

test("a /name in a message calls an installed skill: never a path or a file, sent as words with its instructions", () => {
  const names = bundledSkills().map((x) => x.name);
  assert.deepEqual(calledSkills("/launch-promo then /sound-design, (/motion-craft) and /launch-promo again", names), [
    "launch-promo",
    "sound-design",
    "motion-craft",
  ]);
  assert.deepEqual(calledSkills("see /tmp/launch-promo, ~/x/sound-design, a/launch-promo, /launch-promo.mp4, /Users/me and /not-a-skill", names), []);
  assert.deepEqual(calledSkills("the end: /explainer.", names), ["explainer"]);
  assert.equal(
    skillCallsAsWords("/make-brand-kit for acme.com, files in /tmp/make-brand-kit", ["make-brand-kit"]),
    "(skill make-brand-kit) for acme.com, files in /tmp/make-brand-kit",
  );
  assert.equal(skillCallsAsWords("/explainer stays", []), "/explainer stays");
  const block = skillBlocks([{ id: "make-brand-kit", name: "Make a brand kit", body: "Ask first." }]);
  assert.equal(
    block,
    `<skill name="make-brand-kit" title="Make a brand kit">\nThe user called the skill make-brand-kit (/make-brand-kit) for this message: follow its instructions.\nAsk first.\n</skill>`,
  );
});

test("old projects: builtin- skill ids in active.json and brief.json read as the skills' names; the rubric takes either", async () => {
  const dir = join(root, "old");
  mkdirSync(join(dir, "brand"), { recursive: true });
  writeFileSync(
    join(dir, "brand", "active.json"),
    JSON.stringify({ kit: "acme", skills: ["builtin-launch-promo", "my-own", "launch-promo", "builtin-sound-design"] }),
  );
  assert.deepEqual(await readActive(dir), { kit: "acme", skills: ["launch-promo", "my-own", "sound-design"] });
  assert.deepEqual(normBrief({ film: "x", skills: ["builtin-motion-craft", "explainer"] })!.skills, ["motion-craft", "explainer"]);
  assert.equal(skillIdOf("builtin-brand-application"), BUILTIN_IDS.brand);
  const brief = { film: "A demo", type: "talk" as const, audience: "", duration: "", formats: [], assets: [], visual: "", hardLines: [], deliverables: [] };
  assert.deepEqual(reviewRubric(brief, { skills: ["builtin-motion-craft"] }).levels, reviewRubric(brief, { skills: [BUILTIN_IDS.motion] }).levels);
  assert.equal(reviewRubric(brief, { skills: [BUILTIN_IDS.motion] }).levels.motion, "required");
  assert.equal(soundProfileFor({ ...brief, type: "meme" }, ["builtin-sound-design"]), "strict");
});

test("on the server: brand.get lists the bundled plugin's skills, and a user plugin's once it's allowed", { skip, timeout: 120000 }, async () => {
  const base = join(root, "server");
  const plugins = join(base, "plugins");
  mkdirSync(join(plugins, "acme"), { recursive: true });
  writeFileSync(join(plugins, "acme", "uncut.module.json"), JSON.stringify(skillsPlugin("acme.pack", [skill("cold-open", { title: "Cold open" })])));
  const server = await startServer({ env: { UNCUT_DATA_DIR: join(base, "data"), UNCUT_PLUGINS_DIR: plugins, UNCUT_BUNDLED_PLUGINS_DIR: resolve("plugins") } });
  const client = await connect(server.ready.port, server.ready.token);
  try {
    const before = await client.ok("brand.get", {});
    const own = before.skills.filter((x: { plugin?: string }) => x.plugin === "uncut.skills");
    assert.deepEqual(own.map((x: { id: string }) => x.id).sort(), Object.values(BUILTIN_IDS).sort());
    assert.ok(own.every((x: { builtin?: boolean; pluginName?: string }) => x.builtin && x.pluginName === "Uncut skills"));
    assert.ok(!before.skills.some((x: { id: string }) => x.id === "cold-open"), "not allowed yet");
    const list = await client.ok("plugins.list", {});
    const row = list.find((p: { id: string }) => p.id === "acme.pack");
    assert.equal(row.status, "needs-approval");
    assert.deepEqual(row.contributes.skills, ["Cold open (/cold-open)"]);
    assert.match(row.asks[0], /adds a skill\. Its skills are instructions the agent follows/);
    assert.deepEqual(list.find((p: { id: string }) => p.id === "uncut.skills").contributes.skills.length, 11);
    await client.ok("plugins.approve", { id: row.id, dir: row.dir, capabilities: row.capabilities, skills: row.skillsHash });
    const after = await client.ok("brand.get", {});
    const cold = after.skills.find((x: { id: string }) => x.id === "cold-open");
    assert.deepEqual([cold.name, cold.plugin, cold.pluginName, cold.builtin], ["Cold open", "acme.pack", "Pack acme.pack", undefined]);
  } finally {
    client.close();
    await server.stop();
  }
});
