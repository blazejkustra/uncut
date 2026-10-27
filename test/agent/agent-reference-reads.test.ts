// Overnight 2026-10-27 (handoff 6, 14): the reads the agent made in Auto, with the transcripts' paths.
// Another Uncut project read as a style reference (20 refusals and cards), the brand kits and the
// speech-model hunt in Application Support (6 refusals), and the command checker's `2>&1`.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decide,
  destructive,
  nonReads,
  referencePart,
  shellSegments,
  type Access,
  type PermissionContext,
} from "../../apps/server/src/agent/agentPermissions.ts";

const HOME = "/Users/me";
const PROJECT = `${HOME}/Movies/argent-100s.uncut`;
const REF = `${HOME}/Movies/argent-e2e.uncut`;
const DATA = `${HOME}/Library/Application Support/Uncut`;
const KITS = `${DATA}/brand/kits`;
const LIBS = "/Applications/Uncut.app/Contents/Resources/graphic-libs";
type Extra = Partial<Omit<PermissionContext, "access" | "grants">> & { grants?: Array<string> };
const ctx = (access: Access, extra: Extra = {}): PermissionContext => ({
  project: PROJECT,
  roots: [],
  home: HOME,
  realpath: (p) => p,
  sanctioned: [KITS, LIBS],
  dataDir: DATA,
  readdir: () => [],
  ...extra,
  access,
  grants: new Set(extra.grants ?? []),
});
const d = (tool: string, input: unknown, access: Access = "auto", extra?: Extra) => decide(tool, input, ctx(access, extra));
const kind = (tool: string, input: unknown, access: Access = "auto", extra?: Extra) => d(tool, input, access, extra).kind;
const bash = (command: string, access: Access = "auto", extra?: Extra) => d("Bash", { command }, access, extra);

test("another project's project.json, plan, graphics, brand and reviews are read without a card in Auto (100s t0 #75-#85, e2e t1 #24-#38); its folder and media are listed", () => {
  for (const command of [
    `cat ${REF}/project.json`,
    `cat /Users/me/Movies/argent-family.uncut/project.json | jq .tracks`,
    `grep -c "" ${REF}/project.json`,
    `grep -o '"kind":"[a-z]*"' ${REF}/project.json | head`,
    `wc -c ${REF}/project.json`,
    `cd ${REF} && cat project.json | head -c 1500`,
    `cp ${REF}/project.json .cache/work/ref-project.json`,
    `ls -la ${REF} ${REF}/media ${REF}/graphics`,
    `head -c 2000 ${REF}/graphics/e2e-panel-1.html; cat ${REF}/brief.json ${REF}/storyboard.json`,
    `cat ${REF}/reviews/review-3.json 2>/dev/null`,
    `cat "${REF}/brand/kits/argent/kit.json"`,
  ]) {
    const r = bash(command);
    assert.equal(r.kind, "allow", `${command}: ${r.kind === "deny" ? r.message : r.kind}`);
  }
  for (const [tool, input] of [
    ["Read", { file_path: `${REF}/project.json` }],
    ["Read", { file_path: `${REF}/project.json`, offset: 400, limit: 200 }],
    ["Read", { file_path: `${REF}/graphics/e2e-panel-1.html` }],
    ["Read", { file_path: `${REF}/brief.json` }],
    ["Read", { file_path: `${REF}/storyboard.json` }],
    ["Read", { file_path: `${REF}/reviews/review-1.json` }],
    ["Read", { file_path: `${REF}/brand/active.json` }],
    ["Glob", { pattern: "**/*", path: REF }],
    ["Glob", { pattern: "*", path: `${REF}/media` }],
    ["Grep", { pattern: "font-family", path: `${REF}/graphics` }],
  ] as const) {
    for (const access of ["auto", "ask", "look"] as const) assert.equal(kind(tool, input, access), "allow", `${access} ${tool} ${JSON.stringify(input)}`);
  }
});

test("another project: its history, agent chats, cache, hidden files and media contents stay gated; writes there still ask; links are judged where they point", () => {
  for (const command of [
    `cat ${REF}/history.db`,
    `head -c 100 ${REF}/agent/turns.json`,
    `cat ${REF}/project.json > /tmp/x`,
    `cat ${REF}/project.json | python3 -c "import sys"`,
  ]) {
    assert.equal(bash(command).kind, "deny", command);
  }
  for (const command of [`cat ${REF}/.cache/transcripts/a.json`, `cat ${REF}/media/clip.mov`, `cat ${REF}/../x.txt`])
    assert.notEqual(bash(command).kind, "allow", command);
  for (const file of ["history.db", "agent/turns.json", ".cache/transcripts/a.json", ".env", "graphics/.secret", "media/clip.mov", "notes.txt"]) {
    assert.equal(kind("Read", { file_path: `${REF}/${file}` }), "ask", file);
  }
  assert.equal(kind("Grep", { pattern: "x", path: REF }), "ask", "a grep over the whole folder would read history.db and .cache");
  assert.equal(kind("Write", { file_path: `${REF}/graphics/a.html`, content: "x" }), "ask");
  assert.equal(kind("Edit", { file_path: `${REF}/project.json`, old_string: "a", new_string: "b" }), "ask");
  assert.equal(bash(`mkdir -p ${REF}/graphics/x`).kind, "ask");
  // Not another project: inside ~/Library, the data folder or a hidden folder.
  assert.equal(referencePart(`${DATA}/templates/t.uncut/project.json`, PROJECT, HOME, DATA), undefined);
  assert.equal(referencePart(`${HOME}/Library/Mail/x.uncut/project.json`, PROJECT, HOME), undefined);
  assert.equal(referencePart(`${HOME}/.trash/x.uncut/project.json`, PROJECT, HOME), undefined);
  assert.equal(referencePart(`${PROJECT}/project.json`, PROJECT, HOME), undefined, "this project is the project zone");
  assert.equal(referencePart(`/Volumes/Work/Launch.uncut/graphics/a.html`, PROJECT, HOME), "read", "a drive outside home");
  // A link inside the other project to Uncut's data folder: judged by where it points (D300's hole stays closed).
  const realpath = (p: string) => p.replace(`${REF}/graphics`, DATA);
  assert.equal(kind("Read", { file_path: `${REF}/graphics/server-token` }, "auto", { realpath }), "ask");
  assert.notEqual(bash(`cd ${REF}/graphics && cat keys.json`, "auto", { realpath }).kind, "allow");
  assert.notEqual(bash(`cat ${REF}/graphics/settings.json`, "auto", { realpath }).kind, "allow");
  // Ask first asks for commands (Always can remember it); after the web the files ask too.
  const ask = bash(`cat ${REF}/project.json`, "ask");
  assert.ok(ask.kind === "ask" && ask.grant);
  assert.equal(kind("Read", { file_path: `${REF}/project.json` }, "ask", { webUsed: true }), "ask");
});

test("the refusal says what runs: a cut after jq is named, and the rule lists another project's files", () => {
  const r = bash(`jq '.tracks' ${REF}/project.json | cut -c1-1500`);
  assert.ok(r.kind === "deny", r.kind);
  assert.match(r.message, /another Uncut project \(its project\.json/);
  assert.match(r.message, /`cut -c1-1500` isn't one/);
  const own = bash(`python3 -c "import json; d=json.load(open('project.json')); print(len(d['tracks']))"`);
  assert.ok(own.kind === "deny" && /cp <path>\/project\.json \.cache\/work\//.test(own.message), own.kind === "deny" ? own.message : own.kind);
});

test("the brand kits are read in Auto whether or not one is active (fam t0 #70, t15 #2); keys, token and settings stay refused", () => {
  for (const command of [
    `head -c 400 "${KITS}/argent/nav-logo.DO29ZCYd.svg"`,
    `ls -la "${KITS}/argent/" 2>&1`,
    `ls ~/Library/Application\\ Support/Uncut/brand/kits/argent 2>&1 | head -30`.replace("~", HOME),
  ]) {
    const r = bash(command);
    assert.equal(r.kind, "allow", `${command}: ${r.kind === "deny" ? r.message : r.kind}`);
  }
  for (const command of [
    `cat "${DATA}/keys.json"`,
    `cat "${DATA}/server-token"`,
    `cat "${DATA}/settings.json"`,
    `cat "${KITS}/../../keys.json"`,
    `ls -la "${DATA}"`,
  ]) {
    assert.equal(bash(command).kind, "deny", command);
  }
  assert.equal(kind("Read", { file_path: `${DATA}/keys.json` }), "ask");
  // The piece that isn't a read is named; `2>&1` is no longer split into `2>` and `1`.
  const mixed = bash(`ls -la "${KITS}/argent/" 2>&1; ls /Users/me/Documents/devrel/argent/argent-marketing/public 2>/dev/null | head -30`);
  assert.ok(mixed.kind === "deny", mixed.kind);
  assert.match(mixed.message, /`ls \/Users\/me\/Documents\/devrel\/argent\/argent-marketing\/public \| head -30` isn't one/);
  assert.doesNotMatch(mixed.message, /`2>`|`1`/);
});

test("hunting for whisper or its model in Application Support gets one clear answer pointing at the transcript tools (100s t0 #18, e2e t1 #7 #10, fam t0 #29)", () => {
  for (const command of [
    "which ffmpeg ffprobe whisper-cli whisper-cpp main 2>&1; ls ~/Library/Application\\ Support/ 2>/dev/null | grep -i uncut",
    'which ffmpeg whisper-cli whisper main 2>&1; ls ~/Library/Application\\ Support/Uncut/ 2>/dev/null; find ~/Library/Application\\ Support/Uncut -iname "*ggml*" 2>/dev/null',
    'find ~ /opt/homebrew -name "ggml-*.bin" -not -path "*/Library/Application Support/*" | head',
    'ls ~/Library/Application\\ Support/Uncut/ 2>/dev/null; find ~/Library/Application\\ Support/Uncut -name "*.bin" | head',
  ]) {
    const r = bash(command);
    assert.ok(
      r.kind === "deny" && /transcript_read/.test(r.message) && !/except plain reads/.test(r.message),
      `${command}: ${r.kind === "deny" ? r.message : r.kind}`,
    );
  }
  for (const input of [{ file_path: `${DATA}/models/ggml-base.en.bin` }, { pattern: "*.bin", path: `${DATA}/models` }]) {
    const r = d(input.pattern ? "Glob" : "Read", input);
    assert.ok(r.kind === "deny" && /transcript_read/.test(r.message), JSON.stringify(input));
  }
});

test("2>&1 stays with its command: the checker splits on & only between commands", () => {
  assert.deepEqual(shellSegments(`ls -la "${KITS}/argent/" 2>&1`), [`ls -la "${KITS}/argent/" 2>&1`]);
  assert.deepEqual(shellSegments("which whisper-cli 2>&1; ls"), ["which whisper-cli 2>&1", "ls"]);
  assert.deepEqual(shellSegments("make &>/dev/null && ls"), ["make &>/dev/null", "ls"]);
  assert.deepEqual(shellSegments("cat <&3 & ls"), ["cat <&3", "ls"]);
  assert.deepEqual(shellSegments("a && b & c"), ["a", "b", "c"]);
  const zones = { project: PROJECT };
  const real = (p: string, base: string) => (p.startsWith("/") ? p : `${base}/${p}`);
  assert.deepEqual(nonReads("cat project.json 2>&1 | head -n 5", real, zones), []);
  assert.deepEqual(nonReads("cat project.json 2>&1 > out.txt", real, zones), ["cat project.json 2>&1 > out.txt"], "a real redirect still is no read");
  assert.deepEqual(nonReads("cat project.json 2>&1x", real, zones), ["cat project.json 2>&1x"]);
  // Review of C3+C4: with &> no longer splitting the line, the redirect check still sees it (and an fd redirect).
  assert.match(destructive("cat a &>/Users/x/.zshrc", PROJECT, [], HOME) ?? "", /writes \/Users\/x\/\.zshrc outside the project/);
  assert.match(destructive("cat a 2>/Users/x/.zshrc", PROJECT, [], HOME) ?? "", /writes \/Users\/x\/\.zshrc outside the project/);
  assert.equal(destructive("cat a 2>&1 >&2", PROJECT, [], HOME), undefined);
});

test("review of C3+C4: a pasted folder that holds Claude Code's folder (~/.claude linked into ~/dotfiles) or Uncut's data folder doesn't open them to Bash reads", () => {
  const dots = `${HOME}/dotfiles`;
  const realpath = (p: string) => p.replace(`${HOME}/.claude`, `${dots}/claude`).replace(DATA, `${dots}/uncut-data`);
  const extra = { candidates: [dots], realpath };
  for (const command of [
    `cat ${HOME}/.claude/settings.json`,
    `cat ${HOME}/.claude/projects/-other/a.jsonl`,
    `cat ${dots}/claude/settings.json`,
    `cd ${dots}/claude && cat settings.json`,
  ]) {
    assert.notEqual(bash(command, "auto", extra).kind, "allow", command);
  }
  assert.equal(kind("Read", { file_path: `${HOME}/.claude/settings.json` }, "auto", extra), "deny", "Read was already refused");
  for (const command of [`cat ${dots}/uncut-data/keys.json`, `cat "${DATA}/keys.json"`]) assert.notEqual(bash(command, "auto", extra).kind, "allow", command);
  assert.notEqual(kind("Read", { file_path: `${dots}/uncut-data/keys.json` }, "auto", extra), "allow");
  assert.equal(bash(`cat ${dots}/zshrc`, "auto", extra).kind, "allow", "the rest of the pasted folder still reads");
});

test("a pasted folder is read in Auto by Read, Glob and Bash alike; Look only still asks and writing there asks", () => {
  // e2e t1 #106/#107: a Read card for the pasted folder timed out, then `cd … && cat` read it with no card. Same rule both ways in Auto.
  const pasted = "/Users/me/Documents/devrel/argent/argent-marketing/src/content/blog/argent-e2e-tutorial";
  assert.equal(kind("Read", { file_path: `${pasted}/cover-merge-v7.png` }, "auto", { candidates: [pasted] }), "allow");
  assert.equal(kind("Glob", { pattern: "*.png", path: pasted }, "auto", { candidates: [pasted] }), "allow");
  assert.equal(kind("Bash", { command: `cd ${pasted} && ls -la` }, "auto", { candidates: [pasted] }), "allow");
  assert.equal(kind("Read", { file_path: `${pasted}/cover-merge-v7.png` }, "look", { candidates: [pasted] }), "ask", "Look only: still a card");
  assert.equal(kind("Write", { file_path: `${pasted}/notes.txt`, content: "x" }, "auto", { candidates: [pasted] }), "ask", "writing there still asks");
});
