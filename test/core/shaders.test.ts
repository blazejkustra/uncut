// Shader effects (D213), core's side: the checks every WGSL passes (bounded loops, no storage or
// attributes, the shape Uncut calls), params and values, the uniform layout against TypeGPU's own,
// effect.shader in a project (schema + checks), contributes.shaders in a manifest, the planners,
// the agent's ops filled in from an id, and the TypeGPU builder (shaderBuild.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as d from "typegpu/data";

import {
  clipFx,
  expandShaderEffects,
  fxWords,
  loadModules,
  needsPicturePass,
  planShader,
  planShaderValues,
  readContributions,
  shaderDefProblems,
  shaderEntry,
  shaderParamBytes,
  shaderParamLayout,
  shaderParamProblems,
  shaderUseOf,
  shaderValues,
  shaderWgslProblems,
  stripWgslComments,
  validateModule,
  validateProject,
  clipShader,
  type ModuleManifest,
  type Project,
  type ShaderDef,
  type ShaderParam,
} from "../../packages/core/src/index.ts";
import { buildShader, resolveShaderFn } from "../../apps/server/src/plugins/shaderBuild.ts";

const modules = await loadModules("spec/modules/builtin");
const PARAMS: ReadonlyArray<ShaderParam> = [
  { key: "amount", label: "Amount", type: "number", min: 0, max: 1, default: 0.5 },
  { key: "tint", label: "Tint", type: "color", default: "#ff8800" },
  { key: "on", label: "On", type: "bool", default: true },
];
const WGSL = `struct Params {
  amount: f32,
  tint: vec3f,
  on: f32,
}

fn effect(uv: vec2f, t: f32, size: vec2f, p: Params) -> vec4f {
  var sum = vec3f(0.0);
  for (var i = 0; i < 8; i++) {
    sum += frame(uv + vec2f(f32(i) / size.x, 0.0)).rgb;
  }
  return vec4f(mix(frame(uv).rgb, sum / 8.0 * p.tint, p.amount * p.on), 1.0);
}`;
const DEF: ShaderDef = { id: "acme.fx.smear", name: "Smear", params: PARAMS, wgsl: WGSL };
const body = (inner: string) => WGSL.replace(/fn effect[\s\S]*$/, `fn effect(uv: vec2f, t: f32, size: vec2f, p: Params) -> vec4f {\n${inner}\n}`);

test("D213: a well-formed effect passes; each rule refuses with a sentence", () => {
  assert.deepEqual(shaderDefProblems(DEF), []);
  const refused = (wgsl: string, re: RegExp) =>
    assert.ok(
      shaderWgslProblems(wgsl, PARAMS).some((p) => re.test(p)),
      `${re}: ${shaderWgslProblems(wgsl, PARAMS).join(" | ")}`,
    );
  refused(body("loop { break; } return frame(uv);"), /can't use loop/);
  refused(body("var i = 0; while (i < 3) { i++; } return frame(uv);"), /can't use while/);
  refused(body("for (var i = 0; i < 65; i++) { } return frame(uv);"), /runs 65 times; at most 64/);
  refused(body("for (var i = 0; i < 4; i++) { i = 0; } return frame(uv);"), /counter i is changed inside/);
  refused(body("for (var i = 0; i < n; i++) { } return frame(uv);"), /whole-number literals/);
  refused(body("for (var i = 0; i < 4; i += 2) { } return frame(uv);"), /whole-number literals/);
  refused(body("for (var a = 0; a < 2; a++) { for (var b = 0; b < 2; b++) { for (var c = 0; c < 2; c++) { } } } return frame(uv);"), /two deep/);
  refused(`@group(0) @binding(9) var<storage, read_write> x: array<f32>;\n${WGSL}`, /attributes|bindings and storage/);
  refused(`enable f16;\n${WGSL}`, /enable, requires/);
  refused(body("let uncutSource = 1.0; return frame(uv);"), /names starting with uncut/);
  refused(`fn frame(uv: vec2f) -> vec4f { return vec4f(0.0); }\n${WGSL}`, /its own frame/);
  refused(WGSL.replace("fn effect(", "fn effects("), /needs fn effect/);
  refused(WGSL.replace("tint: vec3f", "tint: vec4f"), /struct Params must be \{ amount: f32, tint: vec3f, on: f32 \}/);
  refused(WGSL + "x".repeat(17 * 1024), /at most 16 KB/);
  // Comments are gone before anything is checked (a loop can't hide, and none is counted).
  assert.equal(stripWgslComments("a // loop\nb /* while /* nested */ */ c"), "a \nb   c");
  assert.deepEqual(shaderWgslProblems(stripWgslComments(body("// loop { }\nreturn frame(uv);")), PARAMS), []);
  // Without params: three arguments, no struct.
  assert.deepEqual(shaderWgslProblems("fn effect(uv: vec2f, t: f32, size: vec2f) -> vec4f { return frame(uv); }", []), []);
});

test("D213: params are checked, values clamped and typed, and the uniform layout is TypeGPU's", () => {
  assert.deepEqual(shaderParamProblems(PARAMS), []);
  const bad = shaderParamProblems([
    { key: "A", label: "x", type: "number", min: 0, max: 1, default: 0 },
    { key: "b", label: "", type: "number", min: 2, max: 1, default: 0 },
    { key: "c", label: "c", type: "number", min: 0, max: 1, default: 5 },
    { key: "d", label: "d", type: "color", default: "red" },
    { key: "e", label: "e", type: "bool", default: 1 as never },
    { key: "e", label: "e", type: "bool", default: true },
  ]);
  for (const re of [
    /"A" needs a name/,
    /"b" needs a label/,
    /"b" needs a min below its max/,
    /"c"'s default must be a number from 0 to 1/,
    /"d"'s default must be a colour/,
    /"e"'s default must be true or false/,
    /"e" is there twice/,
  ])
    assert.ok(
      bad.some((p) => re.test(p)),
      `${re}`,
    );
  assert.deepEqual(shaderValues(PARAMS, { amount: 7, tint: "#ABCDEF", on: "yes", other: 1 }), { amount: 1, tint: "#abcdef", on: true });
  // The layout matches TypeGPU's for the same struct.
  const struct = d.struct({ amount: d.f32, tint: d.vec3f, on: d.f32 });
  const layout = shaderParamLayout(PARAMS);
  assert.deepEqual(layout.offsets, [
    d.memoryLayoutOf(struct, (s) => s.amount).offset,
    d.memoryLayoutOf(struct, (s) => s.tint).offset,
    d.memoryLayoutOf(struct, (s) => s.on).offset,
  ]);
  assert.equal(layout.size, d.sizeOf(struct));
  const other: ReadonlyArray<ShaderParam> = [
    { key: "a", label: "a", type: "color", default: "#000000" },
    { key: "b", label: "b", type: "color", default: "#000000" },
    { key: "c", label: "c", type: "number", min: 0, max: 1, default: 0 },
  ];
  const s2 = d.struct({ a: d.vec3f, b: d.vec3f, c: d.f32 });
  assert.deepEqual(shaderParamLayout(other).offsets, [0, d.memoryLayoutOf(s2, (s) => s.b).offset, d.memoryLayoutOf(s2, (s) => s.c).offset]);
  assert.equal(shaderParamLayout(other).size, d.sizeOf(s2));
  const bytes = new Float32Array(shaderParamBytes(PARAMS, { amount: 0.25, tint: "#ff0000", on: false })!);
  assert.deepEqual([...bytes.slice(0, 1), ...bytes.slice(4, 8)], [0.25, 1, 0, 0, 0]);
  assert.equal(shaderParamBytes([], {}), undefined);
});

const clip = (effects: Project["tracks"][number]["items"][number]["effects"]): Project => ({
  format: "uncut/0",
  name: "S",
  canvas: { width: 640, height: 360, fps: 30, background: "#000000" },
  media: [{ id: "m", kind: "video", name: "a.mp4", path: "a.mp4", probe: { frames: 60, fps: 30, width: 640, height: 360, hasAudio: false } }],
  tracks: [
    {
      id: "main",
      kind: "video",
      role: "main",
      name: "Main",
      items: [{ id: "c1", type: "clip", media: "m", in: 0, duration: 30, ...(effects ? { effects } : {}) }],
    },
  ],
});

test("D213: effect.shader in a project: the schema and the checks, drawn as a picture pass, undone and named", () => {
  const entry = shaderEntry(DEF, { amount: 0.8 });
  const project = clip([entry]);
  assert.deepEqual(validateProject(project, modules), [], "a whole entry validates");
  assert.deepEqual(shaderUseOf(entry)?.values, { amount: 0.8, tint: "#ff8800", on: true });
  assert.equal(clipShader(project.tracks[0]!.items[0]!)?.def.id, "acme.fx.smear");
  assert.equal(needsPicturePass(clipFx(project.tracks[0]!.items[0]!)), false, "no built-in picture effect: the shader is its own pass (exportPlan, Preview)");
  // A loop smuggled into the project, a value out of range, a missing field: refused by validation.
  const looped = clip([{ ...entry, params: { ...entry.params, wgsl: body("loop { } return frame(uv);") } }]);
  assert.ok(validateProject(looped, modules).some((p) => /effect\.shader: Shaders can't use loop/.test(p.message)));
  const far = clip([{ ...entry, params: { ...entry.params, values: { amount: 3 } } }]);
  assert.ok(validateProject(far, modules).some((p) => /"amount" takes a number from 0 to 1/.test(p.message)));
  const bare = clip([{ module: "effect.shader", params: { shader: "acme.fx.smear" } }]);
  assert.ok(validateProject(bare, modules).some((p) => /required property 'wgsl'|must have required property/.test(p.message)));
  // A broken definition isn't drawn (clipShader is undefined), never half drawn.
  assert.equal(clipShader(looped.tracks[0]!.items[0]!), undefined);
  // History words.
  assert.equal(fxWords([entry]), "shader Smear");
  assert.equal(fxWords([{ ...entry, bypass: true }]), "shader Smear (off)");
});

test("D213: planShader and planShaderValues", () => {
  const p = clip(undefined);
  const put = planShader(p, "c1", DEF, { amount: 0.3 });
  assert.ok("ops" in put, JSON.stringify(put));
  assert.equal(put.summary, "Smear on a.mp4");
  const effects = put.ops[0]!.set.effects as Array<{ module: string; params: { values: unknown } }>;
  assert.deepEqual(effects[0]!.params.values, { amount: 0.3, tint: "#ff8800", on: true });
  assert.match((planShader(p, "c1", DEF, { amount: 2 }) as { problem: string }).problem, /from 0 to 1/);
  assert.match((planShader(p, "nope", DEF) as { problem: string }).problem, /Pick a clip/);
  const withIt = clip(effects as never);
  const changed = planShaderValues(withIt, "c1", { tint: "#00ff00" });
  assert.ok("ops" in changed);
  assert.equal(changed.summary, "Smear: Tint on c1");
  assert.deepEqual((changed.ops[0]!.set.effects as Array<{ params: { values: unknown } }>)[0]!.params.values, { amount: 0.3, tint: "#00ff00", on: true });
  assert.match((planShaderValues(withIt, "c1", { nope: 1 }) as { problem: string }).problem, /no param "nope"/);
  const off = planShader(withIt, "c1", undefined);
  assert.ok("ops" in off);
  assert.equal(off.ops[0]!.set.effects, null);
});

test("D213: the agent's ops get the definition from the id; unknown ids and bad values are refused", () => {
  const defs = new Map([[DEF.id, DEF]]);
  const ops = [
    {
      op: "update_item",
      item: "c1",
      set: {
        effects: [
          { module: "effect.look", params: { look: "warm" } },
          { module: "effect.shader", params: { shader: DEF.id, values: { amount: 0.9 }, wgsl: "fn effect() {}" } },
        ],
      },
    },
  ];
  const out = expandShaderEffects(ops, defs);
  assert.ok("ops" in out);
  const set = (out.ops[0] as { set: { effects: Array<{ module: string; params: Record<string, unknown> }> } }).set.effects;
  assert.equal(set[0]!.module, "effect.look", "other effects as they were");
  assert.equal(set[1]!.params.wgsl, WGSL, "the agent's wgsl replaced by the known definition's");
  assert.deepEqual(set[1]!.params.values, { amount: 0.9, tint: "#ff8800", on: true });
  assert.match(
    (
      expandShaderEffects([{ op: "insert_item", track: "main", item: { effects: [{ module: "effect.shader", params: { shader: "nope.x" } }] } }], defs) as {
        problem: string;
      }
    ).problem,
    /no shader effect "nope\.x"\. Known: acme\.fx\.smear/,
  );
  assert.match(
    (
      expandShaderEffects(
        [{ op: "update_item", item: "c1", set: { effects: [{ module: "effect.shader", params: { shader: DEF.id, values: { tint: "red" } } }] } }],
        defs,
      ) as { problem: string }
    ).problem,
    /Smear: "tint" takes a colour/,
  );
  // Ops without shader effects pass through untouched.
  const plain = [{ op: "delete_item", item: "c1" }];
  assert.deepEqual(expandShaderEffects(plain, defs), { ops: plain });
});

test("D213: contributes.shaders in a manifest: the schema, and entries that fail the checks left out with a warning", () => {
  const catalog = JSON.parse(readFileSync("plugins/catalog/typegpu-effects/uncut.module.json", "utf8")) as ModuleManifest;
  assert.deepEqual(validateModule(catalog), []);
  const read = readContributions(catalog, { reserved: new Set(modules.keys()), moves: new Set() });
  assert.deepEqual(read.warnings, []);
  assert.deepEqual(
    read.contributions.shaders?.map((s) => s.id),
    ["typegpu.effects.ripple", "typegpu.effects.rgb-shift", "typegpu.effects.halftone", "typegpu.effects.crt"],
  );
  assert.equal(read.contributions.shaders?.[0]?.pluginName, "TypeGPU effects");
  const shaders = (catalog.contributes as { shaders: Array<Record<string, unknown>> }).shaders;
  const broken = {
    ...catalog,
    contributes: {
      shaders: [
        { ...shaders[0], wgsl: body("loop { } return frame(uv);") },
        { ...shaders[1], id: "other.plugin.x" },
      ],
    },
  } as ModuleManifest;
  const r2 = readContributions(broken, { reserved: new Set(), moves: new Set() });
  assert.deepEqual(r2.contributions.shaders, []);
  assert.match(r2.warnings[0]!, /shader effect typegpu\.effects\.ripple is left out: .*(loop|struct Params)/);
  assert.match(r2.warnings[1]!, /other\.plugin\.x is left out: its id must be the plugin's id/);
  // The schema: params typed, a source .ts at the top level, an export name.
  assert.ok(validateModule({ ...catalog, contributes: { shaders: [{ ...shaders[0], source: "../x.ts" }] } }).length > 0);
  assert.ok(
    validateModule({ ...catalog, contributes: { shaders: [{ ...shaders[0], params: [{ key: "a", label: "A", type: "vec4", default: 0 }] }] } }).length > 0,
  );
});

const problemsOf = (r: { readonly wgsl: string } | { readonly problems: ReadonlyArray<string> }) => ("problems" in r ? r.problems : []);

test("D213: TypeGPU builds the agent's body and resolves a plugin's function; wrong shapes are refused", async () => {
  const built = buildShader(PARAMS, "(uv, t, size, p) { return vec4f(frame(uv).rgb * p.tint * p.amount, 1.0); }");
  assert.ok("wgsl" in built, JSON.stringify(built));
  assert.match(
    built.wgsl,
    /^struct Params \{\n  amount: f32,\n  tint: vec3f,\n  on: f32,\n\}\n\nfn effect\(uv: vec2f, t: f32, size: vec2f, p: Params\) -> vec4f \{/,
  );
  assert.ok("wgsl" in buildShader([], "(uv, t, size) { return frame(uv); }"));
  assert.match(problemsOf(buildShader(PARAMS, "return 1;"))[0]!, /arguments and its block/);
  assert.match(problemsOf(buildShader(PARAMS, "(uv, t, size, p) { loop { } }")).join(" "), /can't use loop/);
  const { ripple } = await import("../../plugins/catalog/typegpu-effects/effects.ts");
  const manifest = JSON.parse(readFileSync("plugins/catalog/typegpu-effects/uncut.module.json", "utf8"));
  const entry = manifest.contributes.shaders[0];
  const resolved = resolveShaderFn(ripple, entry.params);
  assert.ok("wgsl" in resolved);
  assert.equal(resolved.wgsl, entry.wgsl, "the manifest carries what the source resolves to");
  assert.match(problemsOf(resolveShaderFn(ripple, entry.params.slice(1)))[0]!, /params struct must be d\.struct\(\{ wavelength: d\.f32/);
  assert.match(problemsOf(resolveShaderFn(() => 1, []))[0]!, /isn't a TypeGPU function/);
});
