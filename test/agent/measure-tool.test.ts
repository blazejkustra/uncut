// The measure tool (handoff points 15 and 22) on the bundled server through the scripted stand-in
// for claude (helpers/fake-claude.ts) and the real MCP server, on generated media:
// - sound: a talking clip on main (its own sound is the voice) and a whoosh 25 dB under it read as
//   the voice at the export's target and the effect 25 dB under, fine;
// - colour: a magenta-warm clip reads as a cast with the temperature and tint that neutralise it;
//   putting those values in its effect.color makes the edit's frame read neutral (no throwaway edit
//   to learn which way tint goes); the step labels.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { stepLabel } from "../../apps/server/src/agent/agentTools.ts";
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
const skip =
  !existsSync(BUNDLE) || !existsSync(MCP) || !existsSync(MEDIA)
    ? "server bundle or media core not built (run pnpm build)"
    : !FFMPEG || !FFPROBE
      ? "ffmpeg isn't installed"
      : false;

type Server = Awaited<ReturnType<typeof startServer>>;
type Client = Awaited<ReturnType<typeof connect>>;
let root = "";
let server: Server;
let client: Client;
let agent: ReturnType<Client["subscribe"]>;
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
const results = () =>
  readFileSync(resultLog(), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
const answer = (r: any) => JSON.parse(r.result.content[0].text);
const ff = (...args: Array<string>) => execFileSync(FFMPEG!, ["-v", "error", "-y", ...args]);

before(async () => {
  if (skip) return;
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-measure-")));
  mkdirSync(join(root, "projects"));
  mkdirSync(join(root, "footage"));
  const shimDir = join(root, "bin");
  mkdirSync(shimDir);
  symlinkSync(FFMPEG!, join(shimDir, "ffmpeg"));
  symlinkSync(FFPROBE!, join(shimDir, "ffprobe"));
  symlinkSync(process.execPath, join(shimDir, "node"));
  writeFileSync(join(root, "prompts.jsonl"), "");
  writeFileSync(resultLog(), "");
  ff(
    "-f",
    "lavfi",
    "-i",
    "color=c=0x8c7a86:s=320x180:r=30:d=4",
    "-f",
    "lavfi",
    "-i",
    "aevalsrc=0.2*sin(2*PI*1000*t):s=48000:d=4",
    "-c:v",
    "mjpeg",
    "-q:v",
    "2",
    "-c:a",
    "pcm_s16le",
    "-shortest",
    join(root, "footage", "talk.mov"),
  );
  ff("-f", "lavfi", "-i", `aevalsrc=${0.2 * 10 ** (-25 / 20)}*sin(2*PI*1100*t):s=48000:d=1`, "-c:a", "pcm_s16le", join(root, "footage", "whoosh.wav"));
  server = await startServer({
    env: {
      PATH: `${shimDir}:/usr/bin:/bin`,
      UNCUT_DATA_DIR: join(root, "data"),
      UNCUT_CLAUDE: FAKE,
      FAKE_PLAN: plan(),
      FAKE_PROMPT_LOG: join(root, "prompts.jsonl"),
      FAKE_RESULT_LOG: resultLog(),
    },
  });
  client = await connect(server.ready.port, server.ready.token);
  agent = client.subscribe("agent.subscribe");
  const snap = await client.ok("project.create", { parentDir: join(root, "projects"), name: "Measure" });
  await agent.until((s) => s?.dir === snap.dir);
});
after(async () => {
  client?.close();
  await server?.stop();
  killAll();
  if (root) rmSync(root, { recursive: true, force: true });
});

test("measure: the sound by role and the colour cast, and its suggested fix lands neutral", { skip, timeout: 240000 }, async () => {
  const start = results().length;
  const imported = await ask("bring in the footage", [
    { tool: "media_import", args: { paths: [join(root, "footage", "talk.mov"), join(root, "footage", "whoosh.wav")] } },
  ]);
  assert.equal(imported.status, "done", imported.error);
  const media = answer(results()[start]).imported as Array<{ id: string; name: string }>;
  const talk = media.find((m) => m.name.startsWith("talk"))!.id;
  const whoosh = media.find((m) => m.name.startsWith("whoosh"))!.id;

  const turn = await ask("place them and measure", [
    { tool: "project_read", args: {} },
    {
      tool: "timeline_edit",
      args: {
        baseRevision: "$rev",
        summary: "Talk and a whoosh",
        ops: [
          { op: "insert_item", track: "main", item: { id: "talk", type: "clip", media: talk, in: 0, duration: 90 } },
          { op: "add_track", track: { id: "sfx", kind: "audio", name: "Sound effects" } },
          { op: "insert_item", track: "sfx", item: { id: "fx", type: "audio", media: whoosh, in: 0, start: 30, duration: 15 } },
        ],
      },
    },
    { tool: "measure", args: { what: "sound" } },
    { tool: "measure", args: { what: "colour", items: ["talk"], frames: [45] } },
    { tool: "measure", args: { what: "colour" } },
    { tool: "measure", args: { what: "colour", items: ["fx"] } },
  ]);
  assert.equal(turn.status, "done", turn.error);
  const mine = results().slice(start + 1);
  const sound = answer(mine[2]);
  assert.equal(sound.master.targetLufs, -14);
  assert.ok(Math.abs(sound.roles.voice.lufs - -14) < 0.5, JSON.stringify(sound.roles));
  const [fx] = sound.effects;
  assert.equal(fx.item, "fx");
  assert.equal(fx.at, 1);
  assert.equal(fx.against, "voice");
  assert.ok(Math.abs(fx.under - 25) < 1.5, `${fx.under}`);
  assert.match(fx.verdict, /fine \(typical 22 to 30 dB under\)/);

  const colour = answer(mine[3]);
  assert.match(colour.directions, /tint \+ is magenta/);
  const clip = colour.items[0];
  assert.equal(clip.item, "talk");
  assert.match(clip.whiteBalance, /magenta cast/);
  const frame = colour.frames[0];
  assert.equal(frame.frame, 45);
  assert.ok(Math.abs(frame.luma - clip.luma) < 3, `the edit's frame and the clip alone agree: ${frame.luma} vs ${clip.luma}`);
  const fix = /add temperature (-?[\d.]+) and tint (-?[\d.]+)/.exec(clip.neutralise)!;
  assert.ok(Number(fix[2]) < 0, "magenta is taken out with tint towards green");
  assert.equal(mine[4].result.isError, true);
  assert.match(mine[4].result.content[0].text, /Pass frames/);
  assert.equal(mine[5].result.isError, true);
  assert.match(mine[5].result.content[0].text, /isn't a video or picture clip/);
  assert.ok(turn.items.some((i: any) => i.kind === "step" && i.text === "Measured the sound mix"));
  assert.ok(turn.items.some((i: any) => i.kind === "step" && i.text === "Measured the colour"));

  const graded = await ask("fix the white balance", [
    { tool: "project_read", args: {} },
    {
      tool: "timeline_edit",
      args: {
        baseRevision: "$rev",
        summary: "White balance",
        ops: [
          { op: "update_item", item: "talk", set: { effects: [{ module: "effect.color", params: { temperature: Number(fix[1]), tint: Number(fix[2]) } }] } },
        ],
      },
    },
    { tool: "measure", args: { what: "colour", frames: [45], items: ["talk"] } },
  ]);
  assert.equal(graded.status, "done", graded.error);
  const after = answer(results().at(-1));
  assert.match(after.frames[0].whiteBalance, /^neutral/, after.frames[0].whiteBalance);
  assert.match(after.items[0].whiteBalance, /^neutral/, after.items[0].whiteBalance);
});

test("measure's step labels", () => {
  assert.equal(stepLabel("measure", { what: "sound" }), "Measured the sound mix");
  assert.equal(stepLabel("measure", { what: "colour", frames: [1] }), "Measured the colour");
  assert.equal(stepLabel("measure", { what: "colour", items: ["a", "b"] }), "Compared the clips' colour");
});
