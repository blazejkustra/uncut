// Local transcription's tools (D68): whisper-cli (Homebrew's whisper-cpp) found on the login
// shell's PATH like ffmpeg, and the speech models (whisperModels.ts) with their downloads, for the
// Setup row (transcription.* RPCs) and the transcript analyzer (resolve).
import { TranscriptionError, type TranscriptionState } from "@uncut/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { Cancelled } from "./analysisRunner.ts";
import { ServerConfig } from "../app/config.ts";
import { Settings } from "../app/settings.ts";
import { sweepStaleTranscriptTemp } from "./transcription.ts";
import { which } from "../app/setup.ts";
import { DEFAULT_MODEL, modelInfo, modelsDir, ModelStore } from "./whisperModels.ts";

// The binary's name and the missing-binary sentence are the plugin's (plugins/whisper-transcribe, D100).
import { NO_WHISPER, WHISPER_BIN } from "../../../../plugins/whisper-transcribe/whisper.ts";
export { NO_WHISPER, WHISPER_BIN };

/** What a transcript needs: the binary and the model file (downloaded now if needed). */
export type ResolveWhisper = (options: { readonly signal: AbortSignal; readonly onDownload?: (fraction: number) => void }) => Promise<{ readonly bin: string; readonly model: string; readonly modelId: string }>;

export interface WhisperShape {
  readonly state: Stream.Stream<TranscriptionState>;
  readonly download: (model?: string) => Effect.Effect<void, TranscriptionError>;
  readonly cancelDownload: (model?: string) => Effect.Effect<void>;
  readonly select: (model: string) => Effect.Effect<void, TranscriptionError>;
  readonly resolve: ResolveWhisper;
}

export class Whisper extends Context.Service<Whisper, WhisperShape>()("uncut/Whisper") {}

export const layer = Layer.effect(
  Whisper,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const settings = yield* Settings;
    const saved = yield* settings.whisperModel;
    const initial = saved && modelInfo(saved) ? saved : DEFAULT_MODEL;
    let ref: SubscriptionRef.SubscriptionRef<TranscriptionState> | undefined;
    const store = new ModelStore({
      dir: modelsDir(config.dataDir),
      selected: initial,
      baseUrl: config.whisperModelUrl,
      onChange: (state) => {
        if (ref) Effect.runSync(SubscriptionRef.set(ref, state));
      },
    });
    yield* Effect.promise(() => store.refresh());
    ref = yield* SubscriptionRef.make<TranscriptionState>(store.state());
    yield* Effect.addFinalizer(() => Effect.sync(() => store.shutdown()));
    // Transcript temp folders a crashed or force-quit server left behind.
    void sweepStaleTranscriptTemp();
    const stateRef = ref;
    // Choices one at a time, so the saved model and the shown one are always the last one asked for.
    const selectLock = yield* Semaphore.make(1);

    const unknown = (model: string) => new TranscriptionError({ reason: "unknown-model", message: `There's no speech model "${model}".` });

    return Whisper.of({
      // Fresh on every subscribe: a model file removed by hand shows as not installed.
      state: Stream.unwrap(Effect.map(Effect.promise(() => store.refresh()), () => SubscriptionRef.changes(stateRef))),
      download: (model) =>
        Effect.suspend(() => {
          const id = model ?? store.selectedModel();
          if (!modelInfo(id)) return Effect.fail(unknown(id));
          return Effect.promise(async () => {
            await store.isInstalled(id);
            store.download(id);
          });
        }),
      cancelDownload: (model) => Effect.sync(() => store.cancel(model)),
      select: (model) =>
        selectLock.withPermits(1)(Effect.suspend(() => {
          if (!modelInfo(model)) return Effect.fail(unknown(model));
          if (model === store.selectedModel()) return Effect.void;
          // Saved before it's shown or answered, so a restart right after keeps it.
          return Effect.andThen(settings.setWhisperModel(model), Effect.sync(() => store.select(model)));
        })),
      resolve: async ({ signal, onDownload }) => {
        await config.shellReady;
        const bin = await which(WHISPER_BIN, process.env.PATH ?? "");
        if (!bin) throw new Error(NO_WHISPER);
        const modelId = store.selectedModel();
        try {
          const model = await store.ensure(modelId, { signal, ...(onDownload ? { onProgress: onDownload } : {}) });
          return { bin, model, modelId };
        } catch (error) {
          if (signal.aborted) throw error;
          const info = modelInfo(modelId)!;
          if (error instanceof Cancelled) throw new Error(`The speech model's download (${info.name}) was stopped before it finished. Ask again to download it.`);
          throw new Error(`The speech model (${info.name}, ${Math.round(info.bytes / 1e6)} MB) couldn't be downloaded: ${(error as Error).message}`);
        }
      },
    });
  }),
);
