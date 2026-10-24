// #107 and #108: the ElevenLabs plugin (plugins/uncut-elevenlabs, bundled) and the generator-plugin
// contract under it. On the bundled server with a stub ElevenLabs API: its Voiceover and Music are in
// generate.list with their options and price, the voices come from the account (generate.choices),
// a voiceover and a track are made from the Generate tab with the options applied and land in
// Media › Generated with them in source, the agent makes one with generate_media, a refused request
// says why and leaves no file. Then uncut/fetch's rules on the plugin host itself: only with a grant,
// only to the provider's API, the key added by Uncut (never the plugin's own credentials), redacted
// from replies, read-only grants can't POST, one saved file a call. The key never reaches the plugin.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer, type Server, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { BUNDLE, connect, killAll, startServer } from "../helpers/server.ts";
import { PluginHost, type ProcessSpec } from "../../apps/server/src/plugins/plugins.ts";
import { openGrant, servePluginRequest } from "../../apps/server/src/generate/pluginGenerators.ts";
import { allowBaseOverrides } from "../../apps/server/src/generate/providers.ts";

const FAKE_CLAUDE = resolve("test/helpers/fake-claude.ts");
const skip = !existsSync(BUNDLE) ? "the server bundle isn't built (pnpm --filter @uncut/server build)" : false;
const KEY = "el-test-elevenlabs-not-real-5c1d";
const SARAH = "EXAVITQu4vr4xnSDxMaL";
const GEORGE = "JBFqnCBsd6RMkjVDRZzb";

let root = "";
let stub: Server;
let stubPort = 0;
let mp3 = Buffer.alloc(0);
const requests: Array<{ method: string; url: string; headers: Record<string, unknown>; body: string }> = [];
let refuse = false;

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};
const VOICES = [
  { voice_id: GEORGE, name: "George - Warm, Captivating Storyteller", category: "premade" },
  { voice_id: SARAH, name: "Sarah - Mature, Reassuring, Confident", category: "premade" },
  { voice_id: "NOpBlnGInO9m6vDvFkFC", name: "Grandpa Spuds Oxley", category: "professional" },
];

before(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-plugin-gen-")));
  const file = join(root, "tone.mp3");
  execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-c:a", "libmp3lame", file]);
  mp3 = readFileSync(file);
  stub = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      requests.push({ method: req.method!, url: req.url!, headers: req.headers, body });
      const url = new URL(req.url!, "http://stub");
      if (url.pathname === "/v2/voices") {
        const search = url.searchParams.get("search")?.toLowerCase();
        return json(res, 200, { voices: VOICES.filter((v) => !search || v.name.toLowerCase().includes(search)), has_more: false });
      }
      if (url.pathname.startsWith("/v1/text-to-speech/") || url.pathname === "/v1/music") {
        if (refuse) return json(res, 402, { detail: { status: "paid_plan_required", message: "Music is available on paid plans." } });
        res.writeHead(200, { "content-type": "audio/mpeg" });
        return res.end(mp3);
      }
      // Echoes what it got (the key too, to check it's redacted on the way back).
      if (url.pathname === "/echo") return json(res, 200, { headers: req.headers, said: `your key is ${req.headers["xi-api-key"]}` });
      json(res, 404, { detail: "no such route" });
    });
  });
  await new Promise<void>((r) => stub.listen(0, "127.0.0.1", r));
  stubPort = (stub.address() as { port: number }).port;
});
after(() => {
  killAll();
  stub?.closeAllConnections();
  stub?.close();
  if (root) rmSync(root, { recursive: true, force: true });
});

/** Every file under `dir` (recursively) whose bytes contain `needle`. */
function filesContaining(dir: string, needle: string): Array<string> {
  const out: Array<string> = [];
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    if (readFileSync(path).includes(needle)) out.push(path);
  }
  return out;
}

test("the ElevenLabs plugin: Voiceover and Music in the Generate tab and for the agent, with a stub API", { skip, timeout: 240000 }, async () => {
  const base = join(root, "server");
  mkdirSync(join(base, "projects"), { recursive: true });
  const files = { plan: join(base, "plan.json"), prompts: join(base, "prompts.jsonl"), results: join(base, "results.jsonl") };
  for (const f of [files.prompts, files.results]) writeFileSync(f, "");
  writeFileSync(files.plan, "[]");
  const server = await startServer({
    captureStderr: true,
    env: {
      UNCUT_DATA_DIR: join(base, "data"),
      UNCUT_PLUGINS_DIR: "",
      UNCUT_BUNDLED_PLUGINS_DIR: resolve("plugins"),
      UNCUT_CLAUDE: FAKE_CLAUDE,
      ANTHROPIC_API_KEY: "",
      FAKE_PLAN: files.plan,
      FAKE_PROMPT_LOG: files.prompts,
      FAKE_RESULT_LOG: files.results,
      UNCUT_ELEVENLABS_BASE: `http://127.0.0.1:${stubPort}`,
    },
  });
  let output = "";
  server.proc.stdout!.on("data", (d) => (output += d));
  server.proc.stderr!.on("data", (d) => (output += d));
  const client = await connect(server.ready.port, server.ready.token);
  try {
    // Listed with what the tab needs, waiting for the key.
    const listed = await client.ok("generate.list");
    const voice = listed.find((g: any) => g.id === "generate.elevenlabs.voiceover");
    const music = listed.find((g: any) => g.id === "generate.elevenlabs.music");
    assert.ok(voice && music, JSON.stringify(listed.map((g: any) => g.id)));
    assert.deepEqual(
      [voice.ready, voice.needs, voice.provider, voice.plugin, voice.kinds, voice.promptLabel],
      [false, "Needs your ElevenLabs key", "elevenlabs", { id: "uncut.elevenlabs", name: "ElevenLabs" }, ["audio"], "Script"],
    );
    assert.deepEqual(
      voice.options.map((o: any) => [o.id, o.type, o.dynamic ?? false]),
      [
        ["voice", "choice", true],
        ["model", "choice", false],
        ["speed", "choice", false],
      ],
    );
    assert.deepEqual(
      [music.seconds, music.options.map((o: any) => o.id), music.price],
      [[30, 60, 120, 180], ["instrumental"], { unit: "second", usd: 0.0025 }],
    );
    assert.equal((await client.fail("generate.choices", { generator: "generate.elevenlabs.voiceover", option: "voice" })).reason, "needs-key");

    await client.ok("keys.set", { provider: "elevenlabs", key: KEY });
    assert.equal((await client.ok("generate.list")).find((g: any) => g.id === "generate.elevenlabs.voiceover").ready, true);

    // The voices of the account, through Uncut with the key.
    const choices = await client.ok("generate.choices", { generator: "generate.elevenlabs.voiceover", option: "voice" });
    assert.deepEqual(choices, [
      { value: GEORGE, label: "George, Warm, Captivating Storyteller" },
      { value: SARAH, label: "Sarah, Mature, Reassuring, Confident" },
      { value: "NOpBlnGInO9m6vDvFkFC", label: "Grandpa Spuds Oxley (professional)" },
    ]);
    assert.equal(requests.at(-1)!.headers["xi-api-key"], KEY);
    assert.deepEqual(
      (await client.ok("generate.choices", { generator: "generate.elevenlabs.voiceover", option: "model" })).map((c: any) => c.value),
      ["eleven_multilingual_v2", "eleven_v3", "eleven_v4", "eleven_flash_v2_5"],
    );

    // Options are checked before anything is sent.
    const bad = async (request: Record<string, unknown>) =>
      (await client.fail("generate.start", { generator: "generate.elevenlabs.voiceover", prompt: "Hi.", ...request })).message;
    const project = client.subscribe("project.subscribe");
    const jobs = client.subscribe("generate.jobs");
    const agent = client.subscribe("agent.subscribe");
    const snap = await client.ok("project.create", { parentDir: join(base, "projects"), name: "Voice", canvas: { width: 1280, height: 720, fps: 30 } });
    await agent.until((s) => s?.dir === snap.dir);
    assert.equal(await bad({ options: { model: "eleven_v9" } }), "model must be one of eleven_multilingual_v2, eleven_v3, eleven_v4, eleven_flash_v2_5.");
    assert.equal(await bad({ options: { mood: "happy" } }), "Voiceover has no option mood; its options are voice, model, speed.");
    assert.equal(await bad({ seconds: 5 }), "Voiceover takes no length (seconds).");
    assert.equal(
      (await client.fail("generate.start", { generator: "generate.elevenlabs.music", prompt: "lofi", seconds: 10 })).message,
      "seconds must be from 30 to 180.",
    );
    assert.equal(
      (await client.fail("generate.start", { generator: "generate.gpt-image", prompt: "x", options: { a: "b" } })).message,
      "options are only for a plugin's generators; generate.gpt-image takes size and seconds.",
    );

    // A voiceover from the tab: Sarah by name, Flash, a little faster.
    const before = requests.length;
    const script = "Welcome back. Today we build a tiny app.";
    const { jobId } = await client.ok("generate.start", {
      generator: "generate.elevenlabs.voiceover",
      prompt: script,
      options: { voice: "Sarah", model: "eleven_flash_v2_5", speed: "1.1" },
    });
    await jobs.until((v) => v.some((j: any) => j.id === jobId && (j.phase === "done" || j.phase === "failed")), 30000);
    const done = jobs.values.at(-1).find((j: any) => j.id === jobId);
    assert.equal(done.phase, "done", done.error);
    assert.equal(done.estimate, Number((script.length * 0.00004).toFixed(3)));
    const tts = requests.slice(before).find((r) => r.url.startsWith("/v1/text-to-speech/"))!;
    assert.equal(tts.url, `/v1/text-to-speech/${SARAH}?output_format=mp3_44100_128`);
    assert.equal(tts.method, "POST");
    assert.equal(tts.headers["xi-api-key"], KEY);
    assert.deepEqual(JSON.parse(tts.body), { text: script, model_id: "eleven_flash_v2_5", voice_settings: { speed: 1.1 } });
    await project.until((p) => p?.project.media.some((m: any) => m.id === done.mediaId));
    const media = () => project.values.at(-1).project.media;
    const vo = media().find((m: any) => m.id === done.mediaId);
    assert.match(vo.path, /^media\/generated\/welcome-back-today-we-build \d{8}-\d{6}\.mp3$/);
    assert.equal(vo.kind, "audio");
    assert.deepEqual(vo.source, {
      module: "generate.elevenlabs.voiceover",
      prompt: script,
      model: "eleven_flash_v2_5",
      kind: "audio",
      options: { voice: "Sarah", model: "eleven_flash_v2_5", speed: "1.1" },
    });

    // Music: a minute, instrumental.
    const track = await client.ok("generate.start", {
      generator: "generate.elevenlabs.music",
      prompt: "Warm lo-fi beat",
      seconds: 60,
      options: { instrumental: true },
    });
    await jobs.until((v) => v.some((j: any) => j.id === track.jobId && (j.phase === "done" || j.phase === "failed")), 30000);
    const trackDone = jobs.values.at(-1).find((j: any) => j.id === track.jobId);
    assert.equal(trackDone.phase, "done", trackDone.error);
    assert.equal(trackDone.estimate, 0.15);
    const composed = requests.find((r) => r.url === "/v1/music?output_format=mp3_44100_128")!;
    assert.deepEqual(JSON.parse(composed.body), { prompt: "Warm lo-fi beat", music_length_ms: 60000, model_id: "music_v1", force_instrumental: true });
    await project.until((p) => p?.project.media.some((m: any) => m.id === trackDone.mediaId));
    assert.deepEqual(media().find((m: any) => m.id === trackDone.mediaId).source, {
      module: "generate.elevenlabs.music",
      prompt: "Warm lo-fi beat",
      model: "music_v1",
      kind: "audio",
      seconds: 60,
      options: { instrumental: true },
    });

    // Refused by ElevenLabs: the job says why in a sentence; no file is left.
    refuse = true;
    const refused = await client.ok("generate.start", { generator: "generate.elevenlabs.music", prompt: "refused track" });
    await jobs.until((v) => v.some((j: any) => j.id === refused.jobId && j.phase === "failed"), 30000);
    refuse = false;
    assert.equal(
      jobs.values.at(-1).find((j: any) => j.id === refused.jobId).error,
      "ElevenLabs refused it for your plan (402): Music is available on paid plans.",
    );
    assert.ok(!readdirSync(join(snap.dir, "media/generated")).some((f) => f.startsWith("refused-track")), "no file left");

    // The agent: a voiceover with generate_media, an edit of its turn; a voice that isn't there is a sentence.
    writeFileSync(
      files.plan,
      JSON.stringify([
        [
          { tool: "generate_media", args: { generator: "generate.elevenlabs.voiceover", prompt: "Thanks for watching.", options: { voice: "george" } } },
          { tool: "generate_media", args: { generator: "generate.elevenlabs.voiceover", prompt: "Nope.", options: { voice: "Zelda" } } },
          { tool: "modules_list", args: { kind: "generator" } },
        ],
      ]),
    );
    const { turnId } = await client.ok("agent.send", { prompt: "Add a voiceover that says thanks for watching" });
    await agent.until((s) => s?.turns.some((t: any) => t.id === turnId && t.status !== "running"), 120000);
    const turn = agent.values.at(-1).turns.find((t: any) => t.id === turnId);
    assert.equal(turn.status, "done", JSON.stringify(turn));
    const results = readFileSync(files.results, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .filter((r) => r.tool === "generate_media");
    assert.equal(results[0].result.isError, undefined, JSON.stringify(results[0]));
    const made = JSON.parse(results[0].result.content[0].text);
    assert.equal(made.kind, "audio");
    assert.equal(made.model, "eleven_multilingual_v2");
    assert.equal(made.estimatedCost, Number(("Thanks for watching.".length * 0.00008).toFixed(3)));
    assert.ok(requests.some((r) => r.url === `/v1/text-to-speech/${GEORGE}?output_format=mp3_44100_128`));
    assert.equal(results[1].result.isError, true);
    assert.match(
      results[1].result.content[0].text,
      /^Nothing was generated: There's no voice "Zelda" in your ElevenLabs voices\. Some of them: George, Sarah, Grandpa Spuds Oxley\.$/,
    );
    assert.deepEqual(
      turn.items.filter((i: any) => i.kind === "step").map((i: any) => i.text),
      ["Generated a voiceover with ElevenLabs", "Generated a voiceover with ElevenLabs", "Checked the generator modules"],
    );
    assert.deepEqual(
      turn.edits.map((e: any) => e.summary),
      ["Generated Thanks for watching"],
    );

    // modules_list shows the generators with their options (what generate_media takes).
    const listedModules = readFileSync(files.results, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .find((r) => r.tool === "modules_list");
    const plugin = JSON.parse(listedModules.result.content[0].text).find((m: any) => m.id === "uncut.elevenlabs");
    assert.deepEqual(
      plugin.generators.map((g: any) => [g.generator, g.options.map((o: any) => o.id)]),
      [
        ["generate.elevenlabs.voiceover", ["voice", "model", "speed"]],
        ["generate.elevenlabs.music", ["instrumental"]],
      ],
    );
    assert.equal(plugin.generators[0].options[0].values, "the user's own (a name or id)");
    // The key: never in the server's output, the project, or the plugin's arguments and replies.
    assert.ok(!output.includes(KEY), "the key isn't in the server's output");
    assert.deepEqual(filesContaining(snap.dir, KEY), []);
    assert.ok(!readFileSync(files.results, "utf8").includes(KEY));
  } finally {
    client.close();
  }
});

test("uncut/fetch: a grant, the provider's API only, the key added by Uncut and redacted, read-only grants, one saved file", { timeout: 60000 }, async () => {
  process.env.UNCUT_ELEVENLABS_BASE = `http://127.0.0.1:${stubPort}`;
  allowBaseOverrides(true);
  const dir = join(root, "fake-plugin");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "uncut.module.json"),
    JSON.stringify({
      manifest: "uncut.module/0",
      id: "test.fetcher",
      kind: "generator",
      name: "Fetcher",
      version: "0.1.0",
      runtime: { type: "process", command: "node", args: ["server.ts"] },
      capabilities: ["network", "api-key"],
      generators: [],
    }),
  );
  // Tries what it's told and answers with what came back (or the refusal), plus its own environment.
  writeFileSync(
    join(dir, "server.ts"),
    `import { serve, text, failure } from "@uncut/plugin-sdk";
serve({ manifest: new URL("./uncut.module.json", import.meta.url), tools: {
  fetch: async (args, ctx) => { try { return text(JSON.stringify(await ctx.fetch(args.req))); } catch (e) { return failure(e.message); } },
  env: async () => text(JSON.stringify(process.env)),
} });`,
  );
  const spec: ProcessSpec = { id: "test.fetcher", name: "Fetcher", dir, command: "node", args: ["server.ts"], timeoutMs: 20000 };
  const host = new PluginHost();
  host.serveRequests(servePluginRequest);
  const out = join(root, "out");
  mkdirSync(out, { recursive: true });
  const call = async (req: unknown, grant?: string) => {
    const r = await host.call(spec, "fetch", { req }, undefined, undefined, undefined, grant ? { meta: { "uncut/grant": grant } } : {});
    const said = (r.content[0] as { text: string }).text;
    return r.isError ? { error: said } : JSON.parse(said);
  };
  try {
    const abort = new AbortController();
    let billed = 0;
    const g = openGrant({
      pluginId: "test.fetcher",
      provider: "elevenlabs",
      key: KEY,
      signal: abort.signal,
      outBase: join(out, "result"),
      sent: () => billed++,
    });
    // No grant, or someone else's: refused.
    assert.match((await call({ url: "/echo" })).error, /didn't give this call a key/);
    const other = openGrant({ pluginId: "test.other", provider: "elevenlabs", key: KEY, signal: abort.signal });
    assert.match((await call({ url: "/echo" }, other.token)).error, /has no grant from Uncut/);
    other.end();
    // Only ElevenLabs' API.
    assert.match((await call({ url: "https://example.com/v1/voices" }, g.token)).error, /only to 127\.0\.0\.1:\d+, not example\.com/);
    // The key is Uncut's to add: the plugin's own credentials are dropped, its other headers pass, the echo is redacted.
    const echo = await call(
      { url: "/echo", headers: { authorization: "Bearer stolen", "xi-api-key": "mine", "x-api-token": "t", accept: "application/json" } },
      g.token,
    );
    const seen = JSON.parse(echo.text);
    assert.equal(echo.status, 200);
    assert.equal(seen.headers["xi-api-key"], "[key]");
    assert.equal(seen.headers.authorization, undefined);
    assert.equal(seen.headers["x-api-token"], undefined);
    assert.equal(seen.headers.accept, "application/json");
    assert.equal(seen.said, "your key is [key]");
    assert.equal(requests.at(-1)!.headers["xi-api-key"], KEY);
    assert.equal(billed, 0, "a GET doesn't count as billed");
    // A POST saved as the result, once.
    const saved = await call({ url: "/v1/music", method: "POST", body: "{}", save: "mp3" }, g.token);
    assert.deepEqual([saved.status, saved.file, saved.bytes], [200, join(out, "result.mp3"), mp3.length]);
    assert.equal(g.saved(), join(out, "result.mp3"));
    assert.equal(billed, 1);
    assert.match((await call({ url: "/v1/music", method: "POST", body: "{}", save: "mp3" }, g.token)).error, /saved its file already/);
    assert.match((await call({ url: "/v1/music", method: "POST", save: "../x" }, g.token)).error, /save is the file's extension/);
    // A read-only grant (the voices): no POST, nothing saved.
    const ro = openGrant({ pluginId: "test.fetcher", provider: "elevenlabs", key: KEY, signal: abort.signal });
    assert.match((await call({ url: "/v1/music", method: "POST", body: "{}" }, ro.token)).error, /may only read/);
    ro.end();
    // Ended: the grant is gone.
    g.end();
    assert.match((await call({ url: "/echo" }, g.token)).error, /has no grant from Uncut/);
    // The plugin's environment never has the key.
    const env = (await host.call(spec, "env", {})).content[0] as { text: string };
    assert.ok(!env.text.includes(KEY));
  } finally {
    await host.stopAll();
    allowBaseOverrides(false);
    delete process.env.UNCUT_ELEVENLABS_BASE;
  }
});
