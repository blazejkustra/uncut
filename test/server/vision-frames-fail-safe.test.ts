// D328: render_frames, contact sheets and the critic's frame sessions never draw a face-blurred
// clip whose faces couldn't be found: the frames showing it are refused with the export's sentence,
// frames without it still draw, and background removal keeps drawing the clip with a note.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import type { Item, Project } from "../../packages/core/src/index.ts";
import { readyVision, visionResolver } from "../../apps/server/src/analysis/vision/clipVision.ts";
import type { VisionAnalysis } from "../../apps/server/src/analysis/vision/vision.ts";
import { openFrameSession, renderFramesWith, unblurredOnFrames } from "../../apps/server/src/export/exporter/frames.ts";
import { CUTOUT_PERSON, FACE_BLUR_ON, fakeVision, oneClipProject, visionFolder } from "../helpers/fakeVision.ts";

const hasFfmpeg = !spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).error;
const DESKTOP = resolve("apps/desktop/dist/main.cjs");
const T = { skip: hasFfmpeg ? false : "needs ffmpeg", timeout: 60000 };
const DRAWN = { skip: !hasFfmpeg ? "needs ffmpeg" : existsSync(DESKTOP) ? false : "desktop not built (run pnpm build)", timeout: 120000 };

const WIDTH = 160;
const NO_MODULE = /Face detection needs a vision module/;

/** "Interview" (frames 0 to 59) with `effects`, then "Outro" (60 to 119) with none, of one 4 s video. */
function twoClips(path: string, effects: Item["effects"]): Project {
  const base = oneClipProject(path);
  const items = [
    { id: "c", type: "clip", media: "m", name: "Interview", in: 0, duration: 60, effects },
    { id: "d", type: "clip", media: "m", name: "Outro", in: 60, duration: 60 },
  ] as Array<Item>;
  return {
    ...base,
    media: [{ ...base.media[0]!, probe: { frames: 120, fps: 30, width: 320, height: 180, hasAudio: false } }],
    tracks: [{ ...base.tracks[0]!, items }],
  };
}

const writeVideo = (path: string) =>
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "testsrc=s=320x180:r=30:d=4",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-threads",
    "2",
    path,
  ]);

async function lookupFor(f: ReturnType<typeof visionFolder>, p: Project, vision: VisionAnalysis | undefined) {
  const ready = await readyVision(vision, p, f.dir);
  return { lookup: visionResolver(ready), release: ready.release };
}

async function refusalOn(f: ReturnType<typeof visionFolder>, p: Project, vision: VisionAnalysis | undefined, frames: ReadonlyArray<number>) {
  const { lookup, release } = await lookupFor(f, p, vision);
  try {
    return unblurredOnFrames(p, frames, lookup);
  } finally {
    release();
  }
}

test("D328 frames: face blur with no vision module refuses the frames showing the clip, naming it and why", T, async () => {
  const f = visionFolder();
  try {
    const got = await refusalOn(f, twoClips(f.media, [FACE_BLUR_ON]), fakeVision({ noModule: true }).vision, [10, 70]);
    assert.equal(got.length, 1);
    assert.match(got[0]!, /^"Interview" \(Face detection needs a vision module/);
  } finally {
    f.cleanup();
  }
});

test("D328 frames: face blur where the app has no vision at all is refused too", T, async () => {
  const f = visionFolder();
  try {
    assert.deepEqual(await refusalOn(f, twoClips(f.media, [FACE_BLUR_ON]), undefined, [10]), ['"Interview" (Vision isn\'t available here)']);
  } finally {
    f.cleanup();
  }
});

test("D328 frames: face blur whose module fails is refused with the module's reason", T, async () => {
  const f = visionFolder();
  try {
    const vision = fakeVision({ refuse: { faces: "The helper crashed." } }).vision;
    assert.deepEqual(await refusalOn(f, twoClips(f.media, [FACE_BLUR_ON]), vision, [0, 59]), ['"Interview" (The helper crashed)']);
  } finally {
    f.cleanup();
  }
});

test("D328 frames: face blur on offline media is refused, saying the file isn't there", T, async () => {
  const f = visionFolder();
  try {
    const got = await refusalOn(f, twoClips(join(f.root, "offline.mp4"), [FACE_BLUR_ON]), fakeVision().vision, [30]);
    assert.equal(got.length, 1);
    assert.match(got[0]!, /^"Interview" \(.*file isn't there/);
  } finally {
    f.cleanup();
  }
});

test("D328 frames: frames that don't show the clip, a found face and background removal aren't refused", T, async () => {
  const f = visionFolder();
  try {
    const blurred = twoClips(f.media, [FACE_BLUR_ON]);
    assert.deepEqual(await refusalOn(f, blurred, fakeVision({ noModule: true }).vision, [60, 90, 119]), []);
    const face = () => ({ x: 0.4, y: 0.3, w: 0.2, h: 0.3 });
    assert.deepEqual(await refusalOn(f, blurred, fakeVision({ face }).vision, [0, 30, 59]), []);
    assert.deepEqual(await refusalOn(f, twoClips(f.media, [CUTOUT_PERSON]), fakeVision({ noModule: true }).vision, [10]), []);
    assert.deepEqual(await refusalOn(f, twoClips(f.media, [{ ...FACE_BLUR_ON, bypass: true }]), undefined, [10]), []);
  } finally {
    f.cleanup();
  }
});

test("D328 frames: render_frames and the critic's session refuse the clip's frames, draw the rest, and still draw a failed cutout", DRAWN, async () => {
  const f = visionFolder();
  writeVideo(f.media);
  const signal = new AbortController().signal;
  const media = (m: Project["media"][number]) => m.path;
  try {
    const p = twoClips(f.media, [FACE_BLUR_ON]);
    const { lookup, release } = await lookupFor(f, p, fakeVision({ noModule: true }).vision);
    try {
      await assert.rejects(renderFramesWith("ffmpeg", p, media, new Map(), [70, 10], WIDTH, signal, undefined, { vision: lookup }), (error: Error) => {
        assert.match(error.message, /^These frames weren't drawn so faces aren't shown unblurred: "Interview" \(Face detection needs a vision module/);
        assert.match(error.message, /has face blur, but its faces couldn't be found\. Frames without it can still be drawn\.$/);
        return true;
      });
      const outro = await renderFramesWith("ffmpeg", p, media, new Map(), [70], WIDTH, signal, undefined, { vision: lookup });
      assert.deepEqual(
        outro.map((r) => r.frame),
        [70],
      );
      const critic = await openFrameSession("ffmpeg", p, media, new Map(), signal, undefined, { downscale: true, vision: lookup });
      try {
        await assert.rejects(critic.render([0, 30, 90], WIDTH, { census: true }), /These frames weren't drawn so faces aren't shown unblurred: "Interview"/);
        await assert.rejects(critic.render([58, 59, 60], WIDTH, { until: () => false }), NO_MODULE);
        assert.equal((await critic.render([90, 100], WIDTH)).length, 2, "the session goes on for frames without the clip");
      } finally {
        await critic.close();
      }
    } finally {
      release();
    }

    const cut = twoClips(f.media, [CUTOUT_PERSON]);
    const ready = await lookupFor(f, cut, fakeVision({ noModule: true }).vision);
    try {
      const [frame] = await renderFramesWith("ffmpeg", cut, media, new Map(), [10], WIDTH, signal, undefined, { vision: ready.lookup });
      assert.ok(frame && frame.jpeg.length > 0);
      assert.ok(
        frame.notes?.some((n) => /"Interview" is drawn without its background removed: Background removal needs a vision module/.test(n)),
        frame.notes?.join("\n"),
      );
    } finally {
      ready.release();
    }
  } finally {
    f.cleanup();
  }
});
