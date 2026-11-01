// GET /media/footage-thumb/<fingerprint>/<second>?token=…: one frame of an indexed clip for a search
// result. Made with ffmpeg on the first request and kept in <data dir>/footage-index/thumbs/. The
// file read is the path the index holds for that fingerprint, never one from the request.
import { spawn } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import { FOOTAGE_THUMB_PATH } from "@uncut/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { presentedToken, tokensMatch } from "../app/auth.ts";
import { ServerConfig } from "../app/config.ts";
import { which } from "../app/setup.ts";
import { withoutApiKey } from "../app/shellEnv.ts";
import { localInputs } from "../media/localInputs.ts";
import { makeLimiter } from "../media/waveforms.ts";
import { FootageIndex, thumbFolder } from "./footageIndex.ts";

const THUMB_WIDTH = 256;
const MAX_RUNS = 2;
const RUN_TIMEOUT_MS = 20_000;
const REQUEST = /^\/([0-9a-f]{32})\/(\d{1,6})$/;

export const frameArgs = (path: string, second: number, out: string) => [
  "-hide_banner",
  "-nostdin",
  "-v",
  "error",
  "-y",
  "-ss",
  String(second),
  "-i",
  path,
  "-frames:v",
  "1",
  "-vf",
  `scale=${THUMB_WIDTH}:-2`,
  "-q:v",
  "5",
  out,
];

const runFfmpeg = (bin: string, args: ReadonlyArray<string>) =>
  new Promise<boolean>((done) => {
    const child = spawn(bin, localInputs(bin, args), { stdio: "ignore", env: withoutApiKey(process.env), timeout: RUN_TIMEOUT_MS });
    child.on("error", () => done(false));
    child.on("close", (code) => done(code === 0));
  });

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const footage = yield* FootageIndex;
    const { slot, release } = makeLimiter(MAX_RUNS);
    const folder = thumbFolder(config.dataDir);

    const makeFrame = async (path: string, second: number, file: string) => {
      await config.shellReady;
      const ffmpeg = await which("ffmpeg", process.env.PATH ?? "");
      if (!ffmpeg) return undefined;
      await slot();
      try {
        await mkdir(folder, { recursive: true });
        const made = await runFfmpeg(ffmpeg, frameArgs(path, second, file));
        return made ? await readFile(file).catch(() => undefined) : undefined;
      } finally {
        release();
      }
    };

    const frame = async (fingerprint: string, second: number) => {
      const place = footage.places(fingerprint).find((p) => p.kind !== "audio");
      if (!place) return undefined;
      const file = join(folder, `${fingerprint}-${second}.jpg`);
      const made = (await readFile(file).catch(() => undefined)) ?? (await makeFrame(place.path, place.kind === "image" ? 0 : second, file));
      if (!made) await rm(file, { force: true });
      return made;
    };

    return HttpRouter.add(
      "GET",
      `${FOOTAGE_THUMB_PATH}/*`,
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const url = HttpServerRequest.toURL(request);
        if (Option.isNone(url) || !tokensMatch(presentedToken(request.headers, url.value), config.token)) {
          return HttpServerResponse.text("Unauthorized", { status: 401 });
        }
        const asked = REQUEST.exec(url.value.pathname.slice(FOOTAGE_THUMB_PATH.length));
        if (!asked) return HttpServerResponse.text("Not found", { status: 404 });
        const bytes = yield* Effect.promise(() => frame(asked[1]!, Number(asked[2])));
        if (!bytes) return HttpServerResponse.text("Not found", { status: 404 });
        return HttpServerResponse.uint8Array(bytes, { contentType: "image/jpeg", headers: { "cache-control": "private, max-age=3600" } });
      }),
    );
  }),
);
