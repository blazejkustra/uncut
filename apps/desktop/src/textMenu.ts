// Issue #49: right-click on selected text or in a text field shows Cut, Copy, Paste and Select All
// (Electron shows no menu of its own). The app's own menus (a clip, a tile, the canvas) call
// preventDefault in the page, so Electron never asks for this one there.

/** What Electron's context-menu event says about the click (the part this menu reads). */
export interface TextMenuParams {
  readonly isEditable: boolean;
  readonly selectionText: string;
  readonly editFlags: { readonly canCut: boolean; readonly canCopy: boolean; readonly canPaste: boolean; readonly canSelectAll: boolean };
}

export type TextMenuItem = { readonly role: "cut" | "copy" | "paste" | "selectAll"; readonly enabled: boolean } | { readonly type: "separator" };

/** The menu for a right-click, or undefined when it isn't on text (nothing selected, not a field). */
export function textMenu(params: TextMenuParams): Array<TextMenuItem> | undefined {
  const selected = params.selectionText.trim() !== "";
  if (!params.isEditable && !selected) return undefined;
  const f = params.editFlags;
  if (!params.isEditable) return [{ role: "copy", enabled: f.canCopy }];
  return [
    { role: "cut", enabled: f.canCut },
    { role: "copy", enabled: f.canCopy },
    { role: "paste", enabled: f.canPaste },
    { type: "separator" },
    { role: "selectAll", enabled: f.canSelectAll },
  ];
}
