// Phase 8 chunk 2 (D103) on the bundled server: the catalog lists plugins/catalog (taste.extra, off);
// enabling one copies it in and it needs allowing; only an allowed plugin's looks, components and
// rules reach plugins.contributions; a process plugin's own `check` is called with the open project,
// its findings for its own rules kept (others dropped), and one that doesn't answer within 5 s is a
// note, not a failure; a plugin component is copied into graphics/ and the preview's document
// (GET /media/graphic) drawn by the rasteriser matches the export's frame (SSIM ≥ 0.99), also after
// the plugin is disabled (the copy is the project's). Never the network.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { graphicInfo, type Project } from "../../packages/core/src/index.ts";
import { rasterizerCommand, startRasterizer } from "../../apps/server/src/export/rasterizer.ts";
import { BUNDLE, MEDIA, connect, killAll, startServer } from "../helpers/server.ts";

const FAKE = resolve("test/helpers/fake-plugin");
const skip = existsSync(BUNDLE) && existsSync(MEDIA) ? false : "server bundle or media binary not built";

let root = "";
before(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-contrib-")));
});
after(() => {
  killAll();
  if (root) rmSync(root, { recursive: true, force: true });
});

const ssim = (a: string, b: string) => {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-i", a, "-i", b, "-lavfi", "[0]scale=480:270,format=gray[a];[1]scale=480:270,format=gray[b];[a][b]ssim", "-f", "null", "-"], { encoding: "utf8" });
  return Number(/All:([\d.]+)/.exec(r.stderr)![1]);
};

test("catalog, enable and allow, contributions only when allowed, process checks with a timeout, a plugin component preview == export", { skip, timeout: 240000 }, async () => {
  const data = join(root, "data");
  const dev = join(root, "dev-plugins");
  // A process plugin with its own check rule (the fake plugin's *_check).
  cpSync(FAKE, join(dev, "proc"), { recursive: true });
  const fake = JSON.parse(readFileSync(join(FAKE, "uncut.module.json"), "utf8"));
  writeFileSync(join(dev, "proc", "uncut.module.json"), JSON.stringify({ ...fake, id: "proc.checks", name: "Proc checks", agentTools: [], runtime: { ...fake.runtime, args: ["server.ts", "--contributions-test"] }, contributes: { rules: [{ id: "proc.checks.house", title: "House rule", rule: { type: "process" } }] } }));
  const server = await startServer({ env: { UNCUT_DATA_DIR: data, UNCUT_PLUGINS_DIR: dev, UNCUT_BUNDLED_PLUGINS_DIR: resolve("plugins") } });
  const client = await connect(server.ready.port, server.ready.token);
  const jobs = client.subscribe("export.jobs");
  try {
    const none = await client.ok("plugins.contributions", {});
    assert.deepEqual(none, { looks: [], components: [], rules: [] }, "nothing before it's allowed (proc.checks isn't either)");

    // The catalog: shipped, off.
    const catalog = await client.ok("plugins.catalog", {});
    const entry = catalog.plugins.find((p: any) => p.id === "taste.extra");
    assert.ok(entry, "the example is in the catalog");
    assert.equal(entry.enabled, false);
    assert.equal(entry.runs, false);
    assert.deepEqual(entry.contributes, { looks: ["Soft card"], components: ["Corner sticker"], rules: ["Ends on an end card", "No hype words"] });
    assert.deepEqual(catalog.problems, []);
    assert.ok(!(await client.ok("plugins.list", {})).some((p: any) => p.id === "taste.extra"), "not loaded until enabled");

    // The same id from a folder isn't "enabled from the catalog", and Disable doesn't remove it.
    await client.ok("plugins.install", { source: resolve("plugins/catalog/taste-extra") });
    assert.equal((await client.ok("plugins.catalog", {})).plugins.find((p: any) => p.id === "taste.extra").enabled, false);
    const notMine = await client.fail("plugins.disable", { id: "taste.extra" });
    assert.equal(notMine.reason, "not-removable");
    assert.ok((await client.ok("plugins.list", {})).some((p: any) => p.id === "taste.extra"), "still installed");

    // Enable: copied in, needs allowing; still nothing contributed.
    const enabled = await client.ok("plugins.enable", { id: "taste.extra" });
    const row = enabled.plugins.find((p: any) => p.id === "taste.extra");
    assert.equal(row.status, "needs-approval");
    assert.deepEqual(row.origin.kind, "catalog");
    assert.equal(row.removable, true);
    assert.match(row.asks[0], /doesn't run a program/);
    assert.deepEqual(row.contributes.components, ["Corner sticker"]);
    assert.deepEqual(await client.ok("plugins.contributions", {}), none);
    assert.equal((await client.ok("plugins.catalog", {})).plugins.find((p: any) => p.id === "taste.extra").enabled, true);

    // A project; adding a component from an unallowed plugin is refused.
    const { dir } = await client.ok("project.create", { parentDir: root, name: "Plugin bits" });
    assert.equal((await client.fail("plugins.addComponent", { id: "taste.extra.sticker" })).reason, "unknown-plugin");
    assert.deepEqual(await client.ok("plugins.check", {}), { checks: [], notes: [] }, "proc.checks isn't allowed");

    // Allowed: its look, component and rules.
    await client.ok("plugins.approve", { id: row.id, dir: row.dir, capabilities: row.capabilities });
    const c = await client.ok("plugins.contributions", {});
    assert.deepEqual(c.looks.map((l: any) => [l.id, l.pluginName]), [["taste.extra.soft-card", "Taste extra"]]);
    assert.deepEqual(c.components.map((x: any) => x.id), ["taste.extra.sticker"]);
    assert.equal(c.components[0].template, undefined, "the renderer never gets the template");
    assert.deepEqual(c.rules.map((r: any) => r.id), ["taste.extra.end-card", "taste.extra.banned-phrases"]);

    // The process plugin's check, once allowed: its own finding only.
    const proc = (await client.ok("plugins.list", {})).find((p: any) => p.id === "proc.checks");
    await client.ok("plugins.approve", { id: proc.id, dir: proc.dir, capabilities: proc.capabilities });
    const checked = await client.ok("plugins.check", {});
    assert.deepEqual(checked.notes, []);
    assert.equal(checked.checks.length, 1);
    assert.equal(checked.checks[0].id, "proc.checks.house");
    assert.match(checked.checks[0].message, /tracks, checked by the house rule/);
    assert.equal(checked.checks[0].hint, "Keep it.");
    assert.ok((await client.ok("plugins.contributions", {})).rules.some((r: any) => r.id === "proc.checks.house"));

    // A plugin component: copied into graphics/ (once), a graphic item with its props.
    const added = await client.ok("plugins.addComponent", { id: "taste.extra.sticker" });
    assert.equal(added.src, "graphics/taste.extra.sticker.html");
    assert.deepEqual(added.props, { label: "New", color: "#FFD84D" });
    assert.equal((await client.ok("plugins.addComponent", { id: "taste.extra.sticker" })).src, added.src, "the same copy is reused");
    const file = join(dir, added.src);
    assert.match(readFileSync(file, "utf8"), /Uncut component taste\.extra\.sticker/);
    const props = { label: "Ship it", color: "#7CE38B" };
    await client.ok("project.edit", {
      ops: [
        { op: "insert_item", track: "main", item: { id: "bg", type: "component", component: "component.solid", duration: 60, props: { color: "#203040" } } },
        { op: "add_track", index: 0, track: { id: "ov", kind: "video", name: "Overlay" } },
        { op: "insert_item", track: "ov", item: { id: "sticker", type: "graphic", src: added.src, name: added.name, start: 0, duration: 60, props } },
      ],
      summary: "Sticker",
    });

    // Disabled now: the project keeps its copy and still draws it.
    await client.ok("plugins.disable", { id: "taste.extra" });
    assert.ok(!(await client.ok("plugins.list", {})).some((p: any) => p.id === "taste.extra"));
    assert.deepEqual((await client.ok("plugins.contributions", {})).looks, []);
    const hello = await client.ok("server.hello", {});
    const base = `http://127.0.0.1:${server.ready.port}`;
    const doc = await fetch(`${base}/media/graphic/${encodeURIComponent("taste.extra.sticker.html")}?token=${encodeURIComponent(hello.graphicToken)}`);
    assert.equal(doc.status, 200, "the preview's document is still served");
    const html = await doc.text();

    // Preview == export: the preview's document drawn at frame 30 vs the export's frame 30.
    const output = join(root, "Plugin bits.mp4");
    const { jobId } = await client.ok("export.start", { output, quality: "standard", loudness: "off" });
    await jobs.until((list) => list.some((j: any) => j.id === jobId && ["done", "failed", "cancelled"].includes(j.phase)), 180000);
    const job = jobs.values.at(-1)!.find((j: any) => j.id === jobId);
    assert.equal(job.phase, "done", job.error);
    const project = JSON.parse(readFileSync(join(dir, "project.json"), "utf8")) as Project;
    const item = project.tracks.flatMap((t) => t.items).find((i) => i.id === "sticker")!;
    const r = rasterizerCommand();
    assert.ok(!("problem" in r));
    const raster = await startRasterizer(r);
    const { width, height } = project.canvas;
    const sticker = join(root, "sticker.png");
    const bg = join(root, "bg.png");
    try {
      await raster.render({ kind: "graphic", width, height, doc: html, t: 1, info: graphicInfo(item, project.canvas, 30), out: sticker });
    } finally {
      await raster.close();
    }
    // The preview draws the sandboxed document over the background: the same composite here.
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `color=c=0x203040:s=${width}x${height}`, "-i", sticker, "-filter_complex", "[0][1]overlay", "-frames:v", "1", bg]);
    const exported = join(root, "export-30.png");
    execFileSync("ffmpeg", ["-v", "error", "-y", "-i", output, "-vf", "select=eq(n\\,30)", "-frames:v", "1", "-update", "1", exported]);
    mkdirSync("test-output", { recursive: true });
    cpSync(exported, "test-output/plugin-component-export.png");
    const score = ssim(bg, exported);
    console.log(`  plugin component: preview document vs export SSIM ${score.toFixed(4)}`);
    assert.ok(score >= 0.99, `SSIM ${score}`);

    // A process check that never answers: a note after 5 s, no findings, nothing thrown.
    await client.ok("project.create", { parentDir: root, name: "Slow one" });
    const started = Date.now();
    const slow = await client.ok("plugins.check", {});
    const took = Date.now() - started;
    assert.deepEqual(slow.checks, []);
    assert.equal(slow.notes.length, 1);
    assert.match(slow.notes[0], /Proc checks's own checks are left out this time/);
    assert.ok(took >= 4500 && took < 15000, `took ${took} ms`);
  } finally {
    client.close();
    await server.stop();
  }
});
