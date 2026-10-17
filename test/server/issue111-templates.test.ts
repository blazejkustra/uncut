// Issue #111: templates on the server. The user's own are .md files in <dataDir>/templates, listed
// after the built-ins, which can't be overwritten or deleted; a template fills from the open
// project: its media, its kit (name and files), its canvas, the length (brief, timeline, song) and
// the song's tempo and drop from a cached beat analysis only.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { deleteTemplate, fillFor, listTemplates, projectFacts, saveTemplate, templatesDir, type BeatsReader } from "../../apps/server/src/templates/templates.ts";
import type { BeatsResult } from "../../apps/server/src/analysis/beats.ts";

let root = "";
before(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-111-")));
});
after(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

test("the user's templates: saved as Markdown, listed after the built-ins by name, deleted; built-ins are read-only", async () => {
  const data = join(root, "data1");
  const before = await listTemplates(data);
  assert.deepEqual(before.map((t) => t.id), ["keynote-one-take", "one-shape-never-cut", "beat-cut-reel", "talking-head-subtitles"]);
  assert.ok(before.every((t) => t.builtin));
  await saveTemplate(data, { id: "zed", name: "Zed reel", description: "Mine.", body: "Cut {{footage}}." });
  await saveTemplate(data, { id: "alpha", name: "Alpha", description: "", body: "A" });
  const file = join(templatesDir(data), "zed.md");
  assert.equal(readFileSync(file, "utf8"), "---\nname: Zed reel\ndescription: Mine.\n---\n\nCut {{footage}}.\n");
  // A file dropped in by hand is listed too; one named like a built-in, or not .md, is left out.
  writeFileSync(join(templatesDir(data), "beat-cut-reel.md"), "---\nname: Impostor\n---\nX");
  writeFileSync(join(templatesDir(data), "notes.txt"), "x");
  writeFileSync(join(templatesDir(data), "hand-made.md"), "Plain brief for {{project}}.");
  const list = await listTemplates(data);
  assert.deepEqual(list.slice(4).map((t) => [t.id, t.name, t.builtin]), [["alpha", "Alpha", undefined], ["hand-made", "hand-made", undefined], ["zed", "Zed reel", undefined]]);
  assert.equal(list.find((t) => t.id === "beat-cut-reel")!.name, "Beat-cut reel");
  await assert.rejects(saveTemplate(data, { id: "keynote-one-take", name: "Mine", description: "", body: "" }), /can't be changed; duplicate it/);
  await assert.rejects(deleteTemplate(data, "keynote-one-take"), /can't be deleted/);
  await assert.rejects(saveTemplate(data, { id: "../x", name: "X", description: "", body: "" }), /lowercase letters/);
  await assert.rejects(saveTemplate(data, { id: "x", name: " ", description: "", body: "" }), /name/);
  await deleteTemplate(data, "zed");
  assert.equal(existsSync(file), false);
  assert.ok(!(await listTemplates(data)).some((t) => t.id === "zed"));
});

const beats120: BeatsResult = {
  hasAudio: true,
  seconds: 30,
  bpm: 120.04,
  confidence: 0.9,
  beats: Array.from({ length: 60 }, (_, i) => i * 0.5),
  onsets: [],
  // Quiet for 32 beats, then the kick and bass come in: the drop is beat 32, at 16 s.
  beatLevels: Array.from({ length: 60 }, (_, i) => (i < 32 ? 0.2 : 1)),
};

function makeProject(dir: string, kit: boolean) {
  mkdirSync(dir, { recursive: true });
  const data = join(root, "data2");
  if (kit) {
    mkdirSync(join(data, "brand", "kits", "acme"), { recursive: true });
    writeFileSync(join(data, "brand", "kits", "acme", "kit.json"), JSON.stringify({ id: "acme", name: "Acme", logos: { light: "logo.svg" }, colors: [{ hex: "#112233", role: "accent" }], fonts: [{ family: "Inter", file: "Inter.woff2" }], tone: "Plain and direct." }));
    for (const f of ["logo.svg", "Inter.woff2", "ui-shot.png"]) writeFileSync(join(data, "brand", "kits", "acme", f), "x");
    mkdirSync(join(dir, "brand"), { recursive: true });
    writeFileSync(join(dir, "brand", "active.json"), JSON.stringify({ kit: "acme", skills: [] }));
  }
  const project = {
    name: "Coast film",
    canvas: { width: 1080, height: 1920, fps: 30 },
    media: [
      { id: "m1", kind: "video", name: "DJI_0050.MP4", path: "/nowhere/a.mp4", probe: { frames: 300, fps: 50, width: 3840, height: 2160, hasAudio: false } },
      { id: "m2", kind: "audio", name: "sfx-whoosh.wav", path: "/nowhere/w.wav", probe: { frames: 30 } },
      { id: "m3", kind: "audio", name: "track.mp3", path: "/nowhere/t.mp3", probe: { frames: 900 } },
    ],
    tracks: [],
  };
  return { data, open: { dir, project } };
}

test("a template fills from the open project: media, kit files, canvas, song length, tempo and drop from the cached analysis", async () => {
  const { data, open } = makeProject(join(root, "p1"), true);
  const asked: Array<string> = [];
  const readBeats: BeatsReader = async (_dir, m) => (asked.push(m.id), m.id === "m3" ? beats120 : undefined);
  const facts = await projectFacts(data, open, [], readBeats);
  // The longest audio file is asked first and is the song.
  assert.equal(asked[0], "m3");
  assert.equal(facts.music?.name, "track.mp3");
  assert.deepEqual(facts.length, { seconds: 30, from: "song" });
  assert.deepEqual(facts.music?.drop, { seconds: 16, beat: 32 });
  assert.equal(facts.music?.beatCount, 60);
  assert.deepEqual(facts.kit?.logos, ["logo.svg"]);
  assert.deepEqual(facts.kit?.files, ["ui-shot.png"]);

  await saveTemplate(data, { id: "probe", name: "Probe", description: "", body: "{{project}}\n{{canvas}}\n{{length}}\n{{tempo}}\n{{drop}}\n{{beats}}\n{{footage}}\n{{kit}}" });
  const filled = await fillFor(data, "probe", open, [], readBeats);
  assert.deepEqual(filled.missing, []);
  assert.equal(
    filled.text,
    [
      "Coast film",
      "1080 x 1920 (9:16), 30 fps",
      "30 s",
      "120 BPM",
      "0:16.0 into the song (beat 33)",
      "60 beats in 30 s",
      "- DJI_0050.MP4: video, 10 s, 50 fps, 3840 x 2160, no sound",
      '"Acme" brand kit',
      "- Logos (use these files, never redraw them): logo.svg",
      "- Fonts: Inter (Inter.woff2)",
      "- Colours: #112233 accent",
      "- Other files: ui-shot.png",
      "- Tone: Plain and direct.",
    ].join("\n"),
  );
  // The brief's duration wins over the song's length, and the beats are counted inside it.
  writeFileSync(join(open.dir, "brief.json"), JSON.stringify({ film: "A coast film", audience: "", duration: "20 s", formats: [], assets: [], visual: "", hardLines: [], deliverables: [] }));
  const briefed = await projectFacts(data, open, [], readBeats);
  assert.deepEqual(briefed.length, { seconds: 20, from: "brief" });
  assert.equal(briefed.music?.beatCount, 40);
  // A built-in fills too, with no placeholder left.
  const keynote = await fillFor(data, "keynote-one-take", open, [], readBeats);
  assert.doesNotMatch(keynote.text, /\{\{|undefined/);
  assert.match(keynote.text, /track\.mp3, 30 s, 120 BPM, drop at 0:16\.0/);
  await assert.rejects(fillFor(data, "gone", open, [], readBeats), /isn't there any more/);
});

test("no analysis, no kit, no project: the notes say what's missing instead of guessing", async () => {
  const { data, open } = makeProject(join(root, "p2"), false);
  const none: BeatsReader = async () => undefined;
  const filled = await fillFor(data, "beat-cut-reel", open, [], none);
  assert.match(filled.text, /\[no brand kit picked for this project\]/);
  assert.ok(filled.missing.includes("tempo") && filled.missing.includes("kit"));
  assert.doesNotMatch(filled.text, /BPM/);
  // No project open: only fallbacks and notes.
  const closed = await fillFor(data, "talking-head-subtitles", undefined, [], none);
  assert.match(closed.text, /\[no media imported yet/);
});
