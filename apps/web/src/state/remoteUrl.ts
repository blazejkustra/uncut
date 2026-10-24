// Whether a server address sends the token and footage in clear (D106): plain http to anything
// but this Mac's loopback or a Tailscale address (100.64.0.0/10, *.ts.net, already encrypted by
// WireGuard). https, and http through an SSH tunnel (it's 127.0.0.1 here), are fine.

/** The address inside a pasted pairing line (uncut://pair?url=…), or the text itself. */
const addressOf = (raw: string) => {
  const t = raw.trim();
  if (/^uncut:\/\/pair\?/i.test(t)) return new URLSearchParams(t.slice(t.indexOf("?") + 1)).get("url") ?? "";
  return t;
};

export function notEncrypted(raw: string): boolean {
  let text = addressOf(raw);
  if (!text) return false;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `http://${text}`;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "ws:") return false;
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host === "::1" || host.startsWith("127.")) return false;
  if (host.endsWith(".ts.net")) return false;
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
  if (v4 && Number(v4[1]) === 100 && Number(v4[2]) >= 64 && Number(v4[2]) <= 127) return false;
  return true;
}

export const NOT_ENCRYPTED = "Not encrypted: the token and footage travel in clear. Use an SSH tunnel, Tailscale or https.";
