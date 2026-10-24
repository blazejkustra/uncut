// Generators end to end on the bundled server (D99), with stub provider APIs (never a real one) and
// the scripted claude: the Generate tab's RPCs (a missing key says "Needs your … key", a stored key
// makes GPT Image work, the result is media in media/generated with source {module, prompt, model},
// one ⌘Z removes it, cancel leaves nothing), the SVG generator from the tab (Claude one-shot, no
// tools) and from the agent (its own SVG and an animation, drawn by the rasteriser and encoded),
// generate_media's key and cost rules (needsKey, confirmCost over $1, spend on the turn card) and
// Undo turn. The key never shows up in the server's output, the project, or any child's environment.
// Last, keys through the desktop's pipe (--keys-fd): only ciphertext reaches keys.json.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer, type Server, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { Duplex } from "node:stream";

import { BUNDLE, connect, killAll, startServer } from "../helpers/server.ts";

const FAKE_CLAUDE = resolve("test/helpers/fake-claude.ts");
const skip = !existsSync(BUNDLE) ? "the server bundle isn't built (pnpm --filter @uncut/server build)" : false;
const OPENAI_KEY = "sk-test-openai-not-real-4f2a9c";
const GOOGLE_KEY = "AIza-test-google-not-real-77b1";
const KEY_VARS = /^(ANTHROPIC_API_KEY|OPENAI_API_KEY|GOOGLE_API_KEY|GEMINI_API_KEY|ELEVENLABS_API_KEY)$/;
const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4a00000000049454e44ae426082",
  "hex",
);

let root = "";
let stub: Server;
let stubPort = 0;
const requests: Array<{ url: string; headers: Record<string, unknown>; body: string }> = [];
let veoSlow = false;
let openaiDelay = 0;
let openaiFail = false;
let mp4 = Buffer.alloc(0);

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

before(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-generate-")));
  if (skip) return;
  // A real 1 s MP4 for Veo's download, so the import can probe it.
  const clip = join(root, "veo.mp4");
  execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc=size=320x180:rate=30:duration=1", "-pix_fmt", "yuv420p", clip]);
  mp4 = readFileSync(clip);
  stub = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      requests.push({ url: req.url!, headers: req.headers, body });
      if (req.url === "/v1/images/generations") {
        if (openaiFail) return json(res, 500, { error: { message: "server melted" } });
        return void setTimeout(
          () => json(res, 200, { data: [{ b64_json: PNG.toString("base64") }], usage: { input_tokens: 10, output_tokens: 1584 } }),
          openaiDelay,
        );
      }
      if (req.url!.endsWith(":predictLongRunning")) return json(res, 200, { name: veoSlow ? "models/veo/operations/slow" : "models/veo/operations/fast" });
      if (req.url === "/v1beta/models/veo/operations/slow") return json(res, 200, { done: false });
      if (req.url === "/v1beta/models/veo/operations/fast")
        return json(res, 200, {
          done: true,
          response: { generateVideoResponse: { generatedSamples: [{ video: { uri: `http://127.0.0.1:${stubPort}/files/veo.mp4` } }] } },
        });
      if (req.url === "/files/veo.mp4") {
        res.writeHead(200, { "content-type": "video/mp4" });
        return res.end(mp4);
      }
      json(res, 404, { error: { message: "no such route" } });
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

const providerEnv = () => ({
  UNCUT_OPENAI_BASE: `http://127.0.0.1:${stubPort}`,
  UNCUT_GOOGLE_BASE: `http://127.0.0.1:${stubPort}`,
  UNCUT_ELEVENLABS_BASE: `http://127.0.0.1:${stubPort}`,
  UNCUT_VEO_POLL_MS: "50",
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

test("the Generate tab's RPCs and the agent's generate_media, with stub APIs and the scripted claude", { skip, timeout: 240000 }, async () => {
  const base = join(root, "server");
  mkdirSync(join(base, "projects"), { recursive: true });
  const files = { plan: join(base, "plan.json"), prompts: join(base, "prompts.jsonl"), results: join(base, "results.jsonl") };
  for (const f of [files.prompts, files.results]) writeFileSync(f, "");
  writeFileSync(files.plan, "[]");
  const server = await startServer({
    captureStderr: true,
    // ElevenLabs points at plain http off this machine: its key is never sent there (the refund case).
    env: {
      UNCUT_DATA_DIR: join(base, "data"),
      UNCUT_PLUGINS_DIR: "",
      UNCUT_BUNDLED_PLUGINS_DIR: join(base, "no-plugins"),
      UNCUT_CLAUDE: FAKE_CLAUDE,
      ANTHROPIC_API_KEY: "",
      FAKE_PLAN: files.plan,
      FAKE_PROMPT_LOG: files.prompts,
      FAKE_RESULT_LOG: files.results,
      ...providerEnv(),
      UNCUT_ELEVENLABS_BASE: "http://192.0.2.1",
      UNCUT_APPROVAL_MS: "4000",
    },
  });
  let stdout = "";
  server.proc.stdout!.on("data", (d) => (stdout += d));
  const client = await connect(server.ready.port, server.ready.token);
  try {
    // Without keys: the SVG generator is ready, the keyed ones say which key they need.
    const listed = await client.ok("generate.list");
    assert.deepEqual(
      listed.map((g: any) => [g.id, g.ready, g.needs ?? null]),
      [
        ["generate.svg", true, null],
        ["generate.gpt-image", false, "Needs your OpenAI key"],
        ["generate.veo", false, "Needs your Google key"],
        ["generate.sound", false, "Needs your ElevenLabs key"],
      ],
    );
    assert.deepEqual(
      (await client.ok("keys.list")).map((k: any) => [k.provider, k.set, k.storage]),
      [
        ["openai", false, "memory"],
        ["google", false, "memory"],
        ["elevenlabs", false, "memory"],
        ["freesound", false, "memory"],
      ],
    );
    assert.equal((await client.fail("generate.start", { generator: "generate.svg", prompt: "x" })).reason, "no-project");

    const agent = client.subscribe("agent.subscribe");
    const project = client.subscribe("project.subscribe");
    const jobs = client.subscribe("generate.jobs");
    const snap = await client.ok("project.create", { parentDir: join(base, "projects"), name: "Gen", canvas: { width: 1280, height: 720, fps: 30 } });
    await agent.until((s) => s?.dir === snap.dir);
    const mediaNow = () => project.values.at(-1)?.project.media ?? [];

    // A keyed generator without its key: refused with the line the UI shows.
    const needs = await client.fail("generate.start", { generator: "generate.gpt-image", prompt: "a phone on a desk" });
    assert.equal(needs.reason, "needs-key");
    assert.equal(needs.message, "Needs your OpenAI key. Add it in Settings › Keys.");
    assert.equal((await client.fail("generate.start", { generator: "generate.nope", prompt: "x" })).reason, "unknown-generator");
    assert.equal((await client.fail("generate.start", { generator: "generate.svg", prompt: "   " })).reason, "bad-request");
    assert.equal((await client.fail("keys.set", { provider: "openai", key: "has spaces in it" })).reason, "bad-request");

    // With the key: GPT Image into media/generated, source {module, prompt, model}; one ⌘Z removes it.
    const keys = await client.ok("keys.set", { provider: "openai", key: ` ${OPENAI_KEY} ` });
    assert.equal(keys.find((k: any) => k.provider === "openai").set, true);
    assert.ok(!JSON.stringify(keys).includes(OPENAI_KEY), "the key never comes back");
    assert.equal((await client.ok("generate.list")).find((g: any) => g.id === "generate.gpt-image").ready, true);
    const { jobId } = await client.ok("generate.start", { generator: "generate.gpt-image", prompt: "A phone on a desk, soft light", size: "1024x1024" });
    await jobs.until((v) => v.some((j: any) => j.id === jobId && j.phase === "done"), 30000);
    const done = jobs.values.at(-1).find((j: any) => j.id === jobId);
    await project.until((p) => p?.project.media.some((m: any) => m.id === done.mediaId));
    const image = mediaNow().find((m: any) => m.id === done.mediaId);
    assert.match(image.path, /^media\/generated\/a-phone-on-a-desk \d{8}-\d{6}\.png$/);
    assert.deepEqual(image.source, {
      module: "generate.gpt-image",
      prompt: "A phone on a desk, soft light",
      model: "gpt-image-2",
      kind: "image",
      size: "1024x1024",
    });
    assert.equal(image.kind, "image");
    const openaiCall = requests.find((r) => r.url === "/v1/images/generations")!;
    assert.equal(openaiCall.headers.authorization, `Bearer ${OPENAI_KEY}`);
    assert.equal(JSON.parse(openaiCall.body).size, "1024x1024");
    const undone = await client.ok("project.undo");
    assert.equal(undone.project.media.length, 0);
    assert.ok(existsSync(join(snap.dir, image.path)), "undo leaves the file in media/generated");

    // The SVG generator from the tab: Claude (one shot, no tools, no MCP, no key in its env) writes it.
    const svgJob = await client.ok("generate.start", { generator: "generate.svg", prompt: "A yellow sun on navy", kind: "image", size: "canvas" });
    await jobs.until((v) => v.some((j: any) => j.id === svgJob.jobId && (j.phase === "done" || j.phase === "failed")), 60000);
    const svgDone = jobs.values.at(-1).find((j: any) => j.id === svgJob.jobId);
    assert.equal(svgDone.phase, "done", svgDone.error);
    await project.until((p) => p?.project.media.some((m: any) => m.id === svgDone.mediaId));
    const svg = mediaNow().find((m: any) => m.id === svgDone.mediaId);
    assert.match(svg.path, /^media\/generated\/a-yellow-sun-on-navy \d{8}-\d{6}\.svg$/);
    assert.deepEqual(svg.source, { module: "generate.svg", prompt: "A yellow sun on navy", model: "claude", kind: "image", size: "canvas" });
    assert.equal(svg.probe.width, snap.project.canvas.width);
    const oneshot = readFileSync(files.prompts, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .find((e) => e.oneshot);
    assert.ok(oneshot, "claude was asked once");
    assert.equal(oneshot.tools, "");
    assert.ok(!oneshot.args.includes("--mcp-config"));
    assert.ok(oneshot.args.includes("--strict-mcp-config"));
    assert.match(oneshot.prompt, /A still picture, \d+x\d+ pixels\.\nWhat to draw: A yellow sun on navy/);
    assert.ok(!oneshot.env.some((k: string) => KEY_VARS.test(k)), oneshot.env.join(","));
    assert.ok(!oneshot.cwd.startsWith(snap.dir), "Claude runs outside the project");

    // Cancel: a Veo job stuck polling is stopped; nothing is added and no file is left.
    await client.ok("keys.set", { provider: "google", key: GOOGLE_KEY });
    veoSlow = true;
    const slow = await client.ok("generate.start", { generator: "generate.veo", prompt: "slow lake", seconds: 4 });
    await jobs.until((v) => v.some((j: any) => j.id === slow.jobId && /Veo is making/.test(j.status ?? "")), 15000);
    await client.ok("generate.cancel", { jobId: slow.jobId });
    await jobs.until((v) => v.some((j: any) => j.id === slow.jobId && j.phase === "cancelled"), 15000);
    veoSlow = false;
    assert.ok(!readdirSync(join(snap.dir, "media/generated")).some((f) => f.startsWith("slow-lake")), "no file left");
    assert.equal(mediaNow().length, 1);

    // Two jobs with the same name at once: each keeps its own file (the name is reserved per job).
    openaiDelay = 400;
    const twins = await Promise.all([1, 2].map(() => client.ok("generate.start", { generator: "generate.gpt-image", prompt: "a twin", name: "twin" })));
    await jobs.until((v) => twins.every((t) => v.some((j: any) => j.id === t.jobId && j.phase === "done")), 30000);
    openaiDelay = 0;
    await project.until((p) => p?.project.media.length === 3);
    assert.deepEqual(
      mediaNow()
        .filter((m: any) => m.source.prompt === "a twin")
        .map((m: any) => m.path)
        .sort(),
      ["media/generated/twin 2.png", "media/generated/twin.png"],
    );
    await client.ok("project.undo");
    await client.ok("project.undo");
    await project.until((p) => p?.project.media.length === 1);

    // The agent: no key → needsKey; its own SVG; an animation; Veo needs confirmCost; spend; Undo turn.
    await client.ok("keys.remove", { provider: "google" });
    const turns: Array<unknown> = [];
    const ask = async (prompt: string, steps: Array<unknown>) => {
      turns.push(steps);
      writeFileSync(files.plan, JSON.stringify(turns));
      const { turnId } = await client.ok("agent.send", { prompt });
      await agent.until((s) => s?.turns.some((t: any) => t.id === turnId && t.status !== "running"), 120000);
      return agent.values.at(-1).turns.find((t: any) => t.id === turnId);
    };
    const results = () =>
      readFileSync(files.results, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l));
    const resultsOf = (tool: string) =>
      results()
        .filter((r) => r.tool === tool)
        .map((r) => ({ isError: r.result.isError === true, text: r.result.content.map((c: any) => c.text).join("\n") }));

    const logo = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 200"><rect width="400" height="200" fill="#111"/><text x="200" y="115" font-size="48" text-anchor="middle" fill="#fff">Uncut</text></svg>`;
    const anim = `<!doctype html><html><body style="margin:0;background:#0B1D3A"><div id="bar" style="position:absolute;left:0;top:40%;height:20%;background:#F5A524;width:0"></div><script>window.render = (t, info) => { document.getElementById("bar").style.width = Math.min(100, t * 100) + "%"; };</script></body></html>`;
    const turn = await ask("Make me a logo, an animated bar, and a Veo shot of a lake", [
      { tool: "generate_media", args: { generator: "generate.veo", prompt: "a lake at dawn" } },
      { tool: "generate_media", args: { generator: "generate.svg", prompt: "The Uncut wordmark", kind: "image", content: logo, name: "wordmark" } },
      { tool: "generate_media", args: { generator: "generate.svg", prompt: "A bar filling up", kind: "video", seconds: 1, size: "320x180", content: anim } },
      { tool: "generate_media", args: { generator: "generate.gpt-image", prompt: "a phone", kind: "video" } },
    ]);
    assert.equal(turn.status, "done", JSON.stringify(turn));
    const gen = resultsOf("generate_media");
    assert.equal(gen[0]!.isError, true);
    assert.equal(JSON.parse(gen[0]!.text).needsKey, "google");
    assert.match(JSON.parse(gen[0]!.text).message, /^Needs your Google key\. Nothing was generated\.$/);
    assert.equal(gen[1]!.isError, false, gen[1]!.text);
    const wordmark = JSON.parse(gen[1]!.text);
    assert.equal(wordmark.kind, "image");
    assert.match(wordmark.path, /^media\/generated\/wordmark\.svg$/);
    assert.equal(wordmark.estimatedCost, 0);
    assert.equal(gen[2]!.isError, false, gen[2]!.text);
    const bar = JSON.parse(gen[2]!.text);
    assert.equal(bar.kind, "video");
    assert.equal(bar.frames, 30);
    assert.deepEqual([bar.width, bar.height], [320, 180]);
    assert.equal(gen[3]!.text, "GPT Image makes pictures, not video (kind image).");
    assert.equal(turn.spend, undefined, "free generators cost nothing");
    assert.deepEqual(
      turn.edits.map((e: any) => e.summary),
      ["Generated wordmark", `Generated ${bar.name}`],
    );
    assert.deepEqual(
      turn.items.filter((i: any) => i.kind === "step").map((i: any) => i.text),
      ["Generated a video with Veo", "Generated a picture from SVG", "Generated a video from SVG", "Generated a video with GPT Image"],
    );
    // A frame of the animation, drawn at t = 0.5 s: about half the bar is orange.
    const barFile = join(snap.dir, bar.path);
    const mid = execFileSync("ffmpeg", [
      "-v",
      "error",
      "-ss",
      "0.5",
      "-i",
      barFile,
      "-frames:v",
      "1",
      "-vf",
      "crop=320:2:0:90",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "-",
    ]);
    const orange = [...Array(320).keys()].filter((x) => mid[x * 3]! > 200 && mid[x * 3 + 1]! > 120).length;
    assert.ok(orange > 120 && orange < 200, `orange pixels at 0.5 s: ${orange}`);

    // Veo with its key: over $1, so the call waits for the user's Allow on a card (the agent can't approve it).
    await client.ok("keys.set", { provider: "google", key: GOOGLE_KEY });
    // The next card that shows up (values seen so far don't count), answered or left alone.
    const answerNext = (allow: boolean | undefined) => {
      const from = agent.values.length;
      return agent
        .until((st, i) => i >= from && !!st?.approval, 30000)
        .then(async () => {
          const card = agent.values.slice(from).find((st: any) => st?.approval).approval;
          assert.equal(card.text, "Generate a 4 s Veo video, about $1.60 on your Google key");
          assert.equal(card.estimate, 1.6);
          if (allow !== undefined) await client.ok("agent.approve", { id: card.id, allow });
          return card;
        });
    };
    const allowed = answerNext(true);
    const veoTurn = await ask("Make the Veo shot", [
      { tool: "generate_media", args: { generator: "generate.veo", prompt: "a lake at dawn", seconds: 4, confirmCost: true } },
    ]);
    await allowed;
    const lake = JSON.parse(resultsOf("generate_media").at(-1)!.text);
    assert.equal(lake.estimatedCost, 1.6);
    assert.equal(veoTurn.spend, 1.6);
    assert.equal(agent.values.at(-1).approval, undefined, "the card is gone once answered");
    const lakeMedia = mediaNow().find((m: any) => m.id === lake.id);
    assert.deepEqual(lakeMedia.source, { module: "generate.veo", prompt: "a lake at dawn", model: "veo-3.1-generate-preview", kind: "video", seconds: 4 });
    const veoStart = requests.filter((r) => r.url.endsWith(":predictLongRunning")).at(-1)!;
    assert.equal(veoStart.headers["x-goog-api-key"], GOOGLE_KEY);

    // Don't: declined with a sentence, nothing sent, nothing spent. No answer (4 s here): declined too.
    const veoCalls = () => requests.filter((r) => r.url.endsWith(":predictLongRunning")).length;
    const callsBefore = veoCalls();
    const declined = answerNext(false);
    const noTurn = await ask("Another Veo shot", [{ tool: "generate_media", args: { generator: "generate.veo", prompt: "a second lake", seconds: 4 } }]);
    await declined;
    const no = JSON.parse(resultsOf("generate_media").at(-1)!.text);
    assert.equal(no.approved, false);
    assert.match(no.message, /The user didn't allow it \(about \$1\.60 on their Google key\)\. Nothing was generated\./);
    const quiet = answerNext(undefined);
    const lateTurn = await ask("And one more", [{ tool: "generate_media", args: { generator: "generate.veo", prompt: "a third lake", seconds: 4 } }]);
    await quiet;
    assert.match(JSON.parse(resultsOf("generate_media").at(-1)!.text).message, /Nobody answered the approval in the Agent tab/);
    assert.equal(veoCalls(), callsBefore, "declined and unanswered never reach Veo");
    assert.equal(noTurn.spend, undefined);
    assert.equal(lateTurn.spend, undefined);

    // Spend reservation: a failure after the request went out keeps the estimate on the turn; one
    // before any request (ElevenLabs' address isn't https, so the key isn't sent) is refunded.
    await client.ok("keys.set", { provider: "elevenlabs", key: "el-test-not-real" });
    openaiFail = true;
    const failTurn = await ask("Try a picture and a sound", [
      { tool: "generate_media", args: { generator: "generate.gpt-image", prompt: "a broken picture" } },
      { tool: "generate_media", args: { generator: "generate.sound", prompt: "a whoosh", seconds: 2 } },
    ]);
    openaiFail = false;
    const [pic, whoosh] = resultsOf("generate_media").slice(-2);
    assert.match(pic!.text, /Nothing was generated: OpenAI refused the request \(500\): server melted\./);
    assert.match(whoosh!.text, /isn't https, so your key wasn't sent/);
    assert.equal(failTurn.spend, 0.048, "the picture's estimate is kept, the sound's refunded");

    // Undo turn takes each turn's generated media out again.
    for (const t of [failTurn, lateTurn, noTurn]) await client.ok("agent.undoTurn", { turnId: t.id }).catch(() => {});
    await client.ok("agent.undoTurn", { turnId: veoTurn.id });
    await client.ok("agent.undoTurn", { turnId: turn.id });
    await project.until((p) => p?.project.media.length === 1);
    assert.deepEqual(
      mediaNow().map((m: any) => m.id),
      [svg.id],
    );

    // The keys never show up in the server's output, the project folder or any child's environment.
    await new Promise((r) => setTimeout(r, 200));
    for (const key of [OPENAI_KEY, GOOGLE_KEY]) {
      assert.ok(!stdout.includes(key) && !server.stderr().includes(key), "not in the server's output");
      assert.deepEqual(filesContaining(snap.dir, key), [], "not in the project");
      assert.deepEqual(filesContaining(base, key), [], "not in the data dir, logs or the scripted claude's records");
    }
    for (const entry of readFileSync(files.prompts, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l)))
      assert.ok(!entry.env.some((k: string) => KEY_VARS.test(k)), "no key variables in claude's environment");
    assert.ok(!existsSync(join(base, "data", "keys.json")), "memory only without the desktop");
  } finally {
    client.close();
    await server.stop();
  }
});

test("keys through the desktop's pipe (--keys-fd 4): only ciphertext in keys.json, decrypted for the request", { skip, timeout: 60000 }, async () => {
  const base = join(root, "pipe");
  mkdirSync(join(base, "projects"), { recursive: true });
  const ops: Array<string> = [];
  // UNCUT_CDP: the desktop under the test harness, so the stub base URLs count.
  const server = await startServer({
    args: ["--keys-fd", "4"],
    env: {
      UNCUT_CDP: "1",
      UNCUT_DATA_DIR: join(base, "data"),
      UNCUT_PLUGINS_DIR: "",
      UNCUT_BUNDLED_PLUGINS_DIR: join(base, "none"),
      UNCUT_CLAUDE: FAKE_CLAUDE,
      ...providerEnv(),
    },
  });
  // The desktop's side (apps/desktop/src/server.ts), with a stand-in for safeStorage.
  const pipe = server.proc.stdio[4] as Duplex;
  createInterface({ input: pipe }).on("line", (line) => {
    const msg = JSON.parse(line);
    ops.push(msg.op);
    if (msg.op === "encrypt")
      pipe.write(`${JSON.stringify({ id: msg.id, ok: true, data: Buffer.from(`sealed:${[...msg.text].reverse().join("")}`).toString("base64") })}\n`);
    else pipe.write(`${JSON.stringify({ id: msg.id, ok: true, text: [...Buffer.from(msg.data, "base64").toString().slice(7)].reverse().join("") })}\n`);
  });
  const client = await connect(server.ready.port, server.ready.token);
  try {
    const listed = await client.ok("keys.set", { provider: "openai", key: OPENAI_KEY });
    assert.equal(listed.find((k: any) => k.provider === "openai").storage, "keychain");
    const file = join(base, "data", "keys.json");
    const text = readFileSync(file, "utf8");
    assert.ok(!text.includes(OPENAI_KEY), text);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(ops, ["encrypt"]);
    await client.ok("project.create", { parentDir: join(base, "projects"), name: "Pipe" });
    const jobs = client.subscribe("generate.jobs");
    const before = requests.length;
    const { jobId } = await client.ok("generate.start", { generator: "generate.gpt-image", prompt: "a desk" });
    await jobs.until((v) => v.some((j: any) => j.id === jobId && j.phase === "done"), 30000);
    assert.deepEqual(ops, ["encrypt", "decrypt"]);
    assert.equal(requests.slice(before).find((r) => r.url === "/v1/images/generations")!.headers.authorization, `Bearer ${OPENAI_KEY}`);
    await client.ok("keys.remove", { provider: "openai" });
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).keys, {});
  } finally {
    client.close();
    await server.stop();
  }
});
