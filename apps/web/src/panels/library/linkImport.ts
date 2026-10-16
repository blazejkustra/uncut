// D259 (#94): Import from link's renderer state, kept here (not in the app store): whether the
// dialog is open (with a link and a timeline drop when it came from one) and the server's link jobs
// (link.jobs, subscribed while connected by the host). D280: the feature is a catalog plugin, so
// every entry point (Media's + menu, File › Import from Link…, link drops) shows only while that
// plugin is installed and allowed; the rights notice is shown on every import (nothing remembered).
import { LINK_PLUGIN_ID, type LinkJob, type PluginInfo } from "@uncut/contracts";
import { useSyncExternalStore } from "react";

export interface LinkDialogRequest {
  readonly url?: string | undefined;
  readonly drop?: { readonly frame: number; readonly track?: string | undefined } | undefined;
}

let dialog: LinkDialogRequest | undefined;
let jobs: ReadonlyArray<LinkJob> = [];
const listeners = new Set<() => void>();
const notify = () => {
  for (const l of listeners) l();
};
const subscribe = (l: () => void) => (listeners.add(l), () => void listeners.delete(l));

export const openLinkImport = (request: LinkDialogRequest = {}) => {
  dialog = request;
  notify();
};
export const closeLinkImport = () => {
  dialog = undefined;
  notify();
};
export const useLinkDialog = () => useSyncExternalStore(subscribe, () => dialog);

export const setLinkJobs = (next: ReadonlyArray<LinkJob>) => {
  jobs = next;
  notify();
};
export const useLinkJobs = () => useSyncExternalStore(subscribe, () => jobs);
export const liveLinkJob = (j: LinkJob) => j.phase === "running" || j.phase === "importing";

/** D280: Import from link is usable: its plugin is installed and allowed on the server this window shows. */
export const linkImportReady = (plugins: ReadonlyArray<PluginInfo> | undefined) => !!plugins?.some((p) => p.id === LINK_PLUGIN_ID && p.status === "ready");

/** An http(s) link in a drag's data (a link dragged from a browser), if any. */
export function linkFromDrag(data: DataTransfer): string | undefined {
  const raw = data.getData("text/uri-list") || data.getData("text/plain");
  const first = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith("#"));
  return first && /^https?:\/\/\S+$/i.test(first) ? first : undefined;
}
/** Whether a drag may hold a link (its data can't be read until the drop). */
export const dragMayHoldLink = (data: DataTransfer) => {
  const types = [...data.types];
  // Not files, and not one of Uncut's own drags (tiles, effects, transitions).
  return !types.includes("Files") && !types.some((t) => t.startsWith("application/x-uncut-")) && (types.includes("text/uri-list") || types.includes("text/plain"));
};
