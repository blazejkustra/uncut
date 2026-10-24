import { type ServerConnection, TOKEN_QUERY_PARAM, UPLOAD_PATH } from "@uncut/contracts";
import { type CallError, isTransportError, type Connection } from "../connection.ts";
import { set, isRemote } from "./core.ts";

/** A sentence for a failed call, without validator jargon. */
export function plainError(error: CallError): string {
  if (isTransportError(error)) return "Not connected to the server. Try again when it's back.";
  if (error._tag === "PluginError") return error.message;
  const first = error.details?.[0];
  if (error._tag === "EditRefused" && first && /invalid|malformed/.test(error.message)) return `That change isn't allowed: ${first.message}.`;
  if (error._tag === "EditRefused" && first?.code === "depends") return error.message;
  if (error._tag === "EditRefused" && first?.code === "conflict")
    return "The agent changed that while you were editing it, so your change wasn't applied. Try again on what's there now.";
  if (error.reason === "missing") return "The project folder is gone, or has no project.json.";
  if (error.reason === "invalid" && first?.code === "json") return "project.json can't be read: it isn't valid JSON.";
  if (error.reason === "invalid")
    return `project.json can't be read: ${first ? `${first.path === "/" ? "" : `${first.path} `}${first.message}` : error.message}.`;
  return error.message;
}

export let connection: Connection | undefined;
export let serverConnection: ServerConnection | undefined;
/** start() sets both once the server is known. */
export const setServerConnection = (c: ServerConnection) => void (serverConnection = c);
export const setConnection = (c: Connection) => void (connection = c);
export const call: Connection["call"] = (f, timeoutMs) =>
  connection ? connection.call(f, timeoutMs) : Promise.resolve({ ok: false, error: { _tag: "NotConnected", message: "Not connected to the server" } });

export const refreshRecents = async () => {
  const recents = await call((c) => c["recents.list"]({}));
  if (recents.ok) set({ recents: recents.value });
};

/** server.hello: versions, the graphic secret, and for a remote its own home and default folder (D107). */
export async function refreshHello() {
  const hello = await call((c) => c["server.hello"]({}));
  if (hello.ok) {
    set({
      hello: hello.value,
      ...(isRemote() && hello.value.home ? { appInfo: { homeDir: hello.value.home, defaultParentDir: hello.value.defaultParentDir ?? hello.value.home } } : {}),
    });
  } else if (!isTransportError(hello.error)) set({ connectionMessage: plainError(hello.error) });
  return hello;
}

/** A URL on the active server (through the relay when remote) with the window's token. */
const apiUrl = (route: string, params: Record<string, string> = {}) => {
  if (!serverConnection) return undefined;
  const url = new URL(serverConnection.url.replace(/^ws/, "http"));
  url.pathname = route;
  url.search = "";
  url.searchParams.set(TOKEN_QUERY_PARAM, serverConnection.token);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.href;
};

/** One file up to the open remote project's media/uploads/ (D108): its path there, or why not. */
export async function uploadOne(file: File): Promise<{ readonly path: string } | { readonly message: string }> {
  const url = apiUrl(UPLOAD_PATH, { name: file.name });
  if (!url) return { message: "Not connected to the server." };
  try {
    const res = await fetch(url, { method: "POST", body: file, headers: { "content-type": "application/octet-stream" } });
    const text = await res.text();
    if (!res.ok) return { message: text.trim() || `The server answered ${res.status}.` };
    const path = (JSON.parse(text) as { path?: unknown }).path;
    return typeof path === "string" ? { path } : { message: "The server's answer had no path." };
  } catch (error) {
    // A folder (or a file that went away) can't be read as a body.
    return {
      message: file.size === 0 && file.type === "" ? "Folders can't be uploaded; drop the files inside." : `The upload stopped: ${(error as Error).message}`,
    };
  }
}
