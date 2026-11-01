// FCPXML and EDL: a project written out and read back keeps its cuts, and what a file can't carry is
// said. Round trips go through the writer and the reader; no other editor is involved.
import { test } from "node:test";
import assert from "node:assert/strict";

import { writeEdl, timecode } from "../../packages/core/src/timeline/interchange/edl.ts";
import { frameFraction, writeFcpxml } from "../../packages/core/src/timeline/interchange/fcpxml.ts";
import { planImportTimeline, readFcpxml, seconds, type TimelineFile } from "../../packages/core/src/timeline/interchange/readFcpxml.ts";
import { parseXml } from "../../packages/core/src/timeline/interchange/xml.ts";
import { layout } from "../../packages/core/src/timeline/timeline.ts";
import type { Item, Op, Project } from "../../packages/core/src/timeline/types.ts";

const media = (id: string, kind: "video" | "image" | "audio", name: string) => ({
  id,
  kind,
  name,
  path: `/footage/My Trip/${name}`,
  probe: { frames: 900, width: 1920, height: 1080, hasAudio: kind !== "image" },
});

const project = (fps: Project["canvas"]["fps"] = 30): Project =>
  ({
    format: "uncut/0",
    name: "Trip & back",
    canvas: { width: 1920, height: 1080, fps },
    media: [media("a", "video", "A & B.mp4"), media("b", "video", "B#1.mov"), media("s", "audio", "Song.m4a")],
    tracks: [
      { id: "text", kind: "text", name: "Text", items: [{ id: "t1", type: "text", start: 40, duration: 60, text: "Day <four>" }] },
      { id: "over", kind: "video", name: "Over", items: [{ id: "o1", type: "clip", media: "b", in: 12, start: 130, duration: 30 }] },
      {
        id: "main",
        kind: "video",
        role: "main",
        name: "Main",
        items: [
          { id: "c1", type: "clip", media: "a", in: 10, duration: 90 },
          { id: "c2", type: "clip", media: "b", in: 200, duration: 60, gainDb: -6, transitionIn: { module: "transition.crossfade", duration: 20 } },
          { id: "c3", type: "clip", media: "a", in: 300, gap: 15, duration: 45 },
        ],
      },
      { id: "music", kind: "audio", name: "Music", items: [{ id: "m1", type: "audio", media: "s", in: 0, start: 0, duration: 210, gainDb: -12 }] },
    ],
  }) as unknown as Project;

const path = (m: { path: string }) => m.path;
const read = (p: Project) => {
  const file = readFcpxml(writeFcpxml(p, path).text);
  assert.ok(!("problem" in file), "problem" in file ? file.problem : "");
  return file as TimelineFile;
};

test("FCPXML is well formed, escapes names and URLs, and uses exact frame fractions", () => {
  const { text } = writeFcpxml(project(), path);
  assert.ok(parseXml(text));
  assert.match(text, /fcpxml version="1\.10"/);
  assert.match(text, /A &amp; B\.mp4/);
  assert.match(text, /file:\/\/\/footage\/My%20Trip\/B%231\.mov/);
  assert.match(text, /Day &lt;four&gt;/);
  assert.deepEqual(frameFraction(29.97), { num: 1001, den: 30000 });
  assert.deepEqual(frameFraction(24), { num: 100, den: 2400 });
  assert.match(writeFcpxml(project(29.97), path).text, /frameDuration="1001\/30000s"/);
  assert.equal(seconds("3003/30000s"), 0.1001);
  assert.equal(seconds("12s"), 12);
  assert.equal(seconds(undefined), 0);
});

for (const fps of [30, 29.97, 23.976] as const) {
  test(`FCPXML round trip at ${fps} fps keeps every clip's place, source and length`, () => {
    const p = project(fps);
    const file = read(p);
    assert.equal(file.name, "Trip & back");
    assert.deepEqual(file.canvas, { width: 1920, height: 1080, fps });
    const { starts } = layout(p);
    const key = (lane: number, start: number) => file.clips.find((c) => c.lane === lane && c.start === start);
    const c1 = key(0, 0)!;
    assert.deepEqual([c1.path, c1.in, c1.duration], ["/footage/My Trip/A & B.mp4", 10, 90]);
    const c2 = key(0, starts.get("c2")!)!;
    assert.deepEqual([c2.path, c2.in, c2.duration, c2.gainDb, c2.dissolve], ["/footage/My Trip/B#1.mov", 200, 60, -6, 20]);
    const c3 = key(0, starts.get("c3")!)!;
    assert.deepEqual([c3.in, c3.duration, c3.start], [300, 45, 165]);
    const over = file.clips.find((c) => c.path?.endsWith("B#1.mov") && c.lane > 0)!;
    assert.deepEqual([over.start, over.in, over.duration], [130, 12, 30]);
    const music = file.clips.find((c) => c.lane < 0)!;
    assert.deepEqual([music.start, music.duration, music.gainDb], [0, 210, -12]);
    const title = file.clips.find((c) => c.kind === "text")!;
    assert.deepEqual([title.text, title.start, title.duration], ["Day <four>", 40, 60]);
  });
}

test("FCPXML import plans the same timeline, and writing it again gives the same clips", () => {
  const p = project();
  const file = read(p);
  const empty = { ...p, tracks: p.tracks.filter((t) => t.role === "main").map((t) => ({ ...t, items: [] })) };
  const plan = planImportTimeline(empty, file, (at) => p.media.map((m) => ({ ...m, at: m.path })).find((m) => m.at === at), new Set());
  assert.ok(!("problem" in plan));
  assert.equal(plan.clips, 6);
  const tracks = [...empty.tracks.map((t) => ({ ...t, items: [] as Array<Item> }))];
  for (const op of plan.ops as ReadonlyArray<Op & { track: never; item: never; index?: number }>) {
    if (op.op === "add_track") tracks[op.index === 0 ? "unshift" : "push"]({ ...(op.track as object), items: [] } as never);
    else if (op.op === "insert_item") tracks.find((t) => t.id === op.track)!.items.push(op.item);
  }
  const again = { ...p, tracks } as Project;
  const second = read(again);
  const shape = (f: TimelineFile) =>
    f.clips.map(({ kind, path: at, start, in: from, duration, gainDb, dissolve }) => [kind, at, start, from, duration, gainDb, dissolve].join()).sort();
  assert.deepEqual(shape(second), shape(file));
});

test("FCPXML import needs an empty project and says what it left out", () => {
  const p = project();
  const file = read(p);
  const refused = planImportTimeline(p, file, () => undefined, new Set());
  assert.ok("problem" in refused);
  const empty = { tracks: [{ id: "main", kind: "video", role: "main", items: [] }] } as unknown as Project;
  const plan = planImportTimeline(empty, file, () => undefined, new Set());
  assert.ok(!("problem" in plan));
  assert.equal(plan.warnings.length, 5, "every clip with a file went");
});

test("FCPXML from Final Cut's own shapes: clip with video inside, connected title, a compound clip", () => {
  const file = readFcpxml(`<?xml version="1.0"?><!DOCTYPE fcpxml>
<fcpxml version="1.9"><resources>
<format id="f" frameDuration="1/25s" width="1280" height="720"/>
<asset id="a1" src="file:///x/one.mov" start="0s" duration="100s"/>
</resources><library><event><project name="P"><sequence format="f"><spine>
<clip name="One" duration="4s" offset="0s" start="10s"><video ref="a1" offset="10s" duration="4s"/>
<title name="Hello" lane="1" offset="11s" duration="1s"><text><text-style>Hi there</text-style></text></title></clip>
<ref-clip name="Nested" offset="4s" duration="2s"/>
</spine></sequence></project></event></library></fcpxml>`) as TimelineFile;
  assert.deepEqual(file.canvas, { width: 1280, height: 720, fps: 25 });
  assert.equal(file.clips.length, 2);
  assert.deepEqual([file.clips[0]!.path, file.clips[0]!.in, file.clips[0]!.duration], ["/x/one.mov", 250, 100]);
  assert.deepEqual([file.clips[1]!.text, file.clips[1]!.start], ["Hi there", 25]);
  assert.match(file.warnings[0]!, /Nested is left out/);
  assert.ok("problem" in readFcpxml("<xml/>"));
  assert.ok("problem" in readFcpxml("not xml at all <fcpxml>"));
});

const fcpxml = (frameDuration: string, sequence: string, spine: string, asset = 'src="file:///x/one.mov" start="0s"') =>
  `<fcpxml version="1.10"><resources><format id="f" frameDuration="${frameDuration}" width="1920" height="1080"/><asset id="a1" ${asset} duration="100s"/></resources><library><event><project name="P"><sequence format="f" ${sequence}><spine>${spine}</spine></sequence></project></event></library></fcpxml>`;

test("FCPXML import: the sequence's tcStart and an asset's start are where the file counts from", () => {
  const file = readFcpxml(
    fcpxml(
      "1/25s",
      'tcStart="3600s"',
      '<asset-clip ref="a1" name="One" offset="3600s" start="110s" duration="4s"/><asset-clip ref="a1" name="Two" offset="3604s" start="120s" duration="2s"/>',
      'src="file:///x/one.mov" start="100s"',
    ),
  ) as TimelineFile;
  assert.deepEqual(
    file.clips.map((c) => [c.start, c.in, c.duration]),
    [
      [0, 250, 100],
      [100, 500, 50],
    ],
  );
});

test("FCPXML import: only file: URLs are media, and a broken time counts as none", () => {
  const remote = readFcpxml(
    fcpxml("1/25s", "", '<asset-clip ref="a1" name="One" offset="0s" duration="4s"/>', 'src="https://evil.example/one.mov" start="0s"'),
  ) as TimelineFile;
  assert.equal(remote.clips.length, 0);
  assert.match(remote.warnings[0]!, /One is left out/);
  assert.equal(seconds("1/0s"), 0);
  assert.equal(seconds("1.2.3s"), 0);
});

test("FCPXML import: a rate a project can't hold is timed at the canvas's rate, so lengths in seconds stay", () => {
  const file = readFcpxml(fcpxml("1/120s", "", '<asset-clip ref="a1" name="One" offset="0s" start="2s" duration="4s"/>')) as TimelineFile;
  assert.equal(file.canvas!.fps, 60);
  assert.deepEqual([file.clips[0]!.in, file.clips[0]!.duration], [120, 240]);
  assert.match(file.warnings[0]!, /120 fps.*60 fps/);
  const ntsc = readFcpxml(fcpxml("1001/30000s", "", '<asset-clip ref="a1" name="One" offset="0s" start="0s" duration="100100/30000s"/>')) as TimelineFile;
  assert.equal(ntsc.clips[0]!.duration, 100);
  assert.deepEqual(ntsc.warnings, []);
});

test("an XML comment with no end is not well formed", () => {
  assert.equal(parseXml("<a><!-- open</a>"), undefined);
  assert.equal(parseXml("<a><!-- closed --></a>")?.name, "a");
});

test("what a file can't carry comes back as warnings", () => {
  const p = project();
  const main = p.tracks.find((t) => t.role === "main")!;
  const busy = {
    ...p,
    tracks: p.tracks.map((t) =>
      t === main
        ? {
            ...t,
            items: [
              { ...t.items[0]!, name: "Hero", speed: 2, effects: [{ module: "effect.look", params: { look: "warm" } }], transform: { scale: 2 } },
              { id: "g", type: "graphic", src: "g.html", duration: 30 },
            ],
          }
        : t,
    ),
  } as unknown as Project;
  const { warnings, text } = writeFcpxml(busy, path);
  for (const re of [/Hero's effects/, /Hero's position/, /Hero plays at normal speed/, /g is a gap/])
    assert.ok(
      warnings.some((w) => re.test(w)),
      String(re),
    );
  assert.match(text, /<gap /);
});

test("EDL: cuts, a dissolve, record time with the gap, one picture track", () => {
  const { text, warnings } = writeEdl(project(), path);
  const lines = text.split("\n");
  assert.equal(lines[0], "TITLE: Trip & back");
  assert.equal(lines[1], "FCM: NON-DROP FRAME");
  const events = lines.filter((l) => /^\d{3} {2}/.test(l)).map((l) => l.trim().split(/\s+/));
  assert.deepEqual(events[0], ["001", "AX", "AA/V", "C", "00:00:00:10", "00:00:03:10", "00:00:00:00", "00:00:03:00"]);
  assert.deepEqual(events[1]!.slice(3), ["C", "00:00:03:10", "00:00:03:10", "00:00:03:00", "00:00:03:00"]);
  assert.deepEqual(events[2]!.slice(3), ["D", "020", "00:00:06:20", "00:00:08:20", "00:00:03:00", "00:00:05:00"]);
  assert.deepEqual(events[3]!.slice(4), ["00:00:10:00", "00:00:11:15", "00:00:05:15", "00:00:07:00"]);
  assert.match(text, /\* FROM CLIP NAME: A & B\.mp4/);
  assert.match(text, /\* SOURCE FILE: \/footage\/My Trip\/B#1\.mov/);
  assert.ok(warnings.some((w) => /Track Over isn't in the EDL/.test(w)));
});

test("EDL timecode counts the rate's whole frames", () => {
  assert.equal(timecode(0, 30), "00:00:00:00");
  assert.equal(timecode(3661 * 24 + 5, 23.976), "01:01:01:05");
  assert.equal(timecode(30, 29.97), "00:00:01:00");
});
