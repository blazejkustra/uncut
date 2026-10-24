// Blog drafts: site/content/drafts/<slug>.md is gitignored and only a UNCUT_DRAFTS=1 build (the
// preview branch) renders it, under /blog/ with a Draft marker and noindex; the feed and the
// sitemap list published posts only, whatever the build.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readPosts } from "../../site/src/lib/posts.ts";

const post = (title: string, date: string) => `---\ntitle: "${title}"\ndate: "${date}"\ndescription: "d"\n---\n\nBody text.\n`;

test("readPosts: drafts only when asked, marked as drafts, newest first; a draft can't take a published slug", () => {
  const root = mkdtempSync(join(tmpdir(), "uncut-drafts-"));
  try {
    mkdirSync(join(root, "blog"));
    mkdirSync(join(root, "drafts"));
    writeFileSync(join(root, "blog", "first.md"), post("First", "2026-10-16"));
    writeFileSync(join(root, "drafts", "next.md"), post("Next", "2026-10-20"));
    assert.deepEqual(
      readPosts(root, false).map((p) => [p.slug, p.draft]),
      [["first", false]],
    );
    assert.deepEqual(
      readPosts(root, true).map((p) => [p.slug, p.draft]),
      [
        ["next", true],
        ["first", false],
      ],
    );
    writeFileSync(join(root, "drafts", "first.md"), post("Clash", "2026-10-21"));
    assert.throws(() => readPosts(root, true), /already has this slug/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the feed and the sitemap read published posts only; a draft page is noindex and says Draft", () => {
  for (const f of ["site/src/app/blog/rss.xml/route.ts", "site/src/app/sitemap.ts"]) {
    const src = readFileSync(f, "utf8");
    assert.match(src, /getPublishedPosts\(\)/, f);
    assert.doesNotMatch(src, /getAllPosts/, f);
  }
  const page = readFileSync("site/src/app/blog/[slug]/page.tsx", "utf8");
  assert.match(page, /post\.draft \? \{ robots: \{ index: false, follow: false \} \}/);
  assert.match(page, /className="draft-tag">Draft</);
  assert.match(readFileSync("site/src/lib/posts.ts", "utf8"), /SHOW_DRAFTS = process\.env\.UNCUT_DRAFTS === "1"/);
});

test("drafts are never committed", () => {
  assert.equal(execFileSync("git", ["check-ignore", "site/content/drafts/a-post.md"], { encoding: "utf8" }).trim(), "site/content/drafts/a-post.md");
});
