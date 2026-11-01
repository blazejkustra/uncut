// The review page: the HTML holds no way out and no markup from project text, and the round trip
// runs in real Chromium from a file:// URL: comments added on the page, kept over a reload, exported
// as a block, and imported as notes. Hostile text stays text in both directions.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";

import { REVIEW_VIDEO, reviewFolderFor, reviewManifest, reviewPageHtml } from "../../apps/server/src/export/exporter/reviewPage.ts";
import { writeProject } from "../helpers/export-fixture.ts";
import { BUNDLE, MEDIA, connect, killAll, startServer } from "../helpers/server.ts";
import { applyEdit, createSession, inertJson, parseReviewNotes, planReviewImport, reviewNotesBlock, type Project } from "../../packages/core/src/index.ts";

const HOSTILE = `</script><script>window.pwned=1</script><img src=x onerror="window.pwned=1"> "quoted" & <!--`;
const project = {
  format: "uncut/1",
  name: HOSTILE,
  canvas: { width: 640, height: 360, fps: 30 },
  media: [],
  tracks: [{ id: "main", role: "main", kind: "visual", items: [{ id: "a", type: "solid", duration: 90, color: "#000" }] }],
} as unknown as Project;
const manifest = () => reviewManifest(project, 0, { width: 640, height: 360 });

test("the folder is named after the chosen file", () => {
  assert.equal(reviewFolderFor("/x/Launch.mp4"), "/x/Launch review");
});

test("project text can't become markup in the page", () => {
  const html = reviewPageHtml(manifest());
  assert.equal(html.match(/<\/script>/g)!.length, 2);
  assert.doesNotMatch(html, /<img/);
  assert.doesNotMatch(html, /onerror="/);
  assert.doesNotMatch(inertJson({ a: "</script><!--" }), /[<>]/);
  assert.equal(JSON.parse(inertJson({ a: "</script>\u2028" })).a, "</script>\u2028");
});

test("the page loads nothing from anywhere else", () => {
  const html = reviewPageHtml(reviewManifest({ ...project, name: "Launch" }, 0, { width: 640, height: 360 }));
  assert.doesNotMatch(html, /https?:|\/\/[a-z]|fetch\(|XMLHttpRequest|WebSocket|sendBeacon|@import|\burl\(/);
  assert.match(html, /default-src 'none'/);
  assert.match(html, /form-action 'none'/);
  assert.match(html, /media-src 'self';/);
  assert.doesNotMatch(html, /innerHTML|insertAdjacentHTML|document\.write|eval\(/);
  assert.match(html, /no live sync/i);
});

const electronBin = (() => {
  try {
    return createRequire(import.meta.url)("electron") as unknown as string;
  } catch {
    return undefined;
  }
})();
const hasFfmpeg = !spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).error;
const skip = !electronBin ? "needs Electron" : !hasFfmpeg ? "needs ffmpeg" : false;

const PAGE_SCRIPT = `(async () => {
  const video = document.getElementById("video");
  if (video.readyState < 1) await new Promise((r, x) => { video.onloadedmetadata = r; video.onerror = () => x(new Error("video failed")); });
  const seeked = new Promise((r) => video.addEventListener("seeked", r, { once: true }));
  video.currentTime = 2;
  await seeked;
  document.getElementById("author").value = ${JSON.stringify(HOSTILE)};
  document.getElementById("mark").click();
  const draw = document.getElementById("draw");
  const bounds = draw.getBoundingClientRect();
  draw.setPointerCapture = () => {};
  const at = (type, fx, fy) => draw.dispatchEvent(new PointerEvent(type, { clientX: bounds.left + bounds.width * fx, clientY: bounds.top + bounds.height * fy, bubbles: true, pointerId: 1 }));
  at("pointerdown", 0.25, 0.25);
  at("pointermove", 0.5, 0.75);
  at("pointerup", 0.5, 0.75);
  document.getElementById("text").value = ${JSON.stringify(HOSTILE)};
  document.getElementById("add").requestSubmit();
  document.getElementById("copy").click();
  const items = document.querySelectorAll("#comments li").length;
  const shown = document.querySelector("#comments li p").textContent;
  return {
    items,
    shown,
    pins: document.querySelectorAll("#pins button").length,
    title: document.getElementById("title").textContent,
    pwned: window.pwned === 1,
    injected: document.querySelectorAll("img").length,
    block: document.getElementById("block").value,
    stored: Object.keys(localStorage).filter((k) => k.startsWith("uncut.review.")).length,
    width: video.videoWidth,
    timecode: document.querySelector("#comments .time").textContent,
  };
})()`;

test("the round trip: comments on the page come back as notes, with hostile text inert", { skip }, () => {
  const dir = mkdtempSync(join(tmpdir(), "uncut-review-page-"));
  try {
    execFileSync("ffmpeg", [
      "-v",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=640x360:rate=30:duration=3",
      "-pix_fmt",
      "yuv420p",
      join(dir, REVIEW_VIDEO),
    ]);
    writeFileSync(join(dir, "index.html"), reviewPageHtml(manifest()));
    const script = join(dir, "script.js");
    writeFileSync(script, PAGE_SCRIPT);
    const out = spawnSync(electronBin!, [resolve("test/helpers/review-page-driver.cjs"), join(dir, "index.html"), script], {
      encoding: "utf8",
      timeout: 120_000,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
    });
    const line = out.stdout.split("\n").find((l) => l.startsWith("RESULT "));
    assert.ok(line, `no result: ${out.stdout} ${out.stderr}`);
    const { requests, problems, result, afterReload } = JSON.parse(line.slice("RESULT ".length));

    assert.deepEqual(
      requests.filter((u: string) => !u.startsWith("file://")),
      [],
      "no request leaves the disk",
    );
    assert.deepEqual(problems, [], "no CSP or script error");
    assert.equal(result.width, 640, "the video plays under the page's CSP");
    assert.equal(result.items, 1);
    assert.equal(result.pins, 1);
    assert.equal(result.shown, HOSTILE);
    assert.equal(result.title, HOSTILE);
    assert.equal(result.pwned, false);
    assert.equal(result.injected, 0);
    assert.equal(result.stored >= 1, true);
    assert.equal(afterReload, 1, "the browser keeps the comment over a reload");
    assert.equal(result.timecode, "00:02:00");

    const exchange = parseReviewNotes(result.block);
    assert.ok(!("problem" in exchange), JSON.stringify(exchange));
    const plan = planReviewImport(project, exchange);
    assert.ok(!("problem" in plan));
    assert.deepEqual(plan.warnings, []);
    const back = applyEdit(createSession(project), { actor: "user", ops: plan.ops }).project;
    const note = back.reviewNotes![0]!;
    assert.equal(note.frame, 60);
    assert.equal(note.text, HOSTILE);
    assert.deepEqual(note.region, { x: 0.25, y: 0.25, w: 0.25, h: 0.5 });
    assert.equal(reviewNotesBlock(back).match(/<\/script>/g), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const skipServer =
  !existsSync(BUNDLE) || !existsSync(MEDIA) || !existsSync(resolve("apps/desktop/dist/main.cjs"))
    ? "not built (run pnpm build)"
    : hasFfmpeg
      ? false
      : "needs ffmpeg";

test(
  "server: a review export of a range makes the folder, in H.264, refuses to replace it unasked, and imported notes save",
  { skip: skipServer, timeout: 180000 },
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-review-export-")));
    const server = await startServer({ env: { UNCUT_DATA_DIR: join(root, "data") } });
    const client = await connect(server.ready.port, server.ready.token);
    const jobs = client.subscribe("export.jobs");
    const finished = (id: string) =>
      jobs
        .until((list) => list.some((j: any) => j.id === id && ["done", "failed", "cancelled"].includes(j.phase)), 120000)
        .then(() => jobs.values.at(-1).find((j: any) => j.id === id));
    try {
      execFileSync("ffmpeg", [
        "-v",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=320x180:rate=30:duration=3",
        "-pix_fmt",
        "yuv420p",
        join(root, "take.mp4"),
      ]);
      const dir = writeProject(root, "Review", {
        ...project,
        format: "uncut/0",
        name: HOSTILE,
        media: [
          { id: "m", kind: "video", name: "take.mp4", path: join(root, "take.mp4"), probe: { frames: 90, fps: 30, width: 320, height: 180, hasAudio: false } },
        ],
        tracks: [{ id: "main", kind: "video", role: "main", name: "Main", items: [{ id: "c", type: "clip", media: "m", in: 0, duration: 90 }] }],
      } as unknown as Project);
      await client.ok("project.open", { dir });
      mkdirSync(join(root, "out"));
      const input = {
        output: join(root, "out", "Cut.mp4"),
        quality: "draft",
        loudness: "off",
        review: true,
        range: { from: 30, to: 60 },
        video: { codec: "hevc" },
      };
      const { jobId } = await client.ok("export.start", input);
      const done = await finished(jobId);
      assert.equal(done.phase, "done", done.error);
      const folder = join(root, "out", "Cut review");
      assert.equal(done.reviewFolder, folder);
      assert.equal(done.output, join(folder, REVIEW_VIDEO));
      const codec = execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_name", "-of", "csv=p=0", done.output], { encoding: "utf8" });
      assert.match(codec, /h264/);
      const html = readFileSync(join(folder, "index.html"), "utf8");
      const data = JSON.parse(/id="review-data">(.*?)<\/script>/.exec(html)![1]!);
      assert.equal(data.from, 30);
      assert.equal(data.project, HOSTILE);
      assert.doesNotMatch(html, /<img/);
      assert.equal(existsSync(join(root, "out", "Cut.mp4")), false);

      const refused = await client.call("export.start", input);
      assert.equal(refused._tag, "Failure");
      assert.equal(refused.cause[0]?.error?.reason, "exists");

      const opened = await client.ok("project.get", {});
      const parsed = parseReviewNotes(JSON.stringify({ ...data, comments: [{ id: "c1", seconds: 0.5, text: HOSTILE }] }));
      assert.ok(!("problem" in parsed));
      const plan = planReviewImport(opened.project as Project, parsed);
      assert.ok(!("problem" in plan));
      assert.deepEqual(plan.warnings, []);
      await client.ok("project.edit", { ops: plan.ops, summary: plan.summary, baseRevision: opened.revision });
      const saved = JSON.parse(readFileSync(join(dir, "project.json"), "utf8")) as Project;
      assert.equal(saved.reviewNotes![0]!.frame, 45);
      assert.equal(saved.reviewNotes![0]!.text, HOSTILE);
    } finally {
      client.close();
      await server.stop();
      killAll();
      rmSync(root, { recursive: true, force: true });
    }
  },
);
