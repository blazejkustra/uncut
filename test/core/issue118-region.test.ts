// Issue #118: region references. An area dragged over the preview goes with the chat message as a
// chip (kind "region": the rectangle in canvas pixels, at a frame or over a stretch); the agent's
// <context> line gives the rectangle and what's drawn in it then.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Project } from "../../packages/core/src/index.ts";
import { contextBlock, regionLine } from "../../packages/core/src/text/mentions.ts";

const probe = { frames: 900, fps: 30, width: 1920, height: 1080, hasAudio: true };
const project: Project = {
  format: "uncut/0",
  name: "Song",
  canvas: { width: 1920, height: 1080, fps: 30 },
  media: [
    { id: "m-a", kind: "video", name: "a.mp4", path: "/x/a.mp4", probe },
    { id: "m-b", kind: "video", name: "b.mp4", path: "/x/b.mp4", probe },
  ],
  tracks: [
    { id: "main", kind: "video", role: "main", name: "Main", items: [{ id: "c1", type: "clip", media: "m-a", in: 0, duration: 300 }] },
    {
      id: "over",
      kind: "video",
      name: "Overlays",
      items: [
        // A picture-in-picture in the top right quarter, from 2 s to 4 s.
        { id: "pip", type: "clip", media: "m-b", in: 0, start: 60, duration: 60, transform: { x: 960, y: 0, w: 960, h: 540 } },
        { id: "t1", type: "text", start: 0, duration: 300, text: "Hello there" },
      ],
    },
  ],
};

test("a region at a frame: the rectangle, its fractions of the frame and what's drawn in it", () => {
  const line = regionLine(project, { area: { x: 1200, y: 100, w: 400, h: 200 }, frame: 90 });
  assert.match(line, /x 1200–1600, y 100–300 of the 1920x1080 canvas \(63–83% across, 9–28% down\), at frame 90 \(3\.00 s\)/);
  assert.match(line, /drawn in it: pip \(clip "b\.mp4", track over\); c1 \(clip "a\.mp4", track main\)/);
  assert.match(line, /also on screen \(texts and graphics, place not measured\): t1 \(text "Hello there", track over\)/);
  // Before the overlay starts, only the main clip is under it.
  assert.doesNotMatch(regionLine(project, { area: { x: 1200, y: 100, w: 400, h: 200 }, frame: 10 }), /pip/);
  // Bottom left: the overlay isn't there.
  assert.doesNotMatch(regionLine(project, { area: { x: 0, y: 600, w: 400, h: 400 }, frame: 90 }), /pip/);
});

test("a region over a stretch: the frames, and what's in it at any of its first, middle and last frames", () => {
  const line = regionLine(project, { area: { x: 1000, y: 0, w: 900, h: 500 }, range: { start: 0, end: 120 } });
  assert.match(line, /over frames 0–120 \(0\.00 s–4\.00 s, end not included\)/);
  assert.match(line, /pip/);
  // Clamped to the canvas.
  assert.match(regionLine(project, { area: { x: -50, y: 1000, w: 4000, h: 500 }, frame: 0 }), /x 0–1920, y 1000–1080/);
});

test("the chip in the <context> block", () => {
  const mention = { kind: "region" as const, id: "region:1200,100,400,200@90", label: "Area 0:03", area: { x: 1200, y: 100, w: 400, h: 200 }, frame: 90 };
  const block = contextBlock(project, [mention]);
  assert.match(block, /^@Area 0:03 = an area of the picture the user marked: x 1200–1600/m);
  // Two areas at the same moment are two lines.
  const other = { ...mention, id: "region:0,600,400,400@90", label: "Area 2 0:03", area: { x: 0, y: 600, w: 400, h: 400 } };
  assert.equal(
    contextBlock(project, [mention, other])
      .split("\n")
      .filter((l) => l.startsWith("@Area")).length,
    2,
  );
});
