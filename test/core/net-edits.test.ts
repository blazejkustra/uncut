// D6 (handoff 7): the agent's note says the net result of the user's edits, not their churn.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { applyEdit, createSession, EditConflict, redoTurn, undoTurn } from "../../packages/core/src/timeline/apply-ops.ts";
import { netChanges, netEditsNote, netZeroNote } from "../../packages/core/src/timeline/net-edits.ts";
import type { Edit, Op, Project, Session } from "../../packages/core/src/timeline/types.ts";

const promo: Project = JSON.parse(await readFile(new URL("../../spec/examples/close-the-loop.uncut/project.json", import.meta.url), "utf8"));

const user = (s: Session, ...ops: Array<Op>) => applyEdit(s, { actor: "user", ops });
const agent = (s: Session, turnId: string, summary: string, ...ops: Array<Op>) => applyEdit(s, { actor: "agent", turnId, summary, ops } satisfies Edit);

const take = (n: number): Array<Op> => [
  { op: "add_media", media: { id: `take-${n}`, kind: "video", name: `Take ${n}`, path: `media/take-${n}.mov` } as never },
  { op: "insert_item", track: "v2", item: { id: `clip-${n}`, type: "clip", media: `take-${n}`, start: 0, duration: 90 } },
];

test("recording takes and deleting them nets to nothing", () => {
  const start = createSession(promo);
  let s = start;
  for (const n of [1, 2, 3, 4]) {
    s = user(s, ...take(n));
    s = user(s, { op: "delete_item", item: `clip-${n}` }, { op: "delete_media", media: `take-${n}` });
  }
  assert.deepEqual(netChanges(start.project, s, 0), []);
  assert.equal(netEditsNote(start.project, s, 0), netZeroNote(s.revision));
});

test("a take whose clip is deleted but whose media stays in the bin is one line", () => {
  const start = createSession(promo);
  let s = user(start, ...take(1));
  s = user(s, { op: "delete_item", item: "clip-1" });
  assert.deepEqual(netChanges(start.project, s, 0), ["Added media Take 1 (take-1)"]);
});

test("a nudge and its revert, and a trim extended back, net to nothing", () => {
  const start = createSession(promo);
  let s = user(start, { op: "move_item", item: "txt-taps", start: 251 });
  s = user(s, { op: "move_item", item: "txt-taps", start: 250 });
  s = user(s, { op: "trim_item", item: "aud-vo", edge: "end", frames: 3 });
  s = user(s, { op: "trim_item", item: "aud-vo", edge: "end", frames: -3 });
  assert.deepEqual(netChanges(start.project, s, 0), []);
});

test("a trim smaller than a tenth of a second says its frames, never 'by 0.0s'", () => {
  const start = createSession(promo);
  const s = user(start, { op: "trim_item", item: "aud-vo", edge: "end", frames: 2 });
  const [line] = netChanges(start.project, s, 0);
  assert.equal(line, "Changed Voiceover (aud-vo): length 11.0s → 10.9s");
  const one = user(start, { op: "trim_item", item: "sim-login", edge: "end", frames: 1 });
  assert.equal(netChanges(start.project, one, 0)[0], "Changed Login flow, iPhone 16 Pro (sim-login): length 12.0s → 12.0s (−1 frame)");
});

test("mute, unmute and two volumes are the last volume; final values per item", () => {
  const start = createSession(promo);
  let s = user(start, { op: "update_track", track: "a1", set: { mixer: { mute: true } } });
  s = user(s, { op: "update_track", track: "a1", set: { mixer: { mute: false } } });
  s = user(s, { op: "update_track", track: "a1", set: { mixer: { gainDb: -39 } } });
  s = user(s, { op: "update_track", track: "a1", set: { mixer: { gainDb: -31.5 } } });
  s = user(s, { op: "move_item", item: "txt-taps", start: 260 }, { op: "update_item", item: "txt-taps", set: { text: "First" } });
  s = user(s, { op: "update_item", item: "txt-taps", set: { text: "Second" } });
  assert.deepEqual(netChanges(start.project, s, 0), [
    "Set volume of track a1 to −31.5 dB",
    'Changed text "Second" (txt-taps): start 8.3s → 8.7s',
    'Changed the text of txt-taps to "Second"',
  ]);
  const note = netEditsNote(start.project, s, 0);
  assert.match(note, /^The user changed 3 things by hand since your last turn \(now at revision 6\)\. This is the net result/);
  assert.match(note, /\n- Set volume of track a1 to −31\.5 dB/);
});

test("added, removed and reordered items and a deleted track read as the final state", () => {
  const start = createSession(promo);
  let s = user(start, { op: "move_item", item: "signoff", index: 0 });
  s = user(s, { op: "delete_item", item: "cmp-tap" }, { op: "delete_track", track: "v2" });
  s = user(s, { op: "insert_item", track: "t1", item: { id: "txt-new", type: "text", text: "Hi", start: 30, duration: 60 } });
  const lines = netChanges(start.project, s, 0);
  assert.ok(lines.includes("Deleted track v2"), lines.join("\n"));
  assert.ok(lines.includes("Added text txt-new on track t1 at 1.0s, 2.0s long"), lines.join("\n"));
  assert.ok(lines.includes('Changed the text of txt-new to "Hi"'), lines.join("\n"));
  assert.ok(
    lines.some((l) => l.startsWith("Removed ") && l.includes("(cmp-tap) from track v2")),
    lines.join("\n"),
  );
  assert.ok(lines.includes("Reordered track main: signoff, hook-bg, terminal, sim-login, result-bg"), lines.join("\n"));
});

test("the agent's own edits after `since` aren't news; the user's edits around them are", () => {
  const start = createSession(promo);
  let s = agent(start, "t1", "Shorten the music", { op: "trim_item", item: "aud-music", edge: "end", frames: 30 });
  s = user(s, { op: "update_item", item: "txt-hook", set: { text: "Hello" } });
  s = agent(s, "t1", "Retitle", { op: "update_item", item: "txt-result", set: { text: "Done" } });
  assert.deepEqual(netChanges(start.project, s, 0), ['Changed the text of txt-hook to "Hello"']);
  assert.doesNotMatch(netEditsNote(start.project, s, 0), /music|Done/);
});

test("the filter picks whose entries are reported: anyone but turn t1's agent", () => {
  const start = createSession(promo);
  let s = agent(start, "t1", "Mine", { op: "update_item", item: "txt-hook", set: { text: "Mine" } });
  s = agent(s, "t2", "Theirs", { op: "update_item", item: "txt-result", set: { text: "Theirs" } });
  s = user(s, { op: "update_item", item: "txt-taps", set: { text: "User" } });
  const notMine = (e: { readonly turnId?: string }) => e.turnId !== "t1";
  assert.deepEqual(netChanges(start.project, s, 0, notMine), ['Changed the text of txt-taps to "User"', 'Changed the text of txt-result to "Theirs"']);
});

test("nothing done: an empty note", () => {
  const start = createSession(promo);
  assert.equal(netEditsNote(start.project, start, 0), "");
  const s = agent(start, "t1", "Mine", { op: "update_item", item: "txt-hook", set: { text: "Mine" } });
  assert.equal(netEditsNote(start.project, s, 0), "");
});

const hook = (p: Project) => p.tracks.find((t) => t.id === "t1")!.items[0]!.text;

test("redoTurn puts an undone turn back as one revision of that turn; refused when a later edit touched the same item", () => {
  const start = createSession(promo);
  let s = agent(start, "t1", "Retitle", { op: "update_item", item: "txt-hook", set: { text: "Agent" } });
  s = agent(s, "t1", "Trim", { op: "trim_item", item: "aud-music", edge: "end", frames: 30 });
  const entries = s.log.filter((e) => e.turnId === "t1");
  const undone = undoTurn(promo, s, "t1");
  const redone = redoTurn(undone, entries, undone.revision);
  assert.equal(redone.revision, undone.revision + 1);
  assert.equal(redone.log.at(-1)!.turnId, "t1");
  assert.equal(redone.log.at(-1)!.actor, "user", "the user's step: the agent's note reports it");
  assert.deepEqual(redone.project, s.project);
  assert.equal(hook(undoTurn(promo, redone, "t1").project), hook(promo), "Undo turn takes it back again");
  assert.throws(() => redoTurn(redone, entries, undone.revision), /in the project already/);
  const later = user(undone, { op: "update_item", item: "txt-hook", set: { text: "Mine" } });
  assert.throws(() => redoTurn(later, entries, undone.revision), EditConflict);
  const elsewhere = user(undone, { op: "update_item", item: "txt-taps", set: { text: "Other" } });
  assert.equal(hook(redoTurn(elsewhere, entries, undone.revision).project), "Agent");
});

test("an item added since says what it was given, in the edit log's words, with only the final values", () => {
  const start = createSession(promo);
  let s = user(start, { op: "insert_item", track: "a3", item: { id: "audio-1", type: "audio", media: "m-music", in: 0, start: 0, duration: 240 } });
  s = user(s, { op: "update_item", item: "audio-1", set: { gainDb: -6 } });
  s = user(s, { op: "update_item", item: "audio-1", set: { fadeIn: 60 } });
  s = user(s, { op: "update_item", item: "audio-1", set: { fadeOut: 60 } });
  s = user(s, { op: "update_item", item: "audio-1", set: { fadeIn: 90 } });
  assert.deepEqual(netChanges(start.project, s, 0), [
    "Added audio audio-1 on track a3 (Cozy Rhodes) at 0.0s, 8.0s long",
    "Set volume of Cozy Rhodes (audio-1) to −6 dB",
    "Faded in Cozy Rhodes (audio-1) over 3.0 s",
    "Faded out Cozy Rhodes (audio-1) over 2.0 s",
  ]);
});
