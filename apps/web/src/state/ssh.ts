// "Connect over SSH" (D111): the commands to type, built here and only shown; Uncut never runs ssh.
// The server starts from an Uncut.app installed on the other Mac, bound to that Mac's loopback only,
// and the tunnel brings its port here, so nothing listens on the network.

/** A shell word, single-quoted. */
const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** user@host, host, or an ssh config alias: no spaces, quotes or shell characters. */
export const validSshTarget = (target: string) => /^[A-Za-z0-9._@%+-]+(:[0-9]+)?$/.test(target) && !target.startsWith("-");

export function sshCommands(input: { readonly target: string; readonly remotePort: number; readonly localPort: number; readonly appPath?: string }): { readonly start: string; readonly tunnel: string; readonly url: string } {
  const app = input.appPath ?? "/Applications/Uncut.app";
  const server = `ELECTRON_RUN_AS_NODE=1 ${quote(`${app}/Contents/MacOS/Uncut`)} ${quote(`${app}/Contents/Resources/server/server.mjs`)} --port ${input.remotePort} --data-dir "$HOME/Library/Application Support/Uncut Server"`;
  return {
    start: `ssh ${input.target} ${quote(server)}`,
    tunnel: `ssh -N -L ${input.localPort}:127.0.0.1:${input.remotePort} ${input.target}`,
    url: `http://127.0.0.1:${input.localPort}`,
  };
}
