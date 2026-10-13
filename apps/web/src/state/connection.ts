// The renderer's one long-lived connection to the server: an Effect RPC client over a
// WebSocket that reconnects on its own (exponential backoff, capped at 5 s) and reports
// connects and drops, so the UI can show "Reconnecting…" and refetch state.
import { TOKEN_QUERY_PARAM, WsRpcGroup, type ServerConnection } from "@uncut/contracts";
import * as Cause from "effect/Cause";
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
}

const CALL_TIMEOUT = Duration.seconds(15);

export interface Connection {
  readonly call: <A>(f: (client: Client) => Effect.Effect<A, unknown>) => Promise<Result<A>>;
  /** Run a streaming call, handing each value to `onValue`. Ends when the socket drops; returns a cancel. */
  readonly subscribe: <A>(f: (client: Client) => Stream.Stream<A, unknown>, onValue: (value: A) => void) => () => void;
}

/** Transport failures: the call may or may not have reached the server. */
export const isTransportError = (error: CallError) => ["RpcClientError", "Timeout", "NotConnected"].includes(error._tag);

export function connect(
  { url, token }: ServerConnection,
  hooks: { readonly onConnect: () => void; readonly onDisconnect: () => void },
): Connection {
  const socketUrl = new URL(url);
  socketUrl.searchParams.set(TOKEN_QUERY_PARAM, token);
  const socket = Socket.layerWebSocket(socketUrl.href, { openTimeout: Duration.seconds(3) }).pipe(
    Layer.provide(Socket.layerWebSocketConstructorGlobal),
  );
  const protocol = RpcClient.layerProtocolSocket({
    // Pings every 2 s; 6 s of silence counts as a dropped connection.
    pingInterval: Duration.seconds(2),
    pingTimeout: Duration.seconds(6),
    retryTransientErrors: true,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(
        socket,
        RpcSerialization.layerJson,
        Layer.succeed(RpcClient.ConnectionHooks, {
          onConnect: Effect.sync(hooks.onConnect),
          onDisconnect: Effect.sync(hooks.onDisconnect),
        }),
      ),
    ),
  );
  const runtime = ManagedRuntime.make(Layer.effect(WsClient, makeClient).pipe(Layer.provide(protocol)));

  return {
    call: async (f) => {
      const exit = await runtime.runPromiseExit(
        WsClient.use(f).pipe(
          Effect.timeoutOrElse({ duration: CALL_TIMEOUT, orElse: () => Effect.fail({ _tag: "Timeout", message: "The server didn't answer" }) }),
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
      const fiber = runtime.runFork(
        WsClient.use((client) => Stream.runForEach(f(client), (value) => Effect.sync(() => onValue(value)))).pipe(Effect.ignore),
      );
      return () => void runtime.runFork(Fiber.interrupt(fiber));
    },
  };
}
