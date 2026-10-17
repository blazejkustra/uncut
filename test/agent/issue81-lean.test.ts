// Issue #81 (D260): a lean agent context, without a claude.
// - The system prompt is a tight core (under 8k chars); each area's reference is docs_read {topic}.
// - No decision ids (D76…) in anything the model reads: prompt, docs, tool descriptions.
// - <brand>/<plan> whole only when they changed since the session last saw them (or every
//   RESEND_EVERY messages); unchanged ones are a line each.
// - The manual-edits note is capped; project_read gives a long project's items as compact lines,
//   every field on request (detail "items", items [ids]).
import { test } from "node:test";
import assert from "node:assert/strict";

import { DOC_TOPICS, DOCS, docsRead, LOOK_TOOLS, mcpTools, projectSummary, stepLabel, doingLabel, SYSTEM_PROMPT, withoutDecisionIds, COMPACT_ITEMS } from "../../apps/server/src/agent/agentTools.ts";
import { leanPlanBlock, RESEND_EVERY } from "../../apps/server/src/agent/session/send.ts";
import { capNote, NOTE_LINES } from "../../apps/server/src/agent/turns/notes.ts";
import toolsSpec from "../../spec/agent/tools.json" with { type: "json" };
import { AGENT_TEXT } from "../helpers/agentText.ts";

test("#81: the system prompt is a tight core and says where the rest is", () => {
  assert.ok(SYSTEM_PROMPT.length < 8000, `the prompt is ${SYSTEM_PROMPT.length} chars`);
  for (const t of DOC_TOPICS) assert.ok(SYSTEM_PROMPT.includes(t), `the prompt names the ${t} topic`);
  assert.match(SYSTEM_PROMPT, /docs_read \{topic\}/);
  // Hard rules stay in the core.
  assert.match(SYSTEM_PROMPT, /Never invent facts/);
  assert.match(SYSTEM_PROMPT, /never draw a placeholder screen/);
  assert.match(SYSTEM_PROMPT, /words ÷ 3 s/);
  // A1/A2: the agent called bare graphic_write / timeline_edit ("No such tool available"); the full name is the rule.
  assert.match(SYSTEM_PROMPT, /always call the full name \(mcp__uncut__graphic_write, never graphic_write/);
  // The reference blocks moved out.
  assert.doesNotMatch(SYSTEM_PROMPT, /audio\.compressor|transition\.iris|component\.end-card|uncut:lib\/three/);
});

test("#81: docs_read gives each topic, and its tool lists the same topics", () => {
  for (const t of DOC_TOPICS) {
    const out = docsRead(t);
    assert.equal(out.isError, false);
    assert.ok(out.text.length > 500, t);
    assert.equal(out.text, DOCS[t].body);
  }
  const bad = docsRead("mixer");
  assert.equal(bad.isError, true);
  for (const t of DOC_TOPICS) assert.ok(bad.text.includes(t));
  const tool = mcpTools().find((t) => t.name === "docs_read")!;
  assert.deepEqual((tool.inputSchema as any).properties.topic.enum, [...DOC_TOPICS]);
  assert.deepEqual((toolsSpec.tools.find((t) => t.name === "docs_read")!.inputSchema as any).properties.topic.enum, [...DOC_TOPICS]);
  assert.ok((LOOK_TOOLS as ReadonlyArray<string>).includes("docs_read"), "Look only may read the docs");
  assert.equal(stepLabel("docs_read", { topic: "sound" }), "Read the sound reference");
  assert.equal(doingLabel("docs_read", { topic: "sound" }), "Reading the sound reference");
});

test("#81: no decision ids in anything the model reads", () => {
  assert.doesNotMatch(AGENT_TEXT, /\bD\d{2,3}\b/);
  assert.equal(withoutDecisionIds("Captions (D82): a card"), "Captions: a card");
  assert.equal(withoutDecisionIds("effects: the chain (D84–D88: audio.eq, x)"), "effects: the chain (audio.eq, x)");
  assert.equal(withoutDecisionIds("a microphone; D215: a media"), "a microphone: a media");
  assert.equal(withoutDecisionIds("a target, D87: -14 Normal"), "a target: -14 Normal");
  assert.equal(withoutDecisionIds("{bypass: true} skips it). D83."), "{bypass: true} skips it).");
  assert.equal(withoutDecisionIds("sounds (designed and meme sounds, D208)"), "sounds (designed and meme sounds)");
  assert.equal(withoutDecisionIds("D215: cut this item"), "Cut this item");
});

test("D274: library_search no longer offers jamendo; music_list and music_add are gone", () => {
  const tool = mcpTools().find((t) => t.name === "library_search")!;
  assert.ok(!(tool.inputSchema as any).properties.source.enum.includes("jamendo"));
  for (const gone of ["music_list", "music_add"]) assert.ok(!mcpTools().some((t) => t.name === gone), gone);
});

test("#81: <brand> and <plan> whole only when they changed; unchanged ones are a line each", () => {
  const brand = "<brand>\nKit \"Acme\" (acme, the user's)\nColours: #000000 background\n</brand>";
  const plan = "<plan>\nBrief:\n film: a teaser\n</plan>";
  const full = `${brand}\n\n${plan}`;
  // A new session: everything.
  const first = leanPlanBlock(full, undefined);
  assert.equal(first.text, full);
  // Nothing changed: two short lines, each in its own tag.
  const same = leanPlanBlock(full, first.sent);
  assert.match(same.text, /^<brand>\nUnchanged since your last message[^\n]*\n<\/brand>\n\n<plan>\nUnchanged since your last message[^\n]*\n<\/plan>$/);
  assert.ok(same.text.length < 250);
  // The kit changed, the plan didn't: the kit whole, the plan a line.
  const brand2 = brand.replace("#000000", "#111111");
  const kitChanged = leanPlanBlock(`${brand2}\n\n${plan}`, same.sent);
  assert.ok(kitChanged.text.startsWith(brand2));
  assert.equal((kitChanged.text.match(/<brand>/g) ?? []).length, 1, "one <brand> tag");
  assert.match(kitChanged.text, /<plan>\nUnchanged since your last message/);
  // The plan changed, the kit didn't.
  const plan2 = plan.replace("a teaser", "a launch film");
  const planChanged = leanPlanBlock(`${brand2}\n\n${plan2}`, kitChanged.sent);
  assert.match(planChanged.text, /^<brand>\nUnchanged since your last message/);
  assert.ok(planChanged.text.endsWith(plan2));
  // The plan went away: said so.
  const gone = leanPlanBlock(brand2, planChanged.sent);
  assert.match(gone.text, /<plan>\nThe brief, storyboard and reviews are gone/);
  // No plan before or now: no plan line at all.
  const noPlan = leanPlanBlock(brand2, gone.sent);
  assert.doesNotMatch(noPlan.text, /<plan>/);
  // Unchanged for RESEND_EVERY messages: sent whole again (a compacted conversation gets it back).
  let last = leanPlanBlock(full, undefined).sent;
  const texts: Array<string> = [];
  for (let i = 0; i < RESEND_EVERY; i++) {
    const out = leanPlanBlock(full, last);
    texts.push(out.text);
    last = out.sent;
  }
  assert.equal(texts.filter((t) => t === full).length, 1, "once in RESEND_EVERY messages");
  assert.equal(texts.at(-1), full);
});

test("#81: the manual-edits note is capped", () => {
  const lines = Array.from({ length: NOTE_LINES + 5 }, (_, i) => `- Moved clip-${i}`);
  const note = ["The user made 35 edits by hand since your last turn (now at revision 9).", "They are intentional.", ...lines].join("\n");
  const out = capNote(note);
  assert.equal(out.split("\n").filter((l) => l.startsWith("- Moved")).length, NOTE_LINES);
  assert.match(out, /- and 5 more edits \(project_read shows the project as it is now\)$/);
  assert.match(out, /^The user made 35 edits/);
  assert.equal(capNote("- one"), "- one");
  assert.equal(capNote(""), "");
});

test("#81: project_read gives a long project's items as compact lines, every field on request", () => {
  const project: any = { format: "uncut/0", name: "P", canvas: { width: 1920, height: 1080, fps: 30 }, textLooks: 1, media: [{ id: "m-a", kind: "video", name: "A.MP4", path: "/x/A.MP4", probe: { frames: 9000, fps: 30, width: 1920, height: 1080, hasAudio: true } }], tracks: [{ id: "text", kind: "text", name: "Text", items: [] }, { id: "main", kind: "video", role: "main", name: "Main", items: [] }] };
  const small = structuredClone(project);
  small.tracks[0].items.push({ id: "title-1", type: "text", start: 0, duration: 90, text: "Hello", transform: { x: 100, y: 100 }, style: { preset: "text.title", size: 120, weight: 700 } });
  const s = projectSummary(small, 3) as any;
  assert.equal(s.tracks[0].items[0].style.size, 120, "a small project: every field, as before");
  assert.equal(s.itemsNote, undefined);
  const big = structuredClone(project);
  for (let i = 0; i < COMPACT_ITEMS + 1; i++) big.tracks[1].items.push({ id: `clip-${i}`, type: "clip", media: "m-a", in: i * 10, duration: 60, transform: { x: 0, y: 0, w: 960, h: 540, fit: "cover" }, ...(i ? { transitionIn: { module: "transition.crossfade", duration: 10 } } : {}) });
  big.tracks[0].items.push({ id: "title-1", type: "text", start: 30, duration: 90, text: "A very long title ".repeat(10), style: { preset: "text.title", size: 120 } });
  const c = projectSummary(big, 4) as any;
  const clip = c.tracks[1].items[1];
  assert.deepEqual(clip, { id: "clip-1", type: "clip", start: 60, duration: 60, in: 10, media: "m-a", mediaName: "A.MP4", transitionIn: "transition.crossfade 10" });
  assert.equal(c.tracks[0].items[0].style, undefined);
  assert.ok(c.tracks[0].items[0].text.length <= 80);
  assert.match(c.itemsNote, /32 items, listed compactly[^]*detail "items"/);
  assert.equal(c.revision, 4);
  // Every field: detail "items", or a list of ids, or a range.
  const all = projectSummary(big, 4, undefined, { detail: "items" }) as any;
  assert.deepEqual(all.tracks[1].items[1].transform, { x: 0, y: 0, w: 960, h: 540, fit: "cover" });
  const some = projectSummary(big, 4, undefined, { items: ["title-1", "nope"] }) as any;
  assert.deepEqual(some.tracks.map((t: any) => t.items.map((i: any) => i.id)), [["title-1"], []]);
  assert.equal(some.tracks[0].items[0].style.size, 120);
  assert.match(some.itemsNote, /not found: nope/);
  const ranged = projectSummary(big, 4, { start: 0, end: 120 }) as any;
  assert.ok(ranged.tracks[1].items.every((i: any) => i.transform), "a range gives every field");
  // Compact JSON is what the agent gets (no indentation).
  assert.ok(JSON.stringify(c).length < JSON.stringify(all).length * 0.75);
});

test("docs_read graphics carries the bundled libraries' own API (their headers), so the agent never searches the disk for them", async () => {
  const { loadGraphicLibs } = await import("../../apps/server/src/export/graphicLibs.ts");
  const { libraryHeader } = await import("../../apps/server/src/agent/agentDocs.ts");
  const libs = await loadGraphicLibs("assets/graphic-libs");
  const out = docsRead("graphics", libs);
  assert.equal(out.isError, false);
  assert.ok(out.text.startsWith(DOCS.graphics.body));
  // Every library's header, word for word (the library file is the one source of its API).
  for (const name of ["motion.js", "spring.js", "random.js", "confetti.js", "globe.js", "ui.js"]) {
    const header = libraryHeader(libs[name]!);
    assert.ok(header && out.text.includes(header), name);
  }
  assert.match(out.text, /uncutMotion\.shape\(/);
  assert.match(out.text, /uncutMotion\.riseText\(ctx, text, x, baseline, t, o\)/, "signatures from the code");
  // Every function uncutMotion has is listed, even one its header doesn't mention yet.
  const api = /window\.uncutMotion = \{([\s\S]*?)\n  \};/.exec(libs["motion.js"]!)![1]!;
  for (const [, key] of api.matchAll(/^    ([A-Za-z]\w*): (?!\{)/gm)) assert.ok(out.text.includes(`uncutMotion.${key}`), key);
  assert.match(out.text, /uncutMotion\.ease\.inOut\(p\)/);
  assert.match(out.text, /uncutGlobe\.project\(ctx, t, lat, lon, options\)/);
  assert.match(out.text, /uncutUI\.mount\(host, name, props\)/, "the UI parts' API too");
  assert.ok(!out.text.includes("var DATA"), "ui.js's captured markup isn't pasted");
  assert.ok(!out.text.includes("Ec.exports"), "three.js's code isn't pasted");
  assert.equal(docsRead("sound", libs).text, DOCS.sound.body, "other topics unchanged");
  assert.match(SYSTEM_PROMPT, /never search the disk/);
});
