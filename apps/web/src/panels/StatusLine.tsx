import { useApp } from "../state/store.ts";

/** "Server connected, server v0.0.1, media core v0.0.1", or why it isn't. */
export function StatusLine() {
  const { connection, connectionMessage, hello } = useApp();
  const view =
    connection === "connected" && hello
      ? { state: "connected", text: `Server connected, server v${hello.version}, media core v${hello.mediaCore.version}` }
      : connection === "connected" || connection === "connecting"
        ? { state: "connecting", text: connectionMessage ? `Connected, but: ${connectionMessage}` : "Connecting to server…" }
        : connection === "reconnecting"
          ? { state: "connecting", text: "Reconnecting to server…" }
          : { state: "error", text: `Server unavailable: ${connectionMessage ?? "unknown error"}` };
  return (
    <div className="status" data-state={view.state} data-testid="status">
      <span className="dot" />
      <span>{view.text}</span>
    </div>
  );
}
