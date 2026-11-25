// The offline voice (plugins/reverb-tts, Reverb on this Mac's GPU) without the GPU: the runner is
// test/helpers/fake-speech-runner.ts and the model files come from a stub server.
// - Its generator is a local one: listed with no key and no network or api-key capability.
// - Saved voices keep their consent; presets can't be removed.
// - The files download once, with progress; a download nobody waits for pauses and keeps its .part.
// - The plugin over stdio: generate and clone through the runner, refusals, the runner's failure in
//   words, a cancel kills the runner; the runner never gets ELECTRON_RUN_AS_NODE.
// - Whisper (the fake whisper-cli) writes what a clip says when the user leaves it empty.
// - On the bundled server: the Generate tab's offline Voiceover downloads the files, reads a script
//   into Media › Generated, a voice is cloned from a project clip (consent required) and used, then
//   removed; the agent lists the voices, clones one once the user confirms on a card, and speaks in it.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";

import { MODEL_FILES, PRESET_VOICES } from "../../plugins/reverb-tts/reverb.ts";
import { pluginGeneratorsOf } from "../../apps/server/src/generate/pluginGenerators.ts";
import { ReverbFiles } from "../../apps/server/src/speech/reverbFiles.ts";
import { CONSENT_LINE, VoiceStore } from "../../apps/server/src/speech/voices.ts";
import { BUNDLE, connect, killAll, startServer } from "../helpers/server.ts";
import { SAY_TOKENS, whisperJson } from "../helpers/whisper-json.ts";

const PLUGIN_DIR = resolve("plugins/reverb-tts");
const FAKE = resolve("test/helpers/fake-speech-runner.ts");
const FAKE_WHISPER = resolve("test/helpers/fake-whisper.ts");
const FAKE_CLAUDE = resolve("test/helpers/fake-claude.ts");
const MANIFEST = JSON.parse(readFileSync(join(PLUGIN_DIR, "uncut.module.json"), "utf8"));
const hasFfmpeg = (() => {
  try {
    return !!execFileSync("sh", ["-c", "command -v ffmpeg"], { encoding: "utf8" }).trim();
  } catch {
    return false;
  }
})();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

let root = "";
let stub: Server;
let stubPort = 0;
let slow = false;
const served: Array<string> = [];
const fileNames = [...MODEL_FILES.map((f) => f.file), ...PRESET_VOICES.map((v) => `${v.id}.json`)];

before(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-reverb-")));
  stub = createServer((req, res) => {
    const name = decodeURIComponent((req.url ?? "").slice(1));
    if (name.startsWith("whisper/") && name.endsWith(".bin")) return void res.writeHead(200, { "content-length": "16" }).end("not really ggml.");
    if (!fileNames.includes(name)) return void res.writeHead(404).end();
    served.push(name);
    const body = Buffer.from(
      name.endsWith(".json") ? JSON.stringify({ language: "en", transcript: "Hello there.", frames: 100, codes: [] }) : `weights of ${name}`.repeat(200),
    );
    res.writeHead(200, { "content-length": String(body.length) });
    if (!slow) return void res.end(body);
    res.write(body.subarray(0, 10));
    setTimeout(() => res.end(body.subarray(10)), 3000);
  });
  await new Promise<void>((r) => stub.listen(0, "127.0.0.1", r));
  stubPort = (stub.address() as { port: number }).port;
});
after(() => {
  killAll();
  stub?.close();
  if (root) rmSync(root, { recursive: true, force: true });
});

test("its generator is local: no key, no network or api-key capability; a keyed one there still needs them", () => {
  const plugin = { id: "reverb.tts", name: "Reverb (on this Mac)", capabilities: ["gpu"], manifest: MANIFEST };
  const { generators, skipped } = pluginGeneratorsOf([plugin], new Set());
  assert.deepEqual(skipped, []);
  assert.deepEqual(
    generators.map((g) => [g.id, g.provider, g.media, g.options.map((o) => o.id)]),
    [["generate.reverb.voiceover", undefined, "audio", ["voice", "language"]]],
  );
  const keyed = { ...MANIFEST.generators[0], id: "reverb.keyed", provider: "elevenlabs" };
  const mixed = pluginGeneratorsOf([{ ...plugin, manifest: { ...MANIFEST, generators: [...MANIFEST.generators, keyed] } }], new Set());
  assert.deepEqual(
    mixed.generators.map((g) => g.id),
    ["generate.reverb.voiceover"],
  );
  assert.deepEqual(mixed.skipped, ["Reverb (on this Mac)'s generators need the network and api-key capabilities."]);
});

test("saved voices: listed after the presets, found by id or name, with the consent and when; only cloned ones are removed", async () => {
  const store = new VoiceStore(join(root, "voices"));
  assert.equal((await store.list()).length, PRESET_VOICES.length);
  const saved = await store.save({ language: "pl", transcript: "Dzień dobry.", frames: 120, codes: [1, 2, 3] }, { name: "Ania", source: "take.mov from 2 s" });
  assert.match(saved.id, /^voice-[0-9a-f]{8}$/);
  assert.equal(saved.consent.text, CONSENT_LINE);
  assert.ok(Date.parse(saved.consent.at) > 0);
  const listed = await store.list();
  assert.deepEqual(listed.at(-1), {
    id: saved.id,
    name: "Ania",
    language: "pl",
    preset: false,
    transcript: "Dzień dobry.",
    seconds: 4.8,
    source: "take.mov from 2 s",
    createdAt: saved.createdAt,
  });
  assert.equal((await store.find("ania"))?.id, saved.id);
  assert.equal((await store.find("en_male_narrator_1"))?.preset, true);
  assert.equal(await store.remove("en_male_narrator_1"), false);
  assert.equal(await store.remove(saved.id), true);
  assert.equal((await store.list()).length, PRESET_VOICES.length);
});

test("the files download once with progress; nobody waiting pauses the download and keeps its .part", { timeout: 30000 }, async () => {
  const dir = join(root, "models-once");
  const files = new ReverbFiles(dir, `http://127.0.0.1:${stubPort}`);
  assert.equal(await files.installed(), false);
  const before = served.length;
  const seen: Array<number> = [];
  const paths = await files.ensure({ signal: new AbortController().signal, onProgress: (received) => seen.push(received) });
  assert.deepEqual(paths, { model: join(dir, "reverb-int4.safetensors"), codec: join(dir, "higgs-codec.safetensors"), tokenizer: join(dir, "tokenizer.json") });
  assert.deepEqual(served.slice(before).sort(), [...fileNames].sort());
  assert.ok(existsSync(files.presetPath("pl_male_standard")));
  assert.equal(await files.installed(), true);
  await files.ensure({ signal: new AbortController().signal });
  assert.equal(served.length, before + fileNames.length, "nothing is downloaded again");

  slow = true;
  try {
    const paused = new ReverbFiles(join(root, "models-paused"), `http://127.0.0.1:${stubPort}`);
    const controller = new AbortController();
    const waiting = paused.ensure({ signal: controller.signal });
    await sleep(500);
    controller.abort();
    await assert.rejects(waiting);
    await sleep(200);
    assert.deepEqual(readdirSync(join(root, "models-paused")).sort(), ["reverb-int4.safetensors.part", "reverb-int4.safetensors.part.json"]);
  } finally {
    slow = false;
  }
});

/** The plugin over stdio, as Uncut's host talks to it. */
function startPlugin(env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, ["server.ts"], { cwd: PLUGIN_DIR, env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
  const waiting = new Map<number, (m: any) => void>();
  const progress: Array<any> = [];
  let id = 0;
  let stderr = "";
  child.stderr!.on("data", (d) => (stderr += d));
  createInterface({ input: child.stdout! }).on("line", (line) => {
    const m = JSON.parse(line);
    if (m.method === "notifications/progress") progress.push(m.params);
    else waiting.get(m.id)?.(m);
  });
  const request = (method: string, params: unknown, timeout = 20000) =>
    new Promise<any>((done, fail) => {
      const n = ++id;
      const timer = setTimeout(() => fail(new Error(`${method}: no answer in ${timeout} ms; stderr ${stderr}`)), timeout);
      timer.unref();
      waiting.set(n, (m) => (clearTimeout(timer), done(m)));
      child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id: n, method, params })}\n`);
    });
  const call = async (name: string, args: unknown, meta: Record<string, unknown> = {}) =>
    (await request("tools/call", { name, arguments: args, _meta: meta })).result;
  return { child, request, call, progress, nextId: () => id + 1 };
}
const textOf = (r: any) => r.content.map((c: any) => c.text).join(" ");

test("the plugin: generate and clone through the runner, refusals, the runner's failure in words, a cancel kills the runner", { timeout: 60000 }, async () => {
  const log = join(root, "runner.log");
  const runs = () =>
    readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
  const plugin = startPlugin({ FAKE_SPEECH_LOG: log, ELECTRON_RUN_AS_NODE: "1" });
  const runner = { bin: process.execPath, args: [FAKE, "--uncut-speech"] };
  const files = { model: join(root, "m.safetensors"), codec: join(root, "c.safetensors"), tokenizer: join(root, "t.json") };
  try {
    const init = await plugin.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
    assert.equal(init.result.serverInfo.name, "reverb.tts");
    assert.deepEqual((await plugin.request("tools/list", {})).result.tools, [], "the agent reaches it through generate_media and voice_clone");

    const out = join(root, "hello.wav");
    const made = await plugin.call(
      "generate",
      { generator: "reverb.voiceover", prompt: "Hello there.", voice: join(root, "v.json"), language: "en", out, files, runner },
      { progressToken: 3 },
    );
    assert.ok(!made.isError, textOf(made));
    assert.equal(textOf(made), "Read the script (0.5 s).");
    assert.deepEqual(made.structuredContent, { model: "reverb-int4", seconds: 0.5 });
    assert.equal(readFileSync(out).subarray(0, 4).toString(), "RIFF");
    assert.deepEqual(
      plugin.progress.map((p) => p.message),
      ["Reading the script…", "Loading the voice model, 50%"],
    );
    const [speak] = runs();
    assert.deepEqual([speak.kind, speak.text, speak.language, speak.files, speak.electronAsNode], ["speak", "Hello there.", "en", files, false]);

    const voiceOut = join(root, "voice.json");
    const cloned = await plugin.call("clone", {
      audio: join(root, "clip.f32"),
      transcript: "Hi, it's me.",
      language: "pl",
      out: voiceOut,
      files: { codec: files.codec },
      runner,
    });
    assert.ok(!cloned.isError, textOf(cloned));
    assert.equal(JSON.parse(readFileSync(voiceOut, "utf8")).transcript, "Hi, it's me.");
    assert.deepEqual([runs()[1].kind, runs()[1].sampleRate, runs()[1].pid], ["clone", 24000, speak.pid], "one runner for both");

    assert.match(textOf(await plugin.call("generate", { prompt: "x" })), /^Pass prompt, voice/);
    assert.match(textOf(await plugin.call("generate", { prompt: "x", voice: "v", out, files, runner, language: "xx" })), /language must be one of/);
    const failed = await plugin.call("generate", { prompt: "FAIL now", voice: "v", out, files, runner, language: "en" });
    assert.equal(failed.isError, true);
    assert.equal(textOf(failed), "Reverb couldn't read it: the GPU went away");

    const slowPlugin = startPlugin({ FAKE_SPEECH_LOG: log, FAKE_SPEECH_SLEEP_MS: "20000" });
    try {
      await slowPlugin.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
      const id = slowPlugin.nextId();
      const pending = slowPlugin.call("generate", { prompt: "Slow.", voice: "v", out: join(root, "slow.wav"), files, runner, language: "en" });
      pending.catch(() => {});
      let pid = 0;
      for (let i = 0; i < 100 && !pid; i++, await sleep(50)) pid = runs().find((r) => r.text === "Slow.")?.pid ?? 0;
      assert.ok(pid && alive(pid));
      slowPlugin.child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id } })}\n`);
      for (let i = 0; i < 40 && alive(pid); i++) await sleep(50);
      assert.equal(alive(pid), false, "the runner is killed");
      assert.equal(await Promise.race([pending.then(() => "answered"), sleep(1000).then(() => "no answer")]), "no answer");
    } finally {
      slowPlugin.child.kill();
    }
  } finally {
    plugin.child.kill();
  }
});

const skipServer = !existsSync(BUNDLE) ? "the server bundle isn't built (pnpm --filter @uncut/server build)" : !hasFfmpeg ? "ffmpeg isn't installed" : false;

test(
  "on the server: the offline Voiceover downloads its files and reads a script into Media; a voice is cloned from a clip, used and removed",
  { skip: skipServer, timeout: 240000 },
  async () => {
    const base = join(root, "server");
    mkdirSync(join(base, "projects"), { recursive: true });
    for (const f of ["prompts.jsonl", "results.jsonl"]) writeFileSync(join(base, f), "");
    writeFileSync(join(base, "plan.json"), "[]");
    const shims = join(base, "bin");
    mkdirSync(shims);
    writeFileSync(join(shims, "whisper-cli"), `#!/bin/sh\nexec "${process.execPath}" "${FAKE_WHISPER}" "$@"\n`);
    chmodSync(join(shims, "whisper-cli"), 0o755);
    writeFileSync(join(base, "say.json"), whisperJson(SAY_TOKENS, "en"));
    const server = await startServer({
      captureStderr: true,
      env: {
        PATH: `${shims}:${process.env.PATH}`,
        UNCUT_WHISPER_MODEL_URL: `http://127.0.0.1:${stubPort}/whisper`,
        FAKE_WHISPER_JSON: join(base, "say.json"),
        UNCUT_DATA_DIR: join(base, "data"),
        UNCUT_PLUGINS_DIR: "",
        UNCUT_BUNDLED_PLUGINS_DIR: resolve("plugins"),
        ANTHROPIC_API_KEY: "",
        UNCUT_REVERB_MODEL_URL: `http://127.0.0.1:${stubPort}`,
        UNCUT_RENDER_BIN: process.execPath,
        UNCUT_RENDER_ENTRY: FAKE,
        UNCUT_CLAUDE: FAKE_CLAUDE,
        FAKE_PLAN: join(base, "plan.json"),
        FAKE_PROMPT_LOG: join(base, "prompts.jsonl"),
        FAKE_RESULT_LOG: join(base, "results.jsonl"),
      },
    });
    let output = "";
    server.proc.stderr!.on("data", (d) => (output += d));
    const client = await connect(server.ready.port, server.ready.token);
    try {
      const offline = (await client.ok("generate.list")).find((g: any) => g.id === "generate.reverb.voiceover");
      assert.ok(offline, output);
      assert.deepEqual(
        [offline.ready, offline.local, offline.provider, offline.needs, offline.plugin.id, offline.kinds],
        [true, true, undefined, undefined, "reverb.tts", ["audio"]],
      );
      const voices = client.subscribe("voices.state");
      await voices.until((s) => s.voices.length === PRESET_VOICES.length);
      const choices = await client.ok("generate.choices", { generator: "generate.reverb.voiceover", option: "voice" });
      assert.deepEqual(choices[0], { value: "en_male_narrator_1", label: "Narrator, male" });

      const project = client.subscribe("project.subscribe");
      const jobs = client.subscribe("generate.jobs");
      const snap = await client.ok("project.create", { parentDir: join(base, "projects"), name: "Offline", canvas: { width: 1280, height: 720, fps: 30 } });
      const before = served.length;
      const { jobId } = await client.ok("generate.start", {
        generator: "generate.reverb.voiceover",
        prompt: "Welcome back.",
        options: { voice: "pl_male_standard" },
      });
      await jobs.until((v) => v.some((j: any) => j.id === jobId && (j.phase === "done" || j.phase === "failed")), 60000);
      const done = jobs.values.at(-1).find((j: any) => j.id === jobId);
      assert.equal(done.phase, "done", `${done.error}\n${output}`);
      assert.equal(done.estimate, 0);
      assert.deepEqual(served.slice(before).sort(), [...fileNames].sort(), "the files came down on first use");
      await project.until((p) => p?.project.media.some((m: any) => m.id === done.mediaId));
      const media = () => project.values.at(-1).project.media;
      const vo = media().find((m: any) => m.id === done.mediaId);
      assert.match(vo.path, /^media\/generated\/welcome-back \d{8}-\d{6}\.wav$/);
      assert.deepEqual(vo.source, {
        module: "generate.reverb.voiceover",
        prompt: "Welcome back.",
        model: "reverb-int4",
        kind: "audio",
        options: { voice: "pl_male_standard", language: "auto" },
      });

      const clip = join(base, "take.wav");
      execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=220:sample_rate=48000", "-t", "8", "-ac", "1", clip]);
      await client.ok("media.import", { paths: [clip] });
      await project.until((p) => p?.project.media.some((m: any) => m.name.startsWith("take")), 30000);
      const take = media().find((m: any) => m.name.startsWith("take"));
      const refused = await client.fail("voices.clone", { media: take.id, name: "Mine", consent: false });
      assert.equal(refused.message, `Cloning a voice needs the user's confirmation: "${CONSENT_LINE}".`);
      assert.match((await client.fail("voices.clone", { media: take.id, name: "Mine", consent: true, seconds: 40 })).message, /3 to 15 seconds/);
      const clone = await client.ok("voices.clone", { media: take.id, start: 1, seconds: 5, name: "Mine", transcript: "This is my voice.", consent: true });
      await voices.until((s) => s.clone?.id === clone.jobId && s.clone.phase !== "running", 30000);
      const cloned = voices.values.at(-1).clone;
      assert.equal(cloned.phase, "done", `${cloned.error}\n${output}`);
      assert.deepEqual([cloned.voice.name, cloned.voice.language, cloned.voice.transcript, cloned.voice.preset], ["Mine", "en", "This is my voice.", false]);
      assert.equal(voices.values.at(-1).voices.at(-1).id, cloned.voice.id);
      const saved = JSON.parse(readFileSync(join(base, "data", "voices", `${cloned.voice.id}.json`), "utf8"));
      assert.equal(saved.consent.text, CONSENT_LINE);

      const heard = await client.ok("voices.clone", { media: take.id, name: "Heard", consent: true });
      await voices.until((s) => s.clone?.id === heard.jobId && s.clone.phase !== "running", 30000);
      const written = voices.values.at(-1).clone;
      assert.equal(written.phase, "done", `${written.error}\n${output}`);
      assert.match(written.voice.transcript, /^Hello world, this is/, "Whisper wrote what the clip says");
      assert.equal(written.voice.language, "en");

      const again = await client.ok("generate.start", {
        generator: "generate.reverb.voiceover",
        prompt: "Now in my voice.",
        options: { voice: "Mine", language: "de" },
      });
      await jobs.until((v) => v.some((j: any) => j.id === again.jobId && (j.phase === "done" || j.phase === "failed")), 30000);
      assert.equal(jobs.values.at(-1).find((j: any) => j.id === again.jobId).phase, "done");
      await client.ok("voices.remove", { id: cloned.voice.id });
      await client.ok("voices.remove", { id: written.voice.id });

      // The agent: lists the voices, clones one after the user confirms on a card, and speaks in it.
      writeFileSync(
        join(base, "plan.json"),
        JSON.stringify([
          [
            { tool: "voice_list", args: {} },
            { tool: "voice_clone", args: { media: take.id, name: "Agent voice", seconds: 4, transcript: "Hello from the agent." } },
            { tool: "generate_media", args: { generator: "generate.reverb.voiceover", prompt: "Read by the agent.", options: { voice: "Agent voice" } } },
          ],
        ]),
      );
      const agent = client.subscribe("agent.subscribe");
      const { turnId } = await client.ok("agent.send", { prompt: "Clone my voice from the take and read a line" });
      await agent.until((s) => s?.approval?.turnId === turnId, 30000);
      const card = agent.values.findLast((s: any) => s?.approval?.turnId === turnId).approval;
      assert.equal(card.text, `Clone the voice in ${take.name} as "Agent voice". ${CONSENT_LINE}.`);
      await client.ok("agent.approve", { id: card.id, allow: true });
      await agent.until((s) => s?.turns.some((t: any) => t.id === turnId && t.status !== "running"), 60000);
      const results = readFileSync(join(base, "results.jsonl"), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l));
      const answer = (tool: string) => JSON.parse(results.find((r) => r.tool === tool).result.content[0].text);
      assert.equal(answer("voice_list").voices.length, PRESET_VOICES.length);
      assert.equal(answer("voice_clone").voice.name, "Agent voice");
      const spoken = results.find((r) => r.tool === "generate_media").result;
      assert.equal(spoken.isError, undefined, spoken.content[0].text);
      assert.equal(JSON.parse(spoken.content[0].text).kind, "audio");
      await voices.until((s) => s.voices.length === PRESET_VOICES.length);
      assert.equal((await client.fail("voices.remove", { id: cloned.voice.id })).reason, "unknown-voice");
      assert.ok(snap.dir);
    } finally {
      client.close();
      server.proc.kill();
    }
  },
);
