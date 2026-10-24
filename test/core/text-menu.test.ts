// Issue #49: the right-click menu on text: Copy on a selection, Cut/Copy/Paste/Select All in a
// field, nothing anywhere else (the app's own menus handle clips, tiles and the canvas).
import { test } from "node:test";
import assert from "node:assert/strict";

import { textMenu } from "../../apps/desktop/src/textMenu.ts";

const flags = { canCut: false, canCopy: true, canPaste: true, canSelectAll: true };
const roles = (items: ReturnType<typeof textMenu>) => items?.map((i) => ("role" in i ? `${i.role}${i.enabled ? "" : ":off"}` : "-"));

test("#49: no menu without a selection or a field", () => {
  assert.equal(textMenu({ isEditable: false, selectionText: "", editFlags: flags }), undefined);
  assert.equal(textMenu({ isEditable: false, selectionText: "  \n", editFlags: flags }), undefined);
});

test("#49: selected text in a message offers Copy", () => {
  assert.deepEqual(roles(textMenu({ isEditable: false, selectionText: "Added a title", editFlags: flags })), ["copy"]);
});

test("#49: a text field offers Cut, Copy, Paste and Select All, as the page allows", () => {
  assert.deepEqual(roles(textMenu({ isEditable: true, selectionText: "", editFlags: { ...flags, canCopy: false } })), [
    "cut:off",
    "copy:off",
    "paste",
    "-",
    "selectAll",
  ]);
  assert.deepEqual(roles(textMenu({ isEditable: true, selectionText: "x", editFlags: { ...flags, canCut: true } })), [
    "cut",
    "copy",
    "paste",
    "-",
    "selectAll",
  ]);
});
