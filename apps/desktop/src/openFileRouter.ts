// D252/D266: where a .uncut project opened from Finder goes. No Electron imports, so tests drive it.
// - Only the Local environment opens it: the path is this Mac's, and a remote server would open
//   whatever sits at that path there (or fail). On a remote the open is dropped with a notice
//   ("Switch to This Mac…"); it is never kept for a later switch to Local.
// - Before the renderer has asked (a cold launch, or a page that is reloading), the project waits;
//   the renderer asks once per page load (rendererAsks), and a reload or navigation resets that.
// - Until the environments are known (before app ready) nothing is decided.

export interface OpenFileRouterOptions {
  /** True on Local, false on a remote, undefined while the environments aren't loaded yet. */
  readonly isLocal: () => boolean | undefined;
  /** Opens the project in the renderer (an Open Recent command) and brings the window forward. */
  readonly open: (dir: string) => void;
  /** Tells the user to switch to This Mac; the path isn't kept. */
  readonly notifyRemote: (dir: string) => void;
}

export interface OpenFileRouter {
  /** Finder handed over a project folder. */
  opened(dir: string): void;
  /** The environments are loaded (app ready): decide what waited. */
  environmentsReady(): void;
  /** The renderer, connected to a Local server, asks for the waiting project (null: none). */
  rendererAsks(): string | null;
  /** The window's page reloaded or navigated (an environment switch reloads it). */
  rendererReloaded(): void;
}

export function makeOpenFileRouter(options: OpenFileRouterOptions): OpenFileRouter {
  let pending: string | undefined;
  let asked = false;
  const take = () => {
    const dir = pending;
    pending = undefined;
    return dir;
  };
  const route = () => {
    if (pending === undefined) return;
    const local = options.isLocal();
    if (local === undefined) return;
    if (!local) return options.notifyRemote(take()!);
    if (asked) options.open(take()!);
  };
  return {
    opened(dir) {
      pending = dir;
      route();
    },
    environmentsReady: route,
    rendererAsks() {
      asked = true;
      if (options.isLocal() !== true) {
        route();
        return null;
      }
      return take() ?? null;
    },
    rendererReloaded() {
      asked = false;
    },
  };
}
