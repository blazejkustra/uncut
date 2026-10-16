// Phase 6 chunk 8 (D90) without the app: core projectChecks. Every rule fires on a project that
// breaks it and stays quiet on one that doesn't; fixes are valid edits that clear their finding;
// the registry takes extra rules; checks.disabled turns rules off (and planDisableCheck writes it);
// projects without a checks field (the examples, made before) open and validate; a broken rule
// doesn't take the others down.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { planInsertText, type Op } from "../../packages/core/src/index.ts";
import { applyEdit, CHECK_IDS, CHECK_RULES, checkRule, createSession, loadModules, planDisableCheck, projectChecks, validateOps, validateProject, type Check, type CheckRule, type Item, type Project, type Track } from "../../packages/core/src/index.ts";
import { budget, slowdown } from "../helpers/timing.ts";

const modules = await loadModules("spec/modules/builtin", "spec/examples/plugins");
const FPS = 30;

/** A 10 s 1080×1350 project: footage on main, a text track and an audio track (music) with the given items. */
function make({ texts = [], main, audio = [], extra = [], canvas }: { texts?: Array<Partial<Item>>; main?: Array<Partial<Item>>; audio?: Array<Partial<Item>>; extra?: Array<Track>; canvas?: Project["canvas"] } = {}): Project {
  return {
    format: "uncut/0",
    name: "Checks",
    canvas: canvas ?? { width: 1080, height: 1350, fps: FPS },
    media: [
      { id: "m-clip", kind: "video", name: "clip.mp4", path: "/tmp/clip.mp4", probe: { frames: 3000, fps: 30, width: 1080, height: 1350, hasAudio: true } },
      { id: "m-song", kind: "audio", name: "Song.m4a", path: "/tmp/song.m4a", probe: { frames: 3000 } },
      { id: "m-voice", kind: "audio", name: "Voice.m4a", path: "/tmp/voice.m4a", probe: { frames: 3000 } },
    ],
    tracks: [
      { id: "text", kind: "text", name: "Text", items: texts.map((t, i) => ({ id: `t${i + 1}`, type: "text", start: 0, duration: 150, text: "Hi", style: { preset: "text.title", size: 96 }, ...t }) as Item) },
      ...extra,
      { id: "main", kind: "video", role: "main", name: "Main", items: (main ?? [{ duration: 300 }]).map((c, i) => ({ id: `c${i + 1}`, type: "clip", media: "m-clip", in: 0, ...c }) as Item) },
      { id: "music", kind: "audio", name: "Music", items: audio.map((a, i) => ({ id: `a${i + 1}`, type: "audio", media: "m-song", in: 0, start: 0, duration: 300, fadeIn: 30, fadeOut: 60, ...a }) as Item) },
    ],
  };
}
const ids = (checks: ReadonlyArray<Check>) => checks.map((c) => c.id);
const only = (project: Project, id: string) => projectChecks(project).filter((c) => c.id === id);
/** Applies a finding's fix as the user would and says whether the result is valid. */
function applyFix(project: Project, check: Check): Project {
  assert.ok(check.fix, `${check.id} has a fix`);
  assert.deepEqual(validateOps(check.fix!.ops), [], `${check.id}'s fix ops are well formed`);
  const next = applyEdit(createSession(project), { actor: "user", ops: check.fix!.ops, summary: check.fix!.summary }).project;
  assert.deepEqual(validateProject(next, modules), [], `${check.id}'s fix is a valid edit`);
  return next;
}

test("the registry: unique ids, titles and descriptions; a clean project has only the info notes it should", () => {
  assert.equal(new Set(CHECK_IDS).size, CHECK_IDS.length);
  for (const r of CHECK_RULES) {
    assert.ok(r.title && r.description, r.id);
    assert.ok(!/[·•]|\s\*\s/.test(`${r.title} ${r.description}`.replace(/No ·, • or \*/, "")), `${r.id} doesn't put dots between words`);
  }
  const clean = make({ texts: [{ text: "We built it 7 times", duration: 150 }, { text: "One sentence here", start: 150, duration: 150 }] });
  assert.deepEqual(validateProject(clean, modules), []);
  assert.deepEqual(ids(projectChecks(clean)), [], JSON.stringify(projectChecks(clean)));
});

test("read time: words ÷ 3 s (2 s minimum) after the in move; the fix lengthens it when the track has room", () => {
  // 9 words need 3 s; 2 s with a 0.5 s fade in = 1.5 s fully shown.
  const p = make({ texts: [{ text: "This is a line with nine words on it", duration: 60, animation: { in: { module: "move.fade", duration: 15 } } }, { text: "Later", start: 200, duration: 90 }] });
  const [c] = only(p, "text-read-time");
  assert.ok(c);
  assert.deepEqual(c.itemIds, ["t1"]);
  assert.match(c.message, /fully on screen for 1\.5 s, and 9 words need about 3\.0 s/);
  const fixed = applyFix(p, c);
  assert.equal(fixed.tracks[0]!.items[0]!.duration, 105);
  assert.deepEqual(only(fixed, "text-read-time"), []);
  // Short text: 2 s minimum. 1.9 s warns, 2 s doesn't.
  assert.equal(only(make({ texts: [{ text: "Hi", duration: 57 }, { text: "x y", start: 100, duration: 120 }] }), "text-read-time").length, 1);
  assert.equal(only(make({ texts: [{ text: "Hi", duration: 60 }, { text: "x y", start: 100, duration: 120 }] }), "text-read-time").length, 0);
  // No room before the next text: a hint, no fix.
  const tight = only(make({ texts: [{ text: "This is a line with nine words on it", duration: 60 }, { text: "Next", start: 60, duration: 120 }] }), "text-read-time")[0]!;
  assert.equal(tight.fix, undefined);
  assert.ok(tight.hint);
});

test("the last text holds 3 s; no new text in the final 2 s", () => {
  const p = make({ texts: [{ text: "First", duration: 90 }, { text: "Bye", start: 230, duration: 70 }] });
  const last = only(p, "last-text-hold");
  assert.equal(last.length, 1);
  assert.deepEqual(last[0]!.itemIds, ["t2"]);
  assert.equal(last[0]!.fix, undefined, "it already ends with the video: nothing to lengthen into");
  assert.deepEqual(only(make({ texts: [{ text: "First", duration: 90 }, { text: "Bye", start: 200, duration: 100 }] }), "last-text-hold"), []);
  const late = only(make({ texts: [{ text: "First", duration: 90 }, { text: "Bye", start: 250, duration: 50 }] }), "late-text");
  assert.equal(late.length, 1);
  assert.match(late[0]!.message, /starts 1\.7 s before the end/);
  assert.deepEqual(only(make({ texts: [{ text: "First", duration: 90 }, { text: "Bye", start: 240, duration: 60 }] }), "late-text"), []);
  // The last text's hold is lengthened when there's room.
  const room = make({ texts: [{ text: "Last one", start: 100, duration: 60 }] });
  const fixed = applyFix(room, only(room, "last-text-hold")[0]!);
  assert.equal(fixed.tracks[0]!.items[0]!.duration, 90);
});

test("trailing periods, dots between words and filler phrases", () => {
  const p = make({ texts: [{ text: "iOS first." }, { text: "Swift · Kotlin • Dart * TS", start: 150 }] });
  const period = only(p, "trailing-period")[0]!;
  assert.deepEqual(period.itemIds, ["t1"]);
  assert.equal(applyFix(p, period).tracks[0]!.items[0]!.text, "iOS first");
  const dots = only(p, "dot-separators")[0]!;
  assert.equal(applyFix(p, dots).tracks[0]!.items[1]!.text, "Swift, Kotlin, Dart, TS");
  // Per line, after closing markup; an ellipsis, a period inside, **bold** and a decimal are fine.
  assert.equal(applyFix(make({ texts: [{ text: "One thing.\n[[Another.]]" }] }), only(make({ texts: [{ text: "One thing.\n[[Another.]]" }] }), "trailing-period")[0]!).tracks[0]!.items[0]!.text, "One thing\n[[Another]]");
  for (const text of ["Wait for it...", "v1.2 is out", "**Fast** and *small*", "3.5 s faster"]) {
    const q = make({ texts: [{ text }] });
    assert.deepEqual([...only(q, "trailing-period"), ...only(q, "dot-separators")], [], text);
  }
  const filler = only(make({ texts: [{ text: "Seamlessly unlock the Future of video" }] }), "filler-phrases")[0]!;
  assert.match(filler.message, /"seamlessly" and "unlock" and "the future of"/);
  assert.equal(filler.fix, undefined);
  assert.deepEqual(only(make({ texts: [{ text: "Unlocked phones and seams" }] }), "filler-phrases"), [], "whole words only");
});

test("frame 1: empty or fading in from black warns; the fix drops the fade", () => {
  const fading = make({ main: [{ duration: 300, animation: { in: { module: "move.fade", duration: 15 } } }] });
  const c = only(fading, "frame-one")[0]!;
  assert.match(c.message, /fades in from black/);
  const fixed = applyFix(fading, c);
  assert.equal(fixed.tracks.find((t) => t.id === "main")!.items[0]!.animation, undefined);
  assert.deepEqual(only(fixed, "frame-one"), []);
  // Nothing at frame 0 at all (text starts at 1 s, no footage there).
  const empty = make({ main: [], texts: [{ text: "Late", start: 30, duration: 120 }] });
  assert.match(only(empty, "frame-one")[0]!.message, /is empty/);
  assert.equal(only(empty, "frame-one")[0]!.fix, undefined);
  assert.deepEqual(only(make(), "frame-one"), []);
});

test("crowded text, typefaces, small text and the safe area", () => {
  const crowded = make({ texts: [{ text: "One" }, { text: "Two", style: { preset: "text.header", size: 60 } }] , extra: [{ id: "text-2", kind: "text", name: "Text 2", items: [{ id: "x3", type: "text", start: 30, duration: 60, text: "Three", style: { preset: "text.header", size: 60 } }] }] });
  // Two on one free track can't overlap; the third is on another track.
  const p = { ...crowded, tracks: crowded.tracks.map((t) => (t.id === "text" ? { ...t, items: [t.items[0]!] } : t)) };
  assert.deepEqual(only(p, "crowded-text"), []);
  const three = { ...crowded, tracks: [...crowded.tracks.map((t) => (t.id === "text" ? { ...t, items: [t.items[0]!] } : t)), { id: "text-3", kind: "text", name: "Text 3", items: [{ id: "x4", type: "text", start: 45, duration: 60, text: "Four", style: { preset: "text.header", size: 60 } }] } as Track] };
  const c = only(three, "crowded-text")[0]!;
  assert.equal(c.itemIds!.length, 3);
  assert.equal(c.frame, 45);
  // A footnote in the Footnote look (the disclosure line) doesn't count toward crowding (D96); a third text of any other look does.
  const withFootnote = (preset: string) => ({ ...three, tracks: three.tracks.map((t) => (t.id === "text-3" ? { ...t, items: t.items.map((i) => ({ ...i, style: { preset, size: 28 } })) } : t)) });
  assert.deepEqual(only(withFootnote("text.footnote"), "crowded-text"), []);
  assert.equal(only(withFootnote("text.caption"), "crowded-text").length, 1);
  // A "footnote" blown up past the look's own size (3 % of the canvas height) is a headline again: it counts.
  const big = { ...three, tracks: three.tracks.map((t) => (t.id === "text-3" ? { ...t, items: t.items.map((i) => ({ ...i, style: { preset: "text.footnote", size: 80 } })) } : t)) };
  assert.equal(only(big, "crowded-text").length, 1);

  // The built-in looks mix the system sans and DM Sans: one family for the rule (D90). Another family isn't.
  assert.deepEqual(only(make({ texts: [{ text: "Sans", style: { preset: "text.title", size: 96, font: "DM Sans" } }, { text: "System", start: 150, style: { preset: "text.title", size: 96 } }] }), "one-typeface"), []);
  const fonts = make({ texts: [{ text: "Sans", style: { preset: "text.title", size: 96, font: "DM Sans" } }, { text: "Serif", start: 150, style: { preset: "text.title", size: 96, font: "Georgia" } }, { text: "System", start: 300, duration: 100, style: { preset: "text.title", size: 96 } }] });
  const tf = only(fonts, "one-typeface")[0]!;
  assert.match(tf.message, /2 typefaces \(DM Sans and Georgia\)/);
  assert.deepEqual(tf.itemIds, ["t2"]);
  const same = applyFix(fonts, tf);
  assert.deepEqual(same.tracks[0]!.items[1]!.style, { preset: "text.title", size: 96, font: "DM Sans" });
  assert.deepEqual(only(same, "one-typeface"), []);
  // A theme that names its sans makes it a family of its own.
  const themed = { ...make({ texts: [{ text: "Sans", style: { preset: "text.title", size: 96, font: "DM Sans" } }, { text: "System", start: 150, style: { preset: "text.title", size: 96 } }] }), theme: { fonts: { sans: "Inter" } } };
  assert.match(only(themed, "one-typeface")[0]!.message, /Inter and DM Sans|DM Sans and Inter/);
  assert.deepEqual(only(make({ texts: [{ text: "Sans", style: { preset: "text.title", size: 96, font: "DM Sans" } }, { text: "npx it", start: 150, style: { preset: "text.title", size: 40, font: "DM Mono" } }] }), "one-typeface"), [], "a mono face doesn't count");

  const small = make({ texts: [{ text: "Tiny footnote", style: { preset: "text.footnote", size: 20, color: "mute" } }] });
  const s = only(small, "small-text")[0]!;
  assert.match(s.message, /20 px, below the 28 px/);
  const fixed = applyFix(small, s);
  assert.deepEqual(fixed.tracks[0]!.items[0]!.style, { preset: "text.footnote", size: 28, color: "mute" }, "the rest of the style is kept");
  // Scaled to the canvas: 20 px is fine on a 720-tall canvas? 28 × 720/1080 = 18.7.
  assert.deepEqual(only(make({ canvas: { width: 1280, height: 720, fps: 30 }, texts: [{ text: "Small", style: { preset: "text.title", size: 20 } }] }), "small-text"), []);

  const edge = make({ texts: [{ text: "Edge", transform: { x: 10, y: 600 } }, { text: "Bottom", start: 150, transform: { x: 100, y: 1300 } }] });
  const e = only(edge, "text-edge");
  assert.deepEqual(e.map((x) => x.itemIds![0]), ["t1", "t2"]);
  assert.match(e[0]!.message, /left edge/);
  assert.match(e[1]!.message, /bottom edge/);
  assert.deepEqual(only(make({ texts: [{ text: "Fine", transform: { x: 100, y: 600 } }] }), "text-edge"), []);
});

test("one footage speed, same entrance, long transitions, blank stretches", () => {
  const speeds = make({ main: [{ duration: 150 }, { duration: 150, in: 300, speed: 3 }] });
  const s = only(speeds, "one-speed")[0]!;
  assert.match(s.message, /1× and 3×/);
  assert.deepEqual(s.itemIds, ["c2"]);
  assert.deepEqual(only(make({ main: [{ duration: 150, speed: 2 }, { duration: 150, in: 400, speed: 2 }] }), "one-speed"), [], "one speed, even if not 1×");

  const fade = { module: "move.rise", duration: 9 };
  const same = make({ texts: [{ text: "A b", animation: { in: fade } }, { text: "C d", start: 100, animation: { in: fade } }, { text: "E f", start: 200, duration: 100, animation: { in: fade } }] });
  assert.equal(only(same, "same-entrance")[0]!.severity, "info");
  assert.deepEqual(only(make({ texts: [{ text: "A b", animation: { in: fade } }, { text: "C d", start: 100 }, { text: "E f", start: 200, duration: 100, animation: { in: fade } }] }), "same-entrance"), []);

  const long = make({ main: [{ duration: 150 }, { duration: 150, in: 600, transitionIn: { module: "transition.crossfade", duration: 45 } }] });
  const l = only(long, "long-transition")[0]!;
  const fixed = applyFix(long, l);
  assert.equal(fixed.tracks.find((t) => t.id === "main")!.items[1]!.transitionIn!.duration, 9);
  assert.deepEqual(only(make({ main: [{ duration: 150 }, { duration: 150, in: 600, transitionIn: { module: "transition.crossfade", duration: 15 } }] }), "long-transition"), []);

  // Free tracks only (main empty): a text 0–3 s, then another at 5 s: 3–5 s is black.
  const gap = make({ main: [], texts: [{ text: "Start here", duration: 90 }, { text: "Later on", start: 150, duration: 150 }] });
  const g = only(gap, "blank-gap")[0]!;
  assert.deepEqual(g.range, { start: 90, end: 150 });
  assert.deepEqual(only(make(), "blank-gap"), []);
});

test("sound: silent export, music fades, ducking under speech; the fixes", () => {
  const silent = make({ main: [{ duration: 300, gainDb: -60 }] });
  // A clip at −60 still "has sound" (the mix decides); a muted main track is silent.
  const muted = { ...silent, tracks: silent.tracks.map((t) => (t.id === "main" ? { ...t, mixer: { mute: true } } : t)) };
  assert.equal(only(muted, "silent")[0]!.severity, "info");
  assert.deepEqual(only(make(), "silent"), []);

  const cold = make({ audio: [{ fadeIn: undefined, fadeOut: undefined }] });
  const f = only(cold, "music-fades")[0]!;
  assert.match(f.message, /Song\.m4a starts and stops cold/);
  const faded = applyFix(cold, f);
  const a = faded.tracks.find((t) => t.id === "music")!.items[0]!;
  assert.equal(a.fadeIn, 30);
  assert.equal(a.fadeOut, 60);
  assert.deepEqual(only(faded, "music-fades"), []);
  // Not music (a voice track): no fades asked for.
  const voice = make({ extra: [{ id: "voice", kind: "audio", name: "Voice", items: [{ id: "v1", type: "audio", media: "m-voice", in: 0, start: 0, duration: 300 }] }] });
  assert.deepEqual(only(voice, "music-fades"), []);

  // Music under the voice, not ducked: info with a duck fix under it. Main's sound counts only when it's known speech.
  const under = make({ audio: [{}], extra: [{ id: "voice", kind: "audio", name: "Voice", items: [{ id: "v1", type: "audio", media: "m-voice", in: 0, start: 0, duration: 300 }] }] });
  const d = only(under, "music-ducking")[0]!;
  assert.equal(d.severity, "info");
  assert.match(d.message, /Music plays under Voice at full level/);
  const ducked = applyFix(under, d);
  assert.deepEqual(ducked.tracks.find((t) => t.id === "music")!.mixer!.effects![0], { module: "audio.duck", params: { under: ["voice"], amountDb: -12, attackMs: 250, releaseMs: 600 } });
  const speech = projectChecks(under, { speechMedia: ["m-clip"] }).find((c) => c.id === "music-ducking")!;
  assert.match(speech.message, /Music plays under Voice and Main/);
  assert.deepEqual((speech.fix!.ops[0] as unknown as { set: { mixer: { effects: Array<{ params: { under: Array<string> } }> } } }).set.mixer.effects[0]!.params.under, ["voice", "main"]);
  // Captions made from main's footage mean it's speech too.
  const captioned = { ...under, tracks: [{ id: "caps", kind: "text", name: "Captions", items: [{ id: "cap", type: "captions", source: "m-clip", start: 0, duration: 300, words: [] }] } as Track, ...under.tracks] };
  assert.match(only(captioned, "music-ducking")[0]!.message, /Voice and Main/);
  assert.deepEqual(only(ducked, "music-ducking"), []);
  // Music alone (main footage without sound): nothing to duck under.
  const alone = make({ audio: [{}] });
  const quiet = { ...alone, media: alone.media.map((m) => (m.id === "m-clip" ? { ...m, probe: { ...m.probe, hasAudio: false } } : m)) };
  assert.deepEqual(only(quiet, "music-ducking"), []);
});

test("canvas format: info on anything but 4:5, phrased neutrally", () => {
  const wide = only(make({ canvas: { width: 1920, height: 1080, fps: 30 } }), "canvas-format")[0]!;
  assert.equal(wide.severity, "info");
  assert.match(wide.message, /16:9 is right for YouTube/);
  assert.deepEqual(only(make(), "canvas-format"), []);
});

test("checks.disabled, planDisableCheck, extra rules, a broken rule, old projects", () => {
  const p = make({ canvas: { width: 1920, height: 1080, fps: 30 }, texts: [{ text: "Done." }] });
  assert.ok(ids(projectChecks(p)).includes("trailing-period"));
  // Warnings come before info notes.
  const sev = projectChecks(p).map((c) => c.severity);
  assert.deepEqual(sev, [...sev].sort((a, b) => (a === b ? 0 : a === "warn" ? -1 : 1)));
  const off = planDisableCheck(p, "trailing-period");
  assert.deepEqual(validateOps(off.ops), []);
  assert.equal(off.summary, 'Turn off the check "No trailing period"');
  const next = applyEdit(createSession(p), { actor: "user", ops: off.ops }).project;
  assert.deepEqual(next.checks, { disabled: ["trailing-period"] });
  assert.deepEqual(validateProject(next, modules), []);
  assert.ok(!ids(projectChecks(next)).includes("trailing-period"));
  assert.ok(!ids(projectChecks(p, { disabled: ["canvas-format"] })).includes("canvas-format"));
  // Back on: the field goes away.
  assert.deepEqual(validateOps(planDisableCheck(next, "trailing-period", false).ops), []);
  const on = applyEdit(createSession(next), { actor: "user", ops: planDisableCheck(next, "trailing-period", false).ops }).project;
  assert.equal(on.checks, undefined);
  // A module's rule joins in; a throwing one is skipped.
  const extra: CheckRule = { id: "demo.always", title: "Demo", description: "Always says hi.", severity: "info", check: () => [{ key: "demo", message: "Hi." }] };
  const broken: CheckRule = { id: "demo.broken", title: "Broken", description: "Throws.", severity: "warn", check: () => { throw new Error("boom"); } };
  const all = projectChecks(p, { rules: [broken, extra] });
  assert.ok(ids(all).includes("demo.always") && ids(all).includes("trailing-period"), "added to the built-in rules");
  assert.equal(checkRule("demo.always", [extra])?.title, "Demo");
  assert.equal(checkRule("demo.always"), undefined);
  // Same id: the module's replaces the built-in one.
  const quiet: CheckRule = { id: "trailing-period", title: "Quiet", description: "Never fires.", severity: "warn", check: () => [] };
  assert.ok(!ids(projectChecks(p, { rules: [quiet] })).includes("trailing-period"));
  // Schema: checks is optional; a wrong shape is refused.
  assert.ok(validateProject({ ...p, checks: { disabled: "x" } }, modules).length > 0);
  for (const name of ["close-the-loop", "drone-montage", "drone-weekend"]) {
    const example = JSON.parse(readFileSync(`spec/examples/${name}.uncut/project.json`, "utf8")) as Project;
    assert.equal(example.checks, undefined);
    assert.deepEqual(validateProject(example, modules), [], name);
    // The shipped examples follow the house style: no warnings, only notes.
    assert.deepEqual(projectChecks(example).filter((c) => c.severity === "warn").map((c) => c.message), [], name);
    for (const c of projectChecks(example)) {
      assert.ok(c.message.length > 10 && !/[·•]/.test(c.message), `${name}: ${c.message}`);
      if (c.fix) applyFix(example, c);
    }
  }
});

test("fast: a 2,000-item project checks in well under a frame budget", () => {
  const texts = Array.from({ length: 1000 }, (_, i) => ({ text: `Line number ${i}.`, start: i * 100, duration: 90 }));
  const audio = Array.from({ length: 1000 }, (_, i) => ({ start: i * 100, duration: 90 }));
  const p = make({ texts, audio, main: [{ duration: 3000 }] });
  // CPU time of this process, best of three: the full suite runs many files in parallel, so wall
  // time measures the machine's load, not the checks.
  let ms = Infinity;
  let checks: ReturnType<typeof projectChecks> = [];
  for (let run = 0; run < 3; run++) {
    const t0 = process.cpuUsage();
    checks = projectChecks(p);
    const used = process.cpuUsage(t0);
    ms = Math.min(ms, (used.user + used.system) / 1000);
  }
  assert.ok(checks.length > 1000);
  assert.ok(ms < 250, `${ms.toFixed(1)} ms`);
});

test("History and the agent's note word turning checks off", async () => {
  const { describeOp } = await import("../../packages/core/src/index.ts");
  const p = make();
  // The whole list, not a guess at what changed (turning one back on leaves others in it).
  assert.equal(describeOp({ op: "update_project", set: { checks: { disabled: ["canvas-format"] } } }, p), "Set the checks turned off to canvas-format");
  assert.equal(describeOp({ op: "update_project", set: { checks: { disabled: ["canvas-format", "silent"] } } }, p), "Set the checks turned off to canvas-format, silent");
  // The editor's summary names the rule switched: the note says that.
  assert.equal(describeOp({ op: "update_project", set: { checks: { disabled: ["silent"] } } }, p, 'Turn on the check "Canvas for the feed"'), 'Turned on the check "Canvas for the feed"');
  assert.equal(describeOp({ op: "update_project", set: { checks: { disabled: ["silent"] } } }, p, 'Turn off the check "Has sound"'), 'Turned off the check "Has sound"');
  assert.equal(describeOp({ op: "update_project", set: { checks: null } }, p), "Turned every check back on");
});

test("dots: code, maths and bullets; periods: abbreviations (review)", () => {
  const dots = (text: string, style: Record<string, unknown> = {}) => only(make({ texts: [{ text, style: { preset: "text.title", size: 96, ...style } }] }), "dot-separators")[0];
  for (const text of ["`SELECT * FROM users`", "import * as fs", "SELECT * FROM users", "2 * 3 = 6", "**Bold** text", "Use `a · b` here"]) assert.equal(dots(text), undefined, text);
  assert.equal(dots("a * b", { font: "DM Mono" }), undefined, "a star on a mono text is code");
  const fix = (text: string) => (dots(text)!.fix!.ops[0] as unknown as { set: { text: string } }).set.text;
  assert.equal(fix("• Fast\n• Simple"), "Fast\nSimple", "a bullet list keeps its lines");
  assert.equal(dots("Fast ·\nSimple"), undefined, "a dot at a line's end isn't between words");
  assert.equal(fix("Swift · Kotlin\nRust • Go"), "Swift, Kotlin\nRust, Go", "never across lines");
  assert.equal(fix("fast * small"), "fast, small");
  const period = (text: string) => only(make({ texts: [{ text }] }), "trailing-period")[0];
  for (const text of ["Works with Expo, RN, etc.", "Swift vs.", "Made by Acme Inc.", "Pick one, e.g.", "Built with Node.js", "Done. [[Really]]"]) assert.equal(period(text), undefined, text);
  assert.equal((period("Version 2.0.")!.fix!.ops[0] as unknown as { set: { text: string } }).set.text, "Version 2.0");
  assert.equal((period("Use `npm i` today.")!.fix!.ops[0] as unknown as { set: { text: string } }).set.text, "Use `npm i` today");
});

test("the built-in looks together raise no typeface warning (review)", () => {
  let p = make({ main: [{ duration: 600 }] });
  for (const [look, start] of [["text.title", 0], ["text.kicker-title", 150], ["text.header", 300], ["text.big-title", 450], ["text.footnote", 470]] as const) {
    const plan = planInsertText(p, { look, start, duration: 120, text: "Words here" }) as { ops: Array<Op> };
    p = applyEdit(createSession(p), { actor: "user", ops: plan.ops }).project;
  }
  assert.deepEqual(only(p, "one-typeface"), []);
});

test("music: a volume-key fade counts; effects and ambient footage aren't speech (review)", () => {
  const p = make({
    main: [{ duration: 300 }],
    audio: [{ fadeIn: undefined, fadeOut: 60, gainKeys: [{ frame: 0, db: -60 }, { frame: 30, db: 0 }] }],
    extra: [{ id: "sfx", kind: "audio", name: "SFX", items: [{ id: "s1", type: "audio", media: "m-clip", in: 0, start: 100, duration: 9 }] }],
  });
  assert.deepEqual(only(p, "music-fades"), [], "the keys fade it in");
  assert.deepEqual(only(p, "music-ducking"), [], "an effect and the footage's own sound aren't a voice");
  // A fade-out made with keys counts too; a key that isn't near silence doesn't.
  const out = make({ audio: [{ fadeOut: undefined, gainKeys: [{ frame: 240, db: 0 }, { frame: 299, db: -50 }] }] });
  assert.deepEqual(only(out, "music-fades"), []);
  const dip = make({ audio: [{ fadeOut: undefined, gainKeys: [{ frame: 240, db: 0 }, { frame: 299, db: -12 }] }] });
  assert.equal(only(dip, "music-fades").length, 1);
});

test("fast with many tracks and media: 40 audio tracks, 500 media, 1,000 texts (review)", () => {
  const media = Array.from({ length: 500 }, (_, i) => ({ id: `m${i}`, kind: "audio" as const, name: `clip${i}.wav`, path: `/tmp/${i}.wav`, probe: { frames: 3000, hasAudio: true } }));
  const tracks: Array<Track> = [{ id: "main", kind: "video", role: "main", name: "Main", items: [] }];
  for (let t = 0; t < 40; t++) tracks.push({ id: `a${t}`, kind: "audio", name: t === 0 ? "Music" : t === 1 ? "Voice" : `Track ${t}`, items: Array.from({ length: 25 }, (_, i) => ({ id: `a${t}-${i}`, type: "audio" as const, media: `m${(t * 25 + i) % 500}`, in: 0, start: i * 100, duration: 90 })) });
  tracks.push({ id: "tx", kind: "text", name: "Text", items: Array.from({ length: 1000 }, (_, i) => ({ id: `t${i}`, type: "text" as const, text: "a b c d e f g h i j k l m n o p", start: i * 100, duration: 30 })) });
  const p = { format: "uncut/0", name: "x", canvas: { width: 1080, height: 1350, fps: 30 as const }, media, tracks } as Project;
  projectChecks(p);
  // CPU time of this process, best of three: the full suite runs many files in parallel, so wall
  // time measures the machine's load, not the checks.
  let ms = Infinity;
  let checks: ReturnType<typeof projectChecks> = [];
  for (let run = 0; run < 3; run++) {
    const t0 = process.cpuUsage();
    checks = projectChecks(p);
    const used = process.cpuUsage(t0);
    ms = Math.min(ms, (used.user + used.system) / 1000);
  }
  assert.ok(checks.length > 1000);
  // 100 ms on an Apple-silicon Mac, scaled on a slower machine (a CI runner): it guards against
  // a slow algorithm, not a few percent.
  assert.ok(ms < budget(100), `${ms.toFixed(1)} ms (budget ${budget(100).toFixed(0)} ms, ${slowdown().toFixed(2)}× the reference machine)`);
});
