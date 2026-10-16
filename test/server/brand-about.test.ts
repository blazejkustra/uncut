// D296: a kit says what the product is (about), the agent reads it in <brand> ("What it is") and the
// production docs send it to the kits first, never a disk or web search for the product.
import { test } from "node:test";
import assert from "node:assert/strict";

import { normKit } from "../../apps/server/src/brand/store.ts";
import { kitLines, mergeKit, planContext } from "../../apps/server/src/agent/agentPlan.ts";
import { docsRead } from "../../apps/server/src/agent/agentDocs.ts";

const ABOUT = "Uncut is a free, open-source macOS video editor where Claude Code edits a real timeline with you.";

test("about: kept by normKit, written by brand_write's merge (empty clears it), shown to the agent", () => {
  const kit = normKit({ id: "uncut", name: "Uncut", about: `  ${ABOUT}  `, tone: "Plain" }, "global")!;
  assert.equal(kit.about, ABOUT);
  assert.equal(normKit({ id: "argent", name: "Argent" }, "global")!.about, undefined, "a kit without one has none");
  assert.match(kitLines(kit, {}).join("\n"), /What it is: Uncut is a free, open-source macOS video editor/);
  const merged = mergeKit(normKit({ id: "x", name: "X" }, "global")!, { about: "A thing." });
  assert.ok(!("problem" in merged) && merged.about === "A thing.");
  const cleared = mergeKit(kit, { about: " " });
  assert.ok(!("problem" in cleared) && cleared.about === undefined);
});

test("kits first: the context and the production docs say to use a matching kit and ask once, not search", () => {
  const ctx = planContext({ files: {}, skills: [], others: [{ id: "uncut", name: "Uncut" }] }, { reviews: [] }, { closed: false, waiting: false, skip: false });
  assert.match(ctx, /its kit \(brand_read\) if one matches; else ask_user once, don't search the disk or the web/);
  const prod = docsRead("production").text;
  assert.match(prod, /look in the kits first/);
  assert.match(prod, /never a general web search for the product/);
  assert.doesNotMatch(prod, /find its brand on its website/);
});
