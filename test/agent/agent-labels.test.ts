// D182, D184: the now line's present-tense labels (also from a call's input still streaming in),
// what a "Look only" chat may use, and what "Ask first" asks about.
import { test } from "node:test";
import assert from "node:assert/strict";
import { accessLine, bigChange, doingLabel, LOOK_TOOLS, partialFields, stepLabel, TOOL_NAMES } from "../../apps/server/src/agent/agentTools.ts";

const project = {
  format: "uncut/0",
  name: "P",
  canvas: { width: 1920, height: 1080, fps: 30 },
  media: [],
  tracks: [{ id: "text", kind: "text", name: "Text", items: [{ id: "title-1", type: "text", start: 0, duration: 90, text: "Hello" }] }],
} as never;

test("doingLabel: present tense with the target, for every tool", () => {
  assert.equal(doingLabel("graphic_write", { name: "s3-enter.html" }), "Writing graphic s3-enter.html");
  assert.equal(doingLabel("graphic_write", {}), "Writing a graphic");
  assert.equal(doingLabel("timeline_edit", { summary: "Scene 2: the problem" }), "Editing the timeline: Scene 2: the problem");
  assert.equal(doingLabel("project_read", {}), "Reading the timeline");
  assert.equal(doingLabel("render_frames", { frames: [1, 2] }), "Looking at frames 1, 2");
  // Every built-in tool's step label turns into something that isn't the past tense.
  for (const tool of TOOL_NAMES) {
    const now = doingLabel(tool, {});
    assert.ok(now && !/^(Read|Looked|Imported|Analysed|Wrote|Made|Cut|Saved|Generated|Checked|Searched|Added|Moved|Asked|Ranked|Scored|Found|Measured|Transcribed|Edited) /.test(now), `${tool}: ${now} (from ${stepLabel(tool, {})})`);
  }
});

test("partialFields: string fields once their closing quote arrived, escapes decoded", () => {
  assert.deepEqual(partialFields('{"name":"s3-enter.html","html":"<div>'), { name: "s3-enter.html" });
  assert.deepEqual(partialFields('{"name":"s3-en'), {});
  assert.deepEqual(partialFields('{"baseRevision":3,"summary":"Scene \\"2\\"","ops":[{"op":"insert_item","item":{"id":"x"'), { summary: 'Scene "2"', id: "x" });
});

test("access: Look only tools read and look; Ask first asks about removals, project changes, many ops and transcript cuts", () => {
  for (const t of LOOK_TOOLS) assert.ok((TOOL_NAMES as ReadonlyArray<string>).includes(t), t);
  for (const t of ["timeline_edit", "transcript_edit", "graphic_write", "media_import", "generate_media", "screen_record", "library_add", "captions_make"]) assert.ok(!(LOOK_TOOLS as ReadonlyArray<string>).includes(t), t);
  assert.equal(bigChange("timeline_edit", { summary: "Add", ops: [{ op: "insert_item", track: "text", item: { id: "a", type: "text", start: 0, duration: 9, text: "a" } }] }, project), undefined);
  const del = bigChange("timeline_edit", { summary: "Remove the title", ops: [{ op: "delete_item", item: "title-1" }] }, project);
  assert.equal(del?.text, 'Apply "Remove the title" (1 change)');
  assert.equal(del?.lines.length, 1);
  const many = bigChange("timeline_edit", { summary: "Lots", ops: Array.from({ length: 13 }, (_, i) => ({ op: "update_item", item: "title-1", set: { duration: 10 + i } })) }, project);
  assert.equal(many?.text, 'Apply "Lots" (13 changes)');
  assert.equal(many?.lines.at(-1), "and 5 more");
  assert.ok(bigChange("transcript_edit", { media: "m-a", fillers: true }, project));
  assert.equal(bigChange("transcript_edit", { media: "m-a", fillers: true, dryRun: true }, project), undefined);
  assert.equal(bigChange("graphic_write", { name: "a.html" }, project), undefined);
  assert.match(accessLine("look"), /^Access: Look only\./);
  assert.match(accessLine("ask"), /^Access: Ask first\./);
  // D214: Auto is Claude Code's own auto mode; the limits stay.
  assert.match(accessLine("auto"), /^Access: Auto\. Claude Code approves routine commands and file writes inside the project itself; writing outside the project, Uncut's own files, deleting, sudo, git push and uploads are refused or ask the user first\.$/);
  for (const a of ["look", "ask", "auto"] as const) assert.doesNotMatch(accessLine(a), /[·*•]|Edit freely|Ask before big changes/);
});
