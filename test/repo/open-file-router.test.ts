// D252/D266: a .uncut project opened from Finder opens only on Local. On a remote it's dropped with
// a notice (never sent to the remote, never opened later); a reload makes the renderer ask again.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeOpenFileRouter } from "../../apps/desktop/src/openFileRouter.ts";

function setup(initial: boolean | undefined) {
  const env = { local: initial };
  const opened: Array<string> = [];
  const notices: Array<string> = [];
  const router = makeOpenFileRouter({ isLocal: () => env.local, open: (d) => opened.push(d), notifyRemote: (d) => notices.push(d) });
  return { env, opened, notices, router };
}

test("cold launch on Local: the project waits for the renderer, then opens once", () => {
  const t = setup(undefined);
  t.router.opened("/Users/me/Foo.uncut");
  t.env.local = true;
  t.router.environmentsReady();
  assert.deepEqual(t.opened, []);
  assert.equal(t.router.rendererAsks(), "/Users/me/Foo.uncut");
  assert.equal(t.router.rendererAsks(), null);
  assert.deepEqual(t.notices, []);
});

test("Local, renderer ready: a Finder open goes straight to it", () => {
  const { opened, router } = setup(true);
  assert.equal(router.rendererAsks(), null);
  router.opened("/a/B.uncut");
  assert.deepEqual(opened, ["/a/B.uncut"]);
});

test("switched to a remote: not sent to the remote, a notice instead", () => {
  const { env, opened, notices, router } = setup(true);
  router.rendererAsks();
  env.local = false;
  router.rendererReloaded(); // the switch reloads the window
  router.opened("/Users/me/Foo.uncut");
  assert.deepEqual(opened, []);
  assert.deepEqual(notices, ["/Users/me/Foo.uncut"]);
  // Back on Local later: nothing opens by surprise.
  env.local = true;
  router.rendererReloaded();
  assert.equal(router.rendererAsks(), null);
  assert.deepEqual(opened, []);
});

test("cold launch on a remote: the notice when the environments load, and the path is dropped", () => {
  const { env, opened, notices, router } = setup(undefined);
  router.opened("/Users/me/Foo.uncut");
  assert.deepEqual(notices, []);
  env.local = false;
  router.environmentsReady();
  assert.deepEqual(notices, ["/Users/me/Foo.uncut"]);
  env.local = true;
  router.rendererReloaded();
  assert.equal(router.rendererAsks(), null);
  assert.deepEqual(opened, []);
});

test("a reload on Local: the open waits for the new page instead of going to the old one", () => {
  const { opened, router } = setup(true);
  router.rendererAsks();
  router.rendererReloaded();
  router.opened("/x/Y.uncut");
  assert.deepEqual(opened, []);
  assert.equal(router.rendererAsks(), "/x/Y.uncut");
});
