// A long graphic before the encode says how far it is (the 684 s export that showed only
// "Getting ready" for minutes):
// - rasterise hears every frame of a graphic as done of total, the first and the last included;
// - the job's step goes out at least every couple of seconds while frames are drawn (a fake clock,
//   100 ms a frame), not once per frame;
// - the dialog's line says which frame it's on, and its bar follows; other steps say what they do.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Project } from "../../packages/core/src/index.ts";
import { planExport } from "../../apps/server/src/export/exportPlan.ts";
import { rasterise } from "../../apps/server/src/export/exporter/rasterise.ts";
import { stepReporter, STEP_MS } from "../../apps/server/src/export/exporter/runJob.ts";
import type { Rasterizer } from "../../apps/server/src/export/rasterizer.ts";
import { preparingStatus } from "../../apps/web/src/panels/exportDialog/format.ts";

const FRAMES = 1680;
const project = {
  format: "uncut/0",
  name: "Heavy",
  canvas: { width: 64, height: 80, fps: 60 },
  media: [],
  tracks: [{ id: "main", kind: "video", role: "main", name: "Main", items: [{ id: "g", type: "graphic", src: "graphics/heavy.html", duration: FRAMES }] }],
} as unknown as Project;
const DOC = `<script>window.render = (t) => { document.body.style.opacity = String(t % 1); };</script>`;

test("a long graphic reports its frames while drawn, at least every couple of seconds", { timeout: 30000 }, async () => {
  const plan = planExport(project, { mediaPath: () => "", width: 64, height: 80, graphic: () => DOC });
  if ("problem" in plan) throw new Error(plan.problem);
  let clock = 0;
  const stub = {
    render: async (job: { out?: string }) => {
      clock += 100; // a frame of a heavy graphic: 1680 of them is minutes
      if (job.out) writeFileSync(job.out, "");
    },
    close: async () => {},
    pid: undefined,
  } as unknown as Rasterizer;
  const heard: Array<[number, number]> = [];
  const sent: Array<{ at: number; done?: number; total?: number; kind: string }> = [];
  const step = stepReporter((s) => sent.push({ at: clock, ...s }), () => clock);
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "uncut-step-")));
  try {
    // Without an ffmpeg to stream into, every frame of the graphic is drawn as a PNG (no ffmpeg needed here).
    await rasterise(stub, plan, project, () => "", dir, new AbortController().signal, undefined, undefined, (done, total) => {
      heard.push([done, total]);
      step("graphics", done, total);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(heard.length, FRAMES, "every frame heard");
  assert.deepEqual(heard[0], [1, FRAMES]);
  assert.deepEqual(heard.at(-1), [FRAMES, FRAMES]);
  assert.ok(sent.every((s) => s.kind === "graphics" && s.total === FRAMES));
  assert.equal(sent[0]!.done, 1, "the first frame said at once");
  assert.equal(sent.at(-1)!.done, FRAMES, "the last frame said");
  for (let i = 1; i < sent.length; i++) assert.ok(sent[i]!.at - sent[i - 1]!.at <= 2000, `a gap of ${sent[i]!.at - sent[i - 1]!.at} ms`);
  assert.ok(sent.length <= FRAMES / 4, `throttled: ${sent.length} updates for ${FRAMES} frames`);
});

test("the reporter: steps without a count at once, counted ones at most every STEP_MS", () => {
  let clock = 0;
  const sent: Array<unknown> = [];
  const step = stepReporter((s) => sent.push(s), () => clock);
  step("sound");
  step("graphics", 1, 10);
  clock += 100;
  step("graphics", 2, 10);
  clock += STEP_MS;
  step("graphics", 3, 10);
  step("graphics", 10, 10);
  step("loudness");
  assert.deepEqual(sent, [{ kind: "sound" }, { kind: "graphics", done: 1, total: 10 }, { kind: "graphics", done: 3, total: 10 }, { kind: "graphics", done: 10, total: 10 }, { kind: "loudness" }]);
});

test("the dialog says which frame it's drawing, and its bar follows", () => {
  assert.deepEqual(preparingStatus({}), { text: "Getting ready…", fraction: undefined });
  assert.deepEqual(preparingStatus({ step: { kind: "graphics", done: 312, total: 1680 } }), { text: "Drawing the graphics: frame 312 of 1680", fraction: 312 / 1680 });
  assert.deepEqual(preparingStatus({ step: { kind: "shaders", done: 5, total: 10 } }), { text: "Drawing the shader effects: frame 5 of 10", fraction: 0.5 });
  assert.deepEqual(preparingStatus({ step: { kind: "graphics", done: 3, total: 9 } }, false).text, "Drawing the text: frame 3 of 9", "no graphics: the text");
  assert.deepEqual(preparingStatus({ step: { kind: "graphics" } }), { text: "Drawing the graphics…", fraction: undefined });
  assert.deepEqual(preparingStatus({ step: { kind: "sound" } }), { text: "Measuring the sound…", fraction: undefined });
  assert.deepEqual(preparingStatus({ step: { kind: "loudness" } }), { text: "Measuring the loudness…", fraction: undefined });
});
