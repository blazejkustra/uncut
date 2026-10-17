// D292: the bundled skill motion-film. It ships in plugins/uncut-skills like Uncut's other skills
// (so /motion-film calls it and the system prompt lists it for the agent to pick), it has a review
// checklist the critic reads, every uncutMotion function it names exists in uncut:lib/motion.js, a
// one-take brief suggests it, and it makes the critic's motion score required.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";

import { sessionArgs } from "../../apps/server/src/agent/agent.ts";
import { calledSkills } from "../../apps/server/src/agent/agentPlan.ts";
import { BUILTIN_IDS, reviewRubric, skillChecklist, suggestSkills } from "../../packages/core/src/skills/skills.ts";
import { bundledSkill, bundledSkills } from "../helpers/skills.ts";

test("motion-film is one of Uncut's own skills, callable with /motion-film and listed for the agent", () => {
  assert.equal(BUILTIN_IDS.film, "motion-film");
  const skill = bundledSkill("motion-film");
  assert.ok(skill, "bundled");
  assert.equal(bundledSkills().at(-1)!.name, "motion-film", "listed after the others, in BUILTIN_IDS order");
  assert.deepEqual(calledSkills("make it /motion-film style, then /sound-design", bundledSkills().map((x) => x.name)), ["motion-film", "sound-design"]);
  const argv = sessionArgs({ cfg: "/tmp/m.json", skills: bundledSkills() });
  assert.ok(argv[argv.indexOf("--append-system-prompt") + 1]!.includes(`- motion-film: ${skill.description}`));
});

// The ablations (A1/A2 without the skill were the favourites; with it, no better and often worse) cut
// it to what held up: the user's direction first, honest run facts, the defects the critic measures
// stated as facts, the kit's files never redrawn, pointers to the toolkit and to Templates (#111). No
// creative direction: no story, pacing, hero shape, headline sizes, canvas colours or sound profile.
test("its instructions: direction first, honesty, measured defects as facts, the toolkit; no creative rules", () => {
  const body = bundledSkill("motion-film").instructions;
  assert.ok(body.length <= 2600, `${body.length} characters`);
  for (const head of ["The user's direction comes first", "Honesty", "Defects Uncut measures", "Toolkit", "Review checklist"]) assert.match(body, new RegExp(`^${head}`, "m"), head);
  assert.match(body, /a review reads "Reviewing" until one passes; no invented counts, scores/);
  for (const want of [/Hard cuts/, /quick swap/, /Single-frame pops/, /2 to 3 frame flashes/, /Near-empty or low-information frames/, /Text cut at the frame's edge/, /illegible at phone size \(360 px wide\)/, /facts about the render, not taste/]) assert.match(body, want);
  assert.match(body, /logos and Claude mark go in as their files \(brand_read\), never redrawn/);
  assert.match(body, /Template \(#111/);
  for (const want of ["uncut:lib/ui.js", "uncutUI.mount", "uncutUI.sequence", "uncutUI.fly", "uncutMotion.click", "uncutMotion.camera", "uncutMotion.grow", "uncutMotion.frameRect", "safe and keep", "docs_read graphics"]) assert.ok(body.includes(want), want);
  // The removed creative direction stays out.
  for (const gone of [/hero shape/i, /one hero/i, /storyboard_propose/, /About Uncut/, /headline/i, /end card/i, /flat black/i, /LUFS/, /Pace/, /Banned/, /seamless loop/i, /last frame equals frame 0/i]) assert.doesNotMatch(body, gone);
  const checklist = skillChecklist(body);
  assert.ok(checklist.length >= 4 && checklist.length <= 12, `${checklist.length} lines`);
  for (const re of [/message is followed/, /about this run are true, else none/, /hard cut/, /pop/, /near-empty or low-information/, /cut at the frame's edge/, /kit's files/]) assert.ok(checklist.some((l) => re.test(l)), String(re));
  assert.doesNotMatch(body, /[·•]|\w \* \w/);
  // Every uncutMotion function it names is in the library.
  const window: Record<string, unknown> = {};
  runInNewContext(readFileSync(resolve("assets/graphic-libs/motion.js"), "utf8"), { window });
  const lib = window.uncutMotion as Record<string, unknown>;
  const named = [...new Set([...body.matchAll(/uncutMotion\.(\w+)/g)].map((m) => m[1]!))];
  assert.ok(named.length >= 4, named.join(", "));
  for (const n of named) assert.equal(typeof lib[n], "function", n);
});

test("a one-take brief suggests it; it makes motion required in the critic's rubric", () => {
  assert.ok(suggestSkills({ film: "Our launch film: one take, never cut, a single shape morphing on the beat", type: "launch-promo" }).includes("motion-film"));
  assert.ok(suggestSkills({ film: "A seamless loop of UI states", type: "social" }).includes("motion-film"));
  assert.ok(!suggestSkills({ film: "A product demo of the export panel", type: "product-demo" }).includes("motion-film"), "not for any film");
  const brief = { film: "x", type: "talk" };
  assert.equal(reviewRubric(brief).levels.motion, "na");
  assert.equal(reviewRubric(brief, { skills: ["motion-film"] }).levels.motion, "required");
});
