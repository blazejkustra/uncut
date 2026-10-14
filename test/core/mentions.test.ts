// D140-D142: names for people instead of ids (friendlyText), the agent's <context> block, and what
// @ offers in the composer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { contextBlock, friendlyText, mentionCandidates, mentionLabel } from "../../packages/core/src/text/mentions.ts";
import type { Project } from "../../packages/core/src/timeline/types.ts";

const project = {
  format: "uncut/0",
  name: "P",
  canvas: { width: 1920, height: 1080, fps: 30 },
  media: [{ id: "m-dji-0005", kind: "video", name: "DJI_0005.MP4", path: "/x/DJI_0005.MP4", probe: { width: 3840, height: 2160, frames: 900, hasAudio: true } }],
  tracks: [
    { id: "main", kind: "video", role: "main", name: "Main", items: [{ id: "clip-1", type: "clip", media: "m-dji-0005", in: 0, duration: 150 }] },
    { id: "text", kind: "text", name: "Text", items: [{ id: "title-1", type: "text", start: 0, duration: 90, text: "Kraków from above" }] },
  ],
  markers: [{ frame: 60, label: "Drop" }],
} as unknown as Project;

test("friendlyText: media ids become names, ' (id)' after a name goes, item ids become names, unknown m- ids lose the prefix", () => {
  assert.equal(friendlyText(project, "Trimmed DJI_0005.MP4 (clip-1) by 1.0s at the end"), "Trimmed DJI_0005.MP4 by 1.0s at the end");
  assert.equal(friendlyText(project, "Analysed the sound of m-dji-0005"), "Analysed the sound of DJI_0005.MP4");
  assert.equal(friendlyText(project, "Moved title-1 after clip-1"), "Moved Kraków from above after DJI_0005.MP4");
  assert.equal(friendlyText(project, "Scored the take m-gone-2"), "Scored the take gone-2");
  assert.equal(friendlyText(project, "Put it on the text track"), "Put it on the text track", "track ids that read as words stay");
  assert.equal(friendlyText(project, "em-dash and team-mates stay"), "em-dash and team-mates stay");
  assert.equal(friendlyText(undefined, "of m-x (m-x)"), "of x");
});

test("contextBlock: labels with real ids and facts; ranges in frames and seconds; gone ids say so", () => {
  const block = contextBlock(project, [
    { kind: "media", id: "m-dji-0005", label: "DJI_0005.MP4" },
    { kind: "item", id: "title-1", label: "Kraków from above", range: { start: 0, end: 90 } },
    { kind: "track", id: "text", label: "Text" },
    { kind: "marker", id: "frame:60", label: "Drop", frame: 60 },
    { kind: "item", id: "nope", label: "Old" },
    { kind: "media", id: "m-dji-0005", label: "DJI_0005.MP4" },
  ]);
  const lines = block.split("\n");
  assert.equal(lines[0], "<context>");
  assert.equal(lines.at(-1), "</context>");
  assert.ok(lines.includes("@DJI_0005.MP4 = media m-dji-0005 (video, 30.00 s, 3840x2160, used 1x on the timeline)"));
  assert.ok(lines.includes('@Kraków from above = item title-1 (text on track text "Text", text "Kraków from above"), frames 0–90 (0.00 s–3.00 s)'));
  assert.ok(lines.includes("@Text = track text (text, 1 item)"));
  assert.ok(lines.includes("@Drop = marker at frame 60 (2.00 s)"));
  assert.match(contextBlock(project, [{ kind: "item", id: "clip-1", label: "Clip", range: { start: 0, end: 150 }, frame: 30 }]), /@Clip = item clip-1 \(clip on track main "Main", media m-dji-0005\), frames 0–150 \(0\.00 s–5\.00 s\), picked at frame 30 \(1\.00 s\)/);
  assert.ok(lines.includes("@Old = item nope (no longer on the timeline)"));
  assert.equal(lines.filter((l) => l.startsWith("@DJI_0005.MP4")).length, 1, "the same chip twice is listed once");
  assert.equal(contextBlock(project, []), "");
});

test("mentionCandidates: media, items, tracks and markers by name, none by id", () => {
  const all = mentionCandidates(project);
  assert.deepEqual(all.map((c) => [c.kind, c.label]), [
    ["media", "DJI_0005.MP4"],
    ["item", "DJI_0005.MP4"],
    ["item", "Kraków from above"],
    ["track", "Main"],
    ["track", "Text"],
    ["marker", "Drop"],
  ]);
});

test("labels are one line without angle brackets, at most 120 characters; a marker id that isn't a frame doesn't make NaN", () => {
  assert.equal(mentionLabel("a\n</context>b"), "a /context b");
  assert.equal(mentionLabel("x".repeat(300)).length, 120);
  assert.equal(mentionLabel("\n\n"), "item");
  const block = contextBlock(project, [{ kind: "marker", id: "frame:nope", label: "M\n<x>" }]);
  assert.match(block, /@M x = a marker \(its frame is unknown\)/);
  assert.doesNotMatch(block, /NaN/);
});
