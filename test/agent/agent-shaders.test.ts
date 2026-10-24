// Shader effects and the agent (D213) on the bundled server through the scripted stand-in for
// claude (helpers/fake-claude.ts, never the real one) and the real MCP server:
// - with the catalog's TypeGPU effects enabled and allowed, modules_list kind "effect" lists each
//   shader effect with its typed params and how to apply it;
// - timeline_edit with only {shader, values} gets the whole definition (the manifest's WGSL) on the
//   clip; an unknown id and a value out of range are refused with a sentence;
// - shader_write builds, tries (a picture comes back) and keeps project.<name>; it then applies like
//   a plugin's; render_frames draws the clip through it (no note);
// - the plugin removed: the clip keeps drawing (it carries the definition), project.json valid.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { clipShader, loadModules, validateProject, type Project } from "../../packages/core/src/index.ts";
import { BUNDLE, MEDIA, connect, killAll, startServer } from "../helpers/server.ts";
import { makeColours } from "../helpers/fx-fixture.ts";
import { AGENT_TEXT } from "../helpers/agentText.ts";

const MCP = resolve("apps/server/dist/mcp.mjs");
const DESKTOP = resolve("apps/desktop/dist/main.cjs");
const FAKE = resolve("test/helpers/fake-claude.ts");
const which = (name: string) => {
  try {
    return execFileSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).trim() || undefined;
  } catch {
    return undefined;
  }
};
const FFMPEG = which("ffmpeg");
const FFPROBE = which("ffprobe");
const skip =
  !existsSync(BUNDLE) || !existsSync(MCP) || !existsSync(MEDIA) || !existsSync(DESKTOP)
    ? "server bundle, desktop or media core not built (run pnpm build)"
    : !FFMPEG || !FFPROBE
      ? "ffmpeg isn't installed"
      : false;

type Server = Awaited<ReturnType<typeof startServer>>;
type Client = Awaited<ReturnType<typeof connect>>;
let root = "";
let server: Server;
let client: Client;
let agent: ReturnType<Client["subscribe"]>;
let dir = "";
let mediaId = "";
const plan = () => join(root, "plan.json");
const resultLog = () => join(root, "results.jsonl");
const turns: Array<unknown> = [];
async function ask(prompt: string, steps: Array<unknown>) {
  turns.push(steps);
  writeFileSync(plan(), JSON.stringify(turns));
  const { turnId } = await client.ok("agent.send", { prompt });
  await agent.until((s) => s?.turns.some((t: any) => t.id === turnId && t.status !== "running"), 120000);
  return agent.values.at(-1).turns.find((t: any) => t.id === turnId);
}
const onDisk = (): Project => JSON.parse(readFileSync(join(dir, "project.json"), "utf8"));
const results = () =>
  readFileSync(resultLog(), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
const text = (r: any) => r.result.content[0].text as string;

before(async () => {
  if (skip) return;
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-agent-shaders-")));
  mkdirSync(join(root, "projects"));
  const footage = join(root, "Footage");
  mkdirSync(footage);
  makeColours(join(footage, "Colours.mp4"));
  const shimDir = join(root, "bin");
  mkdirSync(shimDir);
  symlinkSync(FFMPEG!, join(shimDir, "ffmpeg"));
  symlinkSync(FFPROBE!, join(shimDir, "ffprobe"));
  symlinkSync(process.execPath, join(shimDir, "node"));
  writeFileSync(join(root, "prompts.jsonl"), "");
  writeFileSync(resultLog(), "");
  server = await startServer({
    env: {
      PATH: `${shimDir}:/usr/bin:/bin`,
      UNCUT_DATA_DIR: join(root, "data"),
      UNCUT_CLAUDE: FAKE,
      FAKE_PLAN: plan(),
      FAKE_PROMPT_LOG: join(root, "prompts.jsonl"),
      FAKE_RESULT_LOG: resultLog(),
      UNCUT_BUNDLED_PLUGINS_DIR: resolve("plugins"),
    },
  });
  client = await connect(server.ready.port, server.ready.token);
  agent = client.subscribe("agent.subscribe");
  const snap = await client.ok("project.create", { parentDir: join(root, "projects"), name: "Shaders" });
  dir = snap.dir;
  await agent.until((s) => s?.dir === dir);
  const turn = await ask("bring in the clip", [{ tool: "media_import", args: { path: join(footage, "Colours.mp4") } }]);
  assert.equal(turn.status, "done", turn.error);
  mediaId = onDisk().media[0]!.id;
  const placed = await ask("put it on the timeline", [
    { tool: "project_read", args: {} },
    {
      tool: "timeline_edit",
      args: {
        baseRevision: "$rev",
        summary: "The clip",
        ops: [
          {
            op: "insert_item",
            track: onDisk().tracks.find((t) => t.role === "main")!.id,
            item: { id: "c1", type: "clip", media: mediaId, in: 0, duration: 60 },
          },
        ],
      },
    },
  ]);
  assert.equal(placed.status, "done", placed.error);
  assert.ok(
    onDisk().tracks.some((t) => t.items.some((i) => i.id === "c1")),
    JSON.stringify(results().at(-1)),
  );
  // The catalog's TypeGPU effects, enabled and allowed by the user.
  const enabled = await client.ok("plugins.enable", { id: "typegpu.effects" });
  const row = enabled.plugins.find((p: any) => p.id === "typegpu.effects");
  assert.match(row.asks[0], /doesn't run a program/);
  assert.deepEqual(row.contributes.shaders, ["Ripple", "RGB shift", "Halftone", "CRT"]);
  await client.ok("plugins.approve", { id: row.id, dir: row.dir, capabilities: row.capabilities });
});
after(async () => {
  client?.close();
  await server?.stop();
  killAll();
  if (root) rmSync(root, { recursive: true, force: true });
});

test(
  "D213: modules_list shows the shader effects with params; timeline_edit applies one by id; bad ids and values are refused",
  { skip, timeout: 180000 },
  async () => {
    const c = await client.ok("plugins.contributions", {});
    assert.deepEqual(
      c.shaders.map((s: any) => s.id),
      ["typegpu.effects.ripple", "typegpu.effects.rgb-shift", "typegpu.effects.halftone", "typegpu.effects.crt"],
    );
    assert.match(c.shaders[0].wgsl, /fn effect\(uv: vec2f, t: f32, size: vec2f, p: Params\) -> vec4f/);
    const from = results().length;
    const turn = await ask("make it look like water", [
      { tool: "modules_list", args: { kind: "effect" } },
      { tool: "project_read", args: {} },
      {
        tool: "timeline_edit",
        args: {
          baseRevision: "$rev",
          summary: "Ripple",
          ops: [
            {
              op: "update_item",
              item: "c1",
              set: { effects: [{ module: "effect.shader", params: { shader: "typegpu.effects.ripple", values: { amplitude: 0.02, speed: 8 } } }] },
            },
          ],
        },
      },
      {
        tool: "timeline_edit",
        args: {
          baseRevision: "$rev",
          summary: "Nope",
          ops: [{ op: "update_item", item: "c1", set: { effects: [{ module: "effect.shader", params: { shader: "typegpu.effects.nope" } }] } }],
        },
      },
      {
        tool: "timeline_edit",
        args: {
          baseRevision: "$rev",
          summary: "Too much",
          ops: [
            {
              op: "update_item",
              item: "c1",
              set: { effects: [{ module: "effect.shader", params: { shader: "typegpu.effects.ripple", values: { amplitude: 9 } } }] },
            },
          ],
        },
      },
    ]);
    assert.equal(turn.status, "done", turn.error);
    const mine = results().slice(from);
    const listed = JSON.parse(text(mine[0])) as Array<Record<string, any>>;
    const ripple = listed.find((m) => m.id === "typegpu.effects.ripple")!;
    assert.ok(ripple, "the ripple is listed among the effects");
    assert.equal(ripple.module, "effect.shader");
    assert.deepEqual(
      ripple.params.map((p: any) => [p.key, p.type, p.min, p.max, p.default]),
      [
        ["amplitude", "number", 0, 0.05, 0.012],
        ["wavelength", "number", 0.02, 0.5, 0.12],
        ["speed", "number", 0, 20, 6],
        ["centerX", "number", 0, 1, 0.5],
        ["centerY", "number", 0, 1, 0.5],
      ],
    );
    assert.match(ripple.note, /"module": "effect\.shader", "params": \{"shader": "typegpu\.effects\.ripple"/);
    assert.ok(
      listed.some((m) => m.id === "effect.shader"),
      "the built-in effect.shader module too",
    );
    assert.equal(JSON.parse(text(mine[2])).ok, true, text(mine[2]));
    const saved = onDisk()
      .tracks.flatMap((t) => t.items)
      .find((i) => i.id === "c1")!;
    const use = clipShader(saved);
    const manifest = JSON.parse(readFileSync("plugins/catalog/typegpu-effects/uncut.module.json", "utf8"));
    assert.equal(use?.def.wgsl, manifest.contributes.shaders[0].wgsl, "Uncut filled in the plugin's WGSL");
    assert.deepEqual(use?.values, { amplitude: 0.02, wavelength: 0.12, speed: 8, centerX: 0.5, centerY: 0.5 });
    assert.match(JSON.parse(text(mine[3])).refused, /There's no shader effect "typegpu\.effects\.nope"\. Known: .*typegpu\.effects\.ripple/);
    assert.match(JSON.parse(text(mine[4])).refused, /Ripple: "amplitude" takes a number from 0 to 0\.05/);
    assert.match(AGENT_TEXT, /Shader effects: modules_list kind "effect"/);
  },
);

test(
  "D213: shader_write keeps project.<name> after trying it; it applies by id; render_frames draws it; the plugin removed, the clip still carries its effect",
  { skip, timeout: 180000 },
  async () => {
    const from = results().length;
    const turn = await ask("give it a scanline wave", [
      {
        tool: "shader_write",
        args: {
          name: "scan-wave",
          title: "Scan wave",
          params: [{ key: "amount", label: "Amount", type: "number", min: 0, max: 0.05, default: 0.01 }],
          body: "(uv, t, size, p) { let c = frame(uv + vec2f(sin(uv.y * 40.0 + t * 4.0) * p.amount, 0.0)); return vec4f(c.rgb * (0.85 + 0.15 * sin(uv.y * size.y * 3.14159)), 1.0); }",
        },
      },
      { tool: "shader_write", args: { name: "broken", body: "(uv, t, size) { loop { } }" } },
      { tool: "modules_list", args: { kind: "effect" } },
      { tool: "project_read", args: {} },
      {
        tool: "timeline_edit",
        args: {
          baseRevision: "$rev",
          summary: "Scan wave",
          ops: [
            {
              op: "update_item",
              item: "c1",
              set: { effects: [{ module: "effect.shader", params: { shader: "project.scan-wave", values: { amount: 0.02 } } }] },
            },
          ],
        },
      },
      { tool: "render_frames", args: { frames: [15] } },
    ]);
    assert.equal(turn.status, "done", turn.error);
    const mine = results().slice(from);
    const written = mine[0].result.content;
    const answer = JSON.parse(written[0].text);
    assert.equal(answer.id, "project.scan-wave");
    assert.equal(written[1].type, "image", "a picture of it on the sample");
    assert.match(answer.next, /"shader":"project\.scan-wave"/);
    assert.ok(existsSync(join(dir, "shaders", "scan-wave.json")));
    assert.equal(mine[1].result.isError, true);
    assert.match(JSON.parse(text(mine[1])).refused, /can't use loop/);
    assert.ok((JSON.parse(text(mine[2])) as Array<{ id: string; source?: string }>).some((m) => m.id === "project.scan-wave" && m.source === "project"));
    assert.equal(JSON.parse(text(mine[4])).ok, true, text(mine[4]));
    const shown = mine[5].result.content;
    assert.equal(shown[1].type, "image");
    assert.doesNotMatch(shown[0].text, /isn't drawn/, "render_frames drew the shader");
    const use = clipShader(
      onDisk()
        .tracks.flatMap((t) => t.items)
        .find((i) => i.id === "c1")!,
    );
    assert.equal(use?.def.id, "project.scan-wave");
    assert.equal(use?.def.name, "Scan wave");
    // The plugin goes; the project still validates and the clip keeps its (project) shader.
    await client.ok("plugins.disable", { id: "typegpu.effects" });
    assert.deepEqual((await client.ok("plugins.contributions", {})).shaders, []);
    const modules = await loadModules("spec/modules/builtin");
    assert.deepEqual(validateProject(onDisk(), modules), []);
  },
);
