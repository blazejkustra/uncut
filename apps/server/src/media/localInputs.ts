// D219: every ffmpeg and ffprobe Uncut starts reads its inputs from files and pipes only. A media
// file is the user's or the agent's, and ffmpeg follows what's inside it: an HLS playlist, a concat
// list or an "ffconcat" file that names http://, tcp://, rtmp:// or a crypto: URL would make it
// fetch from the network (or the local network) with the file's say-so. `-protocol_whitelist
// file,pipe` limits each input (and what it opens in turn: concat lists, image sequences) to local
// files and pipes. It's a per-input option, so it goes before every `-i`.
import { basename } from "node:path";

export const LOCAL_PROTOCOLS = ["-protocol_whitelist", "file,pipe"] as const;

/**
 * `args` for `bin` with -protocol_whitelist file,pipe before each ffmpeg input (unless that input's
 * options already set one) or, for ffprobe, once up front. Any other program's args come back as
 * they are, and so do an ffmpeg's without inputs (-version, -encoders, -hwaccels).
 */
export function localInputs(bin: string, args: ReadonlyArray<string>): Array<string> {
  const name = basename(bin).toLowerCase();
  if (name.startsWith("ffprobe")) return args.includes(LOCAL_PROTOCOLS[0]) ? [...args] : [...LOCAL_PROTOCOLS, ...args];
  if (!name.startsWith("ffmpeg")) return [...args];
  const out: Array<string> = [];
  // Whether the input being described (the options since the last -i) already has a whitelist.
  let set = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === LOCAL_PROTOCOLS[0]) set = true;
    if (a === "-i") {
      if (!set) out.push(...LOCAL_PROTOCOLS);
      out.push(a);
      if (i + 1 < args.length) out.push(args[++i]!);
      set = false;
      continue;
    }
    out.push(a);
  }
  return out;
}
