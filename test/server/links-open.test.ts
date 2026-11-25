// D347: a project saved with D123/D215's linkedTo opens with its links converted to `link`, as one
// edit that ⌘Z takes back; the server then edits linked items by delta (a J/L cut stays).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUNDLE, MEDIA, connect, killAll, startServer } from "../helpers/server.ts";

const skip = existsSync(BUNDLE) && existsSync(MEDIA) ? false : "server bundle or media core not built (run pnpm build)";

let root = "";
before(() => {
  if (skip) return;
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-links-open-")));
});
after(() => {
  killAll();
  if (root) rmSync(root, { recursive: true, force: true });
});

const probe = { frames: 600, fps: 30, width: 320, height: 240, hasAudio: true };
const legacy = {
  format: "uncut/0",
  name: "Old",
  canvas: { width: 1920, height: 1080, fps: 30 },
  media: [{ id: "m", kind: "video", name: "talk.mp4", path: "/talk.mp4", probe }],
  tracks: [
    { id: "main", kind: "video", role: "main", name: "Main", items: [{ id: "c", type: "clip", media: "m", in: 0, duration: 120, mute: true }] },
    { id: "audio", kind: "audio", name: "Audio", items: [{ id: "s", type: "audio", media: "m", in: 0, start: 0, duration: 150, linkedTo: "c" }] },
  ],
};

type Item = { id: string; duration: number; link?: string; linkedTo?: string };
const itemsOf = (project: { tracks: Array<{ items: Array<Item> }> }) => new Map(project.tracks.flatMap((t) => t.items.map((i) => [i.id, i] as const)));

test("an old linkedTo project opens as links in one undoable edit; the server edits them by delta", { skip, timeout: 30000 }, async () => {
  const dir = join(root, "Old.uncut");
  mkdirSync(dir);
  writeFileSync(join(dir, "project.json"), JSON.stringify(legacy));
  const server = await startServer({ env: { UNCUT_DATA_DIR: join(root, "data") } });
  const s = await connect(server.ready.port, server.ready.token);
  try {
    const opened = await s.ok("project.open", { dir });
    const items = itemsOf(opened.project);
    assert.ok(items.get("c")!.link && items.get("c")!.link === items.get("s")!.link);
    assert.equal(items.get("s")!.linkedTo, undefined);
    assert.equal(opened.canUndo, true);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "project.json"), "utf8")), opened.project);

    // The sound's L cut (it runs 30 frames past the clip) stays when the clip's end is trimmed.
    const trimmed = await s.ok("project.edit", { ops: [{ op: "trim_item", item: "c", edge: "end", frames: 20 }] });
    assert.deepEqual([itemsOf(trimmed.project).get("c")!.duration, itemsOf(trimmed.project).get("s")!.duration], [100, 150]);

    await s.ok("project.undo");
    const back = await s.ok("project.undo");
    assert.equal(itemsOf(back.project).get("s")!.linkedTo, "c", "⌘Z brings the old field back");
    assert.equal(itemsOf(back.project).get("s")!.link, undefined);
  } finally {
    s.close();
    await server.stop();
  }
});
