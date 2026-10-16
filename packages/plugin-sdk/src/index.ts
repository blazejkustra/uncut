// The Uncut plugin protocol, uncut.module/1 (D102), in one place: the TypeScript types below are its
// documentation, and `serve` is a small helper that writes a plugin's stdio server in a few lines.
//
// A plugin is a folder with an uncut.module.json (spec/schema/module.schema.json) whose runtime is
// `{"type": "process", "command": ..., "args": [...]}`. Uncut starts the command in the plugin's
// folder on the first call to one of its tools and talks MCP to it over stdio: newline-delimited
// JSON-RPC 2.0, one message per line, UTF-8. stdout carries only protocol messages (anything that
// isn't a JSON object is ignored); stderr is the plugin's log (Uncut keeps the last lines for its
// error messages). A plugin whose command is "node" runs on Uncut's own Node (TypeScript runs as
// is) and can import this module as "@uncut/plugin-sdk": Uncut provides it, nothing to install.
//
// The conversation, in order:
//   1. Uncut → `initialize` (InitializeParams) → the plugin answers InitializeResult.
//   2. Uncut → `notifications/initialized`.
//   3. Uncut → `tools/call` (ToolCallParams) → the plugin answers a ToolResult. Calls can overlap
//      (each has its own id). The agent sees the manifest's `agentTools` (known before the process
//      starts); Uncut itself may call other tools the plugin serves (the Capture tab, a transcript).
//      `_meta` carries the call's context (CallMeta): the project's folders, by capability, and a
//      `progressToken` when Uncut wants progress.
//   4. The plugin → `notifications/progress` (ProgressParams) for a call that has a progressToken.
//   5. Uncut → `notifications/cancelled` (CancelledParams) when a call is no longer wanted (the
//      agent's turn ended, the user cancelled): stop the work and send no answer for it.
//   6. Uncut closes the plugin's stdin when it's done with it, then SIGTERM, then SIGKILL to the
//      plugin's process group 0.5 s later. Exit when stdin closes.
// A call that takes longer than the manifest's runtime.timeoutSeconds (default 120, at most 1800)
// fails and the process group is killed. Uncut answers a plugin's `ping` with {}; it offers no
// other requests (sampling, roots...) and answers them with error -32601.
//
// A plugin returns data; it never edits the project itself. One exception, declared and checked
// by Uncut (D98): a plugin allowed to add media (media:write) may write a file into CallMeta's
// captureDir and declare it in `structuredContent.uncut` (UncutDeclaration) for Uncut to import.
import { readFileSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";

/** The plugin protocol version this module describes. A manifest without `apiVersion` is this one. */
export const API_VERSION = "uncut.module/1";
/** Every protocol version this Uncut understands (a newer one is refused with a sentence). */
export const API_VERSIONS: ReadonlyArray<string> = [API_VERSION];
/** The MCP protocol revision Uncut speaks. */
export const MCP_PROTOCOL_VERSION = "2025-06-18";

// ---- JSON-RPC 2.0 ----

export type RequestId = number | string;
export type Json = Record<string, unknown>;

export interface JsonRpcRequest<P = unknown> {
  readonly jsonrpc: "2.0";
  readonly id: RequestId;
  readonly method: string;
  readonly params?: P;
}
export interface JsonRpcNotification<P = unknown> {
  readonly jsonrpc: "2.0";
  readonly method: string;
  readonly params?: P;
}
export interface JsonRpcSuccess<R = unknown> {
  readonly jsonrpc: "2.0";
  readonly id: RequestId;
  readonly result: R;
}
export interface JsonRpcFailure {
  readonly jsonrpc: "2.0";
  readonly id: RequestId | null;
  readonly error: { readonly code: number; readonly message: string; readonly data?: unknown };
}
export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcSuccess | JsonRpcFailure;

// ---- Uncut → plugin ----

/** `initialize`'s params. */
export interface InitializeParams {
  readonly protocolVersion: string;
  readonly capabilities: Json;
  readonly clientInfo: { readonly name: "uncut"; readonly version: string };
}

/** `initialize`'s answer. */
export interface InitializeResult {
  readonly protocolVersion: string;
  readonly capabilities: { readonly tools: Json };
  readonly serverInfo: { readonly name: string; readonly version: string };
  readonly _meta?: { readonly "uncut/apiVersion"?: string };
}

/** What Uncut tells a plugin about a call, as `_meta` on tools/call. Folders are absolute paths. */
export interface CallMeta {
  /** Present when Uncut wants notifications/progress for this call (it's the request's id). */
  readonly progressToken?: RequestId;
  /** The open project's folder: plugins with project:read. */
  readonly "uncut/projectDir"?: string;
  /** Where a plugin that adds media writes its files: `<project>/media/captures` (media:write; it exists). */
  readonly "uncut/captureDir"?: string;
  /** The project's saved flows, `<project>/flows`: capture-source plugins with project:read or media:write. */
  readonly "uncut/flowsDir"?: string;
}

/** `tools/call`'s params. */
export interface ToolCallParams {
  readonly name: string;
  readonly arguments?: Json;
  readonly _meta?: CallMeta;
}

/** `notifications/cancelled`'s params: stop the call `requestId` and send no answer for it. */
export interface CancelledParams {
  readonly requestId: RequestId;
  readonly reason?: string;
}

// ---- plugin → Uncut ----

/** `notifications/progress`'s params (only for a call whose _meta has a progressToken). */
export interface ProgressParams {
  readonly progressToken: RequestId;
  readonly progress: number;
  readonly total?: number;
  readonly message?: string;
}

export interface TextContent {
  readonly type: "text";
  readonly text: string;
}
/** PNG, JPEG, GIF or WebP, base64, at most 5 MB decoded; others are left out with a note. */
export interface ImageContent {
  readonly type: "image";
  readonly data: string;
  readonly mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp" | (string & {});
}
export type Content = TextContent | ImageContent;

/**
 * A tool's answer. The agent reads `content` (text and images); `isError` marks a failure it
 * should read as one. `structuredContent` is passed on as JSON text when there's no content;
 * its `uncut` key is for Uncut only and never reaches the agent.
 */
export interface ToolResult {
  readonly content: ReadonlyArray<Content>;
  readonly structuredContent?: Json & { readonly uncut?: UncutDeclaration };
  readonly isError?: boolean;
}

/** Where a declared file came from (stored on the media; `module` is always set to the plugin's id). */
export interface DeclaredSource {
  /** Ignored: Uncut stores the plugin's own id. */
  readonly module?: string;
  /** The device it was recorded on. */
  readonly device?: string;
  /** The saved flow it replays, project-relative (`flows/<name>.yaml`), so it can be re-shot. */
  readonly flow?: string;
}

/**
 * A file the plugin made, for Uncut to act on (D98). Honoured only for a plugin with media:write,
 * and only for a file whose real path is inside the call's captureDir; anything else is refused
 * with a sentence. `media`: import it as new media. `replace`: swap it in for the existing media
 * `media` (a re-shoot); items past the new end are trimmed, or held with overrun "hold".
 */
export type UncutDeclaration =
  | { readonly media: { readonly path: string; readonly name?: string; readonly source?: DeclaredSource } }
  | { readonly replace: { readonly media: string; readonly path: string; readonly source?: DeclaredSource; readonly overrun?: "trim" | "hold" } };

// ---- the manifest (the parts a server reads) ----

export interface AgentTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Json & { readonly type: "object" };
}

/** uncut.module.json: see spec/schema/module.schema.json for all of it. */
export interface PluginManifest {
  readonly manifest: "uncut.module/0";
  /** The plugin protocol it was written for; missing means uncut.module/1. */
  readonly apiVersion?: string;
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly kind: string;
  readonly runtime: { readonly type: "process"; readonly command: string; readonly args?: ReadonlyArray<string>; readonly timeoutSeconds?: number };
  readonly capabilities?: ReadonlyArray<string>;
  readonly agentTools?: ReadonlyArray<AgentTool>;
  /** D281: an .svg file at the top of the plugin's folder, its icon in Settings (plain shapes only). */
  readonly icon?: string;
  readonly [key: string]: unknown;
}

// ---- results ----

/** A text answer, with optional structured content; `isError` for a failure. */
export const text = (body: string, structured?: ToolResult["structuredContent"], isError = false): ToolResult => ({
  content: [{ type: "text", text: body }],
  ...(structured !== undefined ? { structuredContent: structured } : {}),
  ...(isError ? { isError: true } : {}),
});

/** A failure the agent reads, in one sentence. */
export const failure = (body: string): ToolResult => text(body, undefined, true);

/** An image item (base64). */
export const image = (data: string, mimeType: ImageContent["mimeType"]): ImageContent => ({ type: "image", data, mimeType });

/** Thrown by a tool: its message is the answer (isError), as is. Other errors are prefixed by `onError`. */
export class ToolError extends Error {}

// ---- the server ----

/** What a tool handler gets besides its arguments. */
export interface ToolContext {
  /** The tool's name (useful for a `fallback` handler). */
  readonly name: string;
  /** The call's JSON-RPC id. */
  readonly id: RequestId;
  /** Aborted when Uncut cancels the call (no answer is sent then) or the plugin is stopping. */
  readonly signal: AbortSignal;
  readonly projectDir: string | undefined;
  readonly captureDir: string | undefined;
  readonly flowsDir: string | undefined;
  /** The raw `_meta`. */
  readonly meta: CallMeta;
  /** Reports progress, when Uncut asked for it (else does nothing). */
  readonly progress: (progress: number, total?: number, message?: string) => void;
}

export type ToolHandler = (args: Json, context: ToolContext) => ToolResult | Promise<ToolResult>;

export interface ServeOptions {
  /** The plugin's uncut.module.json: a URL or path (e.g. `new URL("./uncut.module.json", import.meta.url)`), or the parsed manifest. tools/list and serverInfo come from it. */
  readonly manifest: URL | string | PluginManifest;
  /** The tools, by name: the manifest's agentTools and any tool Uncut itself calls. */
  readonly tools: Readonly<Record<string, ToolHandler>>;
  /** Answers a tool not in `tools` (default: "No tool <name>", isError). */
  readonly fallback?: ToolHandler;
  /** Turns an error a tool threw into its answer (default: its message, isError; a ToolError always as is). */
  readonly onError?: (error: unknown, name: string) => ToolResult;
  /** Runs once on the way out (stdin closed, SIGTERM, SIGINT, an uncaught error), before the process exits. */
  readonly onExit?: () => void;
  /** Every notification from Uncut, after the server handled it (cancelled, initialized...). */
  readonly onNotification?: (method: string, params: unknown) => void;
  /** Answers to the plugin's own requests (sent with `send`). */
  readonly onReply?: (message: JsonRpcSuccess | JsonRpcFailure) => void;
  /** Where messages come from and go (default: this process's stdin and stdout). */
  readonly input?: NodeJS.ReadableStream;
  readonly output?: { write(chunk: string): unknown };
  /** Exit the process on stdin end, SIGTERM, SIGINT and uncaught errors (default true). */
  readonly exitOnClose?: boolean;
}

export interface PluginServer {
  readonly manifest: PluginManifest;
  /** Writes one raw JSON-RPC message (`jsonrpc` is added). */
  readonly send: (message: Json) => void;
  /** Sends a notification. */
  readonly notify: (method: string, params?: unknown) => void;
  /** The calls running now, by id. */
  readonly running: ReadonlyMap<RequestId, AbortController>;
  /** Stops reading (tests; with exitOnClose the process exits on its own). */
  readonly close: () => void;
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));
const isObject = (x: unknown): x is Json => !!x && typeof x === "object" && !Array.isArray(x);
const str = (x: unknown) => (typeof x === "string" && x ? x : undefined);

function loadManifest(source: ServeOptions["manifest"]): PluginManifest {
  if (typeof source === "object" && !(source instanceof URL)) return source;
  return JSON.parse(readFileSync(source, "utf8")) as PluginManifest;
}

/**
 * Starts the plugin's stdio server: answers initialize, ping and tools/list (the manifest's
 * agentTools), dispatches tools/call to `tools`, passes progress on, cancels a call on
 * notifications/cancelled (its signal aborts and no answer is sent) and exits when Uncut is done.
 */
export function serve(options: ServeOptions): PluginServer {
  const manifest = loadManifest(options.manifest);
  const output = options.output ?? process.stdout;
  const input = options.input ?? process.stdin;
  const running = new Map<RequestId, AbortController>();
  const send = (message: Json) => void output.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  const notify = (method: string, params?: unknown) => send({ method, ...(params === undefined ? {} : { params }) });
  const answerError = options.onError ?? ((error: unknown) => failure(messageOf(error)));

  async function call(id: RequestId, params: Json) {
    const name = String(params.name ?? "");
    const handler = options.tools[name] ?? options.fallback;
    if (!handler) return send({ id, result: failure(`No tool ${name}`) });
    const abort = new AbortController();
    running.set(id, abort);
    const meta = (isObject(params._meta) ? params._meta : {}) as CallMeta;
    const token = meta.progressToken;
    const context: ToolContext = {
      name,
      id,
      signal: abort.signal,
      projectDir: str(meta["uncut/projectDir"]),
      captureDir: str(meta["uncut/captureDir"]),
      flowsDir: str(meta["uncut/flowsDir"]),
      meta,
      progress: (progress, total, message) => {
        if (token === undefined || abort.signal.aborted) return;
        notify("notifications/progress", { progressToken: token, progress, ...(total !== undefined ? { total } : {}), ...(message ? { message } : {}) } satisfies ProgressParams);
      },
    };
    let result: ToolResult;
    try {
      result = await handler(isObject(params.arguments) ? params.arguments : {}, context);
    } catch (error) {
      result = error instanceof ToolError ? failure(error.message) : answerError(error, name);
    } finally {
      running.delete(id);
    }
    // A cancelled call gets no answer (MCP).
    if (!abort.signal.aborted) send({ id, result });
  }

  function onMessage(msg: Json) {
    const { id, method } = msg as { id?: unknown; method?: unknown };
    const params = isObject(msg.params) ? msg.params : {};
    const hasId = typeof id === "number" || typeof id === "string";
    if (typeof method !== "string") {
      if (hasId && ("result" in msg || "error" in msg)) options.onReply?.(msg as unknown as JsonRpcSuccess | JsonRpcFailure);
      return;
    }
    if (!hasId) {
      if (method === "notifications/cancelled") running.get((params as Partial<CancelledParams>).requestId as RequestId)?.abort();
      options.onNotification?.(method, msg.params);
      return;
    }
    if (method === "initialize") {
      const result: InitializeResult = {
        protocolVersion: str(params.protocolVersion) ?? MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: manifest.id, version: manifest.version },
        _meta: { "uncut/apiVersion": manifest.apiVersion ?? API_VERSION },
      };
      return send({ id, result });
    }
    if (method === "ping") return send({ id, result: {} });
    if (method === "tools/list") return send({ id, result: { tools: manifest.agentTools ?? [] } });
    if (method === "tools/call") return void call(id, params);
    send({ id, error: { code: -32601, message: `Unknown method ${method}` } });
  }

  // Our own line reader: whatever arrives, it can't throw.
  let buffer = "";
  const decoder = new StringDecoder("utf8");
  const onData = (chunk: Buffer | string) => {
    buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
    for (let nl = buffer.indexOf("\n"); nl !== -1; nl = buffer.indexOf("\n")) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      let msg: unknown;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (isObject(msg)) {
        try {
          onMessage(msg);
        } catch (error) {
          process.stderr.write(`${manifest.id}: ${messageOf(error)}\n`);
        }
      }
    }
  };
  input.on("data", onData);

  let exiting = false;
  const quit = (code: number) => {
    if (exiting) return;
    exiting = true;
    for (const abort of running.values()) abort.abort();
    try {
      options.onExit?.();
    } finally {
      process.exit(code);
    }
  };
  if (options.exitOnClose !== false) {
    // stdin closed: Uncut is done with us (MCP stdio). SIGTERM: Uncut is stopping.
    input.on("end", () => quit(0));
    process.on("SIGTERM", () => quit(0));
    process.on("SIGINT", () => quit(0));
    process.on("uncaughtException", (error) => {
      process.stderr.write(`${manifest.id}: ${messageOf(error)}\n`);
      quit(1);
    });
  }

  return { manifest, send, notify, running, close: () => void input.removeListener("data", onData) };
}
