// D214: the composer's access modes (agentPermissions.ts).
export type Access = "look" | "ask" | "auto";

/** D214: the composer's names for the access modes (on cards' refusals and in the agent's context). */
export const ACCESS_NAME: Record<Access, string> = { look: "Look only", ask: "Ask first", auto: "Auto" };

/** D214: claude's --permission-mode per access: Auto is Claude Code's own auto mode; the others ask Uncut. */
export const permissionMode = (access: Access): "auto" | "default" => (access === "auto" ? "auto" : "default");
