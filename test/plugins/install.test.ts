// Installing plugins (D102): from a folder and from a git repository (a local bare repo in a temp
// folder over file://, never the network), into <dataDir>/plugins/<id>. Refusals, each in one
// sentence: no manifest, not JSON, a newer apiVersion, a built-in id, a bundled plugin's id (unless
// replaced on purpose), a symlink out of the folder or an absolute one, a pipe, over 50 MB, a bad
// ref, an unknown protocol, a repo that isn't there. git runs with a clean environment. On the
// bundled server: plugins.install → needs approval (with its origin), approve → ready, installing
// again → needs approval again, uninstall → gone with its approval; one Uncut didn't install isn't
// removed.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  checkRef,
  gitClone,
  gitEnv,
  installPlugin,
  InstallError,
  parseSource,
  sweepLeftovers,
  swapHooks,
  type InstallContext,
} from "../../apps/server/src/plugins/install.ts";
import { PluginHost } from "../../apps/server/src/plugins/plugins.ts";
import { connect, killAll, startServer } from "../helpers/server.ts";

const FAKE = resolve("test/helpers/fake-plugin");
const manifest = JSON.parse(readFileSync(join(FAKE, "uncut.module.json"), "utf8"));

let root = "";
before(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-install-")));
});
after(() => {
  killAll();
  if (root) rmSync(root, { recursive: true, force: true });
});

let n = 0;
/** A plugin folder: the fake plugin, with this manifest merged over its own. */
const folder = (patch: Record<string, unknown> = {}) => {
  const dir = join(root, `src-${++n}`);
  cpSync(FAKE, dir, { recursive: true });
  writeFileSync(join(dir, "uncut.module.json"), JSON.stringify({ ...manifest, ...patch }, null, 2));
  return dir;
};
const git = (cwd: string, ...args: Array<string>) =>
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "init.defaultBranch=main", ...args], {
    cwd,
    env: gitEnv(),
    encoding: "utf8",
  }).trim();

const context = (pluginsRoot: string, extra: Partial<InstallContext> = {}): InstallContext => ({
  pluginsRoot,
  builtinIds: new Set(["transition.crossfade"]),
  bundled: new Map([["whisper.transcribe", "Whisper (on this Mac)"]]),
  git: async () => execFileSync("which", ["git"], { encoding: "utf8" }).trim(),
  ...extra,
});

const refused = async (promise: Promise<unknown>, pattern: RegExp, reason = "invalid") => {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof InstallError, String(error));
    assert.equal(error.reason, reason);
    assert.match(error.message, pattern);
    return true;
  });
};

test("sources, refs and git's environment", () => {
  assert.deepEqual(parseSource(" /a/b "), { kind: "folder", path: "/a/b" });
  assert.deepEqual(parseSource("https://example.invalid/x.git"), { kind: "git", url: "https://example.invalid/x.git" });
  assert.deepEqual(parseSource("git@example.invalid:me/x.git"), { kind: "git", url: "git@example.invalid:me/x.git" });
  assert.deepEqual(parseSource("file:///tmp/x.git"), { kind: "git", url: "file:///tmp/x.git" });
  assert.throws(() => parseSource("ext::sh -c touch% /tmp/pwned"), /not ext/);
  assert.throws(() => parseSource("http://example.invalid/x.git"), /not http/);
  assert.throws(() => parseSource("relative/folder"), /full path/);
  assert.throws(() => parseSource(""), /Choose a folder/);
  assert.equal(checkRef(" v1.2 "), "v1.2");
  assert.equal(checkRef(""), undefined);
  for (const bad of ["-u", "--upload-pack=x", "a..b", "a b", "x/"]) assert.throws(() => checkRef(bad), /isn't a branch or tag/);
  const env = gitEnv({
    PATH: "/usr/bin",
    HOME: "/h",
    HTTPS_PROXY: "http://proxy",
    GIT_DIR: "/x",
    GIT_CONFIG_PARAMETERS: "'core.sshCommand=evil'",
    OPENAI_API_KEY: "k",
  });
  assert.deepEqual(Object.keys(env).sort(), [
    "GIT_ALLOW_PROTOCOL",
    "GIT_CONFIG_GLOBAL",
    "GIT_CONFIG_NOSYSTEM",
    "GIT_SSH_COMMAND",
    "GIT_TERMINAL_PROMPT",
    "HOME",
    "LANG",
    "LC_ALL",
    "PATH",
  ]);
  assert.equal(env.GIT_TERMINAL_PROMPT, "0");
  assert.equal(env.GIT_ALLOW_PROTOCOL, "file:https:ssh:git");
});

test("install from a folder: copied into <dataDir>/plugins/<id>; the refusals", async () => {
  const plugins = join(root, "data-folder", "plugins");
  const ctx = context(plugins);
  const src = folder();
  mkdirSync(join(src, "lib"));
  writeFileSync(join(src, "lib", "a.txt"), "a");
  symlinkSync("lib/a.txt", join(src, "link.txt")); // inside: kept
  mkdirSync(join(src, ".git"));
  writeFileSync(join(src, ".git", "HEAD"), "ref"); // not copied
  const done = await installPlugin({ source: src }, ctx);
  assert.deepEqual({ ...done, dir: undefined }, { id: "fake.capture", name: "Fake capture", dir: undefined, kind: "folder", source: src });
  assert.equal(done.dir, realpathSync(join(plugins, "fake.capture")));
  assert.deepEqual(readdirSync(done.dir).sort(), ["lib", "link.txt", "server.ts", "uncut.module.json"]);
  assert.ok(lstatSync(join(done.dir, "link.txt")).isSymbolicLink());
  assert.equal(readFileSync(join(done.dir, "link.txt"), "utf8"), "a");
  // No leftovers (staging folders).
  assert.deepEqual(readdirSync(plugins), ["fake.capture"]);

  // Installing again replaces the copy.
  writeFileSync(join(src, "lib", "a.txt"), "b");
  await installPlugin({ source: src }, ctx);
  assert.equal(readFileSync(join(done.dir, "lib", "a.txt"), "utf8"), "b");
  assert.deepEqual(readdirSync(plugins), ["fake.capture"]);

  const empty = join(root, "empty");
  mkdirSync(empty);
  await refused(installPlugin({ source: empty }, ctx), /There's no uncut.module.json at the top of that folder/);
  await refused(installPlugin({ source: join(root, "missing") }, ctx), /There's no folder at/);
  const notJson = folder();
  writeFileSync(join(notJson, "uncut.module.json"), "{");
  await refused(installPlugin({ source: notJson }, ctx), /isn't valid JSON/);
  await refused(
    installPlugin({ source: folder({ apiVersion: "uncut.module/2" }) }, ctx),
    /written for the plugin format uncut.module\/2, which is newer than this Uncut understands/,
  );
  await refused(installPlugin({ source: folder({ id: "transition.crossfade" }) }, ctx), /belongs to a built-in module/);
  await refused(installPlugin({ source: folder({ runtime: { type: "html" } }) }, ctx), /only "process" and "data" plugins/);
  await refused(
    installPlugin({ source: folder({ id: "whisper.transcribe" }) }, ctx),
    /like Whisper \(on this Mac\), which ships with Uncut/,
    "replaces-bundled",
  );
  const replaced = await installPlugin({ source: folder({ id: "whisper.transcribe" }), replaceBundled: true }, ctx);
  assert.equal(replaced.id, "whisper.transcribe");
  await refused(installPlugin({ source: src, ref: "main" }, ctx), /only goes with a git URL/);
  await refused(installPlugin({ source: plugins + "/fake.capture" }, ctx), /already in Uncut's plugins folder/);

  const out = folder({ id: "out.link" });
  writeFileSync(join(root, "secret.txt"), "s");
  symlinkSync("../secret.txt", join(out, "secret.txt"));
  await refused(installPlugin({ source: out }, ctx), /secret.txt is a link to something outside/);
  const abs = folder({ id: "abs.link" });
  symlinkSync(join(abs, "server.ts"), join(abs, "abs.ts"));
  await refused(installPlugin({ source: abs }, ctx), /abs.ts is a link to something outside/);
  const dangling = folder({ id: "dangling.link" });
  symlinkSync("nowhere", join(dangling, "gone"));
  await refused(installPlugin({ source: dangling }, ctx), /gone is a link/);
  const fifo = folder({ id: "fifo.plugin" });
  execFileSync("mkfifo", [join(fifo, "pipe")]);
  await refused(installPlugin({ source: fifo }, ctx), /pipe isn't a regular file/);
  const big = folder({ id: "big.plugin" });
  writeFileSync(join(big, "model.bin"), "");
  truncateSync(join(big, "model.bin"), 51 * 1024 * 1024); // sparse: no disk used
  await refused(installPlugin({ source: big }, ctx), /bigger than 50 MB/);
  // None of the refused ones left anything behind.
  assert.deepEqual(readdirSync(plugins).sort(), ["fake.capture", "whisper.transcribe"]);
});

test("install from a git repository: a shallow clone of a local bare repo, at a branch or tag, with the commit", async () => {
  const work = join(root, "work");
  mkdirSync(work);
  git(work, "init", "-q");
  cpSync(FAKE, work, { recursive: true });
  git(work, "add", ".");
  git(work, "commit", "-q", "-m", "one");
  const first = git(work, "rev-parse", "HEAD");
  git(work, "tag", "v1");
  writeFileSync(join(work, "extra.txt"), "two");
  git(work, "add", ".");
  git(work, "commit", "-q", "-m", "two");
  const second = git(work, "rev-parse", "HEAD");
  const bare = join(root, "repo.git");
  git(root, "clone", "-q", "--bare", work, bare);
  const url = `file://${bare}`;

  const plugins = join(root, "data-git", "plugins");
  const ctx = context(plugins);
  const head = await installPlugin({ source: url }, ctx);
  assert.equal(head.kind, "git");
  assert.equal(head.source, url);
  assert.equal(head.commit, second);
  assert.ok(existsSync(join(head.dir, "extra.txt")));
  assert.ok(!existsSync(join(head.dir, ".git")), "no .git in the installed copy");
  const tagged = await installPlugin({ source: url, ref: "v1" }, ctx);
  assert.equal(tagged.commit, first);
  assert.equal(tagged.ref, "v1");
  assert.ok(!existsSync(join(tagged.dir, "extra.txt")));
  // No temp clones left behind.
  assert.deepEqual(
    readdirSync(tmpdir()).filter((f) => f.startsWith("uncut-plugin-") && existsSync(join(tmpdir(), f, "clone"))),
    [],
  );

  await refused(installPlugin({ source: url, ref: "nope" }, ctx), /Couldn't clone .* at nope: /, "io");
  await refused(installPlugin({ source: `file://${join(root, "missing.git")}` }, ctx), /Couldn't clone file:\/\/.*missing\.git: /, "io");
  await refused(installPlugin({ source: url }, { ...ctx, git: async () => undefined }), /needs git, which isn't installed/);
  // A repo without a manifest.
  const plain = join(root, "plain");
  mkdirSync(plain);
  git(plain, "init", "-q");
  writeFileSync(join(plain, "README"), "x");
  git(plain, "add", ".");
  git(plain, "commit", "-q", "-m", "x");
  await refused(installPlugin({ source: `file://${plain}` }, ctx), /no uncut.module.json at the top of that repository/);
});

test("on the server: install → needs approval (with where it came from) → allow → reinstall asks again → uninstall", async () => {
  const base = join(root, "server");
  const data = join(base, "data");
  const envDir = join(base, "env-plugins");
  mkdirSync(join(envDir, "dev"), { recursive: true });
  cpSync(FAKE, join(envDir, "dev"), { recursive: true });
  writeFileSync(join(envDir, "dev", "uncut.module.json"), JSON.stringify({ ...manifest, id: "dev.plugin", agentTools: [] }));
  const server = await startServer({ env: { UNCUT_DATA_DIR: data, UNCUT_PLUGINS_DIR: envDir, UNCUT_BUNDLED_PLUGINS_DIR: resolve("plugins") } });
  const client = await connect(server.ready.port, server.ready.token);
  try {
    const src = folder({ id: "installed.fake" });
    const installed = await client.ok("plugins.install", { source: src });
    assert.equal(installed.id, "installed.fake");
    const row = installed.plugins.find((p: any) => p.id === "installed.fake");
    assert.equal(row.status, "needs-approval");
    assert.equal(row.removable, true);
    assert.deepEqual(row.origin, { kind: "folder", source: src });
    assert.equal(row.dir, realpathSync(join(data, "plugins", "installed.fake")));
    assert.match(row.asks[0], /runs as a program on this Mac with your rights/);

    const allowed = await client.ok("plugins.approve", { id: row.id, dir: row.dir, capabilities: row.capabilities });
    assert.equal(allowed.find((p: any) => p.id === "installed.fake").status, "ready");
    // Installing again (an update) needs allowing again.
    const again = await client.ok("plugins.install", { source: src });
    assert.equal(again.plugins.find((p: any) => p.id === "installed.fake").status, "needs-approval");
    const settings = () => JSON.parse(readFileSync(join(data, "settings.json"), "utf8"));
    assert.equal(settings().pluginApprovals["installed.fake"], undefined);
    assert.equal(settings().pluginInstalls["installed.fake"].source, src);

    // From git (a local bare repo over file://): the origin has the ref and the commit cloned.
    const work = join(base, "work");
    mkdirSync(work);
    git(work, "init", "-q");
    cpSync(src, work, { recursive: true });
    writeFileSync(join(work, "uncut.module.json"), JSON.stringify({ ...manifest, id: "git.fake" }));
    git(work, "add", ".");
    git(work, "commit", "-q", "-m", "one");
    git(work, "tag", "v1");
    const commit = git(work, "rev-parse", "HEAD");
    const url = `file://${work}`;
    const fromGit = await client.ok("plugins.install", { source: url, ref: "v1" });
    const gitRow = fromGit.plugins.find((p: any) => p.id === "git.fake");
    assert.equal(gitRow.status, "needs-approval");
    assert.deepEqual(gitRow.origin, { kind: "git", source: url, ref: "v1", commit });
    assert.equal(settings().pluginInstalls["git.fake"].commit, commit);
    await client.ok("plugins.uninstall", { id: "git.fake" });

    // A bundled plugin's id: refused unless on purpose.
    const clash = await client.fail("plugins.install", { source: folder({ id: "whisper.transcribe" }) });
    assert.equal(clash.reason, "replaces-bundled");
    assert.match(clash.message, /ships with Uncut/);
    const future = await client.fail("plugins.install", { source: folder({ id: "future.fake", apiVersion: "uncut.module/3" }) });
    assert.equal(future.reason, "invalid");
    assert.match(future.message, /newer than this Uncut understands/);

    // Not Uncut's to remove: the bundled ones and a dev folder.
    assert.equal((await client.fail("plugins.uninstall", { id: "whisper.transcribe" })).reason, "bundled");
    assert.equal((await client.fail("plugins.uninstall", { id: "dev.plugin" })).reason, "not-removable");
    assert.ok(existsSync(join(envDir, "dev", "uncut.module.json")));

    await client.ok("plugins.approve", { id: row.id, dir: row.dir, capabilities: row.capabilities });
    const after = await client.ok("plugins.uninstall", { id: "installed.fake" });
    assert.equal(
      after.some((p: any) => p.id === "installed.fake"),
      false,
    );
    assert.ok(!existsSync(join(data, "plugins", "installed.fake")));
    assert.equal(settings().pluginApprovals["installed.fake"], undefined);
    assert.equal(settings().pluginInstalls["installed.fake"], undefined);
    assert.deepEqual(readdirSync(join(data, "plugins")), []);
  } finally {
    client.close();
    await server.stop?.();
  }
});

test("review fixes: the swap waits for beforeSwap (a failure aborts), rolls back, sweeps litter; clones are capped; a missing SDK is a sentence", async () => {
  const plugins = join(root, "data-review", "plugins");
  const src = folder({ id: "swap.fake" });
  writeFileSync(join(src, "version.txt"), "old");
  const calls: Array<string> = [];
  await installPlugin({ source: src }, context(plugins, { beforeSwap: async (id) => void calls.push(id) }));
  const dest = join(plugins, "swap.fake");
  assert.deepEqual(calls, ["swap.fake"]);

  // M1: beforeSwap runs after every check (not for a refused install), with the old copy still in place.
  writeFileSync(join(src, "version.txt"), "new");
  let seen = "";
  await installPlugin({ source: src }, context(plugins, { beforeSwap: async () => void (seen = readFileSync(join(dest, "version.txt"), "utf8")) }));
  assert.equal(seen, "old");
  assert.equal(readFileSync(join(dest, "version.txt"), "utf8"), "new");
  await refused(
    installPlugin(
      { source: folder({ id: "swap.fake", apiVersion: "uncut.module/9" }) },
      context(plugins, { beforeSwap: async () => void calls.push("refused") }),
    ),
    /newer/,
  );
  assert.ok(!calls.includes("refused"));
  // A failing beforeSwap (the approval couldn't be removed) aborts: nothing replaced, nothing left.
  writeFileSync(join(src, "version.txt"), "newer");
  await refused(
    installPlugin(
      { source: src },
      context(plugins, {
        beforeSwap: async () => {
          throw new Error("settings.json is read-only");
        },
      }),
    ),
    /wasn't installed: settings.json is read-only/,
    "io",
  );
  assert.equal(readFileSync(join(dest, "version.txt"), "utf8"), "new");
  assert.deepEqual(readdirSync(plugins), ["swap.fake"]);

  // L1: the new copy can't be renamed into place: the old one is put back.
  const real = swapHooks.rename;
  swapHooks.rename = async () => {
    throw new Error("disk full");
  };
  try {
    await refused(installPlugin({ source: src }, context(plugins)), /disk full/, "io");
  } finally {
    swapHooks.rename = real;
  }
  assert.equal(readFileSync(join(dest, "version.txt"), "utf8"), "new");
  assert.deepEqual(readdirSync(plugins), ["swap.fake"]);
  // Litter from an interrupted install or removal is swept; plugins aren't.
  for (const d of [".old-abc123", ".install-0f0f0f", ".remove-123abc"]) mkdirSync(join(plugins, d, "x"), { recursive: true });
  mkdirSync(join(plugins, ".keep"));
  assert.deepEqual([...(await sweepLeftovers(plugins))].sort(), [".install-0f0f0f", ".old-abc123", ".remove-123abc"]);
  assert.deepEqual(readdirSync(plugins).sort(), [".keep", "swap.fake"]);

  // M2: a clone over the cap is stopped with a sentence (here 64 KB; the real cap is 200 MB).
  const work = join(root, "big-repo");
  mkdirSync(work);
  git(work, "init", "-q");
  cpSync(FAKE, work, { recursive: true });
  writeFileSync(join(work, "blob.bin"), Buffer.from(Array.from({ length: 512 * 1024 }, (_, i) => (i * 7919) % 251)));
  git(work, "add", ".");
  git(work, "commit", "-q", "-m", "big");
  const gitBin = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  await refused(
    gitClone(gitBin, `file://${work}`, undefined, join(root, "clone-capped"), undefined, 64 * 1024),
    /bigger than 0 MB, so Uncut stopped cloning it/,
  );
  await refused(installPlugin({ source: `file://${work}` }, context(join(root, "data-big", "plugins"), { maxCloneBytes: 64 * 1024 })), /stopped cloning it/);
  assert.ok(!existsSync(join(root, "data-big", "plugins", "fake.capture")));

  // M3: a missing SDK folder is a sentence, not a crash loop.
  const host = new PluginHost(join(root, "no-sdk"));
  const spec = { id: "fake.capture", name: "Fake capture", dir: realpathSync(dest), command: "node", args: ["server.ts"], timeoutMs: 5000 };
  const result = await host.call(spec, "fake_echo", { text: "x" });
  assert.equal(result.isError, true);
  assert.match((result.content[0] as { text: string }).text, new RegExp(`Uncut's plugin SDK is missing at ${join(root, "no-sdk")}`));
  await host.stopAll();
});

test("on the server: a reinstall whose approval can't be removed is aborted; litter is swept at startup", async () => {
  const base = join(root, "server-review");
  const data = join(base, "data");
  mkdirSync(join(data, "plugins", ".old-deadbeef"), { recursive: true });
  const server = await startServer({ env: { UNCUT_DATA_DIR: data, UNCUT_BUNDLED_PLUGINS_DIR: join(base, "none") } });
  const client = await connect(server.ready.port, server.ready.token);
  try {
    assert.deepEqual(readdirSync(join(data, "plugins")), [], "swept at startup");
    const src = folder({ id: "ro.fake" });
    const row = (await client.ok("plugins.install", { source: src })).plugins.find((p: any) => p.id === "ro.fake");
    await client.ok("plugins.approve", { id: row.id, dir: row.dir, capabilities: row.capabilities });
    writeFileSync(join(src, "version.txt"), "new");
    // settings.json can't be written (its folder is read-only): the install stops before the swap.
    chmodSync(data, 0o555);
    try {
      const failed = await client.fail("plugins.install", { source: src });
      assert.equal(failed.reason, "io");
      assert.match(failed.message, /wasn't installed/);
    } finally {
      chmodSync(data, 0o755);
    }
    assert.ok(!existsSync(join(data, "plugins", "ro.fake", "version.txt")), "the old copy is still the one installed");
    const list = await client.ok("plugins.list");
    assert.equal(list.find((p: any) => p.id === "ro.fake").status, "ready", "and it keeps the approval it had");
  } finally {
    client.close();
    await server.stop();
  }
});
