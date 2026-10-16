// The sound library for the agent (D134, D135) on the bundled server through the scripted stand-in
// for claude (helpers/fake-claude.ts) and the real MCP server, with Openverse stubbed on this
// machine (UNCUT_OPENVERSE_BASE): library_search online (hits with ids, licences, frames) and
// included (the bundled sound effects), library_add downloading a CC BY hit and copying a bundled
// sound as audio media with their credits on the turn, project_read's credits, the limit as a
// sentence, bad ids refused; the tools, labels and the system prompt's note.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer, type Server as HttpServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { mcpTools, stepLabel, SYSTEM_PROMPT, TOOL_NAMES } from "../../apps/server/src/agent/agentTools.ts";
import type { Project } from "../../packages/core/src/index.ts";
import { BUNDLE, MEDIA, connect, killAll, startServer } from "../helpers/server.ts";

const MCP = resolve("apps/server/dist/mcp.mjs");
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
const skip = !existsSync(BUNDLE) || !existsSync(MCP) || !existsSync(MEDIA) ? "server bundle or media core not built (run pnpm build)" : !FFMPEG || !FFPROBE ? "ffmpeg isn't installed" : false;

type Server = Awaited<ReturnType<typeof startServer>>;
type Client = Awaited<ReturnType<typeof connect>>;
let root = "";
let server: Server;
let client: Client;
let agent: ReturnType<Client["subscribe"]>;
let dir = "";
let stub: HttpServer;
let base = "";
let limited = false;
let mp3: Buffer;
const requests: Array<string> = [];
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
const results = () => readFileSync(resultLog(), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const answer = (r: any) => JSON.parse(r.result.content[0].text);

const BOOM = "b0000000-0000-0000-0000-000000000001";
const result = (id: string, title: string, license: "cc0" | "by") => ({
  id,
  title,
  foreign_landing_url: `https://freesound.org/people/someone/sounds/${id.slice(0, 4)}`,
  url: `${base}/files/${id}.mp3`,
  creator: "someone",
  license,
  license_version: license === "by" ? "4.0" : "1.0",
  license_url: license === "by" ? "https://creativecommons.org/licenses/by/4.0/" : "https://creativecommons.org/publicdomain/zero/1.0/",
  provider: "freesound",
  filetype: "mp3",
  duration: 1500,
  tags: [{ name: "boom" }],
});

before(async () => {
  if (skip) return;
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-agent-library-")));
  execFileSync(FFMPEG!, ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=220:duration=1.5", "-c:a", "libmp3lame", "-b:a", "64k", join(root, "tone.mp3")]);
  mp3 = readFileSync(join(root, "tone.mp3"));
  stub = createServer((req, res) => {
    requests.push(req.url!);
    const url = new URL(req.url!, "http://x");
    if (url.pathname === "/v1/audio/") {
      if (limited) return res.writeHead(429, { "retry-after": "30" }).end("{}");
      res.writeHead(200, { "content-type": "application/json", "x-ratelimit-available-anon_burst": "18", "x-ratelimit-available-anon_sustained": "150" });
      return res.end(JSON.stringify({ result_count: 2, page_count: 1, results: [result(BOOM, "Cinema Boom", "by"), result("c0000000-0000-0000-0000-000000000002", "Soft Boom", "cc0")] }));
    }
    if (url.pathname.startsWith("/files/")) {
      res.writeHead(200, { "content-type": "audio/mpeg", "content-length": String(mp3.length) });
      return res.end(mp3);
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => stub.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(stub.address() as { port: number }).port}`;
  mkdirSync(join(root, "projects"));
  const shimDir = join(root, "bin");
  mkdirSync(shimDir);
  symlinkSync(FFMPEG!, join(shimDir, "ffmpeg"));
  symlinkSync(FFPROBE!, join(shimDir, "ffprobe"));
  symlinkSync(process.execPath, join(shimDir, "node"));
  writeFileSync(join(root, "prompts.jsonl"), "");
  writeFileSync(resultLog(), "");
  server = await startServer({
    env: { PATH: `${shimDir}:/usr/bin:/bin`, UNCUT_DATA_DIR: join(root, "data"), UNCUT_CLAUDE: FAKE, FAKE_PLAN: plan(), FAKE_PROMPT_LOG: join(root, "prompts.jsonl"), FAKE_RESULT_LOG: resultLog(), UNCUT_OPENVERSE_BASE: base, UNCUT_FREESOUND_BASE: "http://127.0.0.1:9", UNCUT_SFX_DIR: resolve("assets/sfx") },
  });
  client = await connect(server.ready.port, server.ready.token);
  agent = client.subscribe("agent.subscribe");
  const snap = await client.ok("project.create", { parentDir: join(root, "projects"), name: "Sounds" });
  dir = snap.dir;
  await agent.until((s) => s?.dir === dir);
});
after(async () => {
  client?.close();
  await server?.stop();
  killAll();
  stub?.closeAllConnections();
  stub?.close();
  if (root) rmSync(root, { recursive: true, force: true });
});

test("library_search and library_add: online hits and bundled sounds into media/ with credits; project_read lists them", { skip, timeout: 180000 }, async () => {
  const start = results().length;
  const turn = await ask("add a boom when the title lands", [
    { tool: "library_search", args: { kind: "sfx", query: "boom" } },
    { tool: "library_search", args: { kind: "sfx", source: "included", category: "meme" } },
    { tool: "library_add", args: { id: `openverse:${BOOM}` } },
    { tool: "library_add", args: { id: "sfx:airhorn" } },
    { tool: "library_add", args: { id: `openverse:${BOOM}` } },
    { tool: "library_add", args: { id: "pixabay:1" } },
    { tool: "library_search", args: { kind: "sfx" } },
    { tool: "project_read", args: {} },
  ]);
  assert.equal(turn.status, "done", turn.error);
  const mine = results().slice(start);
  const found = answer(mine[0]);
  assert.equal(found.source, "openverse");
  assert.deepEqual(
    found.hits.map((h: any) => [h.id, h.license, h.frames]),
    // Ranked (D208): both match "boom"; the CC0 one first.
    [
      ["openverse:c0000000-0000-0000-0000-000000000002", "CC0", 45],
      [`openverse:${BOOM}`, "CC BY 4.0", 45],
    ],
  );
  const searched = new URL(requests.find((r) => r.startsWith("/v1/audio/"))!, "http://x");
  assert.equal(searched.searchParams.get("license"), "cc0,by");
  assert.equal(searched.searchParams.get("license_type"), "commercial,modification");
  const memes = answer(mine[1]).sounds.map((s: any) => s.id);
  for (const id of ["sfx:bruh", "sfx:airhorn", "sfx:bass-boom"]) assert.ok(memes.includes(id), memes.join(", "));
  // The CC BY hit downloaded into media/ with its credits; the bundled airhorn copied.
  const boom = answer(mine[2]);
  assert.equal(boom.path, "media/cinema-boom-someone.mp3");
  assert.match(boom.license, /CC BY 4\.0: credit "Cinema Boom" by someone/);
  assert.ok(readFileSync(join(dir, boom.path)).equals(mp3));
  const horn = answer(mine[3]);
  assert.equal(horn.path, "media/airhorn.m4a");
  assert.ok(readFileSync(join(dir, horn.path)).equals(readFileSync(resolve("assets/sfx/airhorn.m4a"))));
  assert.match(answer(mine[4]).note, /already in the project/);
  assert.equal(mine[5].result.isError, true);
  assert.match(mine[5].result.content[0].text, /isn't a library id/);
  assert.equal(mine[6].result.isError, true);
  const media = onDisk().media.find((m) => m.id === boom.media)!;
  assert.equal(media.source?.module, "library.openverse");
  assert.equal(media.source?.license, "by");
  assert.equal(media.source?.title, "Cinema Boom");
  assert.match(String(media.source?.sha256), /^[0-9a-f]{64}$/);
  assert.equal(onDisk().media.find((m) => m.id === horn.media)!.source?.module, "library.bundled");
  const credits = answer(mine[7]).credits;
  assert.deepEqual(credits.needAttribution.map((c: any) => [c.title, c.license]), [["Cinema Boom", "CC BY 4.0"]]);
  assert.deepEqual(credits.publicDomain.map((c: any) => c.title), ["DJ airhorn"]);
  assert.match(credits.text, /"Cinema Boom" by someone \(https:\/\/freesound\.org\/people\/someone\/sounds\/b000\), licensed under CC BY 4\.0/);
  assert.match(credits.text, /Found with Openverse/);
  assert.ok(turn.items.some((i: any) => i.kind === "step" && i.text === 'Searched the sound effects library for "boom"'));
  assert.ok(turn.edits.some((e: any) => e.summary === "Added Cinema Boom from the sound library"), JSON.stringify(turn.edits.map((e: any) => e.summary)));
  // Undo turn removes both media (the files stay in media/).
  await client.ok("agent.undoTurn", { turnId: turn.id });
  assert.equal(onDisk().media.length, 0);
  assert.ok(existsSync(join(dir, "media", "airhorn.m4a")));
});

test("a 429 from Openverse: the limit as a sentence, the bundled sounds suggested", { skip, timeout: 120000 }, async () => {
  limited = true;
  const start = results().length;
  const turn = await ask("find a riser", [{ tool: "library_search", args: { kind: "sfx", query: "riser" } }]);
  assert.equal(turn.status, "done", turn.error);
  const r = results().slice(start)[0];
  assert.equal(r.result.isError, true);
  const body = JSON.parse(r.result.content[0].text);
  assert.match(body.limit, /^Openverse's search limit is reached\. Try again in (2\d|30) s\.$/);
  assert.match(body.note, /bundled sounds/);
});

test("the tools, labels and the system prompt's library note", { skip }, () => {
  for (const name of ["library_search", "library_add"]) {
    assert.ok((TOOL_NAMES as ReadonlyArray<string>).includes(name));
    assert.ok(mcpTools().some((t) => t.name === name), name);
  }
  assert.equal(stepLabel("library_search", { kind: "music", query: "lofi" }), 'Searched the music library for "lofi"');
  assert.equal(stepLabel("library_add", { id: "sfx:pop" }), "Added a bundled sound effect");
  assert.match(SYSTEM_PROMPT, /library_search finds royalty-free music and sound effects online/);
});
