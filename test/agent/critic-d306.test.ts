// D306: the user's notes over the critic's rules. (1) A straight cut between two footage shots isn't
// a one-take defect (the picture says so: the pixels it changes are coloured on both sides; or the
// timeline cuts from one clip to the next there); a cut in the UI still is. A request that asks for
// the footage cut on the beat is honoured. (3) Typing is a change: an open where words are typed
// from the first half second isn't static, and the typing isn't a hold.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

import { asksFootageCuts, CUT_CHANGED, clipCutFrames, footageCut, footageJump, FOOTAGE_CHROMA, motionFindings, motionIntent, motionLines, motionScan, OPEN_TYPE_S, thinSize, type ScanFrame } from "../../apps/server/src/agent/criticMotion.ts";

const fps = 60;
const W = 64, H = 80;

/** A picture of `seed` drifting slowly (one level every 10 frames), coloured or grey. */
function shot(seed: number, f: number, coloured: boolean): { gray: Uint8Array; chroma: Uint8Array } {
  const gray = new Uint8Array(W * H);
  const chroma = new Uint8Array(W * H);
  for (let i = 0; i < gray.length; i++) {
    gray[i] = (((i % W) * (3 + seed) + Math.floor(i / W) * (5 + 2 * seed) + seed * 70) % 180) + 30 + Math.floor(f / 10);
    chroma[i] = coloured ? 40 + ((i * 7 + seed) % 50) : (i % 3);
  }
  return { gray, chroma };
}

/** A film cutting at `cut` from shot 1 to shot 2; each side coloured (footage) or grey (UI). */
function cutFilm(cut: number, before: boolean, after: boolean, n = 120): Array<ScanFrame> {
  return Array.from({ length: n }, (_, f) => ({ frame: f, ...(f < cut ? shot(1, f, before) : shot(2, f, after)) }));
}

test("a cut between two coloured (footage) pictures isn't a one-take defect; a cut in the grey UI, or from the UI into footage, still blocks", () => {
  const footage = motionScan(cutFilm(60, true, true), fps);
  const j = footage.jumps.find((x) => x.frame === 60)!;
  assert.ok(j, JSON.stringify(footage.jumps));
  assert.equal(j.footage, true);
  assert.ok(j.photo! >= 0.9, String(j.photo));
  const found = motionFindings(footage, fps, { oneTake: true, hard: true });
  assert.ok(!found.some((x) => x.key?.startsWith("motion:jump:")), JSON.stringify(found));
  const lines = motionLines(footage, fps, { consecutive: true }).join("\n");
  assert.match(lines, /Cuts between two footage shots .*f 60 \(1\.00 s.*fine even in a one-take film/);
  assert.doesNotMatch(lines, /One-frame jumps and quick swaps/);

  for (const [before, after] of [[false, false], [false, true], [true, false]] as const) {
    const ui = motionScan(cutFilm(60, before, after), fps);
    assert.equal(ui.jumps.find((x) => x.frame === 60)?.footage, false, `${before} → ${after}`);
    const blocker = motionFindings(ui, fps, { oneTake: true, hard: true }).find((x) => x.key === "motion:jump:60");
    assert.ok(blocker?.hard, `${before} → ${after}: still a blocker`);
    assert.match(motionLines(ui, fps, { consecutive: true }).join("\n"), /One-frame jumps and quick swaps .*f 60/);
  }
  // Frames without colour (an older caller): judged as before.
  const plain = motionScan(cutFilm(60, true, true).map(({ chroma: _c, ...x }) => x), fps);
  assert.equal(plain.jumps[0]!.footage, undefined);
  assert.ok(motionFindings(plain, fps, { oneTake: true, hard: true }).some((x) => x.key === "motion:jump:60" && x.hard));
});

test("footageCut: the coloured share of the changed pixels on each side; too small a change says nothing", () => {
  const n = W * H;
  const a = new Uint8Array(n).fill(40), b = new Uint8Array(n).fill(40);
  for (let i = 0; i < n / 2; i++) b[i] = 40 + CUT_CHANGED + 10;
  const col = new Uint8Array(n).fill(FOOTAGE_CHROMA + 5), grey = new Uint8Array(n);
  assert.deepEqual(footageCut(a, b, col, col), { footage: true, photo: 1 });
  assert.deepEqual(footageCut(a, b, col, grey), { footage: false, photo: 0 });
  // Coloured only in the half that didn't change (a sharp grey panel swapped next to a still preview).
  const half = new Uint8Array(n);
  for (let i = n / 2; i < n; i++) half[i] = FOOTAGE_CHROMA + 5;
  assert.equal(footageCut(a, b, half, half)!.footage, false);
  const tiny = new Uint8Array(n).fill(40);
  tiny[0] = 200;
  assert.equal(footageCut(a, tiny, col, col), undefined);
});

test("the timeline's straight cuts from one clip to the next are footage cuts; a graphic cutting there isn't", () => {
  const tracks = [
    { items: [{ id: "c1", type: "clip", duration: 60 }, { id: "c2", type: "clip", duration: 60 }, { id: "c3", type: "clip", duration: 60 }] },
    { items: [{ id: "g1", type: "graphic", duration: 30 }] },
    { hidden: true, items: [{ id: "h1", type: "clip", duration: 200 }] },
  ];
  const starts = new Map([["c1", 0], ["c2", 60], ["c3", 120], ["g1", 90], ["h1", 0]]);
  assert.deepEqual(clipCutFrames(tracks, starts), [60], "c2→c3 at 120 is where the graphic ends");
  assert.deepEqual(clipCutFrames(tracks, new Map([...starts, ["g1", 300]])), [60, 120]);
  // A grey (UI-looking) cut at 60 on a clip cut: not a blocker; elsewhere it is.
  const scan = motionScan(cutFilm(60, false, false), fps);
  assert.ok(footageJump(scan.jumps[0]!, [60]));
  assert.ok(!motionFindings(scan, fps, { oneTake: true, hard: true, clipCuts: [60] }).some((x) => x.key?.startsWith("motion:jump:")));
  assert.ok(motionFindings(scan, fps, { oneTake: true, hard: true, clipCuts: [90] }).some((x) => x.key === "motion:jump:60"));
  assert.match(motionLines(scan, fps, { consecutive: true, clipCuts: [60] }).join("\n"), /Cuts between two footage shots .*f 60/);
  // cutsHard: the other cuts as findings, not blockers.
  assert.equal(motionFindings(scan, fps, { oneTake: true, hard: true, cutsHard: false }).find((x) => x.key === "motion:jump:60")!.hard, false);
});

test("asksFootageCuts: footage, a cut and the beat in one clause, not negated; the favourite's one take on the beat isn't it", () => {
  for (const yes of ["Cut the drone clips to the song.", "Make a launch film: footage cut on the beat, the UI in one take.", "One take for the app parts, but cut between the drone shots on the beat.", "chop my clips to the music", "Cut my drone clips into a reel on the beat"]) assert.ok(asksFootageCuts(yes), yes);
  for (const no of ["Make a 28s launch film for Uncut, this app: one take on the beat, show me typing this prompt and the agent editing the video.", "One continuous shot, cut on the beat.", "Don't cut the drone clips on the beat, morph them.", "Cut the drone clips.", "No cuts between the clips on the beat", "music only, the drone footage in one take"]) assert.ok(!asksFootageCuts(no), no);
  const intent = motionIntent({ skills: ["motion-film"], words: "", request: "One take, footage cut on the beat." });
  assert.deepEqual([intent.oneTake, intent.asked, intent.footageCuts], [true, true, true]);
  assert.equal(motionIntent({ skills: [], words: "Cut the drone clips to the song", request: "Make a promo" }).footageCuts, false, "the brief's words are the agent's, not the user's");
});

// The fine grey (thinSize) of an open: a still, softly textured stage, and on it a card where a line
// is typed (a 5 × 6 px glyph every 6 frames from `from`), a cursor that blinks, or everything drifting.
const FINE = thinSize({ width: 1080, height: 1350 });
function open(kind: "typing" | "blink" | "drift", n = 150, from = 6): Array<ScanFrame> {
  const still = new Uint8Array(W * H).fill(40);
  return Array.from({ length: n }, (_, f) => {
    const fine = new Uint8Array(FINE.w * FINE.h);
    const shift = kind === "drift" ? Math.floor(f / 10) : 0;
    for (let i = 0; i < fine.length; i++) fine[i] = 30 + ((((i % FINE.w) + shift) >> 2) % 2) * 60;
    const set = (x0: number, y0: number, w: number, h: number, v: number) => {
      for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) fine[y * FINE.w + x] = v;
    };
    set(20, 150, 160, 40, 25);
    if (kind === "typing") for (let g = 0; g < Math.min(25, Math.floor((f - from) / 6) + 1) && f >= from; g++) set(24 + (g % 20) * 7, 156 + Math.floor(g / 20) * 10, 5, 6, 230);
    if (kind === "blink" && Math.floor(f / 30) % 2 === 0) set(24, 156, 1, 6, 230);
    return { frame: f, gray: still, fine };
  });
}

test("typing is a change: an open typed from the first half second isn't static, and its typing isn't a hold; a blink or a drift is", () => {
  const typing = motionScan(open("typing"), fps, { fine: FINE });
  assert.ok(typing.open!.typing !== undefined && typing.open!.typing <= OPEN_TYPE_S * fps, JSON.stringify(typing.open));
  assert.equal(typing.open!.frame, undefined, "the 64 px grey sees nothing");
  const found = motionFindings(typing, fps, { oneTake: true, hard: true, still: 4 });
  assert.ok(!found.some((x) => x.key === "motion:open:0" || x.key?.startsWith("motion:hold:") || x.key?.startsWith("motion:still:")), JSON.stringify(found.map((x) => x.key)));
  assert.match(motionLines(typing, fps, { consecutive: true }).join("\n"), /typing shows from f \d+ \(0\.\d\d s\)\./);
  // Sampled every 0.15 s, as review_submit samples a long film.
  const sampled = motionScan(open("typing").filter((x) => x.frame % 9 === 0), fps, { fine: FINE });
  assert.ok(sampled.open!.typing !== undefined && sampled.open!.typing <= OPEN_TYPE_S * fps, JSON.stringify(sampled.open));
  // Typing that starts late (after OPEN_TYPE_S) leaves the open static.
  const late = motionScan(open("typing", 150, 50), fps, { fine: FINE });
  assert.ok(motionFindings(late, fps, { oneTake: true }).some((x) => x.key === "motion:open:0"), JSON.stringify(late.open));
  for (const kind of ["blink", "drift"] as const) {
    const scan = motionScan(open(kind), fps, { fine: FINE });
    assert.equal(scan.open!.typing, undefined, kind);
    const keys = motionFindings(scan, fps, { oneTake: true, hard: true }).map((x) => x.key);
    assert.ok(keys.includes("motion:open:0"), `${kind}: ${keys.join(", ")}`);
  }
  assert.ok(motionScan(open("blink"), fps, { fine: FINE }).holds.length, "a blinking cursor alone is still a hold");
  // Without the fine grey: judged as before.
  assert.ok(motionFindings(motionScan(open("typing"), fps), fps, { oneTake: true }).some((x) => x.key === "motion:open:0"));
});

test("the critic is told: footage cuts aren't one-take defects, keyboard sounds on typing are fine unless the request says music only, a typed composer open isn't blank", async () => {
  const { CRITIC_SYSTEM, criticText } = await import("../../apps/server/src/agent/agentCritic.ts");
  const { reviewRubric } = await import("../../packages/core/src/skills/skills.ts");
  assert.match(CRITIC_SYSTEM, /a straight cut between two footage shots never is/);
  assert.match(CRITIC_SYSTEM, /cuts it doesn't ask for other than straight cuts between footage shots/);
  assert.match(CRITIC_SYSTEM, /a keyboard sound on words being typed is not a click on text/);
  assert.match(CRITIC_SYSTEM, /A sharp composer card over the blurred editor while words are typed into it is an open, not this/);
  const brief = { film: "A launch film", audience: "devs", duration: "28 s", formats: ["4:5"], assets: [], visual: "", hardLines: [], deliverables: [], notes: "Music only, no added sound effects.", type: "launch-promo" };
  const text = criticText({ round: 1, canvas: { width: 1080, height: 1350, fps: 60 }, frames: 1680, brief, images: [], checks: [], claims: [], determinism: { checked: [], differed: [] }, skills: [], kit: [], previous: undefined, request: "Make a launch film with keyboard sounds.", sound: [], rubric: reviewRubric(brief, { request: "Make a launch film with keyboard sounds." }) } as never);
  assert.match(text, /a keyboard sound on typing and a click on a cursor's press are welcome/);
  assert.doesNotMatch(text, /sound profile music only/i, "the agent's brief doesn't make it music only");
});

test("chromaFrames decodes review JPEGs into each pixel's colour (as review_submit's decode does)", { skip: spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).error ? "needs ffmpeg" : false }, async () => {
  const { chromaFrames, grayFrames } = await import("../../apps/server/src/agent/criticMotion.ts");
  const jpeg = (src: string) => spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", src, "-frames:v", "1", "-f", "mjpeg", "-"], { maxBuffer: 1 << 24 }).stdout as Buffer;
  const [colour, grey] = await chromaFrames("ffmpeg", [jpeg("testsrc=size=200x250"), jpeg("color=c=gray:size=200x250")], W, H);
  assert.equal(colour!.length, W * H);
  assert.ok(colour!.filter((v) => v >= FOOTAGE_CHROMA).length > 0.5 * W * H, "testsrc is mostly coloured");
  assert.ok(grey!.every((v) => v < FOOTAGE_CHROMA), "a grey frame has no colour");
  assert.equal((await grayFrames("ffmpeg", [jpeg("testsrc=size=200x250")], W, H))[0]!.length, W * H, "grey decoding unchanged");
});
