// #77 (D264): Add to chat everywhere resolves like the composer's @ picker. Effects and
// transitions are picker candidates with stable ids ("<item>/<module>", the item a transition leads
// into) and get their own <context> lines; the same item under two labels keeps both lines.
import { test } from "node:test";
import assert from "node:assert/strict";
import { contextBlock, effectMentionId, mentionCandidates } from "../../packages/core/src/text/mentions.ts";
import type { Project } from "../../packages/core/src/timeline/types.ts";

const project = {
  format: "uncut/0",
  name: "P",
  canvas: { width: 1920, height: 1080, fps: 30 },
  media: [
    { id: "m-a", kind: "video", name: "Harbour", path: "/x/a.mp4", probe: { width: 1920, height: 1080, frames: 300 } },
    { id: "m-b", kind: "video", name: "Bridge", path: "/x/b.mp4", probe: { width: 1920, height: 1080, frames: 300 } },
  ],
  tracks: [
    {
      id: "main",
      kind: "video",
      role: "main",
      name: "Main",
      items: [
        { id: "clip-1", type: "clip", media: "m-a", in: 0, duration: 90, effects: [{ module: "effect.blur", params: { radius: 8 } }] },
        { id: "clip-2", type: "clip", media: "m-b", in: 0, duration: 90, transitionIn: { module: "transition.crossfade", duration: 12 } },
      ],
    },
  ],
} as unknown as Project;

test("the picker offers effects and transitions by name, with stable ids", () => {
  const c = mentionCandidates(project);
  const fx = c.find((x) => x.kind === "effect");
  const tr = c.find((x) => x.kind === "transition");
  assert.ok(fx && tr);
  assert.equal(fx.id, effectMentionId("clip-1", "effect.blur"));
  assert.equal(fx.id, "clip-1/effect.blur");
  assert.match(fx.label, / on Harbour$/);
  assert.equal(tr.id, "clip-2");
  assert.match(tr.label, / into Bridge$/);
});

test("contextBlock: effect and transition lines carry the real ids; gone ones say so", () => {
  const c = mentionCandidates(project);
  const fx = c.find((x) => x.kind === "effect")!;
  const tr = c.find((x) => x.kind === "transition")!;
  const block = contextBlock(project, [
    fx,
    tr,
    { kind: "effect", id: "clip-2/effect.blur", label: "Gone" },
    { kind: "transition", id: "clip-1", label: "None" },
  ]);
  assert.match(block, new RegExp(`@${fx.label} = effect effect\\.blur .*on item clip-1 \\(clip "Harbour" on track main\\)`));
  assert.match(
    block,
    new RegExp(`@${tr.label} = transition transition\\.crossfade .*\\(12 frames\\) into item clip-2 from item clip-1 on track main, at frame 90`),
  );
  assert.match(block, /@Gone = effect effect\.blur on item clip-2 \(no longer there\)/);
  assert.match(block, /@None = the transition into item clip-1 \(no longer there\)/);
});

test("contextBlock: one item under two labels keeps both lines", () => {
  const block = contextBlock(project, [
    { kind: "item", id: "clip-1", label: "Harbour" },
    { kind: "item", id: "clip-1", label: "the opener" },
    { kind: "item", id: "clip-1", label: "Harbour" },
  ]);
  assert.equal(block.split("\n").filter((l) => l.includes("= item clip-1")).length, 2);
});
