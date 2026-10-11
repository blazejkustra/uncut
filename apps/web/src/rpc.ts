import { RPC_METHODS, TOKEN_QUERY_PARAM, WsRpcGroup, type ServerConnection } from "@uncut/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { RpcClient, RpcSerialization } from "effect/rpc";
import * as Socket from "effect/socket/Socket";

const protocolLayer = ({ url, token }: ServerConnection) => {
  const socketUrl = new URL(url);
  socketUrl.searchParams.set(TOKEN_QUERY_PARAM, token);
  const socket = Socket.layerWebSocket(socketUrl.href, { openTimeout: Duration.seconds(5) }).pipe(
    Layer.provide(Socket.layerWebSocketConstructorGlobal),
  );
  return RpcClient.layerProtocolSocket({ retryTransientErrors: false }).pipe(
    Layer.provide(Layer.mergeAll(socket, RpcSerialization.layerJson)),
  );
};

// One-shot for now: open the socket, call server.hello, close.
export const fetchHello = (connection: ServerConnection) =>
  Effect.gen(function* () {
    const client = yield* RpcClient.make(WsRpcGroup);
    return yield* client[RPC_METHODS.serverHello]({});
  }).pipe(
    Effect.scoped,
    Effect.provide(protocolLayer(connection)),
    Effect.timeout(Duration.seconds(10)),
    Effect.runPromise,
  );
