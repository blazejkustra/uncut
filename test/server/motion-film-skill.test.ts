// D292: the bundled skill motion-film. It ships in plugins/uncut-skills like Uncut's other skills
// (so /motion-film calls it and the system prompt lists it for the agent to pick), it has the
// sections its siblings have and a review checklist the critic reads (on the beat, pops, holds, the
// loop seam), every uncutMotion function it names exists in uncut:lib/motion.js, a one-take brief
// suggests it, and it makes the critic's motion score required.
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

test("its instructions: defaults not questions, beat map with numbered stills as the storyboard, footage and UI paths, the techniques, the banned list, the gotchas, a checklist the critic can check", () => {
  const body = bundledSkill("motion-film").instructions;
  for (const head of ["Start", "Build", "Export and sound", "Banned", "Gotchas", "Review checklist"]) assert.match(body, new RegExp(`^${head}`, "m"), head);
  for (const word of ["beat_grid", "drop", "storyboard_propose", "still", "approval", "render(t)", "pure function of t", "uncut:lib/motion.js", "docs_read graphics", "1080 x 1350 at 60 fps", "motion blur", "-14 LUFS", "by its peak", "overscale", "0.3 s", "mask", "cursor", "uncut.frame(", "hero shape", "rounded rect or pill", "rises out of a mask line", "last frame equals frame 0", "crossfades", "blur-ins", "Holds over 1 s", "particles", "glows", "gradients on UI chrome", "Bouncy easing"]) assert.ok(body.toLowerCase().includes(word.toLowerCase()), word);
  // D295: no opening question, defaults instead; tempo from beat_grid, never rounded.
  assert.ok(!/^- Ask on one ask_user card/m.test(body), "no opening question");
  assert.match(body, /don't ask/);
  assert.match(body, /ask_user only when something essential is missing/);
  assert.match(body, /never a rounded "about 120 BPM"/);
  assert.match(body, /^Pick the path from the brief and the media\n- Footage first[\s\S]*\n- UI first/m);
  const checklist = skillChecklist(body);
  assert.ok(checklist.length >= 8 && checklist.length <= 12, `${checklist.length} lines`);
  for (const re of [/every beat/, /pop/, /1 s/, /frame 0 and the last frame match/, /overscales/]) assert.ok(checklist.some((l) => re.test(l)), String(re));
  // No dots, bullets or stars between words in what the agent copies onto the screen.
  assert.doesNotMatch(body, /[·•]|\w \* \w/);
  // Every uncutMotion function it names is in the library.
  const window: Record<string, unknown> = {};
  runInNewContext(readFileSync(resolve("assets/graphic-libs/motion.js"), "utf8"), { window });
  const lib = window.uncutMotion as Record<string, unknown>;
  const named = [...new Set([...body.matchAll(/uncutMotion\.(\w+)/g)].map((m) => m[1]!))];
  assert.ok(named.length >= 7, named.join(", "));
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
