// FCPXML and EDL on the bundled server: the fixture saved as a file, imported into an empty project,
// and the two projects' clips compared. The FCPXML goes through the real probe and project edit.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { Project } from "../../packages/core/src/timeline/types.ts";
import { layout } from "../../packages/core/src/timeline/timeline.ts";
import { exportProject, makeExportFixture, writeProject } from "../helpers/export-fixture.ts";
import { BUNDLE, MEDIA, connect, killAll, startServer } from "../helpers/server.ts";

const DESKTOP = resolve("apps/desktop/dist/main.cjs");
const skip = !existsSync(BUNDLE) || !existsSync(MEDIA) || !existsSync(DESKTOP) ? "not built (run pnpm build)" : false;

type Client = Awaited<ReturnType<typeof connect>>;
let root = "";
let client: Client;

before(async () => {
  if (skip) return;
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-interchange-")));
  for (const d of ["out", "tmp"]) mkdirSync(join(root, d));
  makeExportFixture(join(root, "media"));
  const server = await startServer({ env: { UNCUT_DATA_DIR: join(root, "data"), TMPDIR: join(root, "tmp") } });
  client = await connect(server.ready.port, server.ready.token);
  await client.ok("project.open", { dir: writeProject(root, "Source", exportProject(join(root, "media"))) });
});

after(async () => {
  if (skip) return;
  await killAll();
  rmSync(root, { recursive: true, force: true });
});

/** Each clip or sound as where it plays, which file and which part of it. */
const clipsOf = (project: Project) => {
  const { starts } = layout(project);
  const pathOf = (id: string | undefined) => project.media.find((m) => m.id === id)?.path;
  return project.tracks
    .flatMap((t) => t.items)
    .filter((i) => (i.type === "clip" || i.type === "audio") && pathOf(i.media))
    .map((i) => `${pathOf(i.media)} at ${starts.get(i.id)} for ${i.duration} from ${i.in ?? 0}`)
    .sort();
};

test("FCPXML saved by the server rebuilds the same clips in an empty project", { skip, timeout: 120000 }, async () => {
  const output = join(root, "out", "Edit.fcpxml");
  const saved = await client.ok("export.timeline", { output });
  assert.equal(saved.path, output);
  assert.ok(
    saved.warnings.some((w: string) => /left out|gap/.test(w)),
    "what the file can't carry is said",
  );
  assert.equal((await client.fail("export.timeline", { output })).reason, "exists");
  assert.equal((await client.fail("export.timeline", { output: join(root, "out", "x.txt") })).reason, "invalid-path");

  const original = JSON.parse(readFileSync(join(root, "Source.uncut", "project.json"), "utf8")) as Project;
  const empty: Project = { ...original, media: [], tracks: original.tracks.filter((t) => t.role === "main").map((t) => ({ ...t, items: [] })) };
  const dir = writeProject(root, "Back", empty);
  await client.ok("project.open", { dir });
  const jobs = client.subscribe("media.jobs");
  const { jobId } = await client.ok("media.import", { paths: [output] });
  await jobs.until((list: ReadonlyArray<{ id: string; phase: string }>) => list.some((j) => j.id === jobId && ["done", "failed"].includes(j.phase)), 60000);
  const back = await client.ok("project.open", { dir });
  assert.deepEqual(clipsOf(back.project as Project), clipsOf(original));
  const main = (back.project as Project).tracks.find((t) => t.role === "main")!;
  assert.equal(main.items.find((i) => i.transitionIn)?.transitionIn?.duration, 20);
});

test("an EDL saved by the server lists the main track", { skip, timeout: 60000 }, async () => {
  const output = join(root, "out", "Edit.edl");
  await client.ok("project.open", { dir: join(root, "Source.uncut") });
  const saved = await client.ok("export.timeline", { output });
  const text = readFileSync(saved.path, "utf8");
  assert.match(text, /^TITLE: Export test\nFCM: NON-DROP FRAME\n/);
  assert.match(text, /\* SOURCE FILE: .*B\.mp4/);
  assert.ok(saved.warnings.some((w: string) => /isn't in the EDL/.test(w)));
});

/** One clip and one subtitle, both only inside a sequence on Main. */
const nestedProject = (): Project => {
  const source = exportProject(join(root, "media"));
  const main = source.tracks.find((t) => t.role === "main")!;
  const clip = { id: "inner", type: "clip" as const, media: "m-b", in: 15, duration: 90 };
  const subtitle = { id: "line", type: "text" as const, text: "Nested line", start: 10, duration: 30 };
  return {
    ...source,
    tracks: [{ ...main, items: [{ id: "n1", type: "sequence", sequence: "seq", duration: 90 }] }],
    sequences: [
      {
        id: "seq",
        name: "Nested",
        tracks: [
          { id: "seq-subs", kind: "text", name: "Subtitles", items: [subtitle] },
          { id: "seq-main", kind: "video", role: "main", name: "Main", items: [clip] },
        ],
      },
    ],
  };
};

test("FCPXML, EDL and subtitles keep what's inside a sequence", { skip, timeout: 60000 }, async () => {
  await client.ok("project.open", { dir: writeProject(root, "Nested", nestedProject()) });
  const fcpxml = await client.ok("export.timeline", { output: join(root, "out", "Nested.fcpxml") });
  assert.match(readFileSync(fcpxml.path, "utf8"), /<asset-clip[^>]*name="B\.mp4"/);
  const edl = await client.ok("export.timeline", { output: join(root, "out", "Nested.edl") });
  assert.match(readFileSync(edl.path, "utf8"), /\* SOURCE FILE: .*B\.mp4/);
  const subtitles = await client.ok("export.subtitles", { output: join(root, "out", "Nested.srt") });
  assert.match(readFileSync(subtitles.path, "utf8"), /Nested line/);
});

test("FCPXML into a project with items is refused and changes neither its media nor its canvas", { skip, timeout: 120000 }, async () => {
  const dir = join(root, "Source.uncut");
  const opened = (await client.ok("project.open", { dir })).project as Project;
  const saved = await client.ok("export.timeline", { output: join(root, "out", "Other.fcpxml") });
  cpSync(join(root, "media"), join(root, "copies"), { recursive: true });
  const text = readFileSync(saved.path, "utf8")
    .replaceAll(join(root, "media"), join(root, "copies"))
    .replace(/width="\d+" height="\d+"/, 'width="640" height="360"');
  const other = join(root, "out", "Other copy.fcpxml");
  writeFileSync(other, text);

  const jobs = client.subscribe("media.jobs");
  const { jobId } = await client.ok("media.import", { paths: [other] });
  await jobs.until((l: ReadonlyArray<{ id: string; phase: string }>) => l.some((j) => j.id === jobId && ["done", "failed"].includes(j.phase)), 60000);
  assert.match(JSON.stringify(jobs.values.at(-1)), /empty project/);

  const after = (await client.ok("project.open", { dir })).project as Project;
  assert.deepEqual(after.canvas, opened.canvas);
  assert.deepEqual(
    after.media.map((m) => m.path),
    opened.media.map((m) => m.path),
  );
});
