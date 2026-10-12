// The agent bridge (D40): the MCP server the agent CLI starts (mcp.ts) forwards here.
//   GET  /agent/tools  → the MCP tool list
//   POST /agent/call   → { name, args } → an MCP tools/call result
// On the server's own port, but not with the app's token: each turn gets its own random token
// (header x-uncut-agent-token), which stops working when the turn ends or is cancelled, so a
// leftover MCP process (or anything else on this Mac) can't edit the project outside a turn.
import { AGENT_BRIDGE_PATH, AGENT_TOKEN_HEADER } from "@uncut/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { Agent } from "./agent.ts";

const unauthorized = () => HttpServerResponse.text("Unauthorized", { status: 401 });
const json = (value: unknown) => HttpServerResponse.text(JSON.stringify(value), { contentType: "application/json" });

const tokenOf = (request: HttpServerRequest.HttpServerRequest) => {
  const value = request.headers[AGENT_TOKEN_HEADER];
  return typeof value === "string" ? value : null;
};

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const agent = yield* Agent;
    const tools = HttpRouter.add(
      "GET",
      `${AGENT_BRIDGE_PATH}/tools`,
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const list = yield* agent.tools(tokenOf(request));
        return list ? json(list) : unauthorized();
      }),
    );
    const call = HttpRouter.add(
      "POST",
      `${AGENT_BRIDGE_PATH}/call`,
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const token = tokenOf(request);
        // Check the token before reading the body: strangers get nothing parsed.
        if (!(yield* agent.tools(token))) return unauthorized();
        const body = yield* request.json.pipe(Effect.orElseSucceed(() => undefined));
        if (!body || typeof body !== "object") return HttpServerResponse.text("Bad request", { status: 400 });
        const { name, args } = body as { name?: unknown; args?: unknown };
        const result = yield* agent.call(token, name, args);
        return result ? json(result) : unauthorized();
      }),
    );
    return Layer.mergeAll(tools, call);
  }),
);
