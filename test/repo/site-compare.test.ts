// The /vs/ pages stay honest: dated, sourced, and each says where the rival is better.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { COMPARISONS, GUIDE } from "../../site/src/lib/compare.ts";

test("the comparison pages are the agreed ones", () => {
  assert.deepEqual(COMPARISONS.map((c) => c.slug).toSorted(), ["capcut", "descript", "kino", "palmier", "video-use"]);
});

test("every comparison is dated, sourced and fair to the rival", () => {
  for (const c of COMPARISONS) {
    assert.match(c.checked, /^\d{4}-\d{2}-\d{2}$/, c.slug);
    assert.ok(c.body.includes(`## Where ${c.rival} is better`), c.slug);
    assert.match(c.body, /## Sources\n\n- \[.+\]\(https:/, c.slug);
  }
  assert.match(GUIDE.body, /## Sources\n\n- \[.+\]\(https:/);
});

test("the Kino page says what comes from its docs", () => {
  const kino = COMPARISONS.find((c) => c.slug === "kino")!;
  assert.match(kino.body, /from its docs and pricing page, and we have not run it/);
});

test("the sitemap lists the comparisons and the guide", () => {
  const sitemap = readFileSync("site/src/app/sitemap.ts", "utf8");
  assert.match(sitemap, /COMPARISONS\.map/);
  assert.match(sitemap, /GUIDE_PATH/);
});
