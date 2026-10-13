// Phase 6 chunk 2 (D76, D77, D78): components drawn from their manifests by core's registry,
// device frames (bezel + footage clip, aligned by the screen rect), graphic documents, SVG sizes,
// and the editor's and agent's planners. Pure: no processes (the export of all this is in
// export.test.ts, the app in components-app.test.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  applyEdit,
  bezelSvg,
  componentBox,
  componentDefaults,
  componentHtml,
  componentInfo,
  COMPONENTS,
  createSession,
  describeOp,
  deviceSpec,
  DEVICES,
  DRAWN_COMPONENTS,
  graphicDocument,
  GRAPHIC_CSP,
  layout,
  loadModules,
  planDeviceFrame,
  screenKeys,
  screenRect,
  screenTransform,
  terminalState,
  UNDRAWN_COMPONENTS,
  validateModule,
  validateProject,
  visualsAt,
  type Item,
  type ModuleManifest,
  type Project,
} from "../packages/core/src/index.ts";
import { capStates } from "../apps/server/src/exportPlan.ts";
import { expandDeviceFrames, mcpTools, modulesList, stepLabel, SYSTEM_PROMPT, TOOL_NAMES } from "../apps/server/src/agentTools.ts";
import { svgSize } from "../apps/server/src/svg.ts";
import { planAddComponent, planAlignScreen, planComponentProps, planDevice, planScreenFootage, screenClipOf } from "../apps/web/src/components.ts";
import { clipState, planClipBox } from "../apps/web/src/clip.ts";
import { itemLabel } from "../apps/web/src/project.ts";

const BUILTIN = fileURLToPath(new URL("../spec/modules/builtin/", import.meta.url));
const modules = await loadModules(BUILTIN);
const manifests = readdirSync(BUILTIN)
  .filter((f) => f.startsWith("component."))
  .map((f) => JSON.parse(readFileSync(BUILTIN + f, "utf8")) as ModuleManifest);
const target = { canvas: { width: 1920, height: 1080 } };

function project(items: Array<{ track: string; item: Item }> = [], extra: Partial<Project> = {}): Project {
  const tracks = [
    { id: "text", kind: "text" as const, name: "Text", items: [] as Array<Item> },
    { id: "overlay", kind: "video" as const, name: "Overlay", items: [] as Array<Item> },
    { id: "main", kind: "video" as const, role: "main" as const, name: "Main", items: [{ id: "bg", type: "component" as const, component: "component.solid", duration: 300, props: { color: "bg" } }] as Array<Item> },
  ];
  for (const { track, item } of items) tracks.find((t) => t.id === track)!.items.push(item);
  return {
    format: "uncut/0",
    name: "Components",
    canvas: { width: 1920, height: 1080, fps: 30 },
    media: [
      { id: "m-rec", kind: "video", name: "rec.mp4", path: "/x/rec.mp4", probe: { frames: 600, fps: 30, width: 1170, height: 2532, hasAudio: false } },
      { id: "m-logo", kind: "image", name: "logo.svg", path: "/x/logo.svg", probe: { width: 200, height: 60 } },
      { id: "m-short", kind: "video", name: "short.mp4", path: "/x/short.mp4", probe: { frames: 60, fps: 30, width: 1080, height: 1920 } },
    ],
    tracks,
    ...extra,
  };
}
const valid = (p: Project) => assert.deepEqual(validateProject(p, modules), [], "the project validates");
const apply = (p: Project, ops: ReadonlyArray<unknown>) => applyEdit(createSession(p), { actor: "user", ops: ops as never }).project;

test("every built-in component manifest is drawn by core's registry or listed as not drawn yet; every renderer has its manifest; defaults validate", () => {
  for (const m of manifests) {
    assert.deepEqual(validateModule(m), [], `${m.id} matches the module schema`);
    assert.equal(m.kind, "component");
    const drawn = componentInfo(m.id) || m.id === "component.solid";
    assert.ok(drawn ? !UNDRAWN_COMPONENTS[m.id] : !!UNDRAWN_COMPONENTS[m.id], `${m.id}: drawn (${!!drawn}) or listed as not drawn, not both`);
  }
  assert.deepEqual(
    [...DRAWN_COMPONENTS, ...Object.keys(UNDRAWN_COMPONENTS)].sort(),
    manifests.map((m) => m.id).sort(),
    "the registry and the undrawn list cover exactly the built-in component manifests",
  );
  for (const c of COMPONENTS) {
    const m = modules.get(c.id)!;
    assert.ok(m, `${c.id} has a manifest`);
    assert.deepEqual(c.params, m.params, `${c.id}: the registry reads the manifest's params`);
    assert.deepEqual(c.block, m.component, `${c.id}: and its component block`);
    assert.ok(c.block.size.width > 0 && c.block.size.height > 0);
    // A new one (its defaults) is a valid item; a wrong prop is refused.
    valid(project([{ track: "overlay", item: { id: "c1", type: "component", component: c.id, start: 0, duration: 90, props: componentDefaults(c.id) } }]));
    const bad = validateProject(project([{ track: "overlay", item: { id: "c1", type: "component", component: c.id, start: 0, duration: 90, props: { ...componentDefaults(c.id), nope: 1 } } }]), modules);
    assert.ok(bad.some((e) => e.code === "params"), `${c.id}: an unknown prop is refused`);
  }
  // Only the terminal, the agent log and the compare table change from frame to frame.
  assert.deepEqual(COMPONENTS.filter((c) => c.block.animated).map((c) => c.id), ["component.terminal", "component.agent-log", "component.compare-table"]);
  // Every device has a frame size and a screen inside it.
  assert.deepEqual([...DEVICES].sort(), [...(modules.get("component.device-frame")!.params as { properties: { device: { enum: Array<string> } } }).properties.device.enum].sort());
  for (const d of DEVICES) {
    const s = deviceSpec(d);
    assert.ok(s.screen.x >= 0 && s.screen.y >= 0 && s.screen.x + s.screen.width <= s.size.width && s.screen.y + s.screen.height <= s.size.height, `${d}: the screen is inside the frame`);
  }
});

test("the HTML of each component: a wrapper at its box with its body; deterministic; static ones the same at every frame", () => {
  const html = (id: string, props: Record<string, unknown>, local = 30, extra: Partial<Item> = {}, t: Parameters<typeof componentHtml>[1] = target) =>
    componentHtml({ id: "c1", type: "component", component: id, duration: 120, props, ...extra }, t, local);
  for (const c of COMPONENTS) {
    const a = html(c.id, componentDefaults(c.id));
    assert.match(a, new RegExp(`^<div class="pv-comp" data-item="c1" data-component="${c.id}" style="left:[\\d.-]+px;top:[\\d.-]+px;width:[\\d.]+px;height:[\\d.]+px;opacity:1">`), `${c.id} wrapper`);
    assert.ok(a.endsWith("</div>"));
    assert.equal(a, html(c.id, componentDefaults(c.id)), `${c.id}: the same item and frame give the same HTML`);
    if (!c.block.animated) assert.equal(html(c.id, componentDefaults(c.id), 0), html(c.id, componentDefaults(c.id), 99), `${c.id}: static`);
    assert.doesNotMatch(a, /<video|<script|<iframe/i, `${c.id}: no footage or scripts inside a component`);
  }
  // End card: logo (through the target's mediaUrl), title with markup, the code chip and the URL, centred, filling the canvas.
  const end = html("component.end-card", { logo: { media: "m-logo" }, title: "Argent [[for agents]]", code: "npx @swmansion/argent init", url: "argent.swmansion.com", background: "bg" }, 0, {}, { ...target, mediaUrl: (id) => `data:image/svg+xml;base64,${id}` });
  assert.match(end, /left:0px;top:0px;width:1920px;height:1080px/);
  assert.match(end, /<img src="data:image\/svg\+xml;base64,m-logo"/);
  assert.match(end, /Argent <span class="accent">for agents<\/span>/);
  assert.match(end, /npx @swmansion\/argent init/);
  assert.match(end, /argent\.swmansion\.com/);
  assert.match(end, /font-family:'DM Sans'/);
  assert.match(end, /font-family:'DM Mono'/);
  assert.match(end, /background:#0A0A0B/, "background: the theme's bg");
  // Without a mediaUrl (or with an unsafe one) there is no logo.
  assert.doesNotMatch(html("component.end-card", { logo: { media: "m-logo" } }), /<img/);
  assert.doesNotMatch(html("component.end-card", { logo: { media: "m-logo" } }, 0, {}, { ...target, mediaUrl: () => "javascript:alert(1)" }), /<img/);
  // Text is escaped.
  assert.match(html("component.end-card", { title: "<b>x</b>", url: "\"><script>" }), /&lt;b&gt;x&lt;\/b&gt;.*&quot;&gt;&lt;script&gt;/s);
  // Device frame: an SVG bezel with a transparent hole (evenodd) and a camera pill; centred at its default size.
  const phone = html("component.device-frame", { device: "phone" });
  assert.match(phone, /left:750px;top:100px;width:420px;height:880px/);
  assert.match(phone, /<svg [^>]*viewBox="0 0 420 880"/);
  assert.match(phone, /fill-rule="evenodd"/);
  assert.match(phone, /<rect x="150" y="32" width="120" height="34" rx="17" fill="#000"\/>/);
  assert.match(html("component.device-frame", { device: "android" }), /<circle /);
  assert.match(html("component.device-frame", { device: "browser", url: "argent.dev" }), /argent\.dev<\/text>/);
  // Code block: one row per line, the prompt, + / - lines coloured.
  const code = html("component.code-block", { code: "npm i\n+ added\n- removed", file: "a.sh", prompt: true });
  assert.equal(code.match(/white-space:pre;/g)!.length, 3, "three code lines");
  assert.match(code, />a\.sh</, "under the file name");
  assert.equal(code.match(/\$ </g)!.length, 3);
  assert.match(code, /text-decoration:line-through/);
  // Chart: a column, its value and its label per bar; the accent bar in the theme's accent.
  const chart = html("component.chart", { bars: [{ label: "Swift", value: 42 }, { label: "RN", value: 12.5, accent: true }, { label: "Kotlin", value: 0 }], unit: " min" });
  assert.match(chart, />42 min</);
  assert.match(chart, />12.5 min</);
  assert.match(chart, />Kotlin</);
  assert.equal(chart.match(/background:#99DAFF/g)!.length, 1, "one accent bar");
  // Size follows the box: a component with w only keeps its shape; scale and keys move it.
  const resized = componentBox({ type: "component", component: "component.chart", transform: { x: 0, y: 0, w: 500 } }, target.canvas, 0)!;
  assert.deepEqual([resized.w, resized.h], [500, 300]);
  const keyed = { type: "component" as const, component: "component.code-block", transform: { x: 100, y: 100 }, keys: [{ frame: 0, x: 100, opacity: 0 }, { frame: 10, x: 300, opacity: 1 }] };
  assert.deepEqual([componentBox(keyed, target.canvas, 5)!.x, componentBox(keyed, target.canvas, 5)!.opacity], [200, 0.5]);
  // A vertical canvas: sizes scale by the shorter side (1080 here), centred.
  const tall = componentBox({ type: "component", component: "component.terminal" }, { width: 1080, height: 1920 }, 0)!;
  assert.deepEqual([tall.x, tall.y, tall.w, tall.h], [40, 650, 1000, 620]);
  // Not a component the registry draws: nothing.
  assert.equal(componentBox({ type: "component", component: "component.callout" }, target.canvas, 0), undefined);
  assert.equal(componentHtml({ id: "x", type: "component", component: "component.callout", duration: 9, props: { label: "x" } }, target, 0), "");
});

test("terminal: input lines type in by frame, output lines appear after them; N distinct looks for N typed states, capped by the export", () => {
  const props = { typeFrom: 10, speed: 30, lines: [{ text: "npx init", kind: "input" }, { text: "done" }, { text: "ls", kind: "input", at: 60 }] };
  const shown = (f: number) => terminalState(props, f, 30).lines.map((l) => l.shown).join("|");
  assert.equal(shown(0), "", "before typeFrom nothing is typed");
  assert.equal(terminalState(props, 0, 30).idle, true, "a prompt with the cursor waits for the first input");
  assert.equal(shown(10), "");
  assert.equal(shown(13), "npx");
  assert.equal(shown(17), "npx ini");
  assert.equal(shown(18), "npx init");
  // Typed in 8 frames, then a quarter second (8 frames) before the output.
  assert.equal(shown(25), "npx init");
  assert.equal(shown(26), "npx init|done");
  assert.equal(shown(59), "npx init|done", "the next input waits for its frame");
  assert.equal(shown(61), "npx init|done|l");
  assert.equal(shown(200), "npx init|done|ls");
  assert.equal(terminalState(props, 200, 30).idle, true);
  // The HTML changes exactly when a character lands or a line appears.
  const looks = Array.from({ length: 90 }, (_, f) => componentHtml({ id: "t", type: "component", component: "component.terminal", duration: 90, props }, target, f));
  const distinct = new Set(looks).size;
  assert.equal(distinct, new Set(Array.from({ length: 90 }, (_, f) => `${shown(f)}|${terminalState(props, f, 30).idle}`)).size);
  const capped = capStates(looks, 5);
  assert.ok(capped.states.length <= 5 && capped.hold > 1, `capped to ${capped.states.length} looks, holding ${capped.hold}`);
  assert.deepEqual(capStates(looks).states.length, distinct, "under the cap every look is drawn");
});

test("device frame planner: the footage clip's box is the frame's screen, under the frame, both new tracks above main and under the text", () => {
  const p = project();
  const plan = planDeviceFrame(p, { media: "m-rec", start: 30, duration: 120, in: 15, frameId: "phone", clipId: "rec" });
  assert.ok(!("problem" in plan), JSON.stringify(plan));
  const after = apply(p, plan.ops);
  valid(after);
  const frame = after.tracks.flatMap((t) => t.items).find((i) => i.id === "phone")!;
  const clip = after.tracks.flatMap((t) => t.items).find((i) => i.id === "rec")!;
  const order = after.tracks.map((t) => t.id);
  const at = (id: string) => order.indexOf(after.tracks.find((t) => t.items.some((i) => i.id === id))!.id);
  // The overlay track (free) takes the clip; the frame goes on a new track right above it (drawn on top), under the text.
  assert.ok(at("phone") < at("rec") && at("rec") < order.indexOf("main") && order.indexOf("text") < at("phone"), order.join(","));
  assert.equal(after.tracks[at("rec")]!.id, "overlay");
  assert.deepEqual([clip.start, clip.duration, clip.in, frame.start, frame.duration], [30, 120, 15, 30, 120]);
  // Aligned: the clip's box is the screen rect of the frame's box (rounded), cover, the screen's corners.
  const box = componentBox(frame, after.canvas, 0)!;
  const scr = screenRect("phone", box.w, box.h);
  assert.deepEqual(clip.transform, { x: Math.round(box.x + scr.x), y: Math.round(box.y + scr.y), w: Math.round(scr.w), h: Math.round(scr.h), fit: "cover", radius: Math.round(scr.radius) });
  // Default: centred, 86 % of the canvas height, the phone's shape.
  assert.equal(frame.transform!.h, Math.round(1080 * 0.86));
  assert.ok(Math.abs(frame.transform!.x! + frame.transform!.w! / 2 - 960) <= 1);
  // The bezel's hole is inside the clip's box (2 px in all round), so no seam shows between them.
  const svg = bezelSvg("phone", box.w, box.h, "#000");
  const holeX = Number(/ M([\d.]+) /.exec(svg.split('" fill="#000" fill-rule')[0]!.split("Z ")[1]!.replace(/^/, " "))?.[1]);
  assert.ok(holeX > scr.x, `the hole starts at ${holeX}, inside the screen's ${scr.x}`);
  // In the drawn frame: the clip's box is under the frame's screen at every frame.
  const { starts } = layout(after);
  const vs = visualsAt(after, starts, 60);
  const cv = vs.find((v) => v.item.id === "rec")!;
  const fv = vs.find((v) => v.item.id === "phone")!;
  assert.ok(vs.indexOf(cv) < vs.indexOf(fv), "the clip draws first (under the frame)");
  assert.ok(Math.abs(cv.box!.x - (fv.box!.x + scr.x)) <= 0.5 && Math.abs(cv.box!.w - scr.w) <= 0.5);
  // Every track taken: two new tracks, the frame's above the clip's.
  const busy = apply(p, [{ op: "insert_item", track: "overlay", item: { id: "busy", type: "component", component: "component.solid", start: 0, duration: 300, props: { color: "#000" } } }]);
  const both = planDeviceFrame(busy, { media: "m-rec", device: "browser", start: 0, duration: 60 });
  assert.ok(!("problem" in both));
  assert.deepEqual(both.ops.filter((o) => o.op === "add_track").map((o) => (o as { track: { name: string } }).track.name), ["Screen", "Device"]);
  valid(apply(busy, both.ops));
  // Problems: unknown media, audio, used ids, bad times.
  assert.match((planDeviceFrame(p, { media: "nope", start: 0, duration: 9 }) as { problem: string }).problem, /does not exist/);
  assert.match((planDeviceFrame(p, { frameId: "bg", start: 0, duration: 9 }) as { problem: string }).problem, /already used/);
  assert.match((planDeviceFrame(p, { start: -1, duration: 9 }) as { problem: string }).problem, /start/);
  // Keys on the frame carry over to the screen, offset by the screen rect.
  const keyedFrame = { ...frame, keys: [{ frame: 0, x: 100 }, { frame: 60, x: 400, ease: "inOut" as const }] };
  const k = screenKeys(keyedFrame, after.canvas)!;
  assert.deepEqual(k.map((x) => x.x), [Math.round(100 + scr.x), Math.round(400 + scr.x)]);
  assert.deepEqual(screenTransform(frame, after.canvas), clip.transform);
});

test("graphic documents: canvas-sized, the strict CSP, the author's markup, and the render bootstrap", () => {
  const doc = graphicDocument("<div id=x></div><script>window.render = (t) => {}</script>", { width: 1280, height: 720 });
  assert.match(doc, new RegExp(`<meta http-equiv="Content-Security-Policy" content="${GRAPHIC_CSP.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}">`));
  assert.match(GRAPHIC_CSP, /default-src 'none'/);
  assert.doesNotMatch(GRAPHIC_CSP, /connect-src|http/);
  assert.match(doc, /width:1280px;height:720px/);
  assert.match(doc, /<div id=x><\/div>/);
  assert.match(doc, /window\.__uncutRender = async/);
  assert.match(doc, /addEventListener\("message"/);
  // The bootstrap is in <head>, before the author's markup (an unclosed tag can't swallow it).
  assert.ok(doc.indexOf("__uncutRender") < doc.indexOf("<body>") && doc.indexOf("<body>") < doc.indexOf("<div id=x>"));
  // The format takes only the names the loader serves.
  for (const [src, ok] of [["graphics/move.html", true], ["graphics/../x.html", false], ["graphics/sub/x.html", false], ["graphics/.x.html", false]] as const) {
    const errors = validateProject(project([{ track: "overlay", item: { id: "g", type: "graphic", src, start: 0, duration: 30 } }]), modules);
    assert.equal(errors.length === 0, ok, `${src}: ${JSON.stringify(errors)}`);
  }
});

test("SVG sizes from the file: viewBox, width / height, and the default", () => {
  assert.deepEqual(svgSize(`<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 220 64"><path/></svg>`), { width: 220, height: 64 });
  assert.deepEqual(svgSize(`<svg width="300px" height="100" viewBox="0 0 30 10">`), { width: 300, height: 100 });
  assert.deepEqual(svgSize(`<svg width='440' viewBox='0,0,220,64'>`), { width: 440, height: 128 });
  assert.deepEqual(svgSize(`<svg>`), { width: 300, height: 150 });
  assert.equal(svgSize(`<html></html>`), undefined);
});

test("the editor's planners: add at the playhead or a drop point, props with History labels, the device frame's footage", () => {
  const p = project();
  // An end card at the end of main goes on main; elsewhere on the free overlay track; a full overlay makes a new track.
  const atEnd = planAddComponent(p, "component.end-card", 300);
  assert.ok(!("problem" in atEnd));
  assert.equal((atEnd.ops[0] as { track: string }).track, "main");
  assert.equal(atEnd.summary, "Add end card");
  valid(apply(p, atEnd.ops));
  const mid = planAddComponent(p, "component.chart", 30, { at: { x: 400, y: 300 } });
  assert.ok(!("problem" in mid));
  const added = apply(p, mid.ops);
  valid(added);
  const chart = added.tracks.find((t) => t.id === "overlay")!.items[0]!;
  assert.deepEqual([chart.start, chart.duration, chart.transform], [30, 120, { x: -100, y: 0, w: 1000, h: 600 }], "4 s, centred on the drop point");
  assert.deepEqual(chart.props, componentDefaults("component.chart"));
  const again = planAddComponent(added, "component.terminal", 40);
  assert.ok(!("problem" in again));
  assert.equal((again.ops[0] as { op: string }).op, "add_track", "the overlay is taken then: a new track under the text");
  assert.equal((again.ops[0] as { index: number }).index, 1);
  valid(apply(added, again.ops));
  // Props: whole, labelled; unchanged props plan nothing.
  const labelled = planComponentProps(added, chart.id, { ...chart.props, unit: "%" }, "Change unit of chart");
  assert.ok("ops" in labelled && labelled.summary === "Change unit of chart");
  assert.deepEqual((labelled.ops[0] as { set: unknown }).set, { props: { ...chart.props, unit: "%" } });
  assert.deepEqual(planComponentProps(added, chart.id, { ...chart.props }, "x"), { ops: [], summary: "" });
  assert.equal(itemLabel(added, chart), "Chart");
  // The box editors work on components: a drag is "Move chart".
  assert.equal(clipState(added, chart.id, 40)!.box.w, 1000);
  const moved = planClipBox(added, chart.id, { x: 10, y: 20 }, 40);
  assert.ok("ops" in moved && moved.summary === "Move chart");
  // A device frame alone, then footage in it (a new clip under it on its screen), changed, fitted, removed.
  const dev = planAddComponent(p, "component.device-frame", 0);
  assert.ok(!("problem" in dev));
  const withFrame = apply(p, dev.ops);
  valid(withFrame);
  const footage = planScreenFootage(withFrame, dev.itemId, "m-short");
  assert.ok("ops" in footage && footage.summary === "Put footage in the device frame");
  const withClip = apply(withFrame, footage.ops);
  valid(withClip);
  const sc = screenClipOf(withClip, dev.itemId)!;
  assert.ok(sc, "the clip under the frame is found");
  assert.equal(sc.item.loop, true, "a video shorter than the frame loops");
  const frameItem = withClip.tracks.flatMap((t) => t.items).find((i) => i.id === dev.itemId)!;
  assert.deepEqual(sc.item.transform, screenTransform(frameItem, withClip.canvas));
  const swapped = planScreenFootage(withClip, dev.itemId, "m-rec");
  assert.ok("ops" in swapped && swapped.ops.length === 1 && swapped.summary === "Change the device frame's footage");
  // The frame moved: fit the footage again.
  const movedFrame = apply(withClip, [{ op: "update_item", item: dev.itemId, set: { transform: { ...frameItem.transform, x: 100 } } }]);
  const fit = planAlignScreen(movedFrame, dev.itemId);
  assert.ok("ops" in fit && fit.summary === "Fit footage to the device frame's screen");
  const fitted = apply(movedFrame, fit.ops);
  valid(fitted);
  const movedItem = fitted.tracks.flatMap((t) => t.items).find((i) => i.id === dev.itemId)!;
  assert.deepEqual(screenClipOf(fitted, dev.itemId)!.item.transform, screenTransform(movedItem, fitted.canvas));
  // Another device: the frame takes its shape (same height and centre), the footage follows.
  const browser = planDevice(fitted, dev.itemId, "browser");
  assert.ok("ops" in browser && browser.summary === "Set device frame to browser");
  const asBrowser = apply(fitted, browser.ops);
  valid(asBrowser);
  const b = asBrowser.tracks.flatMap((t) => t.items).find((i) => i.id === dev.itemId)!;
  assert.equal(b.transform!.h, movedItem.transform!.h);
  assert.equal(b.transform!.w, Math.round((movedItem.transform!.h! * 1280) / 820));
  assert.deepEqual(screenClipOf(asBrowser, dev.itemId)!.item.transform, screenTransform(b, asBrowser.canvas));
  const removed = planScreenFootage(asBrowser, dev.itemId, null);
  assert.ok("ops" in removed && removed.ops[0]!.op === "delete_item");
  assert.match((planAddComponent(p, "component.callout", 0) as { problem: string }).problem, /can't draw/);
});

test("device frames, edge cases (review): never a main clip as the footage; short footage loops; keys, scale and the clip's own zoom", () => {
  // A main clip with the frame's start, length and fit is not its footage.
  const p = project();
  const withMain = apply(p, [
    { op: "insert_item", track: "main", index: 0, item: { id: "main-clip", type: "clip", media: "m-rec", in: 0, duration: 120, transform: { fit: "cover" } } },
    { op: "insert_item", track: "overlay", item: { id: "dev", type: "component", component: "component.device-frame", start: 0, duration: 120, props: { device: "phone" } } },
  ]);
  assert.equal(screenClipOf(withMain, "dev"), undefined);
  // insert_device_frame with footage shorter than the frame: the clip loops (else media-range).
  const short = planDeviceFrame(p, { media: "m-short", start: 0, duration: 150 });
  assert.ok(!("problem" in short));
  const looped = apply(p, short.ops);
  valid(looped);
  assert.equal(looped.tracks.flatMap((t) => t.items).find((i) => i.id === short.clipId)!.loop, true);
  assert.match((planDeviceFrame(p, { media: "m-short", start: 0, duration: 10, in: 60 }) as { problem: string }).problem, /past the end/);
  // A keyed, scaled frame: new footage gets the keys; its box is the scaled screen.
  const keyed = apply(p, [{ op: "insert_item", track: "overlay", item: { id: "dev", type: "component", component: "component.device-frame", start: 0, duration: 120, props: { device: "phone" }, transform: { x: 100, y: 50, h: 600, w: 286, scale: 0.5 }, keys: [{ frame: 0, x: 100 }, { frame: 60, x: 500 }] } }]);
  const put = planScreenFootage(keyed, "dev", "m-rec");
  assert.ok("ops" in put);
  const withFootage = apply(keyed, put.ops);
  const clip = screenClipOf(withFootage, "dev")!.item;
  const frame = withFootage.tracks.flatMap((t) => t.items).find((i) => i.id === "dev")!;
  const box = componentBox({ ...frame, keys: undefined }, withFootage.canvas, 0)!;
  const r = screenRect("phone", box.w, box.h);
  assert.ok(Math.abs(clip.transform!.w! - r.w * 0.5) <= 1 && Math.abs(clip.transform!.x! - (box.x + box.w / 2 + (r.x - box.w / 2) * 0.5)) <= 1, JSON.stringify(clip.transform));
  assert.deepEqual(clip.keys!.map((k) => k.x! - clip.transform!.x!), [0, 400], "the footage moves with the frame");
  // Fit keeps the clip's own zoom keys.
  const zoomed = apply(withFootage, [{ op: "update_item", item: clip.id, set: { keys: [...clip.keys!, { frame: 30, scale: 1.2 }] } }]);
  const fit = planAlignScreen(zoomed, "dev");
  assert.ok("ops" in fit);
  assert.ok(((fit.ops[0] as unknown as { set: { keys: Array<{ scale?: number }> } }).set.keys).some((k) => k.scale === 1.2));
  // Another device keeps the centre of a frame with only h (or none).
  const noW = apply(p, [{ op: "insert_item", track: "overlay", item: { id: "d2", type: "component", component: "component.device-frame", start: 0, duration: 60, props: { device: "phone" }, transform: { x: 500, y: 40, h: 600 } } }]);
  const before = componentBox(noW.tracks.flatMap((t) => t.items).find((i) => i.id === "d2")!, noW.canvas, 0)!;
  const after = apply(noW, (planDevice(noW, "d2", "browser") as unknown as { ops: Array<unknown> }).ops);
  const b2 = componentBox(after.tracks.flatMap((t) => t.items).find((i) => i.id === "d2")!, after.canvas, 0)!;
  assert.ok(Math.abs(b2.x + b2.w / 2 - (before.x + before.w / 2)) <= 1 && b2.h === 600);
});

test("the agent: modules_list shows components with params and placement, truthfully drawn or not; insert_device_frame expands; graphic_write is a tool", () => {
  const list = modulesList(modules, "component");
  for (const c of COMPONENTS) {
    const m = list.find((x) => x.id === c.id)!;
    assert.equal(m.showsInPreview, true, c.id);
    assert.deepEqual(m.params, c.params);
    assert.deepEqual((m as { component?: unknown }).component, c.block);
  }
  for (const id of Object.keys(UNDRAWN_COMPONENTS)) {
    const m = list.find((x) => x.id === id)!;
    assert.equal(m.showsInPreview, false, id);
    assert.ok((m as { notDrawn?: string }).notDrawn);
  }
  assert.equal(list.find((x) => x.id === "component.solid")!.showsInPreview, true);
  // insert_device_frame becomes the ops planDeviceFrame makes, against the project after the ops before it.
  const p = project();
  const out = expandDeviceFrames(p, [
    { op: "add_track", index: 1, track: { id: "phones", kind: "video", name: "Phones" } },
    { op: "insert_device_frame", media: "m-rec", start: 0, duration: 90, frameId: "phone-1", clipId: "rec-1" },
    { op: "insert_item", track: "text", item: { id: "t1", type: "text", start: 0, duration: 30, text: "Hi" } },
  ]);
  assert.ok("ops" in out, JSON.stringify(out));
  assert.deepEqual(out.ops.map((o) => (o as { op: string }).op), ["add_track", "insert_item", "insert_item", "insert_item"]);
  const after = apply(p, out.ops);
  valid(after);
  assert.ok(after.tracks.find((t) => t.id === "overlay")!.items.some((i) => i.id === "rec-1"), "the clip on the free track nearest main");
  assert.ok(after.tracks.find((t) => t.id === "phones")!.items.some((i) => i.id === "phone-1"), "the frame on the free track added just before, above it");
  assert.match((expandDeviceFrames(p, [{ op: "insert_device_frame", start: 0 }]) as { problem: string }).problem, /start and duration are required/);
  assert.match((expandDeviceFrames(p, [{ op: "insert_device_frame", start: 0, duration: 9, device: "nokia" }]) as { problem: string }).problem, /device must be/);
  assert.match((expandDeviceFrames(p, [{ op: "insert_device_frame", start: 0, duration: 9, media: "nope" }]) as { problem: string }).problem, /does not exist/);
  assert.match((expandDeviceFrames(p, [{ op: "insert_device_frame", start: 0, duration: 9, box: { h: 0 } }]) as { problem: string }).problem, /box\.h must be more than 0/);
  assert.match((expandDeviceFrames(p, [{ op: "insert_device_frame", start: 0, duration: 9, in: -3 }]) as { problem: string }).problem, /in must be 0 or more/);
  assert.match((expandDeviceFrames(p, [{ op: "insert_device_frame", start: 0, duration: 9, box: { w: 100 } }]) as { problem: string }).problem, /box takes numbers x, y and h/);
  assert.deepEqual(expandDeviceFrames(p, [{ op: "delete_item", item: "bg" }]), { ops: [{ op: "delete_item", item: "bg" }] });
  // The MCP schema offers the op; graphic_write is listed with its label.
  const tools = mcpTools();
  const edit = tools.find((t) => t.name === "timeline_edit")!;
  assert.deepEqual((edit.inputSchema.properties as { ops: { items: unknown } }).ops.items, { anyOf: [{ $ref: "#/$defs/op" }, { $ref: "#/$defs/insertDeviceFrame" }, { $ref: "#/$defs/insertText" }, { $ref: "#/$defs/editCaptions" }] }, "insert_text joined in D80, edit_captions in D82");
  assert.ok((edit.inputSchema.$defs as Record<string, unknown>).insertDeviceFrame);
  assert.ok((TOOL_NAMES as ReadonlyArray<string>).includes("graphic_write") && tools.some((t) => t.name === "graphic_write"));
  assert.equal(stepLabel("graphic_write", { name: "counter.html" }), "Wrote the graphic counter.html");
  // The prompt says what draws (and what doesn't).
  for (const c of COMPONENTS) assert.ok(SYSTEM_PROMPT.includes(c.id), c.id);
  assert.match(SYSTEM_PROMPT, /insert_device_frame/);
  assert.match(SYSTEM_PROMPT, /graphic_write/);
  assert.match(SYSTEM_PROMPT, /component\.callout, component\.follow-card, component\.steps, component\.zoom-pan\) and effects are saved but don't draw yet/);
  // The edit log names components.
  assert.equal(describeOp({ op: "insert_item", track: "overlay", item: { id: "end-1", type: "component", component: "component.end-card", start: 0, duration: 90 } }, p), "Added end card end-1 on track overlay");
  const withCard = apply(p, [{ op: "insert_item", track: "overlay", item: { id: "end-1", type: "component", component: "component.end-card", start: 0, duration: 90, props: { title: "x" } } }]);
  assert.equal(describeOp({ op: "update_item", item: "end-1", set: { props: { title: "Argent", url: "argent.dev" } } }, withCard), 'Restyled end card (end-1): title "Argent", url "argent.dev"');
});
