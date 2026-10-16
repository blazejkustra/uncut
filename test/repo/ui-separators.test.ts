// The user's standing rule for on-screen text: never ·, •, ∙, ⋅ or a lone * between words (commas,
// line breaks or separate elements instead). This scans the renderer's sources and the server
// files whose strings reach the screen (setup rows, plugin texts, step labels, transcription
// states) for those separators in code, comments left out, so they can't come back. The website's
// pages (site/src/**/*.tsx) and its blog posts (site/content/blog, and drafts when present) are scanned the same way.
// agentTools.ts's system prompt names the rule itself and isn't shown, so it isn't scanned.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { withoutComments } from "../helpers/withoutComments.ts";

const WEB = "apps/web/src";
const SERVER = "apps/server/src";
const SERVER_UI = ["app/setup.ts", "plugins/plugins.ts", "plugins/discovery/discover.ts", "plugins/discovery/infos.ts", "plugins/discovery/manifest.ts", "plugins/runtime/host.ts", "plugins/runtime/process.ts", "plugins/runtime/result.ts", "analysis/whisper.ts", "analysis/whisperModels.ts", "analysis/transcription.ts", "media/media.ts", "export/exporter.ts", "export/exporter/duckEnvelopes.ts", "export/exporter/ffmpeg.ts", "export/exporter/files.ts", "export/exporter/frames.ts", "export/exporter/graphics.ts", "export/exporter/rasterise.ts", "export/exporter/runJob.ts", "export/exporter/sheets.ts", "export/exporter/subtitles.ts", "analysis/analysis.ts", "analysis/loudness/loudness.ts", "analysis/queue/cache.ts", "analysis/queue/queue.ts", "agent/agent.ts", "agent/session/config.ts", "agent/session/core.ts", "agent/session/send.ts", "agent/session/spawn.ts", "agent/session/stale.ts", "agent/session/stream.ts", "agent/tools/ask.ts", "agent/tools/brand.ts", "agent/tools/cards.ts", "agent/tools/common.ts", "agent/tools/generate.ts", "agent/tools/library.ts", "agent/tools/media.ts", "agent/tools/run.ts", "agent/tools/transcript.ts", "agent/turns/history.ts", "agent/turns/notes.ts", "media/mediaLibrary/helpers.ts", "media/mediaLibrary/service.ts"];

/** Text in string literals and template literals (without their ${} parts). */
const literals = (code: string) => [...code.matchAll(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g)].map((m) => m[0].replace(/\$\{[^}]*\}/g, " "));

const files = [
  ...(readdirSync(WEB, { recursive: true }) as Array<string>).filter((f) => /\.tsx?$/.test(f)).map((f) => join(WEB, f)),
  // The website's pages and components (its .ts files are browser logic and shaders, not copy).
  ...(readdirSync("site/src", { recursive: true }) as Array<string>).filter((f) => /\.tsx$/.test(f)).map((f) => join("site/src", f)),
  ...SERVER_UI.map((f) => join(SERVER, f)),
];

test("the guard itself: comments are left out, strings and JSX text are kept", () => {
  const code = withoutComments('// a · b\nconst x = "Swift · Kotlin"; /* • */ const y = `${a * b} ok`;\n<p>One · two</p>');
  assert.ok(!code.includes("a · b") && !code.includes("•"));
  assert.ok(code.includes("Swift · Kotlin") && code.includes("One · two"));
  assert.deepEqual(literals('x = "a * b" + `${c * d}`'), ['"a * b"', "` `"]);
});

test("no ·, •, ∙ or ⋅ in the app's on-screen text, and no lone * between words in its strings", () => {
  const found: Array<string> = [];
  for (const file of files) {
    const code = withoutComments(readFileSync(file, "utf8"));
    code.split("\n").forEach((line, n) => {
      if (/[·•∙⋅]/.test(line)) found.push(`${file}:${n + 1}: ${line.trim().slice(0, 140)}`);
    });
    for (const lit of literals(code)) {
      // "a * b" between words; not "**bold**", "* " list markers at a line start, or maths in ${}.
      if (/[A-Za-z0-9)] \* [A-Za-z(]/.test(lit)) found.push(`${file}: ${lit.slice(0, 140)}`);
    }
  }
  assert.deepEqual(found, []);
});

test("no ·, •, ∙ or ⋅ and no lone * between words in the blog's posts", () => {
  // Drafts (site/content/drafts, gitignored) are checked too when there are any on this machine.
  const md = (dir: string) => (existsSync(dir) ? (readdirSync(dir) as Array<string>).filter((f) => f.endsWith(".md")).map((f) => join(dir, f)) : []);
  const posts = md("site/content/blog");
  assert.ok(posts.length > 0);
  posts.push(...md("site/content/drafts"));
  const found: Array<string> = [];
  for (const file of posts) {
    readFileSync(file, "utf8").split("\n").forEach((line, n) => {
      if (/[·•∙⋅]/.test(line) || /[A-Za-z0-9)] \* [A-Za-z(]/.test(line)) found.push(`${file}:${n + 1}: ${line.trim().slice(0, 140)}`);
    });
  }
  assert.deepEqual(found, []);
});
