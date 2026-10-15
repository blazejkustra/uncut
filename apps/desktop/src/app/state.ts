// The app's shared mutable state: the window, the local server and the environments store. Set only
// through the setters (an import can't be assigned); read as live bindings everywhere.
import type { BrowserWindow } from "electron";
import type { EnvironmentStore } from "../environments.ts";
import type { ServerProcess } from "../server.ts";

export let server: ServerProcess | undefined;
export let win: BrowserWindow | undefined;

export let environments: EnvironmentStore | undefined;

export const setServer = (value: ServerProcess | undefined) => {
  server = value;
};
export const setWin = (value: BrowserWindow | undefined) => {
  win = value;
};
export const setEnvironments = (value: EnvironmentStore | undefined) => {
  environments = value;
};
