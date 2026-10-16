import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import { RPC_METHODS } from "../server.ts";

// ---- telemetry (issue #13, D223) ----

/** Whether usage data is sent, and what decided it (Settings › App; anonymous and on by default, D283). */
export const TelemetryState = Schema.Struct({
  enabled: Schema.Boolean,
  // do-not-track: DO_NOT_TRACK is set; env: UNCUT_TELEMETRY=0; settings: the user set the toggle; default: never changed, so on.
  source: Schema.Literals(["do-not-track", "env", "settings", "default"]),
  // This build sends anything at all (it has a token; dev builds and forks don't).
  configured: Schema.Boolean,
});
export type TelemetryState = typeof TelemetryState.Type;

export const TelemetryStateRpc = Rpc.make(RPC_METHODS.telemetryState, { payload: Schema.Struct({}), success: TelemetryState });
// The Settings › App toggle: saved in settings.json, effective at once.
export const TelemetrySetRpc = Rpc.make(RPC_METHODS.telemetrySet, { payload: Schema.Struct({ enabled: Schema.Boolean }), success: TelemetryState });
// An uncaught error in the window: its class name and stack, from which the server keeps only a fingerprint.
export const TelemetryCrashRpc = Rpc.make(RPC_METHODS.telemetryCrash, { payload: Schema.Struct({ name: Schema.String, stack: Schema.optional(Schema.String) }) });
