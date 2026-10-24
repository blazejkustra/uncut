// Talks to the Rust media core helper (native/media, D42): spawned on demand, one JSON
// request per stdin line, one JSON reply per stdout line.
import { MediaCoreError } from "@uncut/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { ServerConfig } from "../app/config.ts";

/** What `uncut-media probe` reports about a file (see native/media/src/probe.rs). */
export interface ProbeInfo {
  readonly kind: "video" | "audio" | "image";
  readonly container: string;
  readonly durationSeconds?: number;
  readonly width?: number;
  readonly height?: number;
  readonly fps?: string;
  readonly fpsValue?: number;
  readonly videoCodec?: string;
  readonly videoProfile?: string;
  readonly audioCodec?: string;
  readonly hasAudio: boolean;
  readonly rotation?: number;
  readonly creationTime?: string;
  readonly via: "native" | "ffprobe" | "svg";
}

/** A probe per path: the info, or why not ("not-found", "unsupported", "unreadable", ...). */
export type ProbeOutcome = { readonly ok: true; readonly info: ProbeInfo } | { readonly ok: false; readonly code: string; readonly message: string };

export interface MediaCoreShape {
  readonly version: Effect.Effect<string, MediaCoreError>;
  /** Probes a batch of files with one helper process; one outcome per path, in order. */
  readonly probeMany: (paths: ReadonlyArray<string>, onProgress?: (done: number) => void) => Effect.Effect<ReadonlyArray<ProbeOutcome>, MediaCoreError>;
}

export class MediaCore extends Context.Service<MediaCore, MediaCoreShape>()("uncut/MediaCore") {}

const fail = (message: string) => new MediaCoreError({ message });

export const layer = Layer.effect(
  MediaCore,
  Effect.gen(function* () {
    const { mediaBin } = yield* ServerConfig;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    const request = (method: string) =>
      Effect.gen(function* () {
        const command = ChildProcess.make(mediaBin, [], {
          // Closing stdin after the request makes the helper exit once it has replied.
          stdin: Stream.encodeText(Stream.make(`${JSON.stringify({ id: 1, method })}\n`)),
          stderr: "inherit",
        });
        const line = yield* spawner.streamLines(command).pipe(Stream.runHead);
        if (Option.isNone(line)) return yield* fail(`${mediaBin} exited without replying`);
        const reply = yield* Effect.try({
          try: () => JSON.parse(line.value) as unknown,
          catch: () => fail(`unreadable reply from ${mediaBin}: ${line.value}`),
        });
        // The helper is another program: trust nothing about the reply's shape.
        if (typeof reply !== "object" || reply === null || Array.isArray(reply)) {
          return yield* fail(`malformed reply from ${mediaBin}: ${line.value}`);
        }
        if ("error" in reply) {
          const error = reply.error as { message?: unknown } | null;
          return yield* fail(typeof error?.message === "string" ? error.message : `error reply from ${mediaBin}: ${line.value}`);
        }
        if (!("result" in reply)) return yield* fail(`reply without a result from ${mediaBin}: ${line.value}`);
        return reply.result;
      }).pipe(
        Effect.timeoutOrElse({
          duration: Duration.seconds(5),
          orElse: () => Effect.fail(fail(`${mediaBin} didn't reply within 5s`)),
        }),
        Effect.catchTag("PlatformError", (e) => Effect.fail(fail(`can't run ${mediaBin}: ${e.message}`))),
      );

    // One helper for a whole batch: every request goes in on stdin, one reply line comes back
    // per request (matched by id), and closing stdin ends the helper. If the helper dies partway
    // (it shouldn't: it catches panics per file), the file it was on is reported and a new
    // helper carries on with the rest.
    const probeMany = (paths: ReadonlyArray<string>, onProgress: (done: number) => void = () => {}) =>
      Effect.gen(function* () {
        const outcomes = new Map<number, ProbeOutcome>();
        let pending = paths.map((_, i) => i);
        for (let attempt = 0; pending.length > 0 && attempt <= paths.length; attempt++) {
          const batch = pending;
          const input = batch.map((i) => `${JSON.stringify({ id: i, method: "probe", params: { path: paths[i] } })}\n`).join("");
          const command = ChildProcess.make(mediaBin, [], { stdin: Stream.encodeText(Stream.make(input)), stderr: "inherit" });
          yield* spawner.streamLines(command).pipe(
            Stream.take(batch.length),
            Stream.runForEach((line) =>
              Effect.sync(() => {
                let reply: { id?: unknown; result?: ProbeInfo; error?: { code?: unknown; message?: unknown } };
                try {
                  reply = JSON.parse(line);
                } catch {
                  return;
                }
                if (typeof reply?.id !== "number" || outcomes.has(reply.id)) return;
                outcomes.set(
                  reply.id,
                  reply.result && typeof reply.result === "object"
                    ? { ok: true, info: reply.result }
                    : { ok: false, code: String(reply.error?.code ?? "error"), message: String(reply.error?.message ?? "no answer") },
                );
                onProgress(outcomes.size);
              }),
            ),
            // A helper that dies ends its output; the files it didn't answer are handled below.
            Effect.catch(() => Effect.void),
          );
          const missing = batch.filter((i) => !outcomes.has(i));
          if (missing.length === 0) break;
          // Requests are answered in order, so the first unanswered one is where it stopped.
          outcomes.set(missing[0]!, { ok: false, code: "crashed", message: "The media core stopped while reading this file." });
          onProgress(outcomes.size);
          pending = missing.slice(1);
        }
        return paths.map((_, i) => outcomes.get(i) ?? { ok: false as const, code: "error", message: "the media core didn't answer for this file" });
      }).pipe(
        Effect.timeoutOrElse({
          duration: Duration.seconds(10 + paths.length),
          orElse: () => Effect.fail(fail(`${mediaBin} didn't finish probing in time`)),
        }),
        // No PlatformError reaches here: the batch loop above already turns a helper that can't
        // run into per-file "crashed" outcomes.
      );

    return MediaCore.of({
      probeMany,
      version: request("version").pipe(
        Effect.flatMap((result) => {
          const version = typeof result === "object" && result !== null ? (result as { version?: unknown }).version : undefined;
          return typeof version === "string" ? Effect.succeed(version) : Effect.fail(fail(`bad version reply: ${JSON.stringify(result)}`));
        }),
      ),
    });
  }),
);
