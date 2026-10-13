// Phase 7 exit check, the real half (D101): a real Argent recording on a simulator you booted, and one
// real-claude turn that records a flow, generates an SVG title card and places them. The scripted
// half is test/app/phase7-exit.test.ts. Not part of `pnpm test`: it uses your Claude subscription
// (claude CLI, signed in) and your Argent. ANTHROPIC_API_KEY is removed from this process and from
// the server's environment (D41).
//
// Run from the repo root:
//   node scripts/phase7-manual-check.ts                      print what to do in the app and what to check
//   node scripts/phase7-manual-check.ts --run --flow <yaml>  do it headlessly (after pnpm build): the bundled
//                                                            server, a project of its own, the real claude and
//                                                            the real argent, then a PASS/CHECK list
//   ... --device <id>     the simulator to record (default: the first booted iOS simulator Argent lists)
//   ... --out <dir>       where to put it all (default: a new temp folder)
//   ... --with-keys       also generate a GPT Image picture with your OpenAI key (read from OPENAI_API_KEY
//                         in this shell and handed to the server over its RPC, never in its environment;
//                         about $0.05). Without it no keyed provider is reachable: their base URLs point
//                         at a closed local port.
//   ... --fake            (testing this script) the scripted claude, the fake argent and the fake whisper
//                         from the exit test instead of the real ones: nothing real is used
// It never boots, shuts down or stops anything: no booted simulator in Argent's list means it refuses.
// It only asks Argent for its device list, a recording's start and stop and a flow run (through the
// bundled plugin). The transcript isn't part of the real run (it would download the speech model).
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

import { projectChecks, type Project } from "../packages/core/src/index.ts";
import { DEVICE, FLOW_YAML, makeFiles, placeSteps, recordSteps } from "../test/helpers/phase7-fixture.ts";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const option = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const openaiKey = process.env.OPENAI_API_KEY;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.OPENAI_API_KEY;
const fake = flag("--fake");
const withKeys = flag("--with-keys");
const flowArg = option("--flow");

const prompt = (flow: string, device: string) =>
  [
    `Record the saved flow "${flow}" on the simulator ${device} with Argent (list the devices first, then argent_record with that flow; the take comes back as media).`,
    "Then make a 1920×1080 title card that says \"Recorded with Argent\" with generate_media and generator generate.svg, writing the SVG yourself (content); it's free.",
    withKeys ? "Then generate one picture with generate.gpt-image (a phone on a wooden desk, 1536x1024): it's billed to my OpenAI key, about $0.05." : "Don't use any generator that needs a key.",
    "Place the title card first and the take after it on the main track with timeline_edit, run project_check and fix every warning.",
  ].join(" ");

if (!flag("--run")) {
  console.log(`
Manual check in the app (pnpm dev, or dist/mac-arm64/Uncut.app). You boot the simulator; Uncut never does.
  1. Boot an iOS simulator yourself and open your app on it. Have an Argent flow for it (a .yaml from
     argent's flow recorder). Argent 0.19 or newer: argent --version.
  2. New project (1920×1080, 30 fps). Capture tab: the simulator is listed as recordable. Record a few
     seconds, Stop: the take is in Media. ⌘Z takes it out, ⇧⌘Z brings it back.
  3. Copy your flow into the project's flows/ folder (e.g. flows/demo.yaml). In the Agent tab send:

${prompt("demo", "<your simulator>")}

  4. Expect: argent_list_devices, argent_record (the flow replays while it records; the take is imported),
     generate_media (generate.svg, "Free on your Claude subscription"), a timeline_edit, project_check with
     0 warnings. The turn card shows no spend.
  5. Transcript (optional, downloads the speech model once): import a clip with speech, Transcript tab,
     Transcribe. The words come from the bundled Whisper plugin (Settings, Capture step, Plugins lists it).
  6. Export; Undo turn restores the project before the turn; quit, reopen from Recents, ⌘Z / ⇧⌘Z still work.
  7. The simulator is still booted and Argent's tool-server still runs afterwards (nothing stopped them).

Or headlessly: node scripts/phase7-manual-check.ts --run --flow <your flow.yaml> [--device <id>] [--with-keys]
`);
  process.exit(0);
}

if (withKeys && !fake && !openaiKey) {
  console.error("--with-keys needs OPENAI_API_KEY set in this shell.");
  process.exit(2);
}
if (!fake && !flowArg) {
  console.error("Pass --flow <path to an Argent flow .yaml> for the app on your simulator.");
  process.exit(2);
}
if (flowArg && !existsSync(flowArg)) {
  console.error(`There's no flow at ${flowArg}.`);
  process.exit(2);
}

const out = resolve(option("--out") ?? realpathSync(mkdtempSync(join(tmpdir(), "uncut-phase7-manual-"))));
mkdirSync(out, { recursive: true });
const data = join(out, "data");
mkdirSync(data, { recursive: true });
writeFileSync(join(data, "settings.json"), JSON.stringify({ onboarded: true }));

// Fakes for --fake: argent, whisper-cli and claude from the tests, on PATH or by variable.
const env: NodeJS.ProcessEnv = { UNCUT_DATA_DIR: data, ANTHROPIC_API_KEY: "" };
const fakePlan = join(out, "plan.json");
const results = join(out, "results.jsonl");
const place = join(out, "place.json");
let files: ReturnType<typeof makeFiles> | undefined;
if (fake) {
  files = makeFiles(join(out, "files"));
  const bin = join(out, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "whisper-cli"), `#!/bin/sh\nexec "${process.execPath}" "${resolve("test/helpers/fake-whisper.ts")}" "$@"\n`);
  chmodSync(join(bin, "whisper-cli"), 0o755);
  if (!existsSync(join(bin, "node"))) symlinkSync(process.execPath, join(bin, "node"));
  mkdirSync(join(data, "models"), { recursive: true });
  writeFileSync(join(data, "models", "ggml-large-v3-turbo-q5_0.bin"), "fake model");
  writeFileSync(results, "");
  Object.assign(env, {
    PATH: `${bin}:${process.env.PATH}`,
    ARGENT_BIN: resolve("test/helpers/fake-argent/argent"),
    FAKE_ARGENT_NODE: process.execPath,
    FAKE_ARGENT_LOG: join(out, "argent.jsonl"),
    FAKE_WHISPER_JSON: files.whisper,
    UNCUT_CLAUDE: resolve("test/helpers/fake-claude.ts"),
    FAKE_PLAN: fakePlan,
    FAKE_PROMPT_LOG: join(out, "prompts.jsonl"),
    FAKE_RESULT_LOG: results,
  });
} else delete process.env.UNCUT_CLAUDE;
// No keyed provider is reachable unless --with-keys: their base URLs go to a closed local port.
if (!withKeys || fake) Object.assign(env, { UNCUT_OPENAI_BASE: "http://127.0.0.1:9", UNCUT_GOOGLE_BASE: "http://127.0.0.1:9", UNCUT_ELEVENLABS_BASE: "http://127.0.0.1:9" });

// A booted simulator, from Argent's own list (read-only). None: refuse. Never boot one.
const argentBin = (env.ARGENT_BIN as string | undefined) ?? process.env.ARGENT_BIN ?? "argent";
let devices: Array<{ platform?: string; udid?: string; name?: string; state?: string; runtimeKind?: string; kind?: string }>;
try {
  const listed = JSON.parse(execFileSync(argentBin, ["run", "list-devices", "--json"], { encoding: "utf8", env: { ...process.env, ...env } as NodeJS.ProcessEnv, timeout: 60_000 }));
  devices = listed.devices ?? [];
} catch (error) {
  console.error(`Couldn't ask Argent for its devices (${(error as Error).message.split("\n")[0]}). Is it installed? npm i -g @swmansion/argent@latest`);
  process.exit(2);
}
const booted = devices.filter((d) => d.platform === "ios" && d.state === "Booted" && (d.runtimeKind ?? "mobile") === "mobile" && d.kind !== "device");
const device = option("--device") ?? (fake ? DEVICE : booted[0]?.udid);
if (!booted.length || !device || !booted.some((d) => d.udid === device)) {
  console.error(booted.length ? `${device} isn't a booted iOS simulator Argent lists. Booted: ${booted.map((d) => `${d.name} (${d.udid})`).join(", ")}.` : "No booted iOS simulator in Argent's list. Boot one yourself (Simulator.app or xcrun simctl boot), then run this again; this script never boots one.");
  process.exit(2);
}
console.log(`Recording on ${booted.find((d) => d.udid === device)?.name ?? device} (${device}). Output in ${out}`);

const { BUNDLE, MEDIA, connect, startServer } = await import("../test/helpers/server.ts");
for (const built of [BUNDLE, resolve("apps/server/dist/mcp.mjs"), MEDIA]) if (!existsSync(built)) throw new Error(`${built} isn't built: run pnpm build (from the repo root)`);
const server = await startServer({ env });
const client = await connect(server.ready.port, server.ready.token);
const checks: Array<[string, boolean]> = [];
try {
  const agent = client.subscribe("agent.subscribe");
  if (withKeys && !fake) await client.ok("keys.set", { provider: "openai", key: openaiKey });
  mkdirSync(join(out, "projects"), { recursive: true });
  const snap = await client.ok("project.create", { parentDir: join(out, "projects"), name: "Phase 7", canvas: { width: 1920, height: 1080, fps: 30 } });
  await agent.until((s) => s?.dir === snap.dir, 20000);
  const flowName = fake ? "demo" : basename(flowArg!).replace(/\.ya?ml$/i, "");
  mkdirSync(join(snap.dir, "flows"), { recursive: true });
  if (fake) writeFileSync(join(snap.dir, "flows", "demo.yaml"), FLOW_YAML);
  else copyFileSync(flowArg!, join(snap.dir, "flows", `${flowName}.yaml`));
  const before = (await client.ok("project.get", {})).project as Project;

  if (fake) {
    writeFileSync(fakePlan, JSON.stringify([recordSteps(files!.voice, place, { keyed: false })]));
    // The scripted claude's second half, once the first has imported everything (as the exit test does).
    void (async () => {
      for (let i = 0; i < 600; i++) {
        await new Promise((r) => setTimeout(r, 200));
        const done = readFileSync(results, "utf8").includes('"media_import"');
        if (!done) continue;
        const p = (await client.ok("project.get", {})).project as Project;
        const take = p.media.find((m) => m.source?.module === "argent.capture")!;
        const card = p.media.find((m) => m.source?.module === "generate.svg")!;
        const voice = p.media.find((m) => m.path === files!.voice)!;
        writeFileSync(place, JSON.stringify(placeSteps({ capture: take.id, captureFrames: take.probe!.frames!, demo: take.id, demoFrames: take.probe!.frames!, card: card.id, voice: voice.id })));
        return;
      }
    })();
  }
  const text = prompt(flowName, device);
  console.log(`\nPrompt: ${text}\nWaiting for the turn (up to 20 min) …`);
  const t0 = Date.now();
  const { turnId } = await client.ok("agent.send", { prompt: text });
  let shown = 0;
  const timer = setInterval(() => {
    const turn = agent.values.at(-1)?.turns?.find((t: any) => t.id === turnId);
    const steps = (turn?.items ?? []).filter((i: any) => i.kind === "step");
    for (const s of steps.slice(shown)) console.log(`  - ${s.text} (${s.status})`);
    shown = steps.length;
  }, 1000);
  await agent.until((s) => s?.turns?.some((t: any) => t.id === turnId && t.status !== "running"), 20 * 60 * 1000);
  clearInterval(timer);
  const turn = agent.values.at(-1).turns.find((t: any) => t.id === turnId);
  console.log(`Turn ${turn.status} in ${((Date.now() - t0) / 1000).toFixed(0)} s${turn.error ? `: ${turn.error}` : ""}`);
  for (const i of turn.items) if (i.kind === "text") console.log(`  claude: ${i.text}`);
  checks.push(["the turn finished", turn.status === "done"]);

  const project = (await client.ok("project.get", {})).project as Project;
  const takes = project.media.filter((m) => m.source?.module === "argent.capture");
  const flowTake = takes.find((m) => typeof m.source?.flow === "string" && m.source.flow.startsWith("flows/"));
  checks.push([`a take recorded with Argent from the flow (${takes.map((m) => m.path).join(", ") || "none"})`, !!flowTake && existsSync(join(snap.dir, flowTake.path))]);
  const card = project.media.find((m) => m.source?.module === "generate.svg");
  checks.push([`an SVG title card generated (${card?.path ?? "none"})`, !!card]);
  const picture = project.media.find((m) => m.source?.module === "generate.gpt-image");
  checks.push([withKeys ? `a GPT Image picture (${picture?.path ?? "none"})` : "no keyed generator was used", withKeys ? !!picture || fake : !picture]);
  const main = project.tracks.find((t) => t.role === "main")?.items ?? [];
  const order = main.map((i) => i.media);
  checks.push(["the card, then the take, on the main track", !!card && !!flowTake && order.includes(card.id) && order.includes(flowTake.id) && order.indexOf(card.id) < order.indexOf(flowTake.id)]);
  const warnings = projectChecks(project).filter((c) => c.severity === "warn");
  for (const w of warnings) console.log(`  check: ${w.message}`);
  checks.push([`project_check: no warnings (${warnings.length})`, warnings.length === 0]);
  checks.push([`spend on the turn: ${turn.spend ? `$${turn.spend}` : "none"}`, withKeys ? (turn.spend ?? 0) < 1 : !turn.spend]);
  // Undo turn: the project before it.
  await client.ok("agent.undoTurn", { turnId }).catch(() => undefined);
  const undone = (await client.ok("project.get", {})).project as Project;
  checks.push(["Undo turn restores the project before the turn", JSON.stringify(undone.tracks) === JSON.stringify(before.tracks) && undone.media.length === before.media.length]);
  // Still booted: nothing was stopped.
  const after = JSON.parse(execFileSync(argentBin, ["run", "list-devices", "--json"], { encoding: "utf8", env: { ...process.env, ...env } as NodeJS.ProcessEnv, timeout: 60_000 })).devices ?? [];
  checks.push([`${device} is still booted`, after.some((d: any) => d.udid === device && d.state === "Booted")]);
  if (fake) {
    const log = readFileSync(join(out, "argent.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    checks.push(["the fake argent never saw a server stop, stop-all or boot", !log.some((e) => e.forbidden)]);
  }
  console.log("");
  for (const [what, ok] of checks) console.log(`  ${ok ? "PASS " : "CHECK"} ${what}`);
  console.log(`\nOpen ${snap.dir} in Uncut to look at it (Agent tab, History, Export).`);
  if (fake) writeFileSync(join(out, "checks.json"), JSON.stringify(checks));
} finally {
  client.close();
  await server.stop();
}
