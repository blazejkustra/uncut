// The wire contract between the server and its clients: one RPC group over WebSocket.
import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";

export const WS_PATH = "/ws";
// Browsers can't set headers on a WebSocket, so the token travels as a query parameter.
export const TOKEN_QUERY_PARAM = "token";

export const RPC_METHODS = {
  serverHello: "server.hello",
} as const;

export const ServerHello = Schema.Struct({
  version: Schema.String,
  node: Schema.String,
  pid: Schema.Number,
  mediaCore: Schema.Struct({ version: Schema.String }),
});
export type ServerHello = typeof ServerHello.Type;

export class MediaCoreError extends Schema.TaggedError<MediaCoreError>()("MediaCoreError", {
  message: Schema.String,
}) {}

const ServerHelloRpc = Rpc.make(RPC_METHODS.serverHello, {
  payload: Schema.Struct({}),
  success: ServerHello,
  error: MediaCoreError,
});

export const WsRpcGroup = RpcGroup.make(ServerHelloRpc);

// What the desktop shell hands the renderer (via the preload bridge).
export interface ServerConnection {
  readonly url: string; // ws://127.0.0.1:<port>/ws
  readonly token: string;
}
