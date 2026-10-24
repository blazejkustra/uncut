// D295: the Agent tab's pure thread helpers: the current chat's turns after New chat, and the
// hand-edit note with media imports folded into one line.
import { test } from "node:test";
import assert from "node:assert/strict";
import { noteLines, splitThread } from "../../apps/web/src/panels/agent/thread.ts";

test("splitThread: no start is one chat; a start splits by startedAt (a turn at the start is the new chat's)", () => {
  const turns = [
    { id: "a", startedAt: "2026-10-16T10:00:00.000Z" },
    { id: "b", startedAt: "2026-10-16T11:00:00.000Z" },
    { id: "c", startedAt: "2026-10-16T12:00:00.000Z" },
  ];
  assert.deepEqual(splitThread(turns, undefined), { earlier: [], current: turns });
  assert.deepEqual(splitThread(turns, "nonsense"), { earlier: [], current: turns });
  const s = splitThread(turns, "2026-10-16T11:00:00.000Z");
  assert.deepEqual(
    s.earlier.map((t) => t.id),
    ["a"],
  );
  assert.deepEqual(
    s.current.map((t) => t.id),
    ["b", "c"],
  );
  assert.deepEqual(splitThread(turns, "2026-10-16T13:00:00.000Z").current, []);
});

test("noteLines: 23 imports become one 'Added 23 files' line where the first was, other lines kept in order", () => {
  const imports = Array.from({ length: 23 }, (_, i) => `- Added media DJI_00${String(i + 10)} (m-dji-00${i + 10})`);
  const note = ["You changed the project:", "- Moved Title", ...imports, '- Renamed the project to "Film"'].join("\n");
  const lines = noteLines(note);
  assert.deepEqual(
    lines.map((l) => l.text),
    ["Moved Title", "Added 23 files", 'Renamed the project to "Film"'],
  );
  const folded = lines[1]!;
  assert.equal(folded.kind, "imports");
  assert.equal(folded.kind === "imports" && folded.names.length, 23);
  assert.equal(folded.kind === "imports" && folded.names[0], "DJI_0010 (m-dji-0010)");
});

test("noteLines: one import stays as it is; a summary line counts its five and the rest", () => {
  assert.deepEqual(noteLines("- Added media A (m-a)\n- Moved B"), [
    { kind: "line", text: "Added media A (m-a)" },
    { kind: "line", text: "Moved B" },
  ]);
  const summary = noteLines("- Added media m-1, m-2, m-3, m-4, m-5 and 18 more");
  assert.equal(summary.length, 1);
  assert.equal(summary[0]!.text, "Added 23 files");
  assert.deepEqual(noteLines("no list here"), []);
});
