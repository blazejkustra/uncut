// D349 through ffmpeg: a V1 transition project exports the same sound, sample for sample, whether
// each clip plays its own sound or its sound is a linked item on A1 (what placement now makes).
// The audio graph is the export's own (planExport + audioGraph), written to 32-bit float WAV.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyEdit, createSession, type Item, type Project } from "../../packages/core/src/index.ts";
import { planDetachAudio, takenIds } from "../../packages/core/src/timeline/arrange.ts";
import { audioGraph, planExport } from "../../apps/server/src/export/exportPlan.ts";

const hasFfmpeg = !spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).error;
const skip = hasFfmpeg ? false : "needs ffmpeg";
let dir = "";

before(() => {
  if (skip) return;
  dir = realpathSync(mkdtempSync(join(tmpdir(), "uncut-pairs-export-")));
  // 6 s of a small picture and a rising tone, so every moment of the sound differs.
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-y",
    "-threads",
    "2",
    "-f",
    "lavfi",
    "-i",
    "testsrc=s=160x90:r=30:d=6",
    "-f",
    "lavfi",
    "-i",
    "aevalsrc=0.3*sin(2*PI*(200+60*t)*t):s=48000:d=6",
    "-c:v",
    "mjpeg",
    "-c:a",
    "pcm_s16le",
    "-shortest",
    join(dir, "talk.mov"),
  ]);
});
after(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const owned = (module: string): Project => ({
  format: "uncut/0",
  name: "Pairs export",
  canvas: { width: 160, height: 90, fps: 30 },
  media: [
    { id: "talk", kind: "video", name: "talk.mov", path: join(dir, "talk.mov"), probe: { frames: 180, fps: 30, width: 160, height: 90, hasAudio: true } },
  ],
  tracks: [
    {
      id: "main",
      kind: "video",
      role: "main",
      name: "Main",
      items: [
        { id: "a", type: "clip", media: "talk", in: 0, duration: 60, gainDb: -3, fadeIn: 6 } as Item,
        { id: "b", type: "clip", media: "talk", in: 90, duration: 60, fadeOut: 9, transitionIn: { module, duration: 20 } } as Item,
      ],
    },
  ],
});

function paired(project: Project): Project {
  let next = project;
  for (const id of ["a", "b"]) {
    const plan = planDetachAudio(next, id, takenIds(next));
    if ("problem" in plan) throw new Error(plan.problem);
    next = applyEdit(createSession(next), { actor: "user", ops: plan.ops }).project;
  }
  return next;
}

function mix(project: Project, name: string): Buffer {
  const plan = planExport(project, { mediaPath: (m) => m.path, width: 160, height: 90 });
  if ("problem" in plan) throw new Error(plan.problem);
  const g = audioGraph(plan, 0);
  const graph = join(dir, `${name}.txt`);
  writeFileSync(graph, g.filters.join(";\n"));
  const out = join(dir, `${name}.wav`);
  const r = spawnSync("ffmpeg", ["-hide_banner", "-y", "-threads", "2", ...g.inputs, "-/filter_complex", graph, "-map", "[aout]", "-c:a", "pcm_f32le", out], {
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr.slice(-800));
  return execFileSync("ffmpeg", ["-v", "error", "-threads", "2", "-i", out, "-map", "0:a", "-f", "f32le", "-"], { maxBuffer: 1 << 26 });
}

test("D349: a crossfade and a dip on V1 export sample-identical with the clips' own sound and with linked sound on A1", { skip }, () => {
  for (const module of ["transition.crossfade", "transition.dip-to-black"]) {
    const name = module.replace("transition.", "");
    const before = owned(module);
    const after = paired(before);
    assert.equal(after.tracks.find((t) => t.kind === "audio")?.items.length, 2);
    const a = mix(before, `${name}-owned`);
    const b = mix(after, `${name}-pairs`);
    assert.ok(a.length > 48000 * 4 * 3, `${name}: some sound came out`);
    assert.equal(a.length, b.length, name);
    assert.ok(a.equals(b), `${name}: the samples differ`);
  }
});
