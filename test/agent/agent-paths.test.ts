// D198 (issue #37): ~ and $HOME in every path from the user or the agent, and every folder a
// message names (a second one too) found, listed and reported, or said why not.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expandHome } from "../../apps/server/src/paths.ts";
import { absolute, mentionedDirs, namedFolders } from "../../apps/server/src/agent/agentPermissions.ts";
import { listFolder, listingWords, planImport } from "../../apps/server/src/agent/agentFootage.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-paths-")));
after(() => rmSync(root, { recursive: true, force: true }));
const home = join(root, "home");

test("expandHome: ~, ~/…, $HOME, ${HOME}, quotes and Terminal's escaped spaces; exact keeps the string as a tool got it", () => {
  assert.equal(expandHome("~", home), home);
  assert.equal(expandHome("~/Downloads/a.mp4", home), join(home, "Downloads/a.mp4"));
  assert.equal(expandHome("$HOME/Movies/x", home), join(home, "Movies/x"));
  assert.equal(expandHome("${HOME}/Movies/x", home), join(home, "Movies/x"));
  assert.equal(expandHome("$HOME", home), home);
  assert.equal(expandHome('  "~/My Clips/a b.mov" ', home), join(home, "My Clips/a b.mov"));
  assert.equal(expandHome("~/My\\ Clips/a.mov", home), join(home, "My Clips/a.mov"));
  assert.equal(expandHome("~user/x", home), "~user/x", "another user's home isn't ours");
  assert.equal(expandHome("$HOMER/x", home), "$HOMER/x");
  assert.equal(expandHome("/abs/path", home), "/abs/path");
  assert.equal(expandHome("~/a\\ b", home, true), join(home, "a\\ b"), "exact: only the home folder");
  assert.equal(absolute("$HOME/x", "/p", home), join(home, "x"));
});

test("media_import's paths take $HOME too", async () => {
  const media = join(home, "Footage");
  mkdirSync(media, { recursive: true });
  writeFileSync(join(media, "clip.mp4"), "x");
  const was = process.env.HOME;
  process.env.HOME = home;
  try {
    const plan = await planImport(["$HOME/Footage/clip.mp4", "${HOME}/Footage"], join(root, "project"));
    assert.ok(!("refused" in plan), JSON.stringify(plan));
    assert.deepEqual(plan.files, [join(media, "clip.mp4")]);
  } finally {
    process.env.HOME = was;
  }
});

test("every folder a message names: both of two folders, a file's folder, $HOME paths; all of ~/Downloads is named with why, a file in it isn't a folder to list", async () => {
  const a = join(home, "Videos", "project");
  const b = join(home, "Videos", "assets");
  mkdirSync(join(a, "sub"), { recursive: true });
  mkdirSync(b, { recursive: true });
  mkdirSync(join(home, "Downloads"), { recursive: true });
  writeFileSync(join(home, "Downloads", "ref.mp4"), "x");
  for (const name of ["one.mp4", "two.png", "three.wav", "notes.txt", ".DS_Store"]) writeFileSync(join(a, name), "x");
  writeFileSync(join(b, "logo.svg"), "x");
  const kind = (p: string) => {
    try {
      const st = statSync(p);
      return st.isDirectory() ? ("dir" as const) : st.isFile() ? ("file" as const) : undefined;
    } catch {
      return undefined;
    }
  };
  const text = `Recreate it from ~/Downloads/ref.mp4, use the clips in ~/Videos/project and the assets in $HOME/Videos/assets. Also ~/Downloads.`;
  const named = namedFolders(text, join(root, "project"), kind, home, (p) => p);
  assert.deepEqual(named, [
    { dir: a, named: "folder" },
    { dir: b, named: "folder" },
    { dir: join(home, "Downloads"), named: "folder", problem: "it's all of ~/Downloads; paste a folder inside it" },
  ]);
  assert.deepEqual(
    mentionedDirs(text, join(root, "project"), kind, home, (p) => p),
    [a, b],
    "only the ones that can be roots are offered",
  );
  const listing = (await listFolder(a))!;
  assert.deepEqual(listing, { files: 4, folders: 1, videos: 1, images: 1, sounds: 1, names: ["notes.txt", "one.mp4", "three.wav", "two.png", "sub/"] });
  assert.equal(listingWords(listing), "4 files (1 video, 1 image, 1 sound) and 1 folder");
  assert.equal(await listFolder(join(root, "nope")), undefined);
});
