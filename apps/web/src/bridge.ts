import type { ServerConnection } from "@uncut/contracts";

// Exposed by apps/desktop/src/preload.ts.
export interface UncutBridge {
  readonly getServerConnection: () => Promise<ServerConnection>;
  // Called if the server dies after it started. Returns an unsubscribe function.
  readonly onServerExit: (listener: (reason: string) => void) => () => void;
}

declare global {
  interface Window {
    readonly uncut?: UncutBridge;
  }
}

export const getServerConnection = (): Promise<ServerConnection> =>
  window.uncut
    ? window.uncut.getServerConnection()
    : Promise.reject(new Error("Not running inside the Uncut desktop app"));

export const onServerExit = (listener: (reason: string) => void): (() => void) =>
  window.uncut ? window.uncut.onServerExit(listener) : () => {};
