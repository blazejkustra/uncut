// D145: a generated result's display name comes from its prompt (the file keeps its unique name).
import { test } from "node:test";
import assert from "node:assert/strict";

import { displayNameOf, fileBase } from "../../apps/server/src/generate/generate.ts";

test("display names: sentence case from the prompt, no leading article, short, numbered when taken", () => {
  assert.equal(displayNameOf({ prompt: "A yellow sun over a navy sea" }), "Yellow sun over a navy sea");
  assert.equal(displayNameOf({ prompt: "the logo drawing itself." }), "Logo drawing itself");
  assert.equal(displayNameOf({ prompt: "  whoosh   as a card slides in!  " }), "Whoosh as a card slides in");
  assert.equal(displayNameOf({ prompt: "Title card: Launch day" }), "Title card: Launch day");
  const long = displayNameOf({ prompt: "A flat illustration of a phone on a desk with soft morning light and a plant" });
  assert.equal(long, "Flat illustration of a phone on a desk with");
  assert.ok(long.length <= 48);
  assert.equal(displayNameOf({ prompt: "x", name: "title card.svg" }), "title card");
  assert.equal(displayNameOf({ prompt: "" }), "Generated");
  assert.equal(displayNameOf({ prompt: "A yellow sun" }, new Set(["Yellow sun", "Yellow sun 2"])), "Yellow sun 3");
  // The file name is unchanged: unique by the time.
  assert.match(fileBase({ prompt: "A yellow sun over a navy sea" }, new Date(2026, 9, 14, 7, 40, 54)), /^a-yellow-sun-over-a 20261014-074054$/);
});
