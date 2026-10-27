// The user's own Claude Code skills in the agent's session (user, 2026-10-27): found in the
// project's .claude/skills (nearest first), ~/.claude/skills (or CLAUDE_CONFIG_DIR), the claude.ai
// account's synced folder and the enabled plugins; loaded as skills-only plugins (--plugin-dir) while
// --setting-sources "" keeps the rest of the user's setup out; /id in a message calls one; the
// composer's / menu lists them; the agent reads a loaded skill's files without a card.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  calledClaudeSkills,
  claudeSkillCallBlock,
  claudeSkillName,
  claudeSkillsPrompt,
  findClaudeSkills,
  parsePluginList,
  skillDescription,
  skillReadDirs,
  writeSkillPlugins,
  type ClaudeSkill,
} from "../../apps/server/src/agent/claudeSkills.ts";
import { sessionArgs } from "../../apps/server/src/agent/session/config.ts";
import { decide, sessionSettings } from "../../apps/server/src/agent/agentPermissions.ts";
import { slashItems } from "../../apps/web/src/panels/composer/slash.ts";

const skillFile = (dir: string, name: string, description: string) => {
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(join(dir, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\nDo the thing.\n`);
};

function machine() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-claude-skills-")));
  const home = join(root, "home");
  const project = join(home, "Movies", "film.uncut");
  mkdirSync(project, { recursive: true });
  skillFile(join(home, ".claude", "skills"), "tone", "Write in my tone.");
  skillFile(join(home, ".claude", "skills"), "shared", "The user's shared.");
  mkdirSync(join(home, ".claude", "skills", "synced"), { recursive: true });
  mkdirSync(join(home, ".claude", "skills", ".trash", "old"), { recursive: true });
  skillFile(join(project, ".claude", "skills"), "shared", "The project's shared.");
  skillFile(join(home, "Movies", ".claude", "skills"), "movies", "From the parent folder.");
  writeFileSync(join(home, ".claude.json"), JSON.stringify({ oauthAccount: { organizationUuid: "org-1", accountUuid: "acc-2" } }));
  skillFile(join(home, ".claude", "skills", "synced", "org-1_acc-2"), "docx", "Word files.");
  skillFile(join(home, ".claude", "skills", "synced", "other_account"), "stale", "Another account's.");
  const plugin = join(root, "plugins", "engineering");
  skillFile(join(plugin, "skills"), "debug", "Debug things.");
  return { root, home, project, plugin, done: () => rmSync(root, { recursive: true, force: true }) };
}

test("findClaudeSkills: project (nearest first), user, the account's synced skills and enabled plugins", () => {
  const m = machine();
  try {
    const skills = findClaudeSkills({ projectDir: m.project, plugins: [{ name: "engineering", installPath: m.plugin }], home: m.home, env: {} });
    assert.deepEqual(
      skills.map((s) => [s.id, claudeSkillName(s)]),
      [
        ["shared", "project:shared"],
        ["movies", "project:movies"],
        ["user:shared", "user:shared"],
        ["tone", "user:tone"],
        ["anthropic-skills:docx", "anthropic-skills:docx"],
        ["engineering:debug", "engineering:debug"],
      ],
    );
    assert.equal(skills[0]!.description, "The project's shared.");
    assert.ok(!skills.some((s) => s.name === "stale" || s.name === "synced" || s.name === "old"));
  } finally {
    m.done();
  }
});

test("findClaudeSkills: CLAUDE_CONFIG_DIR is where the user's skills and account file are", () => {
  const m = machine();
  try {
    const config = join(m.root, "cc");
    skillFile(join(config, "skills"), "moved", "In the moved folder.");
    const skills = findClaudeSkills({ plugins: [], home: m.home, env: { CLAUDE_CONFIG_DIR: config } });
    assert.deepEqual(
      skills.map((s) => s.id),
      ["moved"],
    );
  } finally {
    m.done();
  }
});

test("skillDescription: one line, quoted, or a folded block; long ones are cut", () => {
  assert.equal(skillDescription("---\nname: a\ndescription: Plain words.\n---\nbody"), "Plain words.");
  assert.equal(skillDescription('---\ndescription: "Quoted: yes"\n---\n'), "Quoted: yes");
  assert.equal(skillDescription("---\ndescription: >\n  Folded over\n  two lines.\nname: x\n---\n"), "Folded over two lines.");
  assert.equal(skillDescription("no front matter"), "");
  assert.equal(skillDescription(`---\ndescription: ${"x".repeat(400)}\n---\n`).length, 300);
});

test("writeSkillPlugins: one skills-only plugin per source, linking each skill folder", () => {
  const m = machine();
  try {
    const skills = findClaudeSkills({ projectDir: m.project, plugins: [{ name: "engineering", installPath: m.plugin }], home: m.home, env: {} });
    const out = join(m.root, "session", "claude-skills");
    mkdirSync(join(out, "leftover"), { recursive: true });
    const dirs = writeSkillPlugins(out, skills);
    assert.deepEqual(
      dirs.map((d) => d.slice(out.length + 1)),
      ["project", "user", "anthropic-skills", "engineering"],
    );
    assert.ok(!existsSync(join(out, "leftover")));
    assert.deepEqual(JSON.parse(readFileSync(join(out, "user", ".claude-plugin", "plugin.json"), "utf8")).name, "user");
    assert.equal(readlinkSync(join(out, "user", "skills", "tone")), join(m.home, ".claude", "skills", "tone"));
    assert.equal(readlinkSync(join(out, "engineering", "skills", "debug")), join(m.plugin, "skills", "debug"));
    assert.ok(!existsSync(join(out, "engineering", "hooks")));
    assert.deepEqual(skillReadDirs(skills.slice(0, 1)), [join(m.project, ".claude", "skills", "shared")]);
  } finally {
    m.done();
  }
});

test("parsePluginList: only enabled plugins with a folder, by name", () => {
  const m = machine();
  try {
    const list = JSON.stringify([
      { id: "engineering@synced", enabled: true, installPath: m.plugin },
      { id: "off@market", enabled: false, installPath: m.plugin },
      { id: "gone@market", enabled: true, installPath: join(m.root, "nope") },
    ]);
    assert.deepEqual(parsePluginList(list), [{ name: "engineering", installPath: m.plugin }]);
    assert.deepEqual(parsePluginList("not json"), []);
  } finally {
    m.done();
  }
});

const skill = (id: string, plugin: string, name: string): ClaudeSkill => ({ id, plugin, name, description: "", dir: `/x/${name}` });

test("calledClaudeSkills: /id after a space or at the start, never a path; Uncut's own skill ids win", () => {
  const all = [skill("tone", "user", "tone"), skill("engineering:debug", "engineering", "debug"), skill("launch-promo", "user", "launch-promo")];
  assert.deepEqual(
    calledClaudeSkills("/tone then /engineering:debug.", all).map((s) => s.id),
    ["tone", "engineering:debug"],
  );
  assert.deepEqual(calledClaudeSkills("see /tmp/tone and a/tone", all), []);
  assert.deepEqual(calledClaudeSkills("/launch-promo please", all, ["launch-promo"]), []);
  const block = claudeSkillCallBlock([all[1]!]);
  assert.match(block, /Skill tool \(skill "engineering:debug"\)/);
  assert.equal(claudeSkillsPrompt([]), "");
  assert.match(claudeSkillsPrompt(all), /Skill tool/);
});

test('sessionArgs: the user\'s settings stay out (--setting-sources ""), the skills come in as --plugin-dir', () => {
  const args = sessionArgs({
    cfg: "/tmp/mcp.json",
    pluginDirs: ["/tmp/s/claude-skills/user", "/tmp/s/claude-skills/engineering"],
    claudeSkills: [skill("tone", "user", "tone")],
  });
  assert.equal(args[args.indexOf("--setting-sources") + 1], "");
  assert.ok(args.includes("--strict-mcp-config"));
  assert.deepEqual(
    args.flatMap((a, i) => (a === "--plugin-dir" ? [args[i + 1]] : [])),
    ["/tmp/s/claude-skills/user", "/tmp/s/claude-skills/engineering"],
  );
  assert.match(args[args.indexOf("--append-system-prompt") + 1]!, /Claude Code skills/);
  assert.ok(!sessionArgs({ cfg: "/tmp/mcp.json" }).includes("--plugin-dir"));
  assert.equal(JSON.parse(sessionSettings({ access: "ask" })).disableSkillShellExecution, true);
});

test("decide: a loaded skill's files in ~/.claude are read without a card; the rest of ~/.claude still isn't", () => {
  const home = "/Users/me";
  const skillDir = `${home}/.claude/skills/tone`;
  const ctx = {
    access: "ask" as const,
    project: `${home}/Movies/film.uncut`,
    roots: [],
    home,
    realpath: (p: string) => p,
    grants: new Set<string>(),
    sanctioned: [skillDir],
  };
  assert.equal(decide("Read", { file_path: `${skillDir}/reference.md` }, ctx).kind, "allow");
  assert.equal(decide("Read", { file_path: `${home}/.claude/settings.json` }, ctx).kind, "deny");
  assert.equal(decide("Read", { file_path: `${home}/.claude/skills/other/SKILL.md` }, ctx).kind, "deny");
  assert.equal(decide("Write", { file_path: `${skillDir}/reference.md` }, ctx).kind, "deny");
  assert.equal(decide("Read", { file_path: `${skillDir}/reference.md` }, { ...ctx, webUsed: true }).kind, "deny");
});

test("slashItems: the user's Claude Code skills come last, in their own group; an Uncut skill id wins", () => {
  const items = slashItems(
    "",
    [{ id: "tone", name: "Tone", description: "" }],
    [],
    [
      { id: "tone", name: "tone", description: "" },
      { id: "engineering:debug", name: "debug", description: "Debug" },
    ],
  );
  assert.deepEqual(
    items.map((x) => `${x.kind}:${x.id}`),
    ["skill:tone", "claude:engineering:debug"],
  );
  assert.deepEqual(
    slashItems("engineering:d", [], [], [{ id: "engineering:debug", name: "debug", description: "" }]).map((x) => x.id),
    ["engineering:debug"],
  );
});
