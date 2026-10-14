// Issues #22 and #27 without the app.
// - #22 (D201): pasted files in the composer: a folder, an SVG, a video or a font from disk goes in
//   as its path; Finder's copy (a File with no path, the folder's icon as a TIFF) is matched to the
//   clipboard's file list by name; PNG, JPEG, GIF and WebP pictures still attach. The desktop reads
//   Finder's pasteboard (file URLs and the NSFilenamesPboardType plist).
// - #27 (D202): the agent's ui_show only steers an idle user with "Follow agent" on; otherwise its
//   stretch becomes the pill's "Agent changed 0:12–0:18".
import { test } from "node:test";
import assert from "node:assert/strict";

import { quotePaths, sortPasted } from "../../apps/web/src/panels/pasted.ts";
import { clipboardPaths, pastedPaths } from "../../apps/desktop/src/clipboardPaths.ts";
import { changeLabel, changeRange, followShown, IDLE_MS, mayFollow } from "../../apps/web/src/state/agentFollow.ts";

test("pasted files from disk: images attach, everything else is a path", () => {
  const files = [
    { name: "logo.svg", type: "image/svg+xml", path: "/Users/me/brand/logo.svg" },
    { name: "shot.png", type: "image/png", path: "/Users/me/shot.png" },
    { name: "take.mov", type: "video/quicktime", path: "/Users/me/My Takes/take.mov" },
    { name: "Inter.woff2", type: "font/woff2", path: "/Users/me/fonts/Inter.woff2" },
  ];
  assert.deepEqual(sortPasted(files, []), { paths: ["/Users/me/brand/logo.svg", "/Users/me/My Takes/take.mov", "/Users/me/fonts/Inter.woff2"], attach: [1], unknown: [] });
  assert.equal(quotePaths(["/Users/me/My Takes/take.mov", "/a"]), "/Users/me/My\\ Takes/take.mov /a");
});

test("Finder's copied folder: the icon File is matched to the clipboard's path, not attached", () => {
  const icon = [{ name: "argent-marketing", type: "image/tiff", path: "" }];
  assert.deepEqual(sortPasted(icon, ["/Users/me/Downloads/argent-marketing"]), { paths: ["/Users/me/Downloads/argent-marketing"], attach: [], unknown: [] });
  // Several items copied, one icon on the paste: every path goes in.
  assert.deepEqual(sortPasted(icon, ["/Users/me/Downloads/argent-marketing", "/Users/me/clip.mp4"]).paths, ["/Users/me/Downloads/argent-marketing", "/Users/me/clip.mp4"]);
  // A screenshot (a PNG with no file behind it) still attaches.
  assert.deepEqual(sortPasted([{ name: "image.png", type: "image/png", path: "" }], []), { paths: [], attach: [0], unknown: [] });
  // A TIFF with nothing on the clipboard to say what it is: unknown (the composer says it can't attach it).
  assert.deepEqual(sortPasted([{ name: "x", type: "image/tiff", path: "" }], []).unknown, [0]);
});

test("the desktop reads Finder's pasteboard: file URLs and the filenames plist, each path once", async () => {
  const plist = `<?xml version="1.0"?><plist version="1.0"><array><string>/Users/me/argent &amp; co</string><string>/Users/me/a.svg</string></array></plist>`;
  assert.deepEqual(pastedPaths("file:///Users/me/a.svg\nfile:///Users/me/Folder%20B/", plist), ["/Users/me/argent & co", "/Users/me/a.svg", "/Users/me/Folder B"]);
  assert.deepEqual(pastedPaths("", ""), []);
  const entry = (data: Record<string, string>) => ({ types: Object.keys(data), getType: async (t: string) => (t in data ? new Blob([data[t]!]) : Promise.reject(new Error("no"))) });
  const raw = (f: string) => `electron application/osclipboard;format="${f}"`;
  assert.deepEqual(await clipboardPaths([entry({ [raw("public.file-url")]: "file:///Users/me/argent-marketing/" }), entry({ "text/uri-list": "file:///Users/me/b.ttf" })]), ["/Users/me/argent-marketing", "/Users/me/b.ttf"]);
  assert.deepEqual(await clipboardPaths([entry({ "text/plain": "hello" })]), []);
});

test("the agent steers only an idle user with Follow agent on", () => {
  const idle = { saved: undefined, playing: false, pointerDown: false, sinceInput: IDLE_MS + 1 };
  assert.equal(mayFollow(idle), true);
  assert.equal(mayFollow({ ...idle, playing: true }), false, "never while playing");
  assert.equal(mayFollow({ ...idle, saved: true, playing: true }), false, "not even with Follow on");
  assert.equal(mayFollow({ ...idle, pointerDown: true }), false, "nor while scrubbing");
  assert.equal(mayFollow({ ...idle, sinceInput: 500 }), false, "nor right after an input");
  assert.equal(mayFollow({ ...idle, saved: false }), false, "Follow off: never");
  assert.equal(followShown(undefined, true), false, "the toggle shows off while playing until it's flipped");
  assert.equal(followShown(undefined, false), true);
  assert.equal(followShown(true, true), true);
});

test("the pill's stretch: the selected item, else the items starting at the frame", () => {
  const tracks = [{ items: [{ id: "a", start: 0, duration: 90 }, { id: "b", start: 360, duration: 180 }] }, { items: [{ id: "t", start: 360, duration: 60 }] }];
  assert.deepEqual(changeRange(tracks, { select: "b" }), { from: 360, to: 540 });
  assert.deepEqual(changeRange(tracks, { frame: 360 }), { from: 360, to: 540 });
  assert.deepEqual(changeRange(tracks, { frame: 100 }), { from: 100, to: 100 });
  assert.equal(changeRange(tracks, {}), undefined);
  assert.equal(changeLabel({ from: 360, to: 540 }, 30), "Agent changed 0:12–0:18");
  assert.equal(changeLabel({ from: 100, to: 100 }, 30), "Agent changed 0:03");
});
