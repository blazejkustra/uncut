// Issue #111: templates. The file format reads and writes back; placeholders fill from the project's
// facts, deterministically, with fallbacks and honest notes for what's missing; the built-ins parse,
// use only known placeholders and name no product; the composer's / menu lists skills then a
// Templates group; a filled brief goes into the draft on its own lines.
import { test } from "node:test";
import assert from "node:assert/strict";

import { aspectOf, fillTemplate, formatTemplate, insertBrief, parseTemplate, sayDuration, TEMPLATE_KEYS, TEMPLATE_MISSING, TEMPLATE_SYNTAX, templateId, templatePlaceholders, templateValues, type TemplateFacts } from "../../packages/core/src/templates/templates.ts";
import { BUILTIN_TEMPLATES } from "../../packages/core/src/templates/builtin.ts";
import { slashItems } from "../../apps/web/src/panels/composer/slash.ts";

test("a template file: front matter name and description, the body after; formatTemplate reads back the same", () => {
  const t = parseTemplate("---\nname: My reel\ndescription: \"Fast cuts.\"\n---\n\nCut {{footage}} to {{music}}.\n", "my-reel");
  assert.deepEqual(t, { id: "my-reel", name: "My reel", description: "Fast cuts.", body: "Cut {{footage}} to {{music}}.\n" });
  assert.deepEqual(parseTemplate(formatTemplate(t), "my-reel"), t);
  // Windows line ends and a BOM; no front matter: the id is the name, the whole text the body.
  assert.equal(parseTemplate("﻿---\r\nname: X\r\n---\r\nBody", "x").body, "Body");
  assert.deepEqual(parseTemplate("Just a brief.", "plain"), { id: "plain", name: "plain", description: "", body: "Just a brief." });
  // A multi-line name or description is kept on one line.
  assert.match(formatTemplate({ name: "A\nB", description: "c\n d", body: "x" }), /^---\nname: A B\ndescription: c d\n---\n\nx\n$/);
});

test("templateId: a slug of the name, free of the taken ids", () => {
  assert.equal(templateId("Beat-cut reel copy", []), "beat-cut-reel-copy");
  assert.equal(templateId("Beat-cut reel copy", ["beat-cut-reel-copy"]), "beat-cut-reel-copy-2");
  assert.equal(templateId("Café ☕", []), "cafe");
  assert.equal(templateId("!!!", []), "template");
});

const facts: TemplateFacts = {
  project: "Spring launch",
  media: [
    { name: "hero.mov", kind: "video", seconds: 12.5, fps: 50, width: 3840, height: 2160, hasAudio: false },
    { name: "ui.png", kind: "image", width: 1200, height: 800 },
    { name: "song.mp3", kind: "audio", seconds: 28 },
  ],
  canvas: { width: 1080, height: 1350, fps: 60 },
  length: { seconds: 28, from: "song" },
  kit: { name: "Acme", logos: ["acme-light.svg"], fonts: ["Inter (Inter.woff2)"], files: ["ui-shot.webp"], colors: [{ hex: "#0a0a0a", role: "background" }, { hex: "#6d8cff", role: "accent", name: "Blue" }], about: "Acme makes rockets.", tone: "Plain." },
  music: { name: "song.mp3", seconds: 28, bpm: 121.84, confidence: 0.8, beatCount: 56, beatSpan: 28, drop: { seconds: 14.21, beat: 28 } },
};

test("placeholders fill from the project's facts, deterministically", () => {
  const v = templateValues(facts);
  assert.equal(v.project, "Spring launch");
  assert.equal(v.media, "- hero.mov: video, 12.5 s, 50 fps, 3840 x 2160, no sound\n- ui.png: image, 1200 x 800\n- song.mp3: audio, 28 s");
  assert.equal(v.footage, "- hero.mov: video, 12.5 s, 50 fps, 3840 x 2160, no sound\n- ui.png: image, 1200 x 800");
  assert.equal(v.canvas, "1080 x 1350 (4:5), 60 fps");
  assert.equal(v.length, "28 s");
  assert.equal(v.tempo, "121.8 BPM");
  assert.equal(v.beats, "56 beats in 28 s");
  assert.equal(v.drop, "0:14.2 into the song (beat 29)");
  assert.equal(v.music, "song.mp3, 28 s, 121.8 BPM, drop at 0:14.2");
  assert.equal(v.kit, ['"Acme" brand kit', "- Logos (use these files, never redraw them): acme-light.svg", "- Fonts: Inter (Inter.woff2)", "- Colours: #0a0a0a background, #6d8cff Blue (accent)", "- Other files: ui-shot.webp", "- About: Acme makes rockets.", "- Tone: Plain."].join("\n"));
  assert.deepEqual(templateValues(facts), v);
  const { text, missing } = fillTemplate("Make {{length}} at {{canvas}} for {{project}}.", v);
  assert.equal(text, "Make 28 s at 1080 x 1350 (4:5), 60 fps for Spring launch.");
  assert.deepEqual(missing, []);
});

test("what the project doesn't have: the fallback, else an honest note; never a guessed tempo", () => {
  const bare: TemplateFacts = { media: [{ name: "song.mp3", kind: "audio", seconds: 30 }], music: { name: "song.mp3", seconds: 30 } };
  const v = templateValues(bare);
  assert.equal(v.tempo, undefined);
  assert.equal(v.music, "song.mp3, 30 s");
  const { text, missing } = fillTemplate("{{tempo}} | {{drop|the loudest moment}} | {{kit}} | {{canvas}}", v);
  assert.equal(text, `${TEMPLATE_MISSING.tempo} | the loudest moment | ${TEMPLATE_MISSING.kit} | ${TEMPLATE_MISSING.canvas}`);
  assert.deepEqual(missing, ["tempo", "drop", "kit", "canvas"]);
  // Analysed with no steady beat: said so, no tempo.
  const speech = templateValues({ media: [], music: { name: "talk.wav", seconds: 40, bpm: null } });
  assert.equal(speech.music, "talk.wav, 40 s, no steady beat found");
  assert.equal(speech.tempo, undefined);
  // An empty project: every known placeholder has a note.
  assert.deepEqual(Object.keys(TEMPLATE_MISSING).sort(), Object.keys(TEMPLATE_KEYS).sort());
});

test("unknown placeholders stay as written; \\{{ is a literal; spaces inside braces are fine", () => {
  const { text, missing } = fillTemplate("{{ project }} {{nope}} \\{{project}} {{Project}}", { project: "P" });
  assert.equal(text, "P {{nope}} {{project}} {{Project}}");
  assert.deepEqual(missing, []);
  assert.deepEqual(templatePlaceholders("{{kit}} {{media}} {{kit|x}} {{other}}"), ["kit", "media"]);
  for (const k of Object.keys(TEMPLATE_KEYS)) assert.ok(TEMPLATE_SYNTAX.includes(`{{${k}}}`), k);
});

test("small formatters", () => {
  assert.equal(sayDuration(8.46), "8.5 s");
  assert.equal(sayDuration(65), "1:05");
  assert.equal(aspectOf(1920, 1080), "16:9");
  assert.equal(aspectOf(1080, 1920), "9:16");
  assert.equal(aspectOf(1080, 1080), "1:1");
});

test("the four built-ins: parse, are read-only, use known placeholders with inputs, name no product, invent nothing", () => {
  assert.deepEqual(
    BUILTIN_TEMPLATES.map((t) => [t.id, t.name]),
    [
      ["keynote-one-take", "Keynote one take"],
      ["one-shape-never-cut", "One shape, never cut"],
      ["beat-cut-reel", "Beat-cut reel"],
      ["talking-head-subtitles", "Talking head with subtitles"],
    ],
  );
  for (const t of BUILTIN_TEMPLATES) {
    assert.equal(t.builtin, true);
    assert.ok(t.description.length > 20, t.id);
    for (const section of ["<inputs>", "<direction>", "<structure>", "<build>", "<gotchas>", "<start>"]) assert.ok(t.body.includes(section), `${t.id} ${section}`);
    const used = [...t.body.matchAll(/\{\{\s*([a-z][a-z0-9-]*)/g)].map((m) => m[1]!);
    assert.ok(used.length >= 4, t.id);
    for (const u of used) assert.ok(u in TEMPLATE_KEYS, `${t.id} uses {{${u}}}`);
    assert.ok(t.body.includes("{{canvas}}") && t.body.includes("{{project}}"), t.id);
    assert.match(t.body, /don't invent/i, t.id);
    // General: no product named, no third-party prompt's wording, no "/" that would call a skill.
    assert.doesNotMatch(t.body, /\buncut\b|apple|keynote one take/i, t.id);
    assert.doesNotMatch(t.body, /(?:^|\s)\/[a-z]/, t.id);
    // Uncut's on-screen rule: no dots or asterisks between words.
    assert.doesNotMatch(t.body, /\w · \w|\w \* \w/, t.id);
  }
  // The keynote shows the model picker with the kit's Claude mark when the kit has it, pasted in, never redrawn.
  assert.match(BUILTIN_TEMPLATES[0]!.body, /claude-mark\.svg[^\n]*model picker|model picker[^\n]*claude-mark|claude-mark\.svg, the composer's model picker/);
  // No over-prescribed slow pacing: no "calm", "fewer transitions" or long holds.
  for (const t of BUILTIN_TEMPLATES) assert.doesNotMatch(t.body, /\bcalm|fewer transitions|second and a half|hold(?:s)? (?:for )?(?:two|three|[2-9]) ?s/i, t.id);
  // Filled with nothing, a built-in still reads: notes, never "undefined".
  const filled = fillTemplate(BUILTIN_TEMPLATES[0]!.body, {}).text;
  assert.doesNotMatch(filled, /undefined|\{\{/);
});

const skills = [
  { id: "launch-promo", name: "Launch promo", description: "" },
  { id: "talking-head", name: "Talking-head short", description: "" },
  { id: "motion-film", name: "Motion film", description: "" },
];
test("the / menu: skills first, then the templates as their own group, matched by id or name", () => {
  const all = slashItems("", skills, BUILTIN_TEMPLATES);
  assert.deepEqual(
    all.map((x) => `${x.kind}:${x.id}`),
    ["skill:launch-promo", "skill:talking-head", "skill:motion-film", "template:keynote-one-take", "template:one-shape-never-cut", "template:beat-cut-reel", "template:talking-head-subtitles"],
  );
  assert.deepEqual(slashItems("talking", skills, BUILTIN_TEMPLATES).map((x) => `${x.kind}:${x.id}`), ["skill:talking-head", "template:talking-head-subtitles"]);
  // Only a template matches: the menu still opens with it.
  assert.deepEqual(slashItems("keyn", skills, BUILTIN_TEMPLATES).map((x) => x.id), ["keynote-one-take"]);
  assert.deepEqual(slashItems("one-shape", skills, BUILTIN_TEMPLATES).map((x) => x.id), ["one-shape-never-cut"]);
  assert.deepEqual(slashItems("cut", skills, BUILTIN_TEMPLATES).map((x) => x.id), ["one-shape-never-cut", "beat-cut-reel"]);
  assert.deepEqual(slashItems("zzz", skills, BUILTIN_TEMPLATES), []);
  const own = slashItems("my", [], [{ id: "my-reel", name: "My reel", description: "d" }]);
  assert.deepEqual(own, [{ kind: "template", id: "my-reel", name: "My reel", description: "d", builtin: false }]);
});

test("a filled brief goes into the draft where the /query was, on its own lines", () => {
  assert.equal(insertBrief("", "BRIEF", 0), "BRIEF");
  assert.equal(insertBrief("Please: ", "BRIEF", 8), "Please:\n\nBRIEF");
  assert.equal(insertBrief("before after", "BRIEF", 7), "before\n\nBRIEF\n\nafter");
  assert.equal(insertBrief("x", "BRIEF", 99), "x\n\nBRIEF");
});
