// Several projects at once: where a project opened from Open Recent, Finder, the Dock or a second
// launch goes (windowRouter.ts), and where a new window is placed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cascade, routeProject, windowWithProject, type RoutedWindow } from "../../apps/desktop/src/windowRouter.ts";

const win = (id: number, over: Partial<RoutedWindow> = {}): RoutedWindow => ({ id, local: true, projectDir: undefined, pendingOpen: undefined, ...over });

test("a window that has the project open comes forward, wherever the focus is", () => {
  const windows = [win(1, { projectDir: "/a/A.uncut" }), win(2, { projectDir: "/a/B.uncut" })];
  assert.deepEqual(routeProject(windows, 2, "/a/A.uncut"), { kind: "focus", id: 1 });
  // About to open it (handed over, its page hasn't asked yet) counts too.
  assert.deepEqual(routeProject([win(1, { pendingOpen: "/a/C.uncut" }), win(2)], 2, "/a/C.uncut"), { kind: "focus", id: 1 });
});

test("the focused window opens it when it shows no project; otherwise a new window does", () => {
  assert.deepEqual(routeProject([win(1, { projectDir: "/a/A.uncut" }), win(2)], 2, "/a/B.uncut"), { kind: "open", id: 2 });
  assert.deepEqual(
    routeProject([win(1), win(2, { projectDir: "/a/A.uncut" })], 2, "/a/B.uncut"),
    { kind: "new" },
    "an empty window that isn't focused isn't taken",
  );
  assert.deepEqual(
    routeProject([win(1, { pendingOpen: "/a/A.uncut" })], 1, "/a/B.uncut"),
    { kind: "new" },
    "a window about to open another project isn't empty",
  );
  assert.deepEqual(routeProject([], undefined, "/a/B.uncut"), { kind: "new" });
});

test("a window on a remote environment never takes a path of this Mac, but its local server's project still counts", () => {
  assert.deepEqual(routeProject([win(1, { local: false })], 1, "/a/B.uncut"), { kind: "new" });
  // Switched to a remote with A open on its local server: A is still open there.
  const switched = win(1, { local: false, projectDir: "/a/A.uncut" });
  assert.deepEqual(routeProject([switched, win(2)], 2, "/a/A.uncut"), { kind: "focus", id: 1 });
});

test("the page's own open looks only at the other windows", () => {
  const windows = [win(1, { projectDir: "/a/A.uncut" }), win(2), win(3, { local: false, projectDir: "/a/B.uncut" })];
  assert.equal(windowWithProject(windows, 2, "/a/A.uncut")?.id, 1);
  assert.equal(windowWithProject(windows, 1, "/a/A.uncut"), undefined);
  assert.equal(windowWithProject(windows, 2, "/a/B.uncut")?.id, 3, "a window showing a remote whose local server has it");
});

test("new windows cascade off the ones already there", () => {
  assert.deepEqual(cascade({ x: 100, y: 80 }, []), { x: 100, y: 80 });
  assert.deepEqual(cascade({ x: 100, y: 80 }, [{ x: 100, y: 80 }]), { x: 128, y: 108 });
  assert.deepEqual(
    cascade({ x: 100, y: 80 }, [
      { x: 100, y: 80 },
      { x: 129, y: 107 },
    ]),
    { x: 156, y: 136 },
  );
  assert.deepEqual(cascade({ x: 100, y: 80 }, [{ x: 400, y: 80 }]), { x: 100, y: 80 });
});
