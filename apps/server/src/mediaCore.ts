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

import { ServerConfig } from "./config.ts";

export interface MediaCoreShape {
  readonly version: Effect.Effect<string, MediaCoreError>;
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
        Effect.catchTag("PlatformError", (e) =>
          Effect.fail(fail(`can't run ${mediaBin}: ${e.message}`)),
        ),
      );

    return MediaCore.of({
      version: request("version").pipe(
        Effect.flatMap((result) => {
          const version =
            typeof result === "object" && result !== null ? (result as { version?: unknown }).version : undefined;
          return typeof version === "string"
            ? Effect.succeed(version)
            : Effect.fail(fail(`bad version reply: ${JSON.stringify(result)}`));
        }),
      ),
    });
  }),
);
