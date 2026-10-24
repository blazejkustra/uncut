#!/usr/bin/env node
// Import from link (D259, D280): import a video or audio file from a link using your own yt-dlp.
// Not bundled: it's in Uncut's plugin catalog (Settings, Plugins), off until the user installs and
// allows it. A stdio MCP server on Uncut's own Node, written with @uncut/plugin-sdk (D102). It
// lists no agent tools: only Uncut calls it, from the Import from link dialog, never the agent.
//
//   check { searchPath }
//     Looks for yt-dlp in searchPath (Uncut's PATH and the Homebrew folders). structuredContent:
//     { found, path?, version? }.
//   download { url, kind: "video" | "audio", quality, folder, stem, searchPath }
//     Runs yt-dlp (no config, no cookies, no playlist) in `folder` (the project's media/links,
//     checked by Uncut) into `<stem>.<ext>`. Progress as notifications/progress (0–1, with a step
//     as the message). structuredContent: { file, title? } or, on failure, isError with the reason
//     in plain words. notifications/cancelled kills yt-dlp's process group and removes the partial
//     files; the call gets no answer.
//
// Uncut keeps the rest: the dialog and its rights notice, the job list, naming the file after the
// title and adding it to Media.
import { resolve } from "node:path";

import { failure, serve, text, type Json, type ToolContext } from "@uncut/plugin-sdk";

import { download, killAll, versionOf, which, type LinkKind, type LinkQuality } from "./ytdlp.ts";

const str = (x: unknown) => (typeof x === "string" && x ? x : undefined);

async function check(args: Json) {
  const searchPath = str(args.searchPath) ?? process.env.PATH ?? "";
  const bin = await which("yt-dlp", searchPath);
  if (!bin) return text("yt-dlp isn't installed.", { found: false });
  const version = await versionOf(bin, { ...process.env, PATH: searchPath });
  return text(`yt-dlp${version ? ` ${version}` : ""} at ${bin}.`, { found: true, path: bin, ...(version ? { version } : {}) });
}

async function downloadTool(args: Json, { signal, progress }: ToolContext) {
  const url = str(args.url);
  const folder = str(args.folder);
  const stem = str(args.stem);
  if (!url || !folder || !stem) return failure("Pass url, folder and stem.");
  let last = -1;
  const result = await download(
    {
      url,
      kind: args.kind as LinkKind,
      quality: (str(args.quality) ?? "1080") as LinkQuality,
      folder,
      stem,
      searchPath: str(args.searchPath) ?? process.env.PATH ?? "",
    },
    signal,
    (fraction, status) => {
      const p = Math.round(fraction * 1000) / 1000;
      if (p === last && !status) return;
      last = p;
      progress(p, 1, status);
    },
  );
  if (!result.ok) return failure(result.error);
  return text(`Downloaded ${result.file}.`, { file: result.file, ...(result.title ? { title: result.title } : {}) });
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);
if (isMain) serve({ manifest: new URL("./uncut.module.json", import.meta.url), tools: { check, download: downloadTool }, onExit: killAll });
