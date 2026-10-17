// D292: the bundled skill motion-film. It ships in plugins/uncut-skills like Uncut's other skills
// (so /motion-film calls it and the system prompt lists it for the agent to pick), it has the
// sections its siblings have and a review checklist the critic reads (on the beat, pops, holds, the
// loop seam, camera moves, shape-grow entries, no near-empty frames), every uncutMotion function it
// names exists in uncut:lib/motion.js, a one-take brief suggests it, and it makes the critic's
// motion score required.
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
  for (const word of ["beat_grid", "drop", "storyboard_propose", "still", "approval", "render(t)", "pure function of t", "uncut:lib/motion.js", "docs_read graphics", "1080 x 1350 at 60 fps", "motion blur", "-14 LUFS", "by its peak", "overscale", "0.4 s", "mask", "cursor", "uncut.frame(", "hero shape", "rounded rect or pill", "rises out of a mask line", "last frame equals frame 0", "crossfades", "blur-ins", "Holds over 1 s", "particles", "glows", "gradients on UI chrome", "Bouncy easing"]) assert.ok(body.toLowerCase().includes(word.toLowerCase()), word);
  // D295: no opening question, defaults instead; tempo from beat_grid, never rounded.
  assert.ok(!/^- Ask on one ask_user card/m.test(body), "no opening question");
  assert.match(body, /don't ask/);
  assert.match(body, /ask_user only when something essential is missing/);
  assert.match(body, /never a rounded "about 120 BPM"/);
  // D296: UI first is the main path for a product film (showcase the program); footage first is the short second.
  assert.match(body, /^Pick the path from the brief and the media\n- UI first, the main path for a product or launch film: showcase the program[\s\S]*\n- Footage first, only when/m);
  // A film about Uncut itself builds from its real UI's parts (uncut:lib/ui.js), never a redrawn panel.
  assert.match(body, /never an invented panel: Uncut itself from uncutUI parts \(uncut:lib\/ui\.js\)/);
  // D296: scale and boldness, measurable; kits first; one item; the lock.
  assert.match(body, /^Scale \(both paths\)\n/m);
  for (const want of [/70 % of its area or more, edges within about 6 %/, /full-bleed again and again/, /9 % of the frame's height or more/, /Never a card on flat black with a small caption under it/, /Every transition morphs the outgoing hero/, /never a fade, wipe or headline roll-up/, /^Pace \(measured on the films that worked\)\n- Something on nearly every beat, one big change per bar/m, /Moves at normal speed, about 0\.8 s, settling softly; one main move at a time, the next may start as it settles/, /A change reads in half a beat to a beat, then the next; never 2 s of one state/, /Defaults, not a script/, /The end card lasts about 1\.5 s and springs back into frame 0/, /Never search the disk or the web for the product; no kit matches: ask_user once/, /ONE item spanning it/, /propose last: while it waits nothing can change/, /In a UI film footage stays inside UI, also after the drop/, /The preview stays inset until the drop, flooding on its frame/, /never zooms in until it goes soft/]) assert.match(body, want);
  // Round 2 craft: a camera move in every scene, never the whole editor; shots grow out of shapes (no
  // cut, slice or tile); no near-empty frame; footage at its drawn size; on the kick; a big hook.
  for (const want of [/Every scene gets a move/, /a wide shot only as a brief pull-back/, /uncutMotion\.grow\b/, /slice wipes, split-tile or pixelated transitions/, /No near-empty frame, not even 0\.2 s/, /uncutMotion\.frameWidth\(drawn width, camera zoom\)/, /start on the kick's frame/, /where beat 0 really falls/, /Frame 0 is one huge headline/]) assert.match(body, want);
  // Blind round 3 (the references): one hero carried through every scene (cards under new headlines read
  // as slides), frame 0 moving by 0.5 s, every change caused, phone-legible UI lines, few words, holds that drift.
  assert.match(body, /^The hero \(both paths\)\n- One hero shape, a rounded rect or pill \(uncutMotion\.shape\), never leaves the frame/m);
  for (const want of [/A new card under a new headline is a slide/, /lands by about 0\.5 s/, /Every change has a visible cause: a drawn cursor's click, drag or keystroke/, /4\.5 % of the height or more/, /1 to 3 words/, /most scenes need none/, /holds drift \(uncutMotion\.camera's drift/, /uncutMotion\.click\) lands, rests 0\.1 s, visibly presses the button, and its change starts at fire/, /never on arrival/]) assert.match(body, want);
  for (const re of [/One hero carried through every scene/, /moves by 0\.5 s/, /visible cause \(a click rests, then presses\)/, /footage stays inside UI/]) assert.ok(skillChecklist(body).some((l) => re.test(l)), String(re));
  for (const re of [/near-empty/, /moving in every scene/, /grows out of a shape/, /on the kick/, /huge headline/]) assert.ok(skillChecklist(body).some((l) => re.test(l)), String(re));
  // Round 5: the UI as large pieces morphing into each other (uncutUI.sequence), never a screen-recording pan; Uncut's real flow as the default story.
  for (const want of [/^- Every key moment reads on a phone, words 4\.5 % of the height or more: push in on the stage, or pieces/m, /60 to 90 % of the width/, /uncutUI\.sequence morphs each into the next/, /Never pan over a desktop-sized panel/, /About Uncut, when the message gives no story of its own, by default tell its real flow/, /Send flies the prompt into its bubble as the program comes into focus, a step already ticking \(never an empty panel or a dark gap\); the agent's steps; clips fly to the timeline, push in till their names read; Warm applied, seen on the preview; Export, Saved/]) assert.match(body, want);
  assert.ok(skillChecklist(body).some((l) => /large pieces/.test(l)), "pieces in the checklist");
  // Round 6 named the live stage; round 7 followed it yet dropped beats and read slow and small, while the
  // liked films (A1r6's pieces, A2's own rebuild) were free in form: the stage is the easiest, not the only way.
  assert.match(body, /Easiest: the live editor stage \(uncutUI\.mount "editor", the graphics example\); pieces or your own rebuild work too/);
  // Honesty upfront (the build reads it before the critic does): run facts real, a review card "Reviewing" until it passes.
  assert.match(body, /On-screen run facts are real results only; a review reads "Reviewing" until it passes/);
  assert.ok(skillChecklist(body).some((l) => /about this run are true, else none/.test(l)), "honest run facts in the checklist");
  for (const re of [/70 %/, /9 %/, /caption under a card/]) assert.ok(skillChecklist(body).some((l) => re.test(l)), String(re));
  const checklist = skillChecklist(body);
  assert.ok(checklist.length >= 8 && checklist.length <= 12, `${checklist.length} lines`);
  for (const re of [/something on nearly every beat, normal-speed moves, on the kick, each change read in about a beat/, /pop/, /1 s/, /frame 0 and the last frame match/, /overscales/]) assert.ok(checklist.some((l) => re.test(l)), String(re));
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
