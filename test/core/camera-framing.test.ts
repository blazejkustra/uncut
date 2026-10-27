// C6: a take tagged in the composer names every clip that plays it, and the camera-framing check
// lists clips of one camera take on a track whose framing differs (the user's "fixed zoom on one of three").
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyEdit, createSession, projectChecks, validateProject, loadModules, type Item, type Project } from "../../packages/core/src/index.ts";
import { contextBlock } from "../../packages/core/src/text/mentions.ts";

const modules = await loadModules("spec/modules/builtin", "spec/examples/plugins");
const box = { x: 0, y: 0, w: 800, h: 1080, fit: "cover" as const };

function takeProject(main: Array<Partial<Item>>, overlay: Array<Partial<Item>> = []): Project {
  return {
    format: "uncut/0",
    name: "Take",
    canvas: { width: 1920, height: 1080, fps: 30 },
    media: [
      {
        id: "m-cam",
        kind: "video",
        name: "Take 1 camera",
        path: "/tmp/camera.mp4",
        source: { module: "capture.camera", take: "Take 1" },
        probe: { frames: 9000, fps: 30, width: 1920, height: 1080, hasAudio: false },
      },
      {
        id: "m-screen",
        kind: "video",
        name: "Take 1 screen",
        path: "/tmp/screen.mp4",
        source: { module: "capture.screen", take: "Take 1" },
        probe: { frames: 9000, fps: 30, width: 1920, height: 1080, hasAudio: false },
      },
    ],
    tracks: [
      {
        id: "overlay",
        kind: "video",
        name: "Overlay",
        items: overlay.map((c, i) => ({ id: `s${i + 1}`, type: "clip", media: "m-screen", in: i * 300, start: i * 300, duration: 300, ...c }) as Item),
      },
      {
        id: "main",
        kind: "video",
        role: "main",
        name: "Main",
        items: main.map((c, i) => ({ id: `cam-${"abcdefgh"[i]}`, type: "clip", media: "m-cam", in: i * 1000, duration: 300, transform: box, ...c }) as Item),
      },
    ],
  };
}
const framing = (p: Project) => projectChecks(p).filter((c) => c.id === "camera-framing");

test("camera-framing: the odd zoomed clips of one take are listed; the fix frames them like the rest", () => {
  const p = takeProject([{}, { transform: { ...box, scale: 1.08 } }, {}, { transform: { ...box, scale: 1.08 } }, {}]);
  const [c, more] = framing(p);
  assert.ok(c);
  assert.equal(more, undefined);
  assert.equal(c.severity, "warn");
  assert.deepEqual(c.itemIds, ["cam-b", "cam-d"]);
  assert.equal(
    c.message,
    "2 of 5 clips of Take 1 camera are framed differently from the rest: cam-b at 10.0 s (zoomed in 8%), cam-d at 30.0 s (zoomed in 8%).",
  );
  assert.equal(c.frame, 300);
  const fixed = applyEdit(createSession(p), { actor: "agent", ops: c.fix!.ops }).project;
  assert.deepEqual(validateProject(fixed, modules), []);
  assert.deepEqual(framing(fixed), []);
});

test("camera-framing: the same picture in a different box, a moved picture, a keyed clip, screens and other tracks", () => {
  // A full-width box and the 800 px one show a 16:9 picture the same size at x 0 when cover crops it the same way.
  const wide = { x: -560, y: 0, w: 1920, h: 1080, fit: "cover" as const };
  assert.deepEqual(framing(takeProject([{}, { transform: wide }, {}])), []);
  const moved = framing(takeProject([{}, { transform: { ...box, x: -120 } }, {}]));
  assert.match(moved[0]!.message, /cam-b at 10\.0 s \(moved 120 px\)/);
  // A clip that ends (keys) framed like the rest matches; one that ends zoomed is listed, with no fix for it.
  assert.deepEqual(
    framing(
      takeProject([
        {},
        {
          keys: [
            { frame: 0, scale: 1.2 },
            { frame: 30, scale: 1 },
          ],
        },
        {},
      ]),
    ),
    [],
  );
  const keyed = framing(
    takeProject([
      {},
      {
        keys: [
          { frame: 0, scale: 1 },
          { frame: 30, scale: 1.2 },
        ],
      },
      {},
    ]),
  )[0]!;
  assert.deepEqual(keyed.itemIds, ["cam-b"]);
  assert.equal(keyed.fix, undefined);
  // Screen recordings zoom in on details on purpose: not checked.
  assert.deepEqual(framing(takeProject([{}], [{ transform: { scale: 1.5 } }, {}])), []);
  // A camera picture-in-picture on another track isn't compared with Main.
  const pip = takeProject([{}, {}]);
  const withPip = {
    ...pip,
    tracks: [
      {
        ...pip.tracks[0]!,
        items: [
          { id: "pip", type: "clip", media: "m-cam", in: 0, start: 0, duration: 300, transform: { x: 1500, y: 40, w: 360, h: 360, fit: "cover" } } as Item,
        ],
      },
      pip.tracks[1]!,
    ],
  };
  assert.deepEqual(framing(withPip), []);
});

test("a tagged clip whose chip reads as its take names every clip of the take; a tagged take lists its clips", () => {
  const p = takeProject([{}, { transform: { ...box, scale: 1.08 } }, {}]);
  const block = contextBlock(p, [
    { kind: "item", id: "cam-b", label: "Take 1 camera" },
    { kind: "media", id: "m-cam", label: "Take 1 camera" },
  ]);
  assert.match(
    block,
    /@Take 1 camera = item cam-b \(clip on track main "Main", media m-cam\); its chip names the media "Take 1 camera", which also plays in cam-a \(track main, 0\.00 s\), cam-c \(track main, 20\.00 s\): a change asked for it goes to all of them unless the user means only this clip/,
  );
  assert.match(
    block,
    /@Take 1 camera = media m-cam \(video, 300\.00 s, 1920x1080, used 3x on the timeline\); it plays in cam-a \(track main, 0\.00 s\), cam-b \(track main, 10\.00 s\), cam-c \(track main, 20\.00 s\): a change asked for it goes to every one of them/,
  );
  // A clip with its own name is that clip; the others are still named.
  const named = { ...p, tracks: p.tracks.map((t) => ({ ...t, items: t.items.map((i) => (i.id === "cam-b" ? { ...i, name: "Close-up" } : i)) })) };
  assert.match(
    contextBlock(named, [{ kind: "item", id: "cam-b", label: "Close-up" }]),
    /= item cam-b \(.*\); the same media also plays in cam-a \(track main, 0\.00 s\), cam-c \(track main, 20\.00 s\)$/m,
  );
});
