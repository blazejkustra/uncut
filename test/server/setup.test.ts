// Phase 3 chunk 4: setup.check finds the tools Uncut needs, for real and time-boxed, and the
// server takes its PATH from the login shell so a Finder-launched app finds them too.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { BUNDLE, MEDIA, connect, killAll, startServer } from "../helpers/server.ts";
import { fallbackPathDirs, mergePath, parseShellOutput } from "../../apps/server/src/app/shellEnv.ts";

const skip = existsSync(BUNDLE) && existsSync(MEDIA) ? false : "server bundle or media core not built (run pnpm build)";
const T = { skip, timeout: 30000 };
const SECRET = "sk-ant-api03-SECRETVALUE123";

let root: string;
const script = (dir: string, name: string, body: string) => {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
};
/** A folder of stub tools. Each value is the body of a shell script. */
const stubs = (name: string, tools: Record<string, string>) => {
  const dir = join(root, name);
  for (const [tool, body] of Object.entries(tools)) script(dir, tool, body);
  return dir;
};
const CLAUDE_READY = `case "$1" in --version) echo "2.1.296 (Claude Code)";; auth) echo '{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"max","email":"private@example.com","orgId":"org-secret-id"}';; esac`;
const FFMPEG = { ffmpeg: `echo "ffmpeg version 8.1.1 Copyright (c) 2000-2026"`, ffprobe: `echo "ffprobe version 8.1.1"` };

async function check(env: NodeJS.ProcessEnv) {
  // The test runner may itself have a key in its environment; checks start without one.
  const server = await startServer({ env: { UNCUT_DATA_DIR: join(root, "data"), ANTHROPIC_API_KEY: "", ...env } });
  const client = await connect(server.ready.port, server.ready.token);
  try {
    const started = Date.now();
    const checks = await client.ok("setup.check");
    return { checks, ms: Date.now() - started, byId: Object.fromEntries(checks.map((c: any) => [c.id, c])), raw: JSON.stringify(checks), client };
  } finally {
    client.close();
    await server.stop();
  }
}

before(() => {
  root = mkdtempSync(join(tmpdir(), "uncut-setup-"));
});
after(() => {
  killAll();
  if (root) rmSync(root, { recursive: true, force: true });
});

test("everything installed: ready, with versions and paths, and no account details", T, async () => {
  const dir = stubs("all", { claude: CLAUDE_READY, argent: `echo 0.28.0`, ...FFMPEG, "whisper-cli": `echo "whisper.cpp version: 1.9.5"` });
  const { byId, raw } = await check({ PATH: `${dir}:/usr/bin:/bin` });
  assert.deepEqual(byId.claude, {
    id: "claude",
    name: "Claude Code",
    status: "ready",
    optional: false,
    version: "2.1.296",
    path: join(dir, "claude"),
    detail: "Signed in with a Claude account, Max plan",
  });
  assert.equal(byId.argent.status, "ready");
  assert.equal(byId.argent.version, "0.28.0");
  assert.deepEqual([byId.ffmpeg.status, byId.ffmpeg.version], ["ready", "8.1.1"]);
  assert.deepEqual(byId.whisper, {
    id: "whisper",
    name: "whisper.cpp",
    status: "ready",
    optional: true,
    version: "1.9.5",
    path: join(dir, "whisper-cli"),
    detail: "Transcribes speech on this Mac.",
  });
  assert.equal(byId.codex.status, "missing");
  assert.equal(byId.codex.fix.command, "npm install -g @openai/codex");
  assert.equal(byId["api-key"], undefined, "no API key, no warning");
  assert.ok(!raw.includes("private@example.com") && !raw.includes("org-secret-id"));
});

test("signed out, too old to tell, and missing tools each get their own status and fix", T, async () => {
  const out = stubs("logged-out", {
    claude: `case "$1" in --version) echo "2.1.0 (Claude Code)";; auth) echo '{"loggedIn":false,"authMethod":"none"}'; exit 1;; esac`,
  });
  let r = await check({ PATH: `${out}:/usr/bin:/bin` });
  assert.equal(r.byId.claude.status, "needs-login");
  assert.equal(r.byId.claude.fix.command, "claude auth login");
  assert.equal(r.byId.argent.status, "missing");
  assert.equal(r.byId.argent.fix.command, "npx @swmansion/argent@latest init -y");
  assert.equal(r.byId.ffmpeg.status, "missing");
  assert.equal(r.byId.ffmpeg.fix.command, "brew install ffmpeg");
  assert.match(r.byId.ffmpeg.detail, /ffmpeg and ffprobe not found/);
  assert.deepEqual([r.byId.whisper.status, r.byId.whisper.optional, r.byId.whisper.fix.command], ["missing", true, "brew install whisper-cpp"]);

  const old = stubs("old", {
    claude: `case "$1" in --version) echo "1.0.0 (Claude Code)";; *) echo "error: unknown command 'auth'" >&2; exit 1;; esac`,
    ffmpeg: FFMPEG.ffmpeg,
  });
  r = await check({ PATH: `${old}:/usr/bin:/bin` });
  assert.equal(r.byId.claude.status, "warning");
  assert.match(r.byId.claude.detail, /can't report whether it's signed in/);
  assert.match(r.byId.ffmpeg.detail, /^ffprobe not found/);

  r = await check({ PATH: "/usr/bin:/bin" });
  assert.equal(r.byId.claude.status, "missing");
  assert.ok(r.byId.claude.fix.command);
});

test("a tool that hangs is an error within seconds, and the server keeps answering", T, async () => {
  const dir = stubs("hang", { claude: `sleep 30`, ...FFMPEG });
  const r = await check({ PATH: `${dir}:/usr/bin:/bin` });
  assert.equal(r.byId.claude.status, "error");
  assert.match(r.byId.claude.detail, /didn't answer within 6 s/);
  assert.ok(r.ms < 9000, `took ${r.ms} ms`);
  assert.equal(r.byId.ffmpeg.status, "ready");
});

test("D277: an API key goes to claude (any sign-in Claude Code supports), to no other tool, and never into a reply", T, async () => {
  // Each stub shows in its version whether it can see the key.
  const dir = stubs("key", {
    claude: `case "$1" in --version) echo "2.1.296\${ANTHROPIC_API_KEY:+-keyseen} (Claude Code)";; auth) echo '{"loggedIn":true,"authMethod":"api_key"}';; esac`,
    argent: `echo "0.28.0\${ANTHROPIC_API_KEY:+-leak}"`,
    ...FFMPEG,
  });
  const r = await check({ PATH: `${dir}:/usr/bin:/bin`, ANTHROPIC_API_KEY: SECRET });
  assert.equal(r.byId.claude.version, "2.1.296-keyseen", "claude gets the key");
  assert.equal(r.byId.claude.status, "ready");
  // D277 review: a key in the environment wins over a Claude login, so the row says where it came from.
  assert.equal(
    r.byId.claude.detail,
    "Signed in with an API key. Using ANTHROPIC_API_KEY from your shell environment; agent usage is billed to that API account. Unset it to use your Claude login.",
  );
  assert.equal(r.byId.argent.version, "0.28.0", "argent doesn't");
  assert.equal(r.byId["api-key"], undefined, "no separate key row");
  for (const part of [SECRET, "SECRETVALUE", "sk-ant"]) assert.ok(!r.raw.includes(part), `response contains ${part}`);
});

const raw = (dir: string, name: string, content: string) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), content);
  chmodSync(join(dir, name), 0o755);
};

test("a tool that can't run (zero bytes, no #!) is that row's error; the rest still check", T, async () => {
  for (const [name, content] of [
    ["empty", ""],
    ["no-shebang", "echo 2.1.0\n"],
  ]) {
    const dir = join(root, `bad-${name}`);
    raw(dir, "claude", content);
    raw(dir, "argent", "#!/bin/sh\necho 0.28.0\n");
    const r = await check({ PATH: `${dir}:/usr/bin:/bin` });
    assert.equal(r.byId.claude.status, "error", name);
    assert.equal(r.byId.claude.detail, `Couldn't run ${join(dir, "claude")}: it isn't a valid program.`, name);
    assert.equal(r.byId.argent.status, "ready", name);
    assert.equal(r.byId.codex.status, "missing", name);
  }
});

test("a tool that floods its output is cut off and reported, without hurting the server", T, async () => {
  const dir = stubs("flood", { claude: "exec yes", argent: "echo 0.28.0" });
  const r = await check({ PATH: `${dir}:/usr/bin:/bin` });
  assert.equal(r.byId.claude.status, "error");
  assert.match(r.byId.claude.detail, /printed far more than a version number/);
  assert.ok(r.ms < 4000, `took ${r.ms} ms`);
  assert.equal(r.byId.argent.status, "ready");
});

test("a tool that exits but leaves a child holding its output is not mistaken for a hang", T, async () => {
  const dir = stubs("lingering", { argent: "sleep 30 &\necho 0.28.0" });
  const r = await check({ PATH: `${dir}:/usr/bin:/bin` });
  assert.equal(r.byId.argent.status, "ready");
  assert.equal(r.byId.argent.version, "0.28.0");
  assert.ok(r.ms < 3000, `took ${r.ms} ms`);
});

test("versions are a version number or nothing, never raw tool output", T, async () => {
  const dir = stubs("versions", { argent: `echo "<b>argent</b> build v0.28.0-beta.1 (abc)"`, codex: `echo "hello there, no digits"` });
  const r = await check({ PATH: `${dir}:/usr/bin:/bin` });
  assert.equal(r.byId.argent.version, "0.28.0-beta.1");
  assert.equal(r.byId.codex.version, undefined);
  assert.ok(!r.raw.includes("<b>") && !r.raw.includes("hello there"));
});

test("D277: every sign-in Claude Code supports is Ready; API keys and cloud providers say who's billed", T, async () => {
  {
    const dir = stubs("auth-oauth_token", {
      claude: `case "$1" in --version) echo "2.1.296 (Claude Code)";; auth) echo '{"loggedIn":true,"authMethod":"oauth_token"}';; esac`,
    });
    const { byId } = await check({ PATH: `${dir}:/usr/bin:/bin` });
    assert.equal(byId.claude.status, "ready", byId.claude.detail);
    assert.match(byId.claude.detail, /Claude account.*setup-token/);
    assert.equal(byId.claude.fix, undefined);
  }
  const cases = { api_key: /API key.*billed/, third_party: /Using bedrock.*billed/, something_new: /Signed in \(something_new\)/ };
  for (const [method, pattern] of Object.entries(cases)) {
    const dir = stubs(`auth-${method}`, {
      claude: `case "$1" in --version) echo "2.1.296 (Claude Code)";; auth) echo '{"loggedIn":true,"authMethod":"${method}","apiProvider":"bedrock"}';; esac`,
    });
    const { byId } = await check({ PATH: `${dir}:/usr/bin:/bin` });
    assert.equal(byId.claude.status, "ready", method);
    assert.match(byId.claude.detail, pattern, method);
    assert.doesNotMatch(byId.claude.detail, /subscription/, method);
    assert.equal(byId.claude.fix, undefined, method);
  }
});

// ---- PATH from the login shell ----

test("parsing the shell's output: markers, junk around them, and nonsense PATHs", () => {
  assert.deepEqual(parseShellOutput("motd\n__UNCUT_PATH_START__/a:/b\n__UNCUT_PATH_END__\n"), { path: "/a:/b", auth: {} });
  assert.deepEqual(parseShellOutput("__UNCUT_PATH_START__relative:junk__UNCUT_PATH_END__"), { path: undefined, auth: {} });
  assert.deepEqual(parseShellOutput("garbage"), { path: undefined, auth: {} });
  // D277: only Claude Code's sign-in variables are kept from the shell's environment (values may hold "=" and newlines).
  const env = ["HOME=/h", "ANTHROPIC_API_KEY=k=1", "OPENAI_API_KEY=o", "CLAUDE_CODE_USE_BEDROCK=1", "AWS_PROFILE=dev\nx", "GH_TOKEN=g", "EMPTY_THING="].join(
    "\0",
  );
  assert.deepEqual(parseShellOutput(`__UNCUT_PATH_START__/a__UNCUT_PATH_END__\n__UNCUT_AUTH_START__${env}\0__UNCUT_AUTH_END__\n`).auth, {
    ANTHROPIC_API_KEY: "k=1",
    CLAUDE_CODE_USE_BEDROCK: "1",
    AWS_PROFILE: "dev\nx",
  });
  assert.equal(mergePath("/a:/b", "/b:/c", "rel:/d"), "/a:/b:/c:/d");
  assert.ok(fallbackPathDirs("/Users/x").includes("/opt/homebrew/bin") && fallbackPathDirs("/Users/x").includes("/Users/x/.local/bin"));
});

// What launchd gives a Finder-launched app: no shell PATH.
const launchdEnv = (extra: NodeJS.ProcessEnv) => ({
  HOME: homedir(),
  USER: process.env.USER,
  LOGNAME: process.env.USER,
  TMPDIR: process.env.TMPDIR,
  PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
  UNCUT_SHELL_ENV: "",
  ...extra,
});
const HAS_CLAUDE = existsSync(join(homedir(), ".local/bin/claude"));
const HAS_FFMPEG = existsSync("/opt/homebrew/bin/ffmpeg");

// startServer merges process.env; these runs need a clean slate, so spawn through `env -i`.
async function checkClean(env: NodeJS.ProcessEnv) {
  const vars = Object.entries(env)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${v}`);
  const server = await startServer({ command: "/usr/bin/env", args: ["-i", ...vars, process.execPath, BUNDLE] });
  const client = await connect(server.ready.port, server.ready.token);
  try {
    const checks = await client.ok("setup.check");
    return { byId: Object.fromEntries(checks.map((c: any) => [c.id, c])), raw: JSON.stringify(checks) };
  } finally {
    client.close();
    await server.stop();
  }
}
const baseEnv = () => ({ UNCUT_MEDIA_BIN: MEDIA, UNCUT_MODULES_DIR: join(process.cwd(), "spec/modules/builtin"), UNCUT_DATA_DIR: join(root, "data") });

test(
  "under launchd's bare environment the login shell's PATH still finds claude and ffmpeg",
  { ...T, skip: skip || (!HAS_CLAUDE || !HAS_FFMPEG ? "needs claude in ~/.local/bin and Homebrew ffmpeg" : false) },
  async () => {
    const { byId } = await checkClean({ ...launchdEnv({ SHELL: process.env.SHELL || "/bin/zsh" }), ...baseEnv() });
    assert.equal(byId.claude.path, join(homedir(), ".local/bin/claude"));
    assert.ok(["ready", "needs-login", "warning"].includes(byId.claude.status), byId.claude.status);
    assert.equal(byId.ffmpeg.status, "ready");
    assert.equal(byId.ffmpeg.path, "/opt/homebrew/bin/ffmpeg");
  },
);

test(
  "a login shell that hangs or prints garbage falls back to the usual install folders, quickly",
  { ...T, skip: skip || (!HAS_FFMPEG ? "needs Homebrew ffmpeg" : false) },
  async () => {
    for (const [name, body] of [
      ["hang", "sleep 30"],
      ["garbage", "echo 'welcome!'; echo '__UNCUT_PATH_START__not a path__UNCUT_PATH_END__'"],
    ]) {
      const shell = script(join(root, "shells"), name, body);
      const started = Date.now();
      const { byId } = await checkClean({ ...launchdEnv({ SHELL: shell }), ...baseEnv() });
      assert.ok(Date.now() - started < 9000, `${name}: took ${Date.now() - started} ms`);
      assert.equal(byId.ffmpeg.path, "/opt/homebrew/bin/ffmpeg", name);
      if (HAS_CLAUDE) assert.equal(byId.claude.path, join(homedir(), ".local/bin/claude"), name);
    }
  },
);

test(
  "a login shell that can't start or floods its output can't take the server down",
  { ...T, skip: skip || (!HAS_FFMPEG ? "needs Homebrew ffmpeg" : false) },
  async () => {
    const shells = join(root, "shells");
    raw(shells, "zero-byte", "");
    script(shells, "flood", "exec yes");
    for (const name of ["zero-byte", "flood"]) {
      const { byId } = await checkClean({ ...launchdEnv({ SHELL: join(shells, name) }), ...baseEnv() });
      assert.equal(byId.ffmpeg.path, "/opt/homebrew/bin/ffmpeg", name);
    }
  },
);

test("D277: a key exported by the login shell reaches claude, and its value never appears", T, async () => {
  const shell = script(join(root, "shells"), "keyed", `export ANTHROPIC_API_KEY=${SECRET}\nexec /bin/sh -c "$2"`);
  const claude = script(
    join(root, "shell-claude"),
    "claude",
    `case "$1" in --version) echo "2.1.296\${ANTHROPIC_API_KEY:+-keyseen} (Claude Code)";; auth) echo '{"loggedIn":true,"authMethod":"api_key"}';; esac`,
  );
  const { byId, raw } = await checkClean({ ...launchdEnv({ SHELL: shell }), ...baseEnv(), UNCUT_CLAUDE: claude });
  assert.equal(byId.claude.version, "2.1.296-keyseen");
  assert.equal(byId.claude.status, "ready");
  assert.match(byId.claude.detail, /Using ANTHROPIC_API_KEY from your shell environment/);
  assert.equal(byId["api-key"], undefined);
  assert.ok(!raw.includes(SECRET) && !raw.includes("sk-ant"));
});

test("D277 review: day-job AWS keys in the login shell don't reach a claude that isn't set to use Bedrock", T, async () => {
  const shell = script(join(root, "shells"), "aws", `export AWS_SECRET_ACCESS_KEY=${SECRET}\nexport AWS_PROFILE=work\nexec /bin/sh -c "$2"`);
  const claude = script(
    join(root, "aws-claude"),
    "claude",
    `case "$1" in --version) echo "2.1.296\${AWS_PROFILE:+-awsseen} (Claude Code)";; auth) echo '{"loggedIn":true,"authMethod":"claude.ai"}';; esac`,
  );
  const { byId } = await checkClean({ ...launchdEnv({ SHELL: shell }), ...baseEnv(), UNCUT_CLAUDE: claude });
  assert.equal(byId.claude.version, "2.1.296", "no AWS variable reached claude");
  const bedrock = script(join(root, "shells"), "aws-bedrock", `export AWS_PROFILE=work\nexport CLAUDE_CODE_USE_BEDROCK=1\nexec /bin/sh -c "$2"`);
  const on = await checkClean({ ...launchdEnv({ SHELL: bedrock }), ...baseEnv(), UNCUT_CLAUDE: claude });
  assert.equal(on.byId.claude.version, "2.1.296-awsseen", "with Bedrock on, the AWS profile goes");
});
