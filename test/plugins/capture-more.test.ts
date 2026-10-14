// D143 and D144 on the bundled server, against the fake `argent` (never the real one) and the
// scripted claude. D143: the Capture tab's RPCs list bootable devices and the project's flows,
// capture.boot boots only when called (the fake counts boots), capture.start passes the options
// (rotate, open an app, max length, trim) and capture.record replays a flow into the Library as one
// user edit. D144: the agent's screen_record waits for the user's card; the test plays the renderer
// (agent.approve with the picked source, a take in media/uploads, agent.screenTake): the take is an
// edit of the turn (Undo turn removes it); Don't and a renderer problem record nothing.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { BUNDLE, connect, killAll, startServer } from "../helpers/server.ts";

const FAKE_ARGENT = resolve("test/helpers/fake-argent/argent");
const FAKE_CLAUDE = resolve("test/helpers/fake-claude.ts");
const skip = !existsSync(BUNDLE) ? "the server bundle isn't built (pnpm --filter @uncut/server build)" : false;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let root = "";
before(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-capture-more-")));
});
after(() => {
  killAll();
  rmSync(root, { recursive: true, force: true });
});

const logOf = (file: string) => readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { argv: Array<string>; forbidden?: boolean; boot?: boolean; completed?: string });

test("D143 + D144 on the server: boot on request, options, a flow take; the agent's screen_record asks first and is an edit of its turn", { skip, timeout: 180000 }, async () => {
  const base = join(root, "server");
  mkdirSync(join(base, "projects"), { recursive: true });
  const files = { plan: join(base, "plan.json"), prompts: join(base, "prompts.jsonl"), results: join(base, "results.jsonl"), log: join(base, "argent.jsonl") };
  for (const f of [files.prompts, files.results, files.log]) writeFileSync(f, "");
  const server = await startServer({
    env: {
      UNCUT_DATA_DIR: join(base, "data"),
      UNCUT_PLUGINS_DIR: "",
      UNCUT_BUNDLED_PLUGINS_DIR: resolve("plugins"),
      UNCUT_CLAUDE: FAKE_CLAUDE,
      ANTHROPIC_API_KEY: "",
      ARGENT_BIN: FAKE_ARGENT,
      FAKE_ARGENT_NODE: process.execPath,
      FAKE_ARGENT_LOG: files.log,
      FAKE_PLAN: files.plan,
      FAKE_PROMPT_LOG: files.prompts,
      FAKE_RESULT_LOG: files.results,
      UNCUT_APPROVAL_MS: "20000",
    },
  });
  const client = await connect(server.ready.port, server.ready.token);
  try {
    const agent = client.subscribe("agent.subscribe");
    const project = client.subscribe("project.subscribe");
    const snap = await client.ok("project.create", { parentDir: join(base, "projects"), name: "More" });
    await agent.until((s) => s?.dir === snap.dir);
    mkdirSync(join(snap.dir, "flows"), { recursive: true });
    writeFileSync(join(snap.dir, "flows", "onboarding.yaml"), "# fake-seconds: 1.5\nsteps: []\n");

    // ---- D143 ----
    const state = await client.ok("capture.devices");
    assert.deepEqual(state.flows, ["onboarding"]);
    const ipad = state.devices.find((d: any) => d.id === "SIM-IPAD-OFF");
    assert.equal(ipad.bootable, true);
    assert.equal(ipad.recordable, false);
    assert.equal(state.devices.find((d: any) => d.id === "avd:Pixel_Tablet_API_35").bootable, true);
    assert.equal(logOf(files.log).filter((e) => e.boot).length, 0, "listing boots nothing");

    const booted = await client.ok("capture.boot", { device: "SIM-IPAD-OFF" });
    assert.deepEqual(booted, { device: "SIM-IPAD-OFF", name: "iPad Air" });
    await client.ok("capture.start", { device: "SIM-IPAD-OFF", orientation: "LandscapeRight", bundleId: "com.example.app", maxSeconds: 60, trimStatic: true, showTouches: true });
    await sleep(1100);
    const stopped = await client.ok("capture.stop", { device: "SIM-IPAD-OFF" });
    await project.until((p) => p?.project.media.some((m: any) => m.id === stopped.mediaId));
    const run = (tool: string) => logOf(files.log).filter((e) => e.argv[0] === "run" && e.argv[1] === tool && !e.completed);
    assert.deepEqual(JSON.parse(run("screen-recording-start")[0]!.argv[3]!), { udid: "SIM-IPAD-OFF", timeLimitSeconds: 60, trimStatic: true, showTouches: true });
    assert.deepEqual(JSON.parse(run("rotate")[0]!.argv[3]!), { udid: "SIM-IPAD-OFF", orientation: "LandscapeRight" });
    assert.deepEqual(JSON.parse(run("launch-app")[0]!.argv[3]!), { udid: "SIM-IPAD-OFF", bundleId: "com.example.app" });

    // A flow take: listed as recording (with the flow) while it plays, then one user edit.
    const flowTake = client.ok("capture.record", { device: "SIM-IPHONE-16", flow: "onboarding" });
    await sleep(600);
    const during = await client.ok("capture.devices");
    assert.deepEqual(during.recording.map((r: any) => [r.device, r.flow]), [["SIM-IPHONE-16", "onboarding"]]);
    const flowed = await flowTake;
    await project.until((p) => p?.project.media.some((m: any) => m.id === flowed.mediaId));
    const flowMedia = project.values.at(-1).project.media.find((m: any) => m.id === flowed.mediaId);
    assert.deepEqual(flowMedia.source, { module: "argent.capture", device: "SIM-IPHONE-16", flow: "flows/onboarding.yaml" });
    assert.ok(flowed.seconds > 1, JSON.stringify(flowed));
    assert.equal((await client.ok("capture.devices")).recording.length, 0);
    const mediaBefore = project.values.at(-1).project.media.length;
    const undone = await client.ok("project.undo");
    assert.equal(undone.project.media.length, mediaBefore - 1, "one ⌘Z takes the flow take out");
    assert.match((await client.fail("capture.record", { device: "SIM-APPLE-TV", flow: "onboarding" })).message, /can't be recorded/);

    const log = logOf(files.log);
    assert.deepEqual(log.filter((e) => e.forbidden), []);
    assert.equal(log.filter((e) => e.boot).length, 1, "exactly one boot: the one asked for");

    // ---- D144: screen_record ----
    const turns: Array<unknown> = [];
    const send = async (prompt: string, steps: Array<unknown>) => {
      turns.push(steps);
      writeFileSync(files.plan, JSON.stringify(turns));
      // Right after a Stop the session may still be winding down: try again for a moment.
      for (let i = 0; ; i++) {
        const r: any = await client.call("agent.send", { prompt });
        if (r._tag === "Success") return r.value.turnId as string;
        if (i > 50 || !JSON.stringify(r.cause).includes("busy")) throw new Error(`agent.send failed: ${JSON.stringify(r.cause)}`);
        await sleep(100);
      }
    };
    const finished = async (turnId: string) => {
      await agent.until((s) => s?.turns.some((t: any) => t.id === turnId && t.status !== "running"), 90000);
      return agent.values.at(-1).turns.find((t: any) => t.id === turnId);
    };
    const results = () => readFileSync(files.results, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const lastResult = () => results().filter((r) => r.tool === "screen_record").at(-1)!.result;
    const resultText = () => lastResult().content.map((c: any) => c.text).join("\n");

    // Allowed: the card names the suggestion; the renderer's take comes back and is imported.
    const t1 = await send("Record the docs page for 2 seconds", [
      { tool: "screen_record", args: { source: "Docs", seconds: 2 } },
      { text: "Recorded the docs." },
    ]);
    await agent.until((s) => !!s?.approval?.screen, 20000);
    const card = agent.values.at(-1).approval;
    assert.equal(card.turnId, t1);
    assert.deepEqual(card.screen, { source: "Docs", seconds: 2, withMic: false });
    assert.match(card.text, /^Record "Docs" for 2 s$/);
    assert.equal(card.estimate, 0);
    assert.deepEqual(await client.ok("agent.approve", { id: card.id, allow: true, source: "Docs - Example" }), { accepted: true });
    await agent.until((s) => !s?.approval, 10000);
    // The server now waits for that take (the renderer cancels its take once this goes away).
    assert.equal(agent.values.at(-1).screenTake, card.id);
    // The same card answered again (or a stale one) isn't accepted: the renderer starts nothing.
    assert.deepEqual(await client.ok("agent.approve", { id: card.id, allow: true }), { accepted: false });
    // The renderer's part: a take uploaded to media/uploads under a take name.
    const uploads = join(snap.dir, "media", "uploads");
    mkdirSync(uploads, { recursive: true });
    const upload = join(uploads, "uncut-take-screen-0123456789ab.mp4");
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=320x180:rate=30", "-t", "2", "-pix_fmt", "yuv420p", "-c:v", "libx264", "-preset", "ultrafast", upload]);
    await client.ok("agent.screenTake", { id: card.id, path: upload, source: "Docs - Example" });
    const turn1 = await finished(t1);
    assert.equal(agent.values.at(-1).screenTake, undefined);
    assert.equal(turn1.status, "done", JSON.stringify(turn1));
    const out = JSON.parse(resultText());
    assert.equal(out.source, "Docs - Example");
    assert.ok(out.seconds > 1.5 && out.seconds < 2.5, JSON.stringify(out));
    assert.match(out.path, /^media\/captures\/Docs - Example \d{8}-\d{6}\.mp4$/);
    assert.ok(turn1.edits.some((e: any) => /^Recorded Docs - Example/.test(e.summary)), JSON.stringify(turn1.edits));
    assert.ok(JSON.stringify(turn1.items).includes("Asked to record Docs"), "the step label");
    await project.until((p) => p?.project.media.some((m: any) => m.id === out.id));
    const screenMedia = project.values.at(-1).project.media.find((m: any) => m.id === out.id);
    assert.deepEqual(screenMedia.source, { module: "capture.screen", device: "Docs - Example" });
    assert.ok(!existsSync(upload), "the upload was converted and removed");
    // Undo turn removes the take.
    const afterUndo = await client.ok("agent.undoTurn", { turnId: t1 });
    assert.ok(!afterUndo.project.media.some((m: any) => m.id === out.id));

    // Don't: nothing recorded, and the agent hears why.
    const t2 = await send("Record my screen", [{ tool: "screen_record", args: { seconds: 3, withMic: true } }, { text: "OK." }]);
    await agent.until((s) => !!s?.approval?.screen && s.approval.turnId === t2, 20000);
    const card2 = agent.values.at(-1).approval;
    assert.match(card2.text, /^Record your screen for 3 s with the microphone$/);
    await client.ok("agent.approve", { id: card2.id, allow: false });
    await finished(t2);
    const declined = JSON.parse(resultText());
    assert.equal(declined.approved, false);
    assert.match(declined.message, /didn't want the screen recorded/);
    assert.equal(lastResult().isError, true);

    // Allowed, but the renderer couldn't record (e.g. the user cancelled): a sentence, no media.
    const mediaCount = project.values.at(-1).project.media.length;
    const t3 = await send("Record the screen", [{ tool: "screen_record", args: { seconds: 1 } }, { text: "OK." }]);
    await agent.until((s) => !!s?.approval?.screen && s.approval.turnId === t3, 20000);
    const card3 = agent.values.at(-1).approval;
    await client.ok("agent.approve", { id: card3.id, allow: true, source: "Test screen" });
    await client.ok("agent.screenTake", { id: card3.id, problem: "The user cancelled the recording." });
    await finished(t3);
    assert.match(resultText(), /Nothing was recorded: The user cancelled the recording\./);
    assert.equal(project.values.at(-1).project.media.length, mediaCount);
    // A take for a card nobody waits for any more isn't imported, and its upload is deleted.
    const orphan = join(uploads, "uncut-take-screen-ba9876543210.mp4");
    writeFileSync(orphan, "x");
    await client.ok("agent.screenTake", { id: card3.id, path: orphan });
    for (let i = 0; i < 40 && existsSync(orphan); i++) await sleep(50);
    assert.ok(!existsSync(orphan), "the orphan upload is deleted");
    assert.equal(project.values.at(-1).project.media.length, mediaCount);
    // A file that isn't a take is never touched that way.
    const other = join(uploads, "holiday.mp4");
    writeFileSync(other, "x");
    await client.ok("agent.screenTake", { id: card3.id, path: other });
    await sleep(300);
    assert.ok(existsSync(other));

    // Stop during an allowed take: the wait ends at once (screenTake goes, the renderer cancels).
    const t5 = await send("Record the screen for a while", [{ tool: "screen_record", args: { seconds: 60 } }, { text: "OK." }]);
    await agent.until((s) => !!s?.approval?.screen && s.approval.turnId === t5, 20000);
    const card5 = agent.values.at(-1).approval;
    assert.deepEqual(await client.ok("agent.approve", { id: card5.id, allow: true, source: "Test screen" }), { accepted: true });
    await agent.until((s) => s?.screenTake === card5.id, 10000);
    await client.ok("agent.cancel");
    await agent.until((s) => s?.screenTake === undefined && s?.running === null, 10000);
    // A stopped turn's card can't be answered either.
    const t6 = await send("Record again", [{ tool: "screen_record", args: { seconds: 5 } }, { text: "OK." }]);
    await agent.until((s) => !!s?.approval?.screen && s.approval.turnId === t6, 20000);
    const card6 = agent.values.at(-1).approval;
    await client.ok("agent.cancel");
    await finished(t6);
    assert.deepEqual(await client.ok("agent.approve", { id: card6.id, allow: true }), { accepted: false });

    // seconds out of range: refused before any card.
    const t4 = await send("Record for an hour", [{ tool: "screen_record", args: { seconds: 3600 } }, { text: "OK." }]);
    await finished(t4);
    assert.match(resultText(), /seconds must be more than 0 and at most 300/);
  } finally {
    client.close();
    await server.stop();
  }
});
