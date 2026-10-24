// D260 (issue #81): everything the agent can read about Uncut: the system prompt, the docs_read
// topics and every description in its tool list. Tests check what the agent can learn against it.
import { ALL_DOCS, mcpTools, SYSTEM_PROMPT } from "../../apps/server/src/agent/agentTools.ts";

const descriptions = (value: unknown, out: Array<string>): Array<string> => {
  if (Array.isArray(value)) for (const v of value) descriptions(v, out);
  else if (value && typeof value === "object")
    for (const [k, v] of Object.entries(value)) k === "description" && typeof v === "string" ? out.push(v) : descriptions(v, out);
  return out;
};

export const AGENT_TEXT = [SYSTEM_PROMPT, ALL_DOCS, ...descriptions(mcpTools(), [])].join("\n");
