// Locked items and tracks: the agent can't change, move or unlock them by any op; the user can unlock
// by hand, and that is an edit like any other; what the agent is told.
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyEdit, createSession, EditError, locksNote, type Op, type Project, type Session } from "../../packages/core/src/index.ts";
import { projectSummary } from "../../apps/server/src/agent/tools/summary.ts";

const probe = { frames: 900, fps: 30, width: 1280, height: 720, hasAudio: true };
const base: Project = {
  format: "uncut/0",
  name: "Cut",
  canvas: { width: 1920, height: 1080, fps: 30 },
  media: [
    { id: "m-a", kind: "video", name: "a.mp4", path: "/x/a.mp4", probe },
    { id: "m-b", kind: "video", name: "b.mp4", path: "/x/b.mp4", probe },
    { id: "m-song", kind: "audio", name: "song.m4a", path: "/x/song.m4a", probe: { frames: 900, hasAudio: true } },
  ],
  tracks: [
    {
      id: "main",
      kind: "video",
      role: "main",
      name: "Main",
      items: [
        { id: "c1", type: "clip", media: "m-a", in: 60, duration: 120 },
        { id: "c2", type: "clip", media: "m-b", in: 60, duration: 120, locked: true },
        { id: "c3", type: "clip", media: "m-a", in: 300, duration: 120 },
      ],
    },
    { id: "music", kind: "audio", name: "Music", locked: true, items: [{ id: "song", type: "audio", media: "m-song", in: 0, start: 0, duration: 360 }] },
    { id: "fx", kind: "audio", name: "Fx", items: [] },
  ],
};

const asAgent = (ops: ReadonlyArray<Op>, session: Session = createSession(base)) => applyEdit(session, { actor: "agent", ops });
const asUser = (ops: ReadonlyArray<Op>, session: Session = createSession(base)) => applyEdit(session, { actor: "user", ops });

function refusedAsLocked(ops: ReadonlyArray<Op>, words = /locked|unlock/) {
  assert.throws(
    () => asAgent(ops),
    (e: unknown) => {
      const details = (e as EditError).details as ReadonlyArray<{ code?: string; message?: string }>;
      return e instanceof EditError && details[0]?.code === "locked" && words.test(details[0]?.message ?? "");
    },
    JSON.stringify(ops),
  );
}

test("every op aimed at a locked item or track is refused for the agent, with a code and what to do", () => {
  for (const op of [
    { op: "update_item", item: "c2", set: { name: "x" } },
    { op: "trim_item", item: "c2", edge: "end", frames: 10 },
    { op: "split_item", item: "c2", at: 10, newId: "c2-b" },
    { op: "move_item", item: "c2", index: 0 },
    { op: "delete_item", item: "c2" },
    { op: "set_transition", item: "c2", transition: { module: "transition.crossfade", duration: 10 } },
    { op: "insert_item", track: "music", item: { id: "s2", type: "audio", media: "m-song", start: 400, duration: 10 } },
    { op: "update_item", item: "song", set: { gainDb: -3 } },
    { op: "delete_track", track: "music" },
  ] satisfies ReadonlyArray<Op>)
    refusedAsLocked([op], /leave it as it is, or ask the user/);
});

test("the agent can't unlock an item or a track, on its own or in the middle of an edit", () => {
  refusedAsLocked([{ op: "update_item", item: "c2", set: { locked: null } }], /only the user/);
  refusedAsLocked([{ op: "update_track", track: "music", set: { locked: false } }], /only the user/);
  refusedAsLocked(
    [
      { op: "update_item", item: "c2", set: { locked: null } },
      { op: "trim_item", item: "c2", edge: "end", frames: 10 },
      { op: "update_item", item: "c2", set: { locked: true } },
    ],
    /leave it as it is/,
  );
});

test("the agent can't reach a locked thing from the side", () => {
  refusedAsLocked([{ op: "update_track", track: "music", set: { mixer: { gainDb: -20 } } }]);
  refusedAsLocked([{ op: "update_track", track: "music", set: { hidden: true } }]);
  refusedAsLocked([{ op: "update_media", media: "m-b", set: { path: "/x/other.mp4" } }], /relink/);
  refusedAsLocked([{ op: "set_transition", item: "c3", transition: { module: "transition.crossfade", duration: 10 } }], /transition after it/);
  refusedAsLocked([{ op: "trim_item", item: "c1", edge: "end", frames: 30 }], /move it from frame 120 to 90/);
  refusedAsLocked([{ op: "delete_item", item: "c1" }], /move it from frame 120 to 0/);
  refusedAsLocked([{ op: "insert_item", track: "main", index: 0, item: { id: "c0", type: "clip", media: "m-a", in: 0, duration: 30 } }], /move it/);
});

test("around a lock the agent works as usual, and a gap may hold the locked clip in place", () => {
  const trimmed = asAgent([
    { op: "trim_item", item: "c1", edge: "end", frames: 30 },
    { op: "update_item", item: "c2", set: { gap: 30 } },
  ]);
  assert.equal(trimmed.project.tracks[0]!.items[0]!.duration, 90);
  assert.equal(asAgent([{ op: "trim_item", item: "c3", edge: "end", frames: 30 }]).project.tracks[0]!.items[2]!.duration, 90);
  assert.equal(asAgent([{ op: "insert_item", track: "fx", item: { id: "s2", type: "audio", media: "m-song", start: 0, duration: 10 } }]).revision, 1);
  assert.equal(asAgent([{ op: "update_media", media: "m-b", set: { name: "b" } }]).revision, 1);
  assert.equal(asAgent([{ op: "update_item", item: "c1", set: { locked: true } }]).project.tracks[0]!.items[0]!.locked, true);
});

test("the user's hand: unlocking is always there, is one edit in the log, and edits follow", () => {
  assert.throws(() => asUser([{ op: "trim_item", item: "c2", edge: "end", frames: 10 }]), EditError);
  const unlocked = asUser([{ op: "update_item", item: "c2", set: { locked: null } }]);
  assert.equal(unlocked.log.at(-1)!.actor, "user");
  assert.equal(asUser([{ op: "trim_item", item: "c2", edge: "end", frames: 10 }], unlocked).project.tracks[0]!.items[1]!.duration, 110);
  const track = asUser([{ op: "update_track", track: "music", set: { locked: null } }]);
  assert.equal(asAgent([{ op: "update_item", item: "song", set: { gainDb: -3 } }], track).revision, 2);
  const ripple = asUser([{ op: "trim_item", item: "c1", edge: "end", frames: 30 }]);
  assert.equal(ripple.project.tracks[0]!.items[1]!.locked, true, "the user's own ripple still shifts a locked clip (D52)");
});

test("a lock the user made in the same session binds the agent's next edit", () => {
  const locked = asUser([{ op: "update_item", item: "c3", set: { locked: true } }]);
  assert.throws(() => asAgent([{ op: "delete_item", item: "c3" }], locked), EditError);
});

test("the agent is told what is locked", () => {
  assert.equal(locksNote(base), "track music, c2");
  const summary = projectSummary(base, 0) as { locked?: string; lockedNote?: string };
  assert.equal(summary.locked, "track music, c2");
  assert.match(summary.lockedNote ?? "", /Only the user unlocks/);
  const free = { ...base, tracks: base.tracks.map((t) => ({ ...t, locked: false, items: t.items.map((i) => ({ ...i, locked: false })) })) };
  assert.equal(locksNote(free), "");
});
