// The active environment's connection: the local server or the relay to a remote one, and remote export downloads (D106, D109).
import * as path from "node:path";
import { LOCAL_ID } from "../environments.ts";
import { type Relay, startRelay } from "../relay.ts";
import { devServerUrl } from "./testMode.ts";
import { environments, server, win } from "./state.ts";
import { chooseSavePath, appInfo } from "./dialogs.ts";

// The relay to the active remote, if the active environment is one.
export let relay: { readonly id: string; readonly relay: Relay } | undefined;
const devOrigins = devServerUrl ? [new URL(devServerUrl).origin] : [];

export async function closeRelay() {
  const open = relay;
  relay = undefined;
  await open?.relay.close().catch(() => {});
}

/** The active environment's connection: the local server's, or the relay to the remote one. */
export async function activeConnection() {
  if (!environments || !server) throw new Error("the app is quitting");
  const env = environments.active();
  if (env.kind === "local") {
    await closeRelay();
    return { ...(await server.connection), environment: { id: LOCAL_ID, name: env.name, kind: "local" as const } };
  }
  if (relay?.id !== env.id) {
    await closeRelay();
    let secret: { url: string; token: string } | undefined;
    try {
      secret = environments.secret(env.id);
    } catch (error) {
      throw new Error(`Can't read the token for ${env.name}: ${(error as Error).message}`);
    }
    if (!secret) throw new Error(`${env.name} isn't in the environments list any more`);
    relay = { id: env.id, relay: await startRelay({ target: secret.url, token: secret.token, allowedOrigins: devOrigins }) };
  }
  return { url: relay.relay.wsUrl, token: relay.relay.token, environment: { id: env.id, name: env.name, kind: "remote" as const, ...(env.url ? { url: env.url } : {}) } };
}

// Downloads this window asked for (D109), by URL: where each goes and who's waiting.
export const downloads = new Map<string, { readonly path: string; readonly done: (result: { path: string } | { error: string }) => void }>();

/** A remote export's video, streamed through the relay to a path the user picks here; null when cancelled. */
export async function downloadExport(jobId: string, name: string): Promise<{ path: string } | { error: string } | null> {
  if (typeof jobId !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(jobId)) throw new Error("not an export id");
  const open = relay;
  if (!open || !win) return { error: "Downloads are for exports on a remote environment." };
  const base = typeof name === "string" && name ? path.basename(name) : "Export.mp4";
  const target = await chooseSavePath(path.join(appInfo.defaultParentDir, base), "Download export");
  if (!target) return null;
  const url = `${open.relay.httpBase}/api/export/${encodeURIComponent(jobId)}?token=${encodeURIComponent(open.relay.token)}`;
  return new Promise((done) => {
    downloads.set(url, { path: target, done });
    win!.webContents.downloadURL(url);
  });
}
