// A window's connection: its local server or the relay to the remote it shows, and remote export downloads (D106, D109).
import * as path from "node:path";
import { LOCAL_ID, type EnvironmentInfo } from "../environments.ts";
import { startRelay } from "../relay.ts";
import { devServerUrl } from "./testMode.ts";
import { environments, type AppWindow } from "./state.ts";
import { chooseSavePath, appInfo } from "./dialogs.ts";

const devOrigins = devServerUrl ? [new URL(devServerUrl).origin] : [];

export async function closeRelay(entry: AppWindow) {
  const open = entry.relay;
  entry.relay = undefined;
  await open?.relay.close().catch(() => {});
}

/** The environment the window shows; Local when its remote was removed from the list. */
export function environmentOf(entry: AppWindow): EnvironmentInfo {
  const list = environments!.list().environments;
  return list.find((e) => e.id === entry.envId) ?? list.find((e) => e.id === LOCAL_ID)!;
}

/** The window's connection: its local server's, or the relay to the remote it shows. */
export async function activeConnection(entry: AppWindow) {
  if (!environments || !entry.server) throw new Error("the app is quitting");
  const env = environmentOf(entry);
  if (env.kind === "local") {
    await closeRelay(entry);
    return { ...(await entry.server.connection), environment: { id: LOCAL_ID, name: env.name, kind: "local" as const } };
  }
  if (entry.relay?.id !== env.id) {
    await closeRelay(entry);
    let secret: { url: string; token: string } | undefined;
    try {
      secret = environments.secret(env.id);
    } catch (error) {
      throw new Error(`Can't read the token for ${env.name}: ${(error as Error).message}`);
    }
    if (!secret) throw new Error(`${env.name} isn't in the environments list any more`);
    entry.relay = { id: env.id, relay: await startRelay({ target: secret.url, token: secret.token, allowedOrigins: devOrigins }) };
  }
  const relay = entry.relay.relay;
  return { url: relay.wsUrl, token: relay.token, environment: { id: env.id, name: env.name, kind: "remote" as const, ...(env.url ? { url: env.url } : {}) } };
}

// Downloads the windows asked for (D109), by URL: where each goes and who's waiting.
export const downloads = new Map<string, { readonly path: string; readonly done: (result: { path: string } | { error: string }) => void }>();

/** A remote export's video, streamed through the window's relay to a path the user picks here; null when cancelled. */
export async function downloadExport(entry: AppWindow, jobId: string, name: string): Promise<{ path: string } | { error: string } | null> {
  if (typeof jobId !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(jobId)) throw new Error("not an export id");
  const open = entry.relay;
  if (!open) return { error: "Downloads are for exports on a remote environment." };
  const base = typeof name === "string" && name ? path.basename(name) : "Export.mp4";
  const target = await chooseSavePath(entry.window, path.join(appInfo.defaultParentDir, base), "Download export");
  if (!target) return null;
  const url = `${open.relay.httpBase}/api/export/${encodeURIComponent(jobId)}?token=${encodeURIComponent(open.relay.token)}`;
  return new Promise((done) => {
    downloads.set(url, { path: target, done });
    entry.window.webContents.downloadURL(url);
  });
}
