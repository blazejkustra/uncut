// The renderer's one long-lived connection to the server: an Effect RPC client over a
// WebSocket that reconnects on its own (exponential backoff, capped at 5 s) and reports
// connects and drops, so the UI can show "Reconnecting…" and refetch state.
import { DROPPED_QUERY_PARAM, TOKEN_QUERY_PARAM, WsRpcGroup, type ServerConnection } from "@uncut/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import { RpcClient, RpcSerialization } from "effect/rpc";
import * as Socket from "effect/socket/Socket";
import * as Stream from "effect/Stream";

import { BEAT_MS, stallClock } from "./stallClock.ts";

const makeClient = RpcClient.make(WsRpcGroup);
type Client = typeof makeClient extends Effect.Effect<infer C, infer _E, infer _R> ? C : never;
class WsClient extends Context.Service<WsClient, Client>()("uncut/WsClient") {}

/** What every call resolves to: never a rejected promise. */
export type Result<A> = { readonly ok: true; readonly value: A } | { readonly ok: false; readonly error: CallError };

/** A typed server error (ProjectError, EditRefused, …) or a transport problem. */
export interface CallError {
  readonly _tag: string;
  readonly message: string;
  readonly reason?: string;
  readonly details?: ReadonlyArray<{ readonly code: string; readonly path: string; readonly message: string }>;
  /** ProjectError "open-elsewhere": the pid of the server that has the project open. */
  readonly holderPid?: number;
}

const CALL_TIMEOUT = Duration.seconds(15);

export interface Connection {
  /** `timeoutMs`: how long to wait for the answer (15 s unless a call needs longer, e.g. a take's conversion, D114). */
  readonly call: <A>(f: (client: Client) => Effect.Effect<A, unknown>, timeoutMs?: number) => Promise<Result<A>>;
  /** Run a streaming call, handing each value to `onValue`. Ends when the socket drops; returns a cancel. */
  readonly subscribe: <A>(f: (client: Client) => Stream.Stream<A, unknown>, onValue: (value: A) => void) => () => void;
}

/**
 * Opens the window's WebSockets, telling the server on each reconnect why the last one dropped
 * (DROPPED_QUERY_PARAM, for server.log): "window" when this page gave up on it (no answer in
 * time), else the close code; with the longest stall of the page while it was open.
 */
function reportingDrops(longestStall: () => number) {
  let dropped: string | undefined;
  let current: WebSocket | undefined;
  return (url: string, options?: Socket.WebSocketConstructorOptions) => {
    if (options !== undefined && typeof options !== "string" && !Array.isArray(options))
      throw new TypeError("WebSocket client options are not supported in the window");
    const target = new URL(url);
    if (dropped) target.searchParams.set(DROPPED_QUERY_PARAM, dropped);
    const ws = new globalThis.WebSocket(target.href, options);
    current = ws;
    // A socket replaced already (its close came late) says nothing about the one after it.
    const note = (why: string) => {
      if (ws === current) dropped ??= `${why},stall=${(longestStall() / 1000).toFixed(1)}s`;
    };
    const close = ws.close.bind(ws);
    ws.close = (code?: number, reason?: string) => {
      note("window");
      close(code, reason);
    };
    ws.addEventListener("open", () => {
      dropped = undefined;
      longestStall();
    });
    ws.addEventListener("close", (event) => note(`close-${event.code}`));
    return ws;
  };
}

/** Transport failures: the call may or may not have reached the server. */
export const isTransportError = (error: CallError) => ["RpcClientError", "Timeout", "NotConnected"].includes(error._tag);

export function connect({ url, token }: ServerConnection, hooks: { readonly onConnect: () => void; readonly onDisconnect: () => void }): Connection {
  const socketUrl = new URL(url);
  socketUrl.searchParams.set(TOKEN_QUERY_PARAM, token);
  const stall = stallClock(Clock.Clock.defaultValue());
  setInterval(stall.beat, BEAT_MS);
  const socket = Socket.layerWebSocket(socketUrl.href, { openTimeout: Duration.seconds(3) }).pipe(
    Layer.provide(Layer.succeed(Socket.WebSocketConstructor, reportingDrops(stall.takeLongest))),
  );
  const protocol = RpcClient.layerProtocolSocket({
    // Pings every 2 s; 6 s of silence counts as a dropped connection (on the stall clock: time the
    // page itself couldn't run doesn't count).
    pingInterval: Duration.seconds(2),
    pingTimeout: Duration.seconds(6),
    retryTransientErrors: true,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(
        socket,
        RpcSerialization.layerJson,
        Layer.succeed(Clock.Clock, stall.clock),
        Layer.succeed(RpcClient.ConnectionHooks, {
          onConnect: Effect.sync(hooks.onConnect),
          onDisconnect: Effect.sync(hooks.onDisconnect),
        }),
      ),
    ),
  );
  const runtime = ManagedRuntime.make(Layer.effect(WsClient, makeClient).pipe(Layer.provide(protocol)));

  return {
    call: async (f, timeoutMs) => {
      const exit = await runtime.runPromiseExit(
        WsClient.use(f).pipe(
          Effect.timeoutOrElse({
            duration: timeoutMs ? Duration.millis(timeoutMs) : CALL_TIMEOUT,
            orElse: () => Effect.fail({ _tag: "Timeout", message: "The server didn't answer" }),
          }),
        ),
      );
      if (Exit.isSuccess(exit)) return { ok: true, value: exit.value };
      const error = Cause.squash(exit.cause) as Partial<CallError> | undefined;
      const tag = typeof error?._tag === "string" ? error._tag : "Error";
      // A dropped socket surfaces as RpcClientError; the UI only needs to know it's not connected.
      const message = tag === "RpcClientError" ? "Not connected to the server" : String(error?.message ?? error);
      return { ok: false, error: { ...error, _tag: tag, message } };
    },
    subscribe: (f, onValue) => {
      const fiber = runtime.runFork(WsClient.use((client) => Stream.runForEach(f(client), (value) => Effect.sync(() => onValue(value)))).pipe(Effect.ignore));
      return () => void runtime.runFork(Fiber.interrupt(fiber));
    },
  };
}
