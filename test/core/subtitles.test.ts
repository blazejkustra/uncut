// D105: subtitle files in core. Writing: the cues are the cards the captions draw (timeline time
// after cuts, hidden words and fillers out, corrections in, word mode as line cards) plus the text
// items of Subtitles tracks; SRT / VTT times to the millisecond at the project's fps; escaping.
// Reading: .srt / .vtt parsing and refusals; importing as text items on a Subtitles track; a round
// trip import → export gives the same file.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyEdit,
  captionCards,
  createSession,
  decodeSubtitleBytes,
  layout,
  loadModules,
  parseSubtitles,
  planImportSubtitles,
  subtitleCues,
  subtitleLanguageTag,
  subtitleTime,
  validateProject,
  writeSrt,
  writeVtt,
  type Item,
  type Project,
} from "../../packages/core/src/index.ts";

const modules = await loadModules("spec/modules/builtin");

// Media seconds at 30 fps. Main plays media 0–59 then 120–179 (a cut removes 60–119: "Delta" never shows).
const WORDS = [
  { text: "Alpha", start: 0.2, end: 0.6 },
  { text: "um", start: 0.62, end: 0.68, filler: true },
  { text: "Bravo", start: 0.7, end: 1.1 },
  { text: "Charlie.", start: 1.2, end: 1.6 },
  { text: "Delta", start: 2.2, end: 2.6 },
  { text: "Echo", start: 4.6, end: 5.0 },
  { text: "Foxtrot.", start: 5.1, end: 5.5 },
];

function project(captions: Partial<Item> = {}, fps = 30): Project {
  return {
    format: "uncut/0",
    name: "Subs",
    canvas: { width: 1280, height: 720, fps },
    textLooks: 1,
    media: [{ id: "m-talk", kind: "video", name: "Talk.mp4", path: "/tmp/talk.mp4", probe: { frames: 6 * fps, fps, width: 640, height: 360, hasAudio: true } }],
    tracks: [
      {
        id: "captions-track-1",
        kind: "text",
        name: "Captions",
        items: [
          {
            id: "captions-1",
            type: "captions",
            source: "m-talk",
            start: 0,
            duration: 4 * fps,
            coversMain: true,
            mode: "line",
            words: WORDS,
            hideFillers: true,
            ...captions,
          } as Item,
        ],
      },
      {
        id: "main",
        kind: "video",
        role: "main",
        name: "Main",
        items: [
          { id: "clip-1", type: "clip", media: "m-talk", in: 0, duration: 2 * fps },
          { id: "clip-2", type: "clip", media: "m-talk", in: 4 * fps, duration: 2 * fps },
        ],
      },
    ],
  } as Project;
}

test("cues are the captions' cards in timeline time across a cut, fillers and hidden words out, fixes in", () => {
  const p = project({
    edits: [
      { word: 2, text: "Bravissimo" },
      { word: 6, text: "" },
    ],
  });
  const cards = captionCards(p, p.tracks[0]!.items[0]!);
  const cues = subtitleCues(p);
  assert.deepEqual(
    cues.map((c) => [c.from, c.to, c.text]),
    cards.map((c) => [c.from, c.to, c.words.map((w) => w.text).join(" ")]),
    "the same cards the renderer draws",
  );
  assert.deepEqual(
    cues.map((c) => c.text),
    ["Alpha Bravissimo Charlie.", "Echo"],
  );
  // Echo is heard at media 4.6 s = 138, played at timeline 78 (clip-2 starts at 60 with in 120).
  assert.equal(cues[1]!.from, 78);
  const srt = writeSrt(cues, 30);
  assert.equal(srt, "1\n00:00:00,200 --> 00:00:01,900\nAlpha Bravissimo Charlie.\n\n2\n00:00:02,600 --> 00:00:03,300\nEcho\n");
  assert.ok(!srt.includes("um") && !srt.includes("Delta") && !srt.includes("Foxtrot"));
  // Fillers back when hideFillers is off.
  assert.match(writeSrt(subtitleCues(project({ hideFillers: false })), 30), /Alpha um Bravo/);
});

test("word and single modes export line cards; two-line cards keep their line break; hidden tracks are left out", () => {
  const line = writeSrt(subtitleCues(project({ mode: "line", lines: { maxChars: 12 } })), 30);
  assert.equal(writeSrt(subtitleCues(project({ mode: "word", lines: { maxChars: 12 } })), 30), line);
  assert.equal(writeSrt(subtitleCues(project({ mode: "single", lines: { maxChars: 12 } })), 30), line);
  assert.match(line, /Alpha Bravo\nCharlie\./, "the card's two lines");
  const p = project();
  const hidden: Project = { ...p, tracks: p.tracks.map((t, i) => (i === 0 ? { ...t, hidden: true } : t)) };
  assert.deepEqual(subtitleCues(hidden), []);
});

test("times round to the millisecond at any fps; hours; VTT header and escaping", () => {
  assert.equal(subtitleTime(1, 30, "srt"), "00:00:00,033");
  assert.equal(subtitleTime(2, 30, "srt"), "00:00:00,067");
  assert.equal(subtitleTime(1001, 30000 / 1001, "vtt"), "00:00:33.400");
  assert.equal(subtitleTime(25, 25, "vtt"), "00:00:01.000");
  assert.equal(subtitleTime(3 * 3600 * 24 + 61 * 24 + 12, 24, "srt"), "03:01:01,500");
  const cues = [
    { from: 0, to: 24, text: "Tom & Jerry <3 -> a --> b" },
    { from: 24, to: 48, text: "Line one\n\nLine two" },
  ];
  assert.equal(
    writeVtt(cues, 24),
    "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nTom &amp; Jerry &lt;3 -&gt; a -&gt; b\n\n00:00:01.000 --> 00:00:02.000\nLine one\nLine two\n\n",
  );
  assert.equal(writeSrt(cues, 24), "1\n00:00:00,000 --> 00:00:01,000\nTom & Jerry <3 -> a -> b\n\n2\n00:00:01,000 --> 00:00:02,000\nLine one\nLine two\n");
  assert.equal(writeVtt([], 30), "WEBVTT\n\n");
  assert.equal(subtitleLanguageTag("en-US"), "eng");
  assert.equal(subtitleLanguageTag("pl"), "pol");
  assert.equal(subtitleLanguageTag("deu"), "deu");
  assert.equal(subtitleLanguageTag("x"), "und");
});

test("parsing SRT and VTT: BOM, CRLF, tags, entities, cue settings, NOTE blocks; refusals with reasons", () => {
  const srt = "﻿1\r\n00:00:01,000 --> 00:00:02,500\r\n<i>Hello</i> {\\an8}there\r\nsecond line\r\n\r\n2\r\n00:00:03,000 --> 00:00:04,000\r\nTom &amp; Jerry\r\n";
  const a = parseSubtitles(srt, "talk.srt");
  assert.ok(!("problem" in a), JSON.stringify(a));
  assert.equal(a.format, "srt");
  assert.deepEqual(a.cues, [
    { start: 1, end: 2.5, text: "Hello there\nsecond line" },
    { start: 3, end: 4, text: "Tom & Jerry" },
  ]);
  const vtt =
    "WEBVTT - a title\nKind: captions\n\nNOTE a comment\nover lines\n\nSTYLE\n::cue { color: red }\n\nintro\n00:01.000 --> 00:02.000 align:start line:90%\n<v Ann>Hi &lt;there&gt;</v>\n\n01:00:00.500 --> 01:00:01.000\n<c.yellow>Late</c>\n";
  const b = parseSubtitles(vtt, "talk.vtt");
  assert.ok(!("problem" in b), JSON.stringify(b));
  assert.deepEqual(b.cues, [
    { start: 1, end: 2, text: "Hi <there>" },
    { start: 3600.5, end: 3601, text: "Late" },
  ]);
  const bad = (text: string, name: string) => {
    const r = parseSubtitles(text, name);
    assert.ok("problem" in r, `${name} should be refused`);
    return r.problem;
  };
  assert.match(bad("1\n00:00:01,000 --> 00:00:02,000\nHi\n", "x.vtt"), /isn't a WebVTT file: it has to start with "WEBVTT"/);
  assert.match(bad("", "x.srt"), /x\.srt is empty/);
  assert.match(bad("just some notes\nnothing timed\n", "notes.srt"), /no subtitle cues/);
  assert.match(bad("1\n00:00:aa,000 --> 00:00:02,000\nHi\n", "x.srt"), /a time Uncut can't read at line 2/);
  assert.match(bad("1\n00:00:05,000 --> 00:00:02,000\nBackwards\n", "x.srt"), /no cues with text and a time that ends after it starts/);
  // Windows-1252 bytes (an older .srt) decode instead of failing.
  assert.equal(decodeSubtitleBytes(new Uint8Array([0x63, 0x61, 0x66, 0xe9])), "café");
  assert.equal(decodeSubtitleBytes(new TextEncoder().encode("zażółć")), "zażółć");
});

test("import: text items on a new Subtitles track, clipped to the edit, overlaps resolved; a valid edit; round trip", () => {
  const p = project();
  // Frame-aligned cues (30 fps), one overlapping the next, two starting together, one past the end (120 frames).
  const srt = [
    "1\n00:00:00,500 --> 00:00:01,500\nFirst cue\n",
    "2\n00:00:01,000 --> 00:00:02,000\nSecond, **bold** [[x]]\n",
    "3\n00:00:02,000 --> 00:00:03,000\nSpeaker A\n",
    "4\n00:00:02,000 --> 00:00:02,500\nSpeaker B\n",
    "5\n00:00:03,500 --> 00:00:04,500\nRuns past the end\n",
    "6\n00:00:05,000 --> 00:00:06,000\nAfter the end\n",
  ].join("\n");
  const parsed = parseSubtitles(srt, "talk.srt");
  assert.ok(!("problem" in parsed));
  const plan = planImportSubtitles(p, parsed.cues, "talk.srt");
  assert.ok(!("problem" in plan), JSON.stringify(plan));
  assert.deepEqual([plan.cues, plan.clipped, plan.joined, plan.summary], [4, 1, 1, "Import subtitles talk.srt"]);
  const session = applyEdit(createSession(p), { actor: "user", ops: plan.ops, summary: plan.summary }, (x) => validateProject(x, modules));
  const track = session.project.tracks[0]!;
  assert.deepEqual([track.name, track.kind], ["Subtitles", "text"]);
  assert.deepEqual(
    track.items.map((i) => [i.start, i.duration, i.text]),
    [
      [15, 15, "First cue"],
      [30, 30, "Second, *bold* [x]"],
      [60, 30, "Speaker A\nSpeaker B"],
      [105, 15, "Runs past the end"],
    ],
  );
  assert.equal(layout(session.project).duration, 120, "subtitles don't make the video longer");
  // A two-line cue sits higher, so both end on the caption's bottom line.
  assert.ok(track.items[2]!.transform!.y! < track.items[0]!.transform!.y!);

  // Round trip: without the captions item, the export is the file's cues as imported.
  const only = { ...session.project, tracks: session.project.tracks.filter((t) => t.id !== "captions-track-1") };
  assert.equal(
    writeSrt(subtitleCues(only), 30),
    "1\n00:00:00,500 --> 00:00:01,000\nFirst cue\n\n2\n00:00:01,000 --> 00:00:02,000\nSecond, *bold* [x]\n\n3\n00:00:02,000 --> 00:00:03,000\nSpeaker A\nSpeaker B\n\n4\n00:00:03,500 --> 00:00:04,000\nRuns past the end\n",
  );
  // A clean file goes round unchanged, in both formats.
  const clean = "1\n00:00:00,500 --> 00:00:01,000\nOne\n\n2\n00:00:01,500 --> 00:00:02,000\nTwo lines\nhere\n";
  const again = parseSubtitles(clean, "clean.srt");
  assert.ok(!("problem" in again));
  const bare: Project = { ...p, tracks: p.tracks.filter((t) => t.role === "main") };
  const plan2 = planImportSubtitles(bare, again.cues, "clean.srt");
  assert.ok(!("problem" in plan2));
  const imported = applyEdit(createSession(bare), { actor: "user", ops: plan2.ops, summary: plan2.summary }, (x) => validateProject(x, modules)).project;
  assert.equal(writeSrt(subtitleCues(imported), 30), clean);
  const vtt = writeVtt(subtitleCues(imported), 30);
  const back = parseSubtitles(vtt, "clean.vtt");
  assert.ok(!("problem" in back));
  assert.deepEqual(back.cues, again.cues);
  // Merged by time with captions: one list.
  const both = subtitleCues(session.project);
  assert.ok(both.length === 6 && both.every((c, i) => i === 0 || c.from >= both[i - 1]!.from));
  // A second import gets its own track; everything after the end is refused.
  const plan3 = planImportSubtitles(session.project, again.cues, "clean.srt");
  assert.ok(!("problem" in plan3));
  assert.match(JSON.stringify(plan3.ops[0]), /"name":"Subtitles 2"/);
  const late = planImportSubtitles(p, [{ start: 10, end: 11, text: "x" }], "late.srt");
  assert.ok("problem" in late && /Every cue in late\.srt starts after the end of the edit \(4\.0 s\)/.test(late.problem));
});

test("flattenCues: overlapping cues stacked, split at every edge, equal neighbours joined", async () => {
  const { flattenCues } = await import("../../packages/core/src/index.ts");
  assert.deepEqual(
    flattenCues([
      { from: 0, to: 30, text: "A" },
      { from: 10, to: 20, text: "B" },
      { from: 30, to: 40, text: "C" },
      { from: 50, to: 60, text: "D" },
    ]),
    [
      { from: 0, to: 10, text: "A" },
      { from: 10, to: 20, text: "A\nB" },
      { from: 20, to: 30, text: "A" },
      { from: 30, to: 40, text: "C" },
      { from: 50, to: 60, text: "D" },
    ],
  );
  assert.deepEqual(
    flattenCues([
      { from: 0, to: 10, text: "X" },
      { from: 10, to: 20, text: "X" },
    ]),
    [{ from: 0, to: 20, text: "X" }],
  );
});
