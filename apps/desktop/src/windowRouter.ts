// Several projects at once: one window per project, each with its own server. Where a project
// opened from the menu's Open Recent, Finder, the Dock or a second launch goes. No Electron
// imports, so tests drive it.
// - A window that has it open (or is about to) is brought forward.
// - Else the focused window, when it's on This Mac and shows no project, opens it.
// - Else a new window opens it. A window on a remote environment never opens a path of this Mac.

export interface RoutedWindow {
  readonly id: number;
  readonly local: boolean;
  /** The project the window shows (as the renderer last said), or undefined. */
  readonly projectDir: string | undefined;
  /** A project handed to the window that its page hasn't taken yet. */
  readonly pendingOpen: string | undefined;
}

export type Route = { readonly kind: "focus"; readonly id: number } | { readonly kind: "open"; readonly id: number } | { readonly kind: "new" };

export function routeProject(windows: ReadonlyArray<RoutedWindow>, focusedId: number | undefined, dir: string): Route {
  const has = windows.find((w) => w.local && (w.projectDir === dir || w.pendingOpen === dir));
  if (has) return { kind: "focus", id: has.id };
  const focused = windows.find((w) => w.id === focusedId);
  if (focused && focused.local && focused.projectDir === undefined && focused.pendingOpen === undefined) return { kind: "open", id: focused.id };
  return { kind: "new" };
}

/** Another window (not `self`) that has `dir` open on This Mac, if any. */
export const windowWithProject = (windows: ReadonlyArray<RoutedWindow>, self: number, dir: string) =>
  windows.find((w) => w.id !== self && w.local && (w.projectDir === dir || w.pendingOpen === dir));

const CASCADE = 28;

/**
 * Where a new window goes: `want`, moved down and right by a step while another window's top left
 * corner is there (macOS's cascade), so a new window never hides the one under it exactly.
 */
export function cascade(want: { readonly x: number; readonly y: number }, taken: ReadonlyArray<{ readonly x: number; readonly y: number }>) {
  let { x, y } = want;
  for (let i = 0; i < 50 && taken.some((t) => Math.abs(t.x - x) < 4 && Math.abs(t.y - y) < 4); i++) {
    x += CASCADE;
    y += CASCADE;
  }
  return { x, y };
}
