// #67 (D239): how long an error toast stays.
import { test } from "node:test";
import assert from "node:assert/strict";

import { TOAST_MAX_MS, TOAST_MIN_MS, toastMs } from "../../apps/web/src/ui/toast.ts";

test("a short error stays the minimum, a longer one longer, never past the maximum", () => {
  assert.equal(toastMs("Locked."), TOAST_MIN_MS);
  const mid = toastMs("That track is locked. Unlock it in its header to change what's on it, then try again.");
  assert.ok(mid > TOAST_MIN_MS && mid < TOAST_MAX_MS, String(mid));
  assert.ok(toastMs("x".repeat(80)) < toastMs("x".repeat(120)));
  assert.equal(toastMs("x".repeat(2000)), TOAST_MAX_MS);
});
