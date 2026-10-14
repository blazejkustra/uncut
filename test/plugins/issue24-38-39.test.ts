// Issues #24, #38, #39 on the bundled server, against the fake `argent` (never the real one) and the
// scripted claude.
// #24 (D204): argent_boot lists bootable devices, asks on a card before anything boots (Don't boots
//   nothing, Look only is refused), boots on Boot through capture.boot, then argent_record opens the
//   app and records; the same device boots again in that chat without a second card.
// #39 (D205): the user's media index lists another project's capture and import (media.recent),
//   media_search finds it, media_import copies a file that lives inside another project and
//   references one that doesn't; media.recentImport does the same for the Media panel.
// #38 (D206): timeline_edit dryRun (diff, nothing saved), a refusal with a fix, place_item, and the
//   turn-end clean-up (an unused graphic to the trash, an empty track removed) with Restore.
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
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-issue24-38-39-")));
});
after(() => {
  killAll();
  rmSync(root, { recursive: true, force: true });
});

const logOf = (file: string) => readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { argv: Array<string>; forbidden?: boolean; boot?: boolean; completed?: string });

test("#39 media index across projects, #24 argent_boot with a card, #38 dry run, fixes, place_item and the turn-end clean-up", { skip, timeout: 240000 }, async () => {
  const base = join(root, "server");
  mkdirSync(join(base, "projects"), { recursive: true });
  mkdirSync(join(base, "footage"), { recursive: true });
  const files = { plan: join(base, "plan.json"), prompts: join(base, "prompts.jsonl"), results: join(base, "results.jsonl"), log: join(base, "argent.jsonl") };
  for (const f of [files.prompts, files.results, files.log]) writeFileSync(f, "");
  const dataDir = join(base, "data");
  const server = await startServer({
    env: {
      UNCUT_DATA_DIR: dataDir,
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
  const boots = () => logOf(files.log).filter((e) => e.boot).length;
  try {
    const agent = client.subscribe("agent.subscribe");
    const project = client.subscribe("project.subscribe");

    // ---- #39: a capture and an import in "test argent" ----
    const a = await client.ok("project.create", { parentDir: join(base, "projects"), name: "test argent" });
    await client.ok("capture.start", { device: "SIM-IPHONE-16" });
    await sleep(1100);
    const take = await client.ok("capture.stop", { device: "SIM-IPHONE-16" });
    await project.until((p) => p?.project.media.some((m: any) => m.id === take.mediaId));
    const outside = join(base, "footage", "drone.mp4");
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=320x180:rate=30", "-t", "1", "-pix_fmt", "yuv420p", "-c:v", "libx264", "-preset", "ultrafast", outside]);
    await client.ok("media.import", { paths: [outside] });
    await project.until((p) => p?.dir === a.dir && p.project.media.length === 2, 30000);
    const capturePath = join(a.dir, project.values.at(-1).project.media.find((m: any) => m.id === take.mediaId).path);
    assert.ok(existsSync(capturePath), capturePath);

    // ---- another project: the index lists both, newest first, and searches ----
    const b = await client.ok("project.create", { parentDir: join(base, "projects"), name: "argent-cloud-2" });
    await agent.until((s) => s?.dir === b.dir);
    const recent = (await client.ok("media.recent", {})).entries;
    assert.equal(recent.length, 2, JSON.stringify(recent));
    const cap = recent.find((e: any) => e.origin === "capture");
    const imp = recent.find((e: any) => e.origin === "import");
    assert.equal(cap.path, capturePath);
    assert.equal(cap.project.name, "test argent");
    assert.equal(cap.device, "SIM-IPHONE-16");
    assert.equal(cap.kind, "video");
    assert.equal(cap.copies, true, "it lives inside the other project: importing copies it");
    assert.equal(imp.path, outside);
    assert.equal(imp.copies, undefined);
    assert.ok(existsSync(join(dataDir, "media-index.json")), "kept in the user data dir");
    assert.deepEqual((await client.ok("media.recent", { query: "zzz nothing" })).entries, []);
    assert.deepEqual((await client.ok("media.recent", { kind: "capture" })).entries.map((e: any) => e.id), [cap.id]);
    assert.deepEqual((await client.ok("media.recent", { query: "test argent recording" })).entries.map((e: any) => e.id), [cap.id]);

    const turns: Array<unknown> = [];
    const send = async (prompt: string, steps: Array<unknown>, access?: string) => {
      turns.push(steps);
      writeFileSync(files.plan, JSON.stringify(turns));
      for (let i = 0; ; i++) {
        const r: any = await client.call("agent.send", { prompt, ...(access ? { access } : {}) });
        if (r._tag === "Success") return r.value.turnId as string;
        if (i > 50 || !JSON.stringify(r.cause).includes("busy")) throw new Error(`agent.send failed: ${JSON.stringify(r.cause)}`);
        await sleep(100);
      }
    };
    const finished = async (turnId: string) => {
      await agent.until((s) => s?.turns.some((t: any) => t.id === turnId && t.status !== "running"), 90000);
      return agent.values.at(-1).turns.find((t: any) => t.id === turnId);
    };
    const results = (tool: string) => readFileSync(files.results, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.tool === tool);
    const last = (tool: string) => results(tool).at(-1)!.result;
    const lastJson = (tool: string) => JSON.parse(last(tool).content[0].text);

    // media_search finds the capture; media_import copies it into this project's media/imports.
    const t1 = await send("Put the Argent demo in", [
      { tool: "media_search", args: { query: "argent" } },
      { tool: "media_import", args: { path: capturePath } },
      { text: "Imported." },
    ]);
    const turn1 = await finished(t1);
    assert.equal(turn1.status, "done", JSON.stringify(turn1));
    const found = JSON.parse(results("media_search")[0].result.content[0].text);
    assert.ok(found.found.some((f: any) => f.path === capturePath && f.origin === "capture" && f.project === "test argent"), JSON.stringify(found));
    assert.ok(JSON.stringify(turn1.items).includes('Searched other projects for \\"argent\\"'), "the step label");
    const imported = lastJson("media_import");
    assert.equal(imported.copied.length, 1, JSON.stringify(imported));
    assert.match(imported.copied[0], /^media\/imports\//);
    await project.until((p) => p?.dir === b.dir && p.project.media.length === 1);
    const copiedPath = project.values.at(-1).project.media[0].path;
    assert.match(copiedPath, /^media\/imports\//, "stored inside this project");
    assert.ok(existsSync(join(b.dir, copiedPath)));
    assert.ok(existsSync(capturePath), "the other project's file is untouched");
    // The Media panel's Add: an outside file is referenced where it is.
    const added = await client.ok("media.recentImport", { id: imp.id });
    assert.equal(added.copied, false);
    await project.until((p) => p?.project.media.some((m: any) => m.path === outside), 30000);
    // Media this project has are no longer offered.
    assert.deepEqual((await client.ok("media.recent", {})).entries.map((e: any) => e.id), [cap.id]);

    // ---- #24: argent_boot ----
    assert.equal(boots(), 0);
    const t2 = await send("What can you boot?", [{ tool: "argent_boot", args: {} }, { text: "Listed." }]);
    await finished(t2);
    const listed = lastJson("argent_boot");
    assert.deepEqual(listed.bootable.map((d: any) => d.name).sort(), ["Pixel Tablet API 35", "iPad Air"].sort());
    assert.ok(listed.running.some((d: any) => d.name === "iPhone 16" && d.kind === "iOS simulator"));
    assert.equal(boots(), 0, "listing boots nothing");

    const t3 = await send("Boot the iPad", [{ tool: "argent_boot", args: { device: "iPad Air" } }, { text: "Can't." }], "look");
    const turn3 = await finished(t3);
    assert.match(last("argent_boot").content[0].text, /Look only/);
    assert.equal(turn3.status, "done");
    assert.equal(boots(), 0, "Look only boots nothing");

    const t4 = await send("Boot the iPad and record the app", [{ tool: "argent_boot", args: { device: "iPad Air", bundleId: "com.example.app" } }, { text: "OK." }]);
    await agent.until((s) => !!s?.approval?.boot && s.approval.turnId === t4, 20000);
    const card = agent.values.at(-1).approval;
    assert.deepEqual(card.boot, { device: "SIM-IPAD-OFF", name: "iPad Air", platform: "ios", kind: "iOS simulator", bundleId: "com.example.app" });
    assert.equal(card.text, "Boot iPad Air");
    await sleep(300);
    assert.equal(boots(), 0, "nothing boots while the card waits");
    assert.deepEqual(await client.ok("agent.approve", { id: card.id, allow: false }), { accepted: true });
    await finished(t4);
    assert.equal(lastJson("argent_boot").approved, false);
    assert.equal(boots(), 0, "Don't boots nothing");

    const t5 = await send("Boot the iPad and record the app", [
      { tool: "argent_boot", args: { device: "iPad Air", bundleId: "com.example.app" } },
      { tool: "argent_record", args: { device: "SIM-IPAD-OFF", bundleId: "com.example.app", seconds: 1 } },
      { text: "Recorded." },
    ]);
    await agent.until((s) => !!s?.approval?.boot && s.approval.turnId === t5, 20000);
    assert.equal(boots(), 0);
    await client.ok("agent.approve", { id: agent.values.at(-1).approval.id, allow: true });
    const turn5 = await finished(t5);
    assert.equal(turn5.status, "done", JSON.stringify(turn5));
    const bootOut = JSON.parse(results("argent_boot").at(-1)!.result.content[0].text);
    assert.equal(bootOut.booted, true);
    assert.equal(bootOut.device, "SIM-IPAD-OFF");
    assert.equal(boots(), 1, "one boot, after Boot");
    const launched = logOf(files.log).filter((e) => e.argv[0] === "run" && e.argv[1] === "launch-app" && !e.completed);
    assert.deepEqual(JSON.parse(launched.at(-1)!.argv[3]!), { udid: "SIM-IPAD-OFF", bundleId: "com.example.app" });
    assert.ok(turn5.edits.some((e: any) => /^Recorded /.test(e.summary)), JSON.stringify(turn5.edits));

    // Shut down again: the same device boots in this chat without another card.
    rmSync(join(base, "fake-argent-state", "booted.json"), { force: true });
    const t6 = await send("Boot it again", [{ tool: "argent_boot", args: { device: "SIM-IPAD-OFF" } }, { text: "Booted." }]);
    const turn6 = await finished(t6);
    assert.equal(turn6.status, "done");
    assert.equal(lastJson("argent_boot").booted, true);
    assert.equal(boots(), 2, "booted again without a card");
    assert.deepEqual(logOf(files.log).filter((e) => e.forbidden), []);

    // ---- #38: dry run, a refusal with a fix, place_item, clean-up ----
    const before = project.values.at(-1).revision;
    const t7 = await send("Titles and graphics", [
      { tool: "project_read", args: {} },
      { tool: "timeline_edit", args: { baseRevision: "$rev", summary: "Two titles", dryRun: true, ops: [{ op: "add_track", track: { id: "t2", kind: "text", name: "Titles" }, index: 0 }, { op: "insert_item", track: "t2", item: { id: "title-a", type: "text", text: "A", start: 0, duration: 60 } }] } },
      { tool: "project_read", args: {} },
      { tool: "timeline_edit", args: { baseRevision: "$rev", summary: "Overlapping titles", ops: [{ op: "add_track", track: { id: "t3", kind: "text", name: "More" }, index: 0 }, { op: "insert_item", track: "t3", item: { id: "x-1", type: "text", text: "X", start: 0, duration: 60 } }, { op: "insert_item", track: "t3", item: { id: "x-2", type: "text", text: "Y", start: 30, duration: 60 } }] } },
      { tool: "graphic_write", args: { name: "keep.html", html: "<div id=a>A</div><script>window.render=()=>{}</script>" } },
      { tool: "graphic_write", args: { name: "spare.html", html: "<div id=b>B</div><script>window.render=()=>{}</script>" } },
      { tool: "project_read", args: {} },
      {
        tool: "timeline_edit",
        args: {
          baseRevision: "$rev",
          summary: "A graphic and titles",
          ops: [
            { op: "add_track", track: { id: "gfx", kind: "video", name: "Graphics" }, index: 0 },
            { op: "add_track", track: { id: "spare-track", kind: "video", name: "Spare" }, index: 0 },
            { op: "insert_item", track: "gfx", item: { id: "g-1", type: "graphic", src: "graphics/keep.html", start: 0, duration: 30 } },
            { op: "add_track", track: { id: "words", kind: "text", name: "Words" }, index: 0 },
            { op: "insert_item", track: "words", item: { id: "w-1", type: "text", text: "One", start: 0, duration: 60 } },
            { op: "place_item", track: "words", item: { id: "w-2", type: "text", text: "Two", duration: 60 }, start: 30, place: "free-track" },
          ],
        },
      },
      { text: "Done." },
    ]);
    const turn7 = await finished(t7);
    assert.equal(turn7.status, "done", JSON.stringify(turn7));
    const edits = results("timeline_edit").slice(-3).map((r) => ({ isError: !!r.result.isError, out: JSON.parse(r.result.content[0].text) }));
    // The dry run: planned, nothing saved.
    assert.equal(edits[0]!.isError, false);
    assert.equal(edits[0]!.out.dryRun, true);
    assert.deepEqual(edits[0]!.out.diff.added, [{ id: "title-a", type: "text", track: "t2", start: 0, end: 60 }]);
    assert.deepEqual(edits[0]!.out.diff.tracksAdded, ["t2"]);
    assert.ok(!project.values.at(-1).project.tracks.some((t: any) => t.id === "t2"), "the dry run changed nothing");
    assert.ok(JSON.stringify(turn7.items).includes("Planned two titles"), "its step label");
    // The overlap refused with the fix: a start and a new track.
    assert.equal(edits[1]!.isError, true);
    assert.match(edits[1]!.out.fix, /Use start 60 on "t3" \(right after "x-1"\), or track "text" \(free at 30–90\)/);
    assert.ok(edits[1]!.out.details.some((d: any) => d.code === "overlap" && d.fix));
    // place_item: the overlap went on another text track free there, and the result says where.
    assert.equal(edits[2]!.isError, false, JSON.stringify(edits[2]));
    assert.deepEqual(edits[2]!.out.placed, [{ item: "w-2", track: "text", start: 30, how: 'on track "text", free there' }]);
    // The clean-up: spare.html to the trash, the empty track gone (an edit of the turn), keep.html stays.
    assert.deepEqual(turn7.cleanup, { graphics: ["spare.html"], tracks: ["spare-track"] });
    assert.ok(existsSync(join(b.dir, "graphics", "keep.html")));
    assert.ok(!existsSync(join(b.dir, "graphics", "spare.html")));
    assert.ok(existsSync(join(b.dir, ".cache", "trash", t7, "graphics", "spare.html")));
    await project.until((p) => p?.project.tracks.every((t: any) => t.id !== "spare-track"));
    assert.ok(turn7.edits.some((e: any) => e.summary === "Removed an empty track"), JSON.stringify(turn7.edits));
    assert.ok(project.values.at(-1).revision > before);
    // Restore puts it back.
    assert.deepEqual(await client.ok("agent.restoreCleanup", { turnId: t7 }), { restored: ["spare.html"] });
    assert.ok(existsSync(join(b.dir, "graphics", "spare.html")));
    await agent.until((s) => s?.turns.find((t: any) => t.id === t7)?.cleanup?.restored === true);

    // A later turn leaves the restored one alone; Undo turn brings back what its own clean-up moved.
    const t8 = await send("Another graphic", [
      { tool: "graphic_write", args: { name: "draft.html", html: "<p>d</p><script>window.render=()=>{}</script>" } },
      { tool: "project_read", args: {} },
      { tool: "timeline_edit", args: { baseRevision: "$rev", summary: "A word", ops: [{ op: "place_item", track: "words", item: { id: "w-3", type: "text", text: "Three", duration: 30 }, start: 0, place: "after" }] } },
      { text: "Done." },
    ]);
    const turn8 = await finished(t8);
    assert.deepEqual(turn8.cleanup, { graphics: ["draft.html"], tracks: [] });
    assert.deepEqual(JSON.parse(last("timeline_edit").content[0].text).placed, [{ item: "w-3", track: "words", start: 60, how: 'moved to frame 60, right after "w-1"' }]);
    assert.ok(existsSync(join(b.dir, "graphics", "spare.html")), "restored stays");
    await client.ok("agent.undoTurn", { turnId: t8 });
    assert.ok(existsSync(join(b.dir, "graphics", "draft.html")), "Undo turn restores the trashed graphic");
  } finally {
    await client.close?.();
  }
});
