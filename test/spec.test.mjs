// Phase 1.1 and 1.2: the project format and module manifests.
// Both examples must pass, and each broken copy must fail with the right error.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { loadModules, validateModule, validateProject, projectDuration } from "../spec/lib/validate.mjs";

const read = async (p) => JSON.parse(await readFile(new URL(p, import.meta.url), "utf8"));
const builtinDir = new URL("../spec/modules/builtin/", import.meta.url).pathname;
const pluginDir = new URL("../spec/examples/plugins/", import.meta.url).pathname;
const modules = await loadModules(builtinDir, pluginDir);
const promo = await read("../spec/examples/close-the-loop.uncut/project.json");
const longform = await read("../spec/examples/drone-weekend.uncut/project.json");
const clone = (x) => structuredClone(x);
const codes = (errors) => errors.map((e) => e.code);

test("every built-in and plugin manifest matches the module schema", async () => {
  for (const dir of [builtinDir, pluginDir]) {
    for (const f of (await readdir(dir)).filter((f) => f.endsWith(".json"))) {
      const manifest = JSON.parse(await readFile(dir + f, "utf8"));
      assert.deepEqual(validateModule(manifest), [], f);
      assert.equal(`${manifest.id}.json`, f, "file name matches the module id");
    }
  }
});

test("Argent (D20) and a local Whisper (D26) fit the manifest", () => {
  const argent = modules.get("argent.capture");
  assert.equal(argent.kind, "capture-source");
  assert.ok(argent.capture.flows && argent.capture.agentDriven);
  assert.ok(argent.agentTools.some((t) => t.name === "argent_record"));
  const whisper = modules.get("whisper.transcribe");
  assert.equal(whisper.analyzer.backend, "local-model");
  assert.ok(whisper.analyzer.outputs.includes("transcript"));
});

test("manifest schema rejects bad manifests", () => {
  const base = clone(modules.get("whisper.transcribe"));
  const noModel = clone(base);
  delete noModel.analyzer.model;
  assert.ok(validateModule(noModel).length > 0, "a local-model analyzer must say which model it downloads");
  const typo = { ...clone(base), capabilites: ["network"] };
  assert.ok(validateModule(typo).length > 0, "unknown top-level fields are rejected");
  const wrongBlock = { ...clone(modules.get("transition.crossfade")), analyzer: base.analyzer };
  assert.ok(validateModule(wrongBlock).length > 0, "a transition can't carry an analyzer block");
  const badCap = { ...clone(base), capabilities: ["everything"] };
  assert.ok(validateModule(badCap).length > 0, "capabilities come from a fixed list");
});

test("the 28 s promo example is valid", () => {
  assert.deepEqual(validateProject(promo, modules), []);
  assert.equal(projectDuration(promo), 840);
});

test("the 20 min long-form example is valid", () => {
  assert.deepEqual(validateProject(longform, modules), []);
  assert.equal(projectDuration(longform), 36000);
});

const broken = {
  "main-track items can't have a start": [promo, (p) => { p.tracks.find((t) => t.role === "main").items[1].start = 100; }, "main-item-start"],
  "free-track items need a start": [promo, (p) => { delete p.tracks[0].items[0].start; }, "missing-start"],
  "two items overlap on one track": [promo, (p) => { p.tracks[0].items[1].start = 60; }, "overlap"],
  "unknown module": [promo, (p) => { p.tracks.find((t) => t.role === "main").items[1].transitionIn.module = "transition.spin-3d"; }, "unknown-module"],
  "module of the wrong kind": [promo, (p) => { p.tracks[0].items[1].animation.in.module = "transition.crossfade"; }, "module-kind"],
  "missing media": [promo, (p) => { p.tracks.find((t) => t.role === "main").items[2].media = "m-nope"; }, "unknown-media"],
  "missing media inside props": [promo, (p) => { p.tracks.find((t) => t.role === "main").items[4].props.logo.media = "m-gone"; }, "unknown-media"],
  "clip runs past the end of its media": [promo, (p) => { p.tracks.find((t) => t.role === "main").items[2].in = 200; }, "media-range"],
  "transition on the first main item": [promo, (p) => { p.tracks.find((t) => t.role === "main").items[0].transitionIn = { module: "transition.crossfade", duration: 6 }; }, "transition-first"],
  "transition longer than its clips allow": [promo, (p) => { p.tracks.find((t) => t.role === "main").items[1].transitionIn.duration = 60; }, "transition-too-long"],
  "transition on a free track": [promo, (p) => { p.tracks[0].items[1].transitionIn = { module: "transition.crossfade", duration: 6 }; }, "transition-track"],
  "duplicate id": [promo, (p) => { p.tracks[0].items[1].id = "txt-hook"; }, "duplicate-id"],
  "text item on an audio track": [promo, (p) => { p.tracks.find((t) => t.id === "a3").items.push({ ...p.tracks[0].items[0], id: "stray", start: 600 }); }, "item-track-kind"],
  "audio item from a silent clip": [promo, (p) => { p.tracks.find((t) => t.id === "a3").items[0].media = "m-sim-login"; }, "media-kind"],
  "component props that don't match its manifest": [promo, (p) => { p.tracks.find((t) => t.role === "main").items[2].props.device = "nokia-3310"; }, "params"],
  "duck under a track that doesn't exist": [promo, (p) => { p.tracks.find((t) => t.id === "a1").mixer.effects[1].params.under = ["voice"]; }, "unknown-track"],
  "gain key past the clip": [promo, (p) => { p.tracks.find((t) => t.id === "a1").items[0].gainKeys.push({ frame: 900, db: -3 }); }, "key-range"],
  "scene past the end": [promo, (p) => { p.scenes.at(-1).end = 900; }, "scene-range"],
  "two main tracks": [promo, (p) => { p.tracks.push({ ...clone(p.tracks.find((t) => t.role === "main")), id: "main-2", items: [] }); }, "main-track-count"],
  "typo in an item field (schema)": [promo, (p) => { p.tracks[0].items[0].duraton = 90; }, "schema"],
  "float frame count (schema)": [promo, (p) => { p.tracks[0].items[0].duration = 90.5; }, "schema"],
  "captions from video without audio": [longform, (p) => { p.tracks[0].items[0].source = "m-screen"; }, "media-kind"],
  "stabilize on an audio track": [longform, (p) => { p.tracks.find((t) => t.id === "a-music").items[0].effects = [{ module: "effect.stabilize" }]; }, "module-kind"],
};

for (const [name, [base, mutate, code]] of Object.entries(broken)) {
  test(`rejects: ${name}`, () => {
    const p = clone(base);
    mutate(p);
    const errors = validateProject(p, modules);
    assert.ok(codes(errors).includes(code), `expected "${code}", got ${JSON.stringify(errors)}`);
  });
}
