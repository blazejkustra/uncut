// D193: bundled libraries for graphic items. uncut:lib/ markers resolve to inline scripts (known
// ones; unknown ones become a comment and show up in graphicLibsUsed), the author's code around
// them is untouched, the size cap is the author's file's (readGraphics), every library together
// stays under the export's data: URL budget, and Uncut's own libraries are pure: run in a VM with
// a fake 2D context, the same t draws the same calls, another seed draws others. uncutSpring is
// core's spring, value for value.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runInNewContext } from "node:vm";

import { GRAPHIC_LIBS, GRAPHIC_LIBS_DOC, graphicDocument, graphicLibsUsed, MAX_GRAPHIC_BYTES, MAX_GRAPHIC_DOC_BYTES, resolveGraphicLibs, SPRING_NAMES, SPRING_PRESETS, springAt, springEase, springSettleTime, springState, type Project } from "../../packages/core/src/index.ts";
import { readGraphics } from "../../apps/server/src/export/exporter.ts";
import { loadGraphicLibs } from "../../apps/server/src/export/graphicLibs.ts";

const DIR = resolve("assets/graphic-libs");
const source = (name: string) => readFileSync(join(DIR, name), "utf8");

test("markers: known libraries are inlined, unknown ones become a comment, the rest of the HTML is untouched", () => {
  const libs = { "three.js": "window.THREE = { ok: 1 };", "spring.js": "window.uncutSpring = 1; var s = '</script>';" };
  const html = `<canvas id="c"></canvas>
<script src="uncut:lib/three.js"></script>
<SCRIPT SRC='uncut:lib/spring.js' ></script >
<script src="uncut:lib/three.js"></script>
<script src="uncut:lib/nope.js"></script>
<script>const label = "uncut:lib/three.js"; window.render = (t) => {};</script>`;
  const out = resolveGraphicLibs(html, libs);
  assert.equal(out.split("window.THREE = { ok: 1 };").length - 1, 1, "a library is inlined once");
  assert.match(out, /<!-- uncut:lib\/three\.js is already loaded above -->/, "a repeated marker is a comment");
  assert.match(out, /<script>\/\* uncut:lib\/spring\.js \*\/\nwindow\.uncutSpring = 1; var s = '<\\\/script>';\n<\/script>/, "a </script inside a library can't close its tag");
  assert.match(out, /<!-- uncut:lib\/nope\.js is not a bundled library \(bundled: three\.js, confetti\.js, globe\.js, spring\.js, random\.js\) -->/);
  assert.ok(out.startsWith('<canvas id="c"></canvas>\n'));
  assert.ok(out.endsWith('<script>const label = "uncut:lib/three.js"; window.render = (t) => {};</script>'), "a marker-like string in the author's code stays");
  assert.ok(!/src="uncut:lib/.test(out.replace('"uncut:lib/three.js";', "")), "no marker left");
  // A known name whose source isn't there (a broken install) is a comment too.
  assert.match(resolveGraphicLibs('<script src="uncut:lib/globe.js"></script>', {}), /uncut:lib\/globe\.js is not a bundled library/);
  // Only real names: an own-property check, not "constructor" or "__proto__".
  assert.match(resolveGraphicLibs('<script src="uncut:lib/constructor"></script>', libs), /not a bundled library/);
  // No markers: the HTML as it was.
  assert.equal(resolveGraphicLibs("<div>x</div><script>window.render=()=>{}</script>", libs), "<div>x</div><script>window.render=()=>{}</script>");
  assert.deepEqual(graphicLibsUsed(html), { known: ["three.js", "spring.js"], unknown: ["nope.js"] });
  assert.deepEqual(graphicLibsUsed("<script>render()</script>"), { known: [], unknown: [] });
});

test("readGraphics: the cap is on the author's file; markers resolve with the bundled sources; the whole document fits the export", async () => {
  const libs = await loadGraphicLibs(DIR);
  assert.deepEqual(Object.keys(libs).sort(), [...GRAPHIC_LIBS].sort(), "every library is bundled");
  assert.match(libs["three.js"]!, /^\/\* three\.js 0\.169\.0 \(MIT/);
  assert.match(libs["three.js"]!, /@license[\s\S]*Three\.js Authors[\s\S]*SPDX-License-Identifier: MIT/, "three's licence header kept");
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "uncut-graphic-libs-")));
  try {
    mkdirSync(join(tmp, "graphics"));
    // Every library, each asked for twice (the second is a comment, so this is the biggest document there can be).
    const all = [...GRAPHIC_LIBS, ...GRAPHIC_LIBS].map((n) => `<script src="uncut:lib/${n}"></script>`).join("\n");
    // An author's file just under the cap that loads every library.
    const big = `${all}\n<script>/*${"x".repeat(MAX_GRAPHIC_BYTES - all.length - 200)}*/</script>`;
    assert.ok(Buffer.byteLength(big) <= MAX_GRAPHIC_BYTES);
    writeFileSync(join(tmp, "graphics", "big.html"), big);
    writeFileSync(join(tmp, "graphics", "over.html"), `${all}${"y".repeat(MAX_GRAPHIC_BYTES)}`);
    const project = { tracks: [{ items: [{ type: "graphic", src: "graphics/big.html" }, { type: "graphic", src: "graphics/over.html" }] }] } as unknown as Project;
    const read = await readGraphics(tmp, project, libs);
    assert.equal(read.has("graphics/over.html"), false, "an author's file over the cap isn't read");
    const html = read.get("graphics/big.html")!;
    assert.ok(Buffer.byteLength(html) > MAX_GRAPHIC_BYTES, "the libraries don't count toward the cap");
    for (const n of GRAPHIC_LIBS) assert.ok(html.includes(`/* uncut:lib/${n} */`), n);
    const doc = graphicDocument(html, { width: 1920, height: 1080 });
    assert.ok(Buffer.byteLength(doc) < MAX_GRAPHIC_DOC_BYTES, `the whole document: ${Buffer.byteLength(doc)} bytes`);
    // base64 of it as the export's data: URL stays under Chromium's 2 MB URL limit.
    assert.ok(`data:text/html;base64,${Buffer.from(doc).toString("base64")}`.length < 2 * 1024 * 1024);
    // Without the sources (the two-argument call), markers are comments.
    assert.match((await readGraphics(tmp, project)).get("graphics/big.html")!, /uncut:lib\/three\.js is not a bundled library/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

/** A fake 2D context that records every call and property set, rounded so the log compares exactly. */
function recorder(width = 1280, height = 720) {
  const log: Array<string> = [];
  const r = (v: unknown) => (typeof v === "number" ? Math.round(v * 1e6) / 1e6 : v);
  const target: Record<string, unknown> = { canvas: { width, height } };
  const ctx = new Proxy(target, {
    get(t, key) {
      if (key in t) return t[key as string];
      return (...args: Array<unknown>) => log.push(`${String(key)}(${args.map(r).join(",")})`);
    },
    set(t, key, value) {
      t[key as string] = value;
      log.push(`${String(key)}=${String(r(value))}`);
      return true;
    },
  });
  return { ctx, log };
}

/** Run a library's source in a fresh context with only `window` (and Math etc.), as a classic script would. */
function load(name: string): Record<string, unknown> {
  const window: Record<string, unknown> = {};
  runInNewContext(source(name), { window });
  return window;
}

test("confetti: a pure function of t and its seed", () => {
  const { uncutConfetti } = load("confetti.js") as { uncutConfetti: { draw: (ctx: unknown, t: number, o?: unknown) => number } };
  const draw = (t: number, o: Record<string, unknown>) => {
    const { ctx, log } = recorder();
    const n = uncutConfetti.draw(ctx, t, o);
    return { n, log: log.join("\n") };
  };
  const a = draw(0.8, { seed: 7, count: 120 });
  assert.ok(a.n > 50, `drew ${a.n}`);
  // Any order, any number of times, a fresh copy of the library: the same calls.
  draw(2.5, { seed: 7, count: 120 });
  assert.deepEqual(draw(0.8, { seed: 7, count: 120 }), a);
  const fresh = load("confetti.js") as { uncutConfetti: typeof uncutConfetti };
  const { ctx, log } = recorder();
  fresh.uncutConfetti.draw(ctx, 0.8, { seed: 7, count: 120 });
  assert.equal(log.join("\n"), a.log);
  assert.notEqual(draw(0.8, { seed: 8, count: 120 }).log, a.log, "another seed, another burst");
  assert.notEqual(draw(0.9, { seed: 7, count: 120 }).log, a.log, "it moves");
  assert.equal(draw(0.5, { seed: 7, at: 1 }).n, 0, "nothing before it starts");
  assert.equal(draw(30, { seed: 7 }).n, 0, "gone after its life");
  // One particle goes up, then gravity brings it down.
  const ys: Array<number> = [];
  for (let t = 0.05; t < 6; t += 0.05) {
    const line = draw(t, { seed: 3, count: 1, origin: { x: 0.5, y: 0.5 }, life: 10 }).log.split("\n").find((l) => l.startsWith("translate("));
    if (line) ys.push(Number(line.slice(10, -1).split(",")[1]));
  }
  const top = Math.min(...ys);
  assert.ok(ys[0]! > top && ys.at(-1)! > top + 100, `up then down: ${ys[0]} to ${top} to ${ys.at(-1)}`);
});

test("globe: a pure function of t; it turns; markers project where they're drawn", () => {
  const { uncutGlobe } = load("globe.js") as { uncutGlobe: { draw: (ctx: unknown, t: number, o?: unknown) => void; project: (ctx: unknown, t: number, lat: number, lon: number, o?: unknown) => { x: number; y: number; visible: boolean }; isLand: (lat: number, lon: number) => boolean } };
  const options = { dots: 3000, speed: 30, markers: [{ lat: 52.2, lon: 21 }, { lat: 40.7, lon: -74 }] };
  const draw = (t: number, o: Record<string, unknown> = options) => {
    const { ctx, log } = recorder();
    uncutGlobe.draw(ctx, t, o);
    return log.join("\n");
  };
  const a = draw(1.25);
  assert.ok(a.split("\n").filter((l) => l.startsWith("arc(")).length > 200, "land dots drawn");
  draw(4);
  assert.equal(draw(1.25), a);
  assert.notEqual(draw(1.3), a, "it turns");
  assert.notEqual(draw(1.25, { ...options, rotation: 90 }), a);
  // Land and sea (a coarse outline, but the right side of the Atlantic).
  assert.equal(uncutGlobe.isLand(48.8, 2.3), true, "Paris");
  assert.equal(uncutGlobe.isLand(40.7, -80), true, "Pennsylvania");
  assert.equal(uncutGlobe.isLand(35, -40), false, "mid-Atlantic");
  assert.equal(uncutGlobe.isLand(-25, 134), true, "Australia");
  // A marker facing the viewer is drawn at its projected place.
  const { ctx } = recorder();
  const p = uncutGlobe.project(ctx, 0, 0, 0, { rotation: 0, tilt: 0 });
  assert.ok(p.visible && Math.abs(p.x - 640) < 1e-9 && Math.abs(p.y - 360) < 1e-9, JSON.stringify(p));
  assert.equal(uncutGlobe.project(ctx, 0, 0, 180, { rotation: 0, tilt: 0 }).visible, false, "the far side is hidden");
  assert.ok(uncutGlobe.project(ctx, 3, 0, 90, { rotation: 0, speed: 30, tilt: 0 }).visible, "after 3 s at 30 degrees a second, longitude 90 faces the viewer");
});

test("random: seeded, repeatable, and spread over [0, 1)", () => {
  const { uncutRandom } = load("random.js") as { uncutRandom: ((seed: unknown) => (() => number) & { range: (a: number, b: number) => number; int: (a: number, b: number) => number; pick: <T>(l: Array<T>) => T; normal: () => number }) & { at: (seed: unknown, i: number) => number; noise: (seed: unknown, x: number) => number } };
  const take = (seed: unknown, n = 1000) => {
    const r = uncutRandom(seed);
    return Array.from({ length: n }, () => r());
  };
  assert.deepEqual(take(42), take(42));
  assert.deepEqual(take("hello"), take("hello"));
  assert.notDeepEqual(take(42), take(43));
  const v = take(1, 20000);
  assert.ok(v.every((x) => x >= 0 && x < 1));
  const mean = v.reduce((s, x) => s + x, 0) / v.length;
  assert.ok(Math.abs(mean - 0.5) < 0.01, `mean ${mean}`);
  const r = uncutRandom(5);
  for (let i = 0; i < 200; i++) {
    const n = r.int(3, 6);
    assert.ok(Number.isInteger(n) && n >= 3 && n <= 6);
    const x = r.range(-2, 2);
    assert.ok(x >= -2 && x < 2);
  }
  assert.equal(uncutRandom.at(9, 17), uncutRandom.at(9, 17));
  assert.notEqual(uncutRandom.at(9, 17), uncutRandom.at(9, 18));
  // Noise is smooth: small steps, small changes; integers hit the lattice values.
  for (let x = 0; x < 10; x += 0.01) assert.ok(Math.abs(uncutRandom.noise(3, x + 0.01) - uncutRandom.noise(3, x)) < 0.05);
  assert.equal(uncutRandom.noise(3, 4), uncutRandom.at(3, 4));
});

test("spring.js is core's spring, value for value", () => {
  const { uncutSpring } = load("spring.js") as { uncutSpring: ((t: number, s: unknown) => number) & { state: (t: number, s: unknown) => { value: number; velocity: number }; settle: (s: unknown) => number; ease: (s: unknown) => (p: number) => number; presets: Record<string, unknown> } };
  assert.deepEqual(Object.keys(uncutSpring.presets).sort(), [...SPRING_NAMES].sort());
  const params = [...SPRING_NAMES, { stiffness: 100, damping: 20 }, { stiffness: 100, damping: 50, mass: 2, velocity: 1 }, { stiffness: 80, damping: 6, velocity: -3 }];
  for (const p of params) {
    for (let t = -0.1; t < 3; t += 0.037) {
      assert.equal(uncutSpring(t, p), springAt(p, t), `${JSON.stringify(p)} at ${t}`);
      assert.deepEqual({ ...uncutSpring.state(t, p) }, springState(p, t));
    }
    assert.equal(uncutSpring.settle(p), springSettleTime(p));
    const a = uncutSpring.ease(p);
    const b = springEase(p);
    for (let x = 0; x <= 1; x += 0.05) assert.equal(a(x), b(x));
  }
  for (const n of SPRING_NAMES) assert.deepEqual({ ...(uncutSpring.presets[n] as object) }, { ...SPRING_PRESETS[n] });
});

test("libraries: no clocks, no Math.random, no timers, nothing that closes an inline script; the doc covers the contract", () => {
  for (const n of ["confetti.js", "globe.js", "spring.js", "random.js"]) {
    const s = source(n);
    // The code, not its comments (which say what not to use).
    assert.doesNotMatch(s.replace(/\/\*[\s\S]*?\*\//g, ""), /Math\.random|Date\.now|performance\.now|setTimeout|setInterval|requestAnimationFrame|new Date/, n);
    assert.doesNotMatch(s, /<\/script|<!--/i, n);
  }
  assert.doesNotMatch(source("three.js"), /<\/script|<!--/i);
  for (const word of ["render(t", "requestAnimationFrame", "Date.now", "Math.random", "uncutRandom(seed)", "preserveDrawingBuffer: true", "info.width", 'src="uncut:lib/three.js"', "uncutConfetti.draw", "uncutGlobe.draw", "uncutSpring(", "renderer.render"]) assert.ok(GRAPHIC_LIBS_DOC.includes(word), word);
  for (const n of GRAPHIC_LIBS) assert.ok(GRAPHIC_LIBS_DOC.includes(`uncut:lib/${n}`), n);
  assert.doesNotMatch(GRAPHIC_LIBS_DOC, /[·•*]/);
});
