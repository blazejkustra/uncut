// D285: no em dashes (—) and no en dashes used as dashes (" – ") in anything the model or the user
// reads: the system prompt and docs, tool descriptions and results, module manifests, skills, the
// app's UI copy, the README and the website (its pages and blog posts). Sentences use a comma, colon, period or parentheses
// instead. En dashes in ranges ("2–60 frames", "w12–w18") stay. Code comments, the verbatim
// licences (THIRD_PARTY_NOTICES) and planning/ aren't scanned.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { withoutComments } from "../helpers/withoutComments.ts";

/** An em dash in any spelling, or an en dash with a space on either side (a dash, not a range). */
const DASH = /—|&mdash;|&#8212;|&#x2014;|\\u2014|\s–|–\s|\s&ndash;|&ndash;\s|&#8211;\s|\s&#8211;/i;

const walk = (dir: string, keep: (f: string) => boolean): Array<string> =>
  existsSync(dir)
    ? (readdirSync(dir, { recursive: true }) as Array<string>).filter((f) => !f.split("/").includes("node_modules") && keep(f)).map((f) => join(dir, f))
    : [];

/** Code: string literals, template text and JSX text, comments left out. */
const CODE = [
  ...walk("apps/server/src", (f) => /\.tsx?$/.test(f)),
  ...walk("apps/web/src", (f) => /\.tsx?$/.test(f)),
  ...walk("apps/desktop/src", (f) => /\.tsx?$/.test(f)),
  ...walk("packages/core/src", (f) => /\.tsx?$/.test(f)),
  ...walk("plugins", (f) => /\.tsx?$/.test(f)),
  ...walk("site/src", (f) => /\.tsx?$/.test(f)),
];
/** Text the model or the user reads as it is. */
const TEXT = [
  "spec/agent/tools.json",
  ...walk("spec/schema", (f) => f.endsWith(".json")),
  ...walk("spec/modules", (f) => f.endsWith(".json")),
  ...walk("plugins", (f) => f.endsWith(".json")),
  "README.md",
  ...walk("site/content", (f) => f.endsWith(".md")),
];

/** Comment lines withoutComments can miss (after a regex literal with a quote in it, say). */
const COMMENT_LINE = /^\s*(\/\/|\/\*|\*)/;

const hits = (file: string, text: string, code = false) =>
  text
    .split("\n")
    .map((line, i) => [line, i] as const)
    .filter(([line]) => DASH.test(line) && !(code && COMMENT_LINE.test(line)))
    .map(([line, i]) => `${file}:${i + 1}: ${line.trim().slice(0, 120)}`);

test("the guard itself: em dashes and spaced en dashes are caught, ranges and comments aren't", () => {
  assert.ok(DASH.test("cut it tight — remove fillers"));
  assert.ok(DASH.test("EU &#8212; US") && DASH.test("a &mdash; b") && DASH.test("a – b"));
  assert.ok(!DASH.test("2–60 frames") && !DASH.test("w12–w18") && !DASH.test("${a}–${b} s") && !DASH.test("[300–452]"));
  assert.ok(!DASH.test(withoutComments("// a — b\nconst x = 1; /* c — d */")));
});

test("no em dashes or spaced en dashes in what the model or the user reads", () => {
  assert.ok(CODE.length > 100 && TEXT.length > 100, `scanned ${CODE.length} code and ${TEXT.length} text files`);
  const found = [
    ...CODE.flatMap((f) => hits(f, withoutComments(readFileSync(f, "utf8")), true)),
    ...TEXT.filter(existsSync).flatMap((f) => hits(f, readFileSync(f, "utf8"))),
  ];
  assert.deepEqual(found, [], "rewrite each with a comma, colon, period or parentheses");
});
