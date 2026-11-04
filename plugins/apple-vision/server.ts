#!/usr/bin/env node
// Uncut's Apple Vision plugin (D325): the macOS provider of the vision outputs (packages/contracts
// vision.ts). Uncut calls it itself, never the agent (no agent tools):
//
//   matte { media, start, end?, mode, out, ffmpeg }  a grey FFV1 matte at `out`; answers its size,
//     fps, frame count and each frame's source time.
//   faces { media, start, end?, out }                 face boxes per frame with stable ids, as JSON at `out`.
//   track { media, at, end?, box: {x, y, w, h}, out } one object's box per frame until it's lost, as JSON at `out`.
//   version {}                                        the helper's version, part of Uncut's cache key.
//
// Progress comes as notifications/progress (frames done of total); notifications/cancelled kills
// the helper (and ffmpeg) and the call gets no answer.
import { resolve } from "node:path";

import { failure, serve, text, type Json, type ToolContext } from "@uncut/plugin-sdk";

import { findHelper, helperVersion, NO_HELPER, rangeArgs, runMatte, runToFile, type MatteMode } from "./helper.ts";

const MODES: ReadonlyArray<MatteMode> = ["person", "subject"];

const str = (x: unknown) => (typeof x === "string" && x.trim() ? x : undefined);
const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : undefined);

interface Range {
  readonly media: string;
  readonly start: number;
  readonly end: number | undefined;
}

function rangeOf(args: Json, startKey: "start" | "at"): Range | string {
  const media = str(args.media);
  const start = num(args[startKey]) ?? 0;
  const end = num(args.end);
  if (!media) return "Pass media (a video file).";
  if (start < 0 || (end !== undefined && end <= start)) return `The range ${start} to ${end} s is empty.`;
  return { media, start, end };
}

function helperOrRefusal(): { readonly helper: string } | { readonly refused: string } {
  if (process.platform !== "darwin") return { refused: "Apple Vision runs only on macOS." };
  const helper = findHelper(import.meta.dirname);
  return helper ? { helper } : { refused: NO_HELPER };
}

const progressOf = (context: ToolContext) => (done: number, total: number) => context.progress(done, total);

async function matte(args: Json, context: ToolContext) {
  const range = rangeOf(args, "start");
  if (typeof range === "string") return failure(range);
  const mode = MODES.find((m) => m === args.mode);
  if (!mode) return failure(`mode must be "person" or "subject".`);
  const out = str(args.out);
  const ffmpeg = str(args.ffmpeg);
  if (!out || !ffmpeg) return failure("Pass out (the .mkv to write) and ffmpeg.");
  const found = helperOrRefusal();
  if ("refused" in found) return failure(found.refused);
  const answer = await runMatte({ ...range, helper: found.helper, ffmpeg, mode, out }, { signal: context.signal, onProgress: progressOf(context) });
  return text(`${answer.frames} frames, ${answer.width}×${answer.height}.`, answer as unknown as Json);
}

async function faces(args: Json, context: ToolContext) {
  const range = rangeOf(args, "start");
  if (typeof range === "string") return failure(range);
  const out = str(args.out);
  if (!out) return failure("Pass out (the .json to write).");
  const found = helperOrRefusal();
  if ("refused" in found) return failure(found.refused);
  await runToFile(found.helper, ["faces", "--input", range.media, ...rangeArgs(range.start, range.end)], out, {
    signal: context.signal,
    onProgress: progressOf(context),
  });
  return text("Faces written.", { out });
}

async function track(args: Json, context: ToolContext) {
  const range = rangeOf(args, "at");
  if (typeof range === "string") return failure(range);
  const box = (args.box ?? {}) as Json;
  const parts = [box.x, box.y, box.w, box.h].map(num);
  if (parts.some((p) => p === undefined)) return failure("Pass box {x, y, w, h}, 0 to 1 from the top left.");
  const out = str(args.out);
  if (!out) return failure("Pass out (the .json to write).");
  const found = helperOrRefusal();
  if ("refused" in found) return failure(found.refused);
  const command = [
    "track",
    "--input",
    range.media,
    "--at",
    String(range.start),
    ...(range.end !== undefined ? ["--end", String(range.end)] : []),
    "--box",
    parts.join(","),
  ];
  await runToFile(found.helper, command, out, { signal: context.signal, onProgress: progressOf(context) });
  return text("Track written.", { out });
}

async function version() {
  const found = helperOrRefusal();
  if ("refused" in found) return failure(found.refused);
  const helper = await helperVersion(found.helper);
  return text(helper, { helper });
}

const isMain = process.argv[1] && resolve(process.argv[1]) === import.meta.filename;
if (isMain) serve({ manifest: new URL("./uncut.module.json", import.meta.url), tools: { matte, faces, track, version } });
