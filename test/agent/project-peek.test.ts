// project_peek: another project's outline and one graphic, within the reference boundary, writing nothing.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { peekProject } from "../../apps/server/src/agent/tools/peek.ts";

const home = realpathSync(mkdtempSync(join(tmpdir(), "uncut-peek-")));
after(() => rmSync(home, { recursive: true, force: true }));

const movies = join(home, "Movies");
const here = join(movies, "here.uncut");
const there = join(movies, "there.uncut");
mkdirSync(join(here, "graphics"), { recursive: true });
mkdirSync(join(there, "graphics"), { recursive: true });
mkdirSync(join(there, "agent"), { recursive: true });
writeFileSync(join(here, "project.json"), "{}");
writeFileSync(
  join(there, "project.json"),
  JSON.stringify({
    name: "there",
    canvas: { width: 1080, height: 1920, fps: 30 },
    theme: { colors: { bg: "#000" } },
    media: [{ path: "/Users/me/secret/footage.mov" }],
    tracks: [{ id: "v", kind: "video", name: "Main", role: "main", items: [{ type: "clip" }, { type: "clip" }, { type: "graphic" }] }],
  }),
);
writeFileSync(join(there, "brief.json"), JSON.stringify({ film: "A promo", visual: "Silver", assets: ["/Users/me/x.mov"] }));
writeFileSync(join(there, "graphics", "panel.html"), "<div>panel</div><script>const k = 'sk-ant-abcdefghijklmnopqrstuvwx';</script>");
writeFileSync(join(there, "graphics", "huge.html"), "x".repeat(70 * 1024));
writeFileSync(join(there, "secrets.env"), "KEY=1");
symlinkSync(join(there, "secrets.env"), join(there, "graphics", "link.html"));
writeFileSync(join(there, "agent", "turns.json"), "{}");

const peek = (project: string, graphic?: string) => peekProject({ project, graphic, current: here, home });

test("the outline: brief, canvas, look, tracks by type and graphic sizes, and no media paths", async () => {
  const seen = (await peek(there)) as Record<string, any>;
  assert.equal(seen.name, "there");
  assert.deepEqual(seen.canvas, { width: 1080, height: 1920, fps: 30 });
  assert.deepEqual(seen.brief, { film: "A promo", visual: "Silver" });
  assert.deepEqual(seen.look, { theme: { colors: { bg: "#000" } } });
  assert.deepEqual(seen.tracks, [{ id: "v", kind: "video", name: "Main", role: "main", types: { clip: 2, graphic: 1 } }]);
  assert.ok(seen.graphics.some((g: any) => g.name === "panel.html" && g.bytes > 20));
  assert.doesNotMatch(JSON.stringify(seen), /secret\/footage/);
});

test("a sibling by name and by ~ path", async () => {
  assert.equal(((await peek("there")) as any).name, "there");
  assert.equal(((await peek("there.uncut")) as any).name, "there");
  assert.equal(((await peek("~/Movies/there.uncut")) as any).name, "there");
});

test("one graphic, with key shapes hidden", async () => {
  const seen = (await peek(there, "panel.html")) as Record<string, any>;
  assert.match(seen.html, /<div>panel/);
  assert.doesNotMatch(seen.html, /sk-ant-abcdefghijklmnopqrstuvwx/);
});

test("refused: this project, what isn't a project, ~/Library, traversal, links out, dot files and a huge file", async () => {
  const library = join(home, "Library", "Application Support", "x.uncut");
  mkdirSync(library, { recursive: true });
  writeFileSync(join(library, "project.json"), "{}");
  for (const project of [here, join(home, "nope.uncut"), library, "../there.uncut", "/etc"]) assert.ok("problem" in (await peek(project)), project);
  for (const graphic of ["../secrets.env", "../project.json", "link.html", ".env", "a/b.html", "huge.html", "secrets.env"])
    assert.ok("problem" in (await peek(there, graphic)), graphic);
});

test("nothing is written: the folder's files and times stay", async () => {
  const stamp = () =>
    readdirSync(there, { recursive: true })
      .map((f) => `${f}:${statSync(join(there, String(f))).mtimeMs}`)
      .sort();
  const before = stamp();
  await peek(there);
  await peek(there, "panel.html");
  assert.deepEqual(stamp(), before);
});
