// Phase 8 chunk 2 (D103) without the app: what a plugin adds as data. The example plugin
// (plugins/catalog/taste-extra) validates and contributes one look, one component and two rules;
// ids must be namespaced by the plugin, built-in ids and earlier plugins' ids are refused, script
// in a component template is refused; the declarative rules find what they should; a text in a
// plugin's look carries the whole look (it draws the same, and the project validates, with the
// plugin gone); a component's graphic escapes its params and runs only Uncut's own script.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  applyEdit,
  BUILTIN_CONTRIBUTION_IDS,
  componentGraphicHtml,
  componentProblem,
  mergeContributions,
  createSession,
  GRAPHIC_SRC,
  loadModules,
  planInsertText,
  pluginCheckRules,
  projectChecks,
  readContributions,
  textHtml,
  validateModule,
  validateProject,
  type ModuleManifest,
  type Project,
} from "../../packages/core/src/index.ts";
import { checkManifest } from "../../apps/server/src/plugins/plugins.ts";
import { emptyProject } from "../../apps/server/src/project/projects.ts";

const modules = await loadModules("spec/modules/builtin");
const builtinIds = new Set(modules.keys());
const moves = new Set([...modules.values()].filter((m) => m.kind === "move").map((m) => m.id));
const example = JSON.parse(readFileSync("plugins/catalog/taste-extra/uncut.module.json", "utf8")) as ModuleManifest;
const read = (m: ModuleManifest, taken?: Set<string>) => readContributions(m, { reserved: builtinIds, moves, ...(taken ? { taken } : {}) });
const withContributes = (contributes: Record<string, unknown>, patch: Record<string, unknown> = {}) => ({ ...example, ...patch, contributes }) as ModuleManifest;

test("the example plugin validates and contributes a look, a component and two rules", () => {
  assert.deepEqual(validateModule(example), []);
  assert.ok("manifest" in checkManifest(example, builtinIds));
  const { contributions, warnings } = read(example);
  assert.deepEqual(warnings, []);
  assert.deepEqual(contributions.looks.map((l) => l.id), ["taste.extra.soft-card"]);
  assert.equal(contributions.looks[0]!.pluginName, "Taste extra");
  assert.deepEqual(contributions.components.map((c) => c.id), ["taste.extra.sticker"]);
  assert.deepEqual(contributions.components[0]!.defaults, { label: "New", color: "#FFD84D" });
  assert.deepEqual(contributions.rules.map((r) => r.id), ["taste.extra.end-card", "taste.extra.banned-phrases"]);
});

test("data plugins: no tools, something to contribute; contributions validated, namespaced, collisions refused", () => {
  assert.match((checkManifest({ ...example, agentTools: [{ name: "x_y", description: "d", inputSchema: { type: "object" } }] }, builtinIds) as { problem: string }).problem, /agent tools/);
  assert.match((checkManifest({ ...example, contributes: {} }, builtinIds) as { problem: string }).problem, /contributes nothing/);
  // Schema: an id must have the plugin's id and a name (three parts at least); a bad rule shape is refused.
  assert.ok(validateModule(withContributes({ rules: [{ id: "solo", title: "x", rule: { type: "max-words", max: 3 } }] })).length > 0);
  assert.ok(validateModule(withContributes({ rules: [{ id: "taste.extra.x", title: "x", rule: { type: "max-words" } }] })).length > 0);
  const look = example.contributes as { looks: Array<Record<string, unknown>> };
  const base = look.looks[0]!;
  const { contributions, warnings } = read(
    withContributes({
      looks: [
        { ...base, id: "other.plugin.look" },
        { ...base, id: "taste.extra.bad-move", look: { ...(base.look as object), animation: { in: { module: "move.nope", seconds: 1 } } } },
        { ...base, id: "taste.extra.bad-with", look: { ...(base.look as object), with: [{ look: "text.nope", text: "x" }] } },
        { ...base, id: "taste.extra.ok" },
        { ...base, id: "taste.extra.ok" },
      ],
      components: [
        { id: "taste.extra.script", name: "S", template: "<img src=x onerror=alert(1)>" },
        { id: "taste.extra.script2", name: "S", template: "<script>alert(1)</script>" },
        { id: "taste.extra.css", name: "S", template: "<b>x</b>", css: "</style><script>x</script>" },
        { id: "taste.extra.fine", name: "Fine", template: "<b>{{x}}</b>" },
      ],
      rules: [{ id: "taste.extra.proc", title: "P", rule: { type: "process" } }],
    }),
  );
  assert.deepEqual(contributions.looks.map((l) => l.id), ["taste.extra.ok"]);
  assert.deepEqual(contributions.components.map((c) => c.id), ["taste.extra.fine"]);
  assert.deepEqual(contributions.rules, [], "a process rule needs a process plugin");
  for (const pattern of [/must be the plugin's id, taste.extra, a dot and one name/, /move.nope isn't one of Uncut's moves/, /text.nope, which isn't a built-in look/, /another plugin \(or entry\) has that id/, /script, an event handler/, /plain CSS/, /needs a plugin that runs a program/]) {
    assert.ok(warnings.some((w) => pattern.test(w)), `${pattern} in ${warnings.join(" | ")}`);
  }
  // Built-in ids are refused (a plugin whose id is a built-in namespace can't take one), and the first plugin keeps an id.
  assert.ok(BUILTIN_CONTRIBUTION_IDS.has("text.big-title") && BUILTIN_CONTRIBUTION_IDS.has("text-read-time"));
  const clash = read(withContributes({ looks: [{ ...base, id: "text.big-title" }] }, { id: "text" }));
  assert.match(clash.warnings[0]!, /a built-in has that id/);
  const taken = new Set<string>();
  read(example, taken);
  const second = read(example, taken);
  assert.equal(second.contributions.looks.length + second.contributions.components.length + second.contributions.rules.length, 0);
  assert.equal(second.warnings.length, 4);
});

const textItem = (id: string, text: string, start: number, duration: number) => ({ id, type: "text", text, start, duration, transform: { x: 100, y: 100 }, style: { size: 60 } });
function projectWith(items: Array<Record<string, unknown>>, extra: Array<Record<string, unknown>> = []): Project {
  const p = emptyProject("Rules", { width: 1920, height: 1080, fps: 30 });
  return applyEdit(createSession(p), {
    actor: "user",
    ops: [
      { op: "insert_item", track: p.tracks.find((t) => t.role === "main")!.id, item: { id: "bg", type: "component", component: "component.solid", duration: 300, props: { color: "#111111" } } },
      { op: "add_track", index: 0, track: { id: "t1", kind: "text", name: "Text" } },
      { op: "add_track", index: 0, track: { id: "t2", kind: "text", name: "Text 2" } },
      ...items.map((item, i) => ({ op: "insert_item", track: i % 2 ? "t2" : "t1", item })),
      ...extra,
    ] as never,
  }).project;
}

test("declarative rules: max words on screen, banned phrases, min text size, ends on an end card", () => {
  const rules = pluginCheckRules([
    { id: "p.x.words", title: "Words", description: "", severity: "warn", plugin: "p.x", pluginName: "P", rule: { type: "max-words", max: 6 } },
    { id: "p.x.banned", title: "Banned", description: "", severity: "warn", plugin: "p.x", pluginName: "P", rule: { type: "banned-phrases", phrases: ["game changer", "next level"] } },
    { id: "p.x.size", title: "Size", description: "", severity: "info", plugin: "p.x", pluginName: "P", rule: { type: "min-text-size", px: 80 } },
    { id: "p.x.end", title: "End", description: "", severity: "warn", plugin: "p.x", pluginName: "P", rule: { type: "end-card", seconds: 2 } },
    { id: "p.x.proc", title: "Proc", description: "", severity: "warn", plugin: "p.x", pluginName: "P", rule: { type: "process" } },
  ]);
  assert.deepEqual(rules.map((r) => r.id), ["p.x.words", "p.x.banned", "p.x.size", "p.x.end"], "process rules are the server's");
  const project = projectWith([textItem("a", "This is a Game  Changer", 0, 90), textItem("b", "three more words", 30, 90), textItem("c", "fine", 200, 60)]);
  const found = projectChecks(project, { rules }).filter((c) => c.id.startsWith("p.x."));
  const by = (id: string) => found.filter((c) => c.id === id);
  assert.deepEqual(by("p.x.words").map((c) => c.itemIds), [["a", "b"]], "8 words at b's start, 5 at a's");
  assert.equal(by("p.x.banned").length, 1);
  assert.match(by("p.x.banned")[0]!.message, /says "Game Changer", a phrase P asks to leave out/);
  assert.equal(by("p.x.size").length, 3);
  assert.equal(by("p.x.size")[0]!.severity, "info");
  assert.equal(by("p.x.end").length, 1);
  assert.match(by("p.x.end")[0]!.message, /doesn't end on an end card/);
  // An end card over the last 2 s clears it; a disabled plugin rule finds nothing.
  const ended = projectWith([], [{ op: "add_track", index: 0, track: { id: "ov", kind: "video", name: "Overlay" } }, { op: "insert_item", track: "ov", item: { id: "end", type: "component", component: "component.end-card", start: 240, duration: 60, props: {} } }]);
  assert.equal(projectChecks(ended, { rules }).filter((c) => c.id === "p.x.end").length, 0);
  assert.equal(projectChecks(project, { rules, disabled: ["p.x.end"] }).filter((c) => c.id === "p.x.end").length, 0);
});

test("a text in a plugin's look carries the whole look: same drawing, valid project, with the plugin gone", () => {
  const look = read(example).contributions.looks[0]!;
  const p = emptyProject("Looks", { width: 1920, height: 1080, fps: 30 });
  const plan = planInsertText(p, { look: look.id, start: 0, duration: 90 }, { [look.id]: look });
  assert.ok(!("problem" in plan));
  const project = applyEdit(createSession(p), { actor: "user", ops: plan.ops }).project;
  assert.deepEqual(validateProject(project, modules), [], "valid without the plugin in the module map");
  const item = project.tracks.flatMap((t) => t.items).find((i) => i.id === plan.itemId)!;
  assert.equal(item.id, "soft-card-1");
  assert.equal(item.style?.preset, undefined, "no module reference to break");
  assert.equal(item.style?.font, "DM Sans");
  assert.deepEqual(item.style?.background, { color: "#FFFFFF", opacity: 0.94, padding: 58.5, radius: 29.25, wrap: "box" });
  assert.equal(item.style?.shadow, false);
  assert.equal(item.text, "Soft card");
  assert.equal(item.animation?.in?.module, "move.fade");
  const html = textHtml(item, { canvas: project.canvas, theme: project.theme, textLooks: 1 });
  assert.match(html, /font-family:'DM Sans'/);
  assert.match(html, /background:rgb\(255 255 255 \/ 94%\)|background:rgba\(255, 255, 255, 0.94\)|background:#FFFFFFF0|background:/);
  assert.match(html, /text-align:center/);
  assert.doesNotMatch(html, /text-shadow/);
  // Unknown look ids are still refused without the plugin's looks.
  assert.ok("problem" in planInsertText(p, { look: look.id, start: 0, duration: 90 }));
});

test("a component becomes a graphic file: params escaped, no plugin script, Uncut's render(t, info)", () => {
  const component = read(example).contributions.components[0]!;
  const html = componentGraphicHtml(component);
  assert.ok(GRAPHIC_SRC.test(`graphics/${component.id}.html`));
  assert.equal((html.match(/<script>/g) ?? []).length, 1, "only Uncut's script");
  assert.doesNotMatch(html, /<\/script>[\s\S]*<\/script>/);
  assert.match(html, /window\.render = \(t, info\)/);
  // A template with "</script>" in it stays inside its JSON string.
  const sneaky = componentGraphicHtml({ ...component, template: "<b>{{x}}</b></script><script>alert(1)</script>" });
  assert.equal((sneaky.match(/<\/script>/g) ?? []).length, 1);
  // Run the substitution: props escaped, defaults filled, objects dropped.
  const script = html.slice(html.indexOf("<script>") + 8, html.lastIndexOf("</script>"));
  const root = { innerHTML: "", style: { setProperty: () => {} } };
  const win: Record<string, any> = {};
  new Function("window", "document", script)(win, { getElementById: () => root });
  win.render(0.5, { frame: 15, duration: 90, props: { label: `<img src=x onerror="alert(1)">` } });
  assert.equal(root.innerHTML, `<div class="sticker" style="background: #FFD84D">&lt;img src=x onerror=&quot;alert(1)&quot;&gt;</div>`);
  win.render(0, { frame: 0, duration: 90, props: { label: { toString: () => "x" } } });
  assert.equal(root.innerHTML, `<div class="sticker" style="background: #FFD84D"></div>`);
});

test("review fixes: version can't break out, only Uncut's script, own-property looks, ids owned per plugin id, obfuscated script URLs", () => {
  // The version is anchored in the schema, and nothing plugin-written lands in the comment.
  assert.ok(validateModule({ ...example, version: "1.0.0--><script>alert(1)</script>" }).length > 0);
  assert.deepEqual(validateModule({ ...example, version: "1.2.3-beta.1+build.5" }), []);
  const component = read(example).contributions.components[0]!;
  const html = componentGraphicHtml({ ...component, id: "x--><script>alert(1)</script>" } as typeof component);
  assert.equal((html.match(/<script/g) ?? []).length, 1);
  assert.match(html, /<!-- Uncut component \(plugin component\), copied/);
  assert.doesNotMatch(componentGraphicHtml(component), /0\.1\.0/, "no version in the file");
  // A component that slipped past the checks still can't add a script: drawing it fails.
  assert.throws(() => componentGraphicHtml({ ...component, css: "</style><script>alert(1)</script><style>" }), /can't be drawn safely/);
  // Prototype keys aren't built-in looks.
  const p = emptyProject("Proto", { width: 1920, height: 1080, fps: 30 });
  for (const look of ["constructor", "__proto__", "toString"]) assert.ok("problem" in planInsertText(p, { look, start: 0, duration: 30 }), look);
  const base = (example.contributes as { looks: Array<Record<string, unknown>> }).looks[0]!;
  const proto = read(withContributes({ looks: [{ ...base, look: { ...(base.look as object), with: [{ look: "constructor", text: "x" }] } }] }));
  assert.equal(proto.contributions.looks.length, 0);
  assert.match(proto.warnings[0]!, /constructor, which isn't a built-in look/);
  // One name after the plugin's id: a shorter-id plugin can't take a longer one's names.
  const squat = read(withContributes({ looks: [{ ...base, id: "taste.extra.more.soft-card" }] }));
  assert.equal(squat.contributions.looks.length, 0);
  assert.match(squat.warnings[0]!, /the plugin's id, taste\.extra, a dot and one name/);
  // Across plugins only what's merged (the allowed ones) claims an id; the first keeps it.
  const a = read(example).contributions;
  const merged = mergeContributions([a, { ...a, looks: a.looks.map((l) => ({ ...l, name: "Copy" })) }]);
  assert.deepEqual(merged.looks.map((l) => l.name), ["Soft card"]);
  assert.equal(merged.rules.length, 2);
  // Script URLs however they're spelled, and more embedding tags.
  for (const template of [
    `<a href="jav&#x61;script:alert(1)">x</a>`,
    `<a href="jav&#97;script&colon;alert(1)">x</a>`,
    `<a href="java\tscript:alert(1)">x</a>`,
    `<a href=" JaVaScRiPt :alert(1)">x</a>`,
    `<a href="data:text/html,hi">x</a>`,
    `<form action="x"></form>`,
    `<frameset></frameset>`,
    `<portal src="x"></portal>`,
  ]) assert.ok(componentProblem(template, ""), template);
  assert.ok(componentProblem("<b>x</b>", "a{background:url(javascript:alert(1))}"));
  assert.equal(componentProblem(`<div class="sticker">{{label}} costs 5 &amp; more: see docs</div>`, ".a{color:red}"), undefined);
});
