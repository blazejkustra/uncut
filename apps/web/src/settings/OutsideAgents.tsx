// Settings › App › Outside agents: the switch for the MCP gateway (apps/desktop/src/mcpGateway.ts)
// and each client's setup. The token lives in the desktop shell, so outside it there's nothing to show.
import { useEffect, useState } from "react";

import { bridge, type McpState } from "../state/bridge.ts";
import { MCP_CLIENTS } from "./mcpClients.ts";
import "./outsideAgents.css";

function ClientSetup({ state }: { readonly state: McpState }) {
  const [clientId, setClientId] = useState(MCP_CLIENTS[0]!.id);
  const [copied, setCopied] = useState(false);
  const client = MCP_CLIENTS.find((c) => c.id === clientId)!;
  const snippet = client.snippet?.(state.url, state.token);
  const choose = (id: string) => {
    setClientId(id);
    setCopied(false);
  };
  const copy = () => {
    if (snippet) void bridge.copyText(snippet).then(() => setCopied(true));
  };
  return (
    <div className="mcp-setup">
      <div className="seg">
        {MCP_CLIENTS.map((c) => (
          <button key={c.id} className={c.id === clientId ? "active" : ""} data-testid={`mcp-client-${c.id}`} onClick={() => choose(c.id)}>
            {c.label}
          </button>
        ))}
      </div>
      <p className="muted" data-testid="mcp-how">
        {client.how}
      </p>
      {snippet && (
        <>
          <pre className="mcp-snippet" data-testid="mcp-snippet">
            {snippet}
          </pre>
          <button className="btn" data-testid="mcp-copy" onClick={copy}>
            {copied ? "Copied" : "Copy"}
          </button>
        </>
      )}
    </div>
  );
}

export function OutsideAgentsSettings() {
  const [state, setState] = useState<McpState>();
  useEffect(() => {
    void bridge.mcpState?.().then(setState);
  }, []);
  if (!state) return null;
  const set = (enabled: boolean) => void bridge.setMcpEnabled?.(enabled).then(setState);
  const renew = () => void bridge.renewMcpToken?.().then(setState);
  return (
    <div className="group">
      <div className="group-label">Outside agents</div>
      <label className="check-row">
        <input type="checkbox" data-testid="settings-mcp" checked={state.enabled} onChange={(e) => set(e.target.checked)} />
        Let agents outside Uncut work on the open project over MCP
      </label>
      <p className="muted">
        Claude Code, Claude Desktop or Cursor can use the agent's tools. Only this Mac can connect, with the token below, and big changes still wait for your
        Allow in the Agent tab.
      </p>
      {state.problem && (
        <p className="mcp-problem" data-testid="mcp-problem">
          {state.problem}
        </p>
      )}
      {state.enabled && (
        <>
          <ClientSetup state={state} />
          <button className="btn" data-testid="mcp-new-token" onClick={renew}>
            New token
          </button>
        </>
      )}
    </div>
  );
}
