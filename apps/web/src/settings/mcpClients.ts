// What each outside client needs to reach Uncut's MCP gateway. No React, so tests read it.

export interface McpClient {
  readonly id: string;
  readonly label: string;
  /** Where the snippet goes. */
  readonly how: string;
  /** Undefined: there's nothing to paste. */
  readonly snippet?: (url: string, token: string) => string;
}

const json = (value: unknown) => JSON.stringify(value, null, 2);

export const MCP_CLIENTS: ReadonlyArray<McpClient> = [
  {
    id: "claude-code",
    label: "Claude Code",
    how: "Run this in a terminal. Or install the Uncut plugin, which connects by itself: claude plugin marketplace add blazejkustra/uncut, then claude plugin install uncut@uncut.",
    snippet: (url, token) => `claude mcp add --transport http --scope user uncut ${url} --header "Authorization: Bearer ${token}"`,
  },
  {
    id: "claude-desktop",
    label: "Claude Desktop",
    how: "Add this to mcpServers in Settings, Developer, Edit Config, then restart Claude. It needs Node for npx.",
    snippet: (url, token) =>
      json({
        mcpServers: {
          uncut: {
            command: "npx",
            args: ["-y", "mcp-remote", url, "--header", "Authorization:${UNCUT_AUTH}"],
            env: { UNCUT_AUTH: `Bearer ${token}` },
          },
        },
      }),
  },
  {
    id: "cursor",
    label: "Cursor",
    how: "Add this to ~/.cursor/mcp.json.",
    snippet: (url, token) => json({ mcpServers: { uncut: { url, headers: { Authorization: `Bearer ${token}` } } } }),
  },
  {
    id: "chatgpt",
    label: "ChatGPT",
    how: "ChatGPT connects to MCP servers on the internet, and Uncut listens on this Mac alone, so ChatGPT can't reach it.",
  },
];
