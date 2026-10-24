// U12 (D178): what's pending when the user leaves, per way of leaving, and the dialog's words.
import { test } from "node:test";
import assert from "node:assert/strict";

import { leaveWords, pendingWork, type PendingInput } from "../../apps/web/src/state/pending.ts";

const idle: PendingInput = {
  reason: "quit",
  saving: 0,
  draft: undefined,
  message: false,
  agentRunning: false,
  exports: [],
  recorder: "idle",
  devices: [],
  uploading: 0,
  imports: 0,
  generating: 0,
  downloads: 0,
};

test("nothing pending: nothing to ask, for every way of leaving", () => {
  for (const reason of ["quit", "window", "close-project", "open-project", "new-project", "environment"] as const)
    assert.deepEqual(pendingWork({ ...idle, reason }), []);
});

test("a running agent turn and a draft are listed, with Save and wait / Discard and stop", () => {
  const items = pendingWork({ ...idle, agentRunning: true, draft: "rename" });
  assert.deepEqual(
    items.map((i) => [i.id, i.text, i.how, i.stop]),
    [
      ["draft", "A name being edited", "save", "rename"],
      ["agent", "The agent is working", "wait", "agent"],
    ],
  );
  assert.deepEqual(leaveWords("quit", items), { title: "Quit Uncut?", keep: "Save and wait", drop: "Discard and stop" });
  assert.deepEqual(leaveWords("close-project", pendingWork({ ...idle, reason: "close-project", agentRunning: true })), {
    title: "Close the project?",
    keep: "Wait",
    drop: "Stop",
  });
  assert.deepEqual(leaveWords("window", pendingWork({ ...idle, draft: "field" })), { title: "Close Uncut?", keep: "Save", drop: "Discard" });
});

test("exports and generations stop only with the app; a project change leaves them running", () => {
  const busy = { ...idle, exports: [{ id: "e1", name: "Promo.mp4" }], generating: 2, downloads: 1 };
  assert.deepEqual(
    pendingWork({ ...busy, reason: "quit" }).map((i) => i.text),
    ["Exporting Promo.mp4", "Generating 2 results", "Downloading 1 export"],
  );
  assert.deepEqual(pendingWork({ ...busy, reason: "close-project" }), []);
  assert.deepEqual(
    pendingWork({ ...busy, reason: "environment" }).map((i) => i.id),
    ["downloads"],
  );
});

test("saves, takes, devices, uploads, imports and an unsent message", () => {
  const items = pendingWork({
    ...idle,
    reason: "open-project",
    saving: 2,
    recorder: "recording",
    devices: ["iPhone 17"],
    uploading: 3,
    imports: 1,
    message: true,
  });
  assert.deepEqual(
    items.map((i) => [i.text, i.how]),
    [
      ["2 changes being saved", "wait"],
      ["A recording on this Mac", "save"],
      ["Recording iPhone 17", "save"],
      ["Uploading 3 files", "wait"],
      ["Media being imported", "wait"],
      ["An unsent message to the agent (not kept)", "none"],
    ],
  );
  assert.equal(pendingWork({ ...idle, saving: 1 })[0]!.text, "The last change is being saved");
  assert.equal(pendingWork({ ...idle, recorder: "saving" })[0]!.how, "wait");
  // Only an unsent message: nothing to keep, only Discard.
  assert.deepEqual(leaveWords("window", pendingWork({ ...idle, message: true })), { title: "Close Uncut?", keep: undefined, drop: "Discard" });
  // No word separators the user asked us never to use.
  for (const i of items) assert.doesNotMatch(i.text, /[·*•]/);
});
