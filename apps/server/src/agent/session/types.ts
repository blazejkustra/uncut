import type { ChildProcess } from "node:child_process";
import type { AgentProvider, AgentTurn, AgentCard, AgentEdit, AgentUi, AgentPlan, AgentAccess, AgentContext } from "@uncut/contracts";
import type { Access } from "../agentPermissions.ts";
import type { TurnLimits } from "../agentLimits.ts";

// The agent's in-memory records: stored turns, a project's Loaded agent, a claude session, a running turn.

export type StoredTurn = { -readonly [K in keyof Omit<AgentTurn, "undo">]: Omit<AgentTurn, "undo">[K] } & {
  items: Array<{
    kind: "text" | "step" | "thinking" | "card";
    text: string;
    tool?: string;
    status?: "running" | "done" | "error";
    live?: boolean;
    error?: string;
    doing?: string;
    card?: AgentCard;
    result?: string;
  }>;
  edits: Array<AgentEdit>;
};

export interface Loaded {
  readonly dir: string;
  // The opening of the project this belongs to. The same folder opened again keeps its Loaded
  // (one turns array, one owner of turns.json) with the new opening's id.
  openId: number;
  sessionId: string | undefined;
  readonly turns: Array<StoredTurn>;
  // The newest revision the agent has seen (its last project_read, or the note it got).
  agentSeen: number;
  // Revisions the agent read in this opening: the only ones it may base an edit on. Revisions
  // restart when the server does, so a number remembered from an earlier opening could name
  // another state; this refuses it whatever it is.
  seen: Set<number>;
  // D6 note from an earlier opening (persisted as pendingNote), for the next turn.
  carried: string | undefined;
  // The note the next turn would get right now (kept saved, so a close doesn't lose it).
  pending: string;
  // turns.json exists but can't be read (permissions, I/O): never overwrite it.
  readError: string | undefined;
  // The agent's latest ui_show (D65), for the renderer to apply once. Not saved.
  ui: AgentUi | undefined;
  // Each turn as last saved (JSON), so a save only writes the turns that changed.
  readonly saved: Map<string, string>;
  // The revisions a turn started and ended at (history.db's columns; not part of AgentTurn).
  readonly bounds: Map<string, { start?: number; end?: number }>;
  // D188: brief.json, storyboard.json and reviews/ as last read or written.
  plan: AgentPlan;
  // D194: "Always for this session" answers on permission cards (grant keys), until the project closes. Not saved.
  readonly grants: Set<string>;
  // D194: folders the user confirmed on a card for this chat (--add-dir), oldest first. Not saved.
  readonly dirs: Array<string>;
  // D194: folders pasted in this chat's messages, not confirmed yet (a card offers them). Not saved.
  readonly mentioned: Array<string>;
  // D194: this chat used the web (WebSearch / WebFetch, a subagent's too): anything outside the project asks for the rest of the session (Ask first and Look only; D214: not in Auto).
  webUsed: boolean;
  // D194: secret-looking strings from tool results in this chat (a web search or address carrying one asks). Not saved.
  readonly tainted: Set<string>;
  // D261: the context window's use after the agent's last answer (the composer's meter). Kept
  // across claude sessions of the conversation (a --resume carries on from it); not saved.
  context?: AgentContext | undefined;
  // D295: when the current chat started (New chat); earlier turns are earlier chats. Saved.
  threadStart?: string | undefined;
}

/**
 * One long-lived claude for the open project's chat (D139): its MCP config folder and token live
 * as long as it does. Spawned by the first message, kept between turns, closed after an idle
 * while, when the project closes or opens again, when the plugins' tool list changes, or when it
 * dies (the next message starts another with --resume).
 */
export interface ClaudeSession {
  // Issue #106: the CLI it runs: claude (stream-json), or Codex's app-server (JSON-RPC, `codex`).
  readonly provider: AgentProvider;
  readonly codex?: CodexLink | undefined;
  readonly owner: Loaded;
  readonly openId: number;
  readonly dir: string;
  readonly token: string;
  // The plugin tools it was started with (sorted names): another list needs another session.
  readonly toolsKey: string;
  // The model and effort it was started with (D184): another choice starts another (with --resume).
  readonly model: string | undefined;
  readonly effort: string | undefined;
  // It was started with --thinking-display (D181).
  readonly thinking: string | undefined;
  // It was started with --system-prompt-snapshot off (D260 amended).
  readonly snapshotOff: boolean;
  // The --resume it was started with.
  readonly resumed: string | undefined;
  // D194: the --add-dir folders it was started with (sorted, joined): more folders need another session.
  readonly dirsKey: string;
  // D194: can_use_tool requests waiting for an answer (request id → close its card).
  readonly prompts: Map<string, () => void>;
  // D194, D214: the access it was started for (Look only: --disallowedTools; Auto: --permission-mode
  // auto and its rules): another access needs another session (it resumes the conversation).
  readonly access: Access;
  // D194: the initialize control request (as the SDK sends it) and whether it was answered; the
  // first message waits for it (at most INIT_MS).
  readonly initId: string;
  initialized: boolean;
  // It never answered initialize: every call that needs an approval is denied (fail closed).
  initFailed: boolean;
  initTimer: NodeJS.Timeout | undefined;
  waiting: (() => void) | undefined;
  child: ChildProcess | undefined;
  // The turn whose message it is working on.
  turn: Running | undefined;
  gotInit: boolean;
  closed: boolean;
  stderr: string;
  idleTimer: NodeJS.Timeout | undefined;
  killTimer: NodeJS.Timeout | undefined;
  // Turns written to it so far.
  gens: number;
  // D261: the model claude said it runs (system/init), the length of the system prompt Uncut
  // appended, and of the tool list claude got from tools/list (JSON), for the meter's estimate.
  initModel: string | undefined;
  // Where claude's credential came from (system/init apiKeySource: "ANTHROPIC_API_KEY", "apiKeyHelper",
  // "/login managed key", "none", ...), to say which sign-in an auth or billing error came from. Never the key.
  apiKeySource?: string | undefined;
  readonly systemChars: number;
  toolsChars: number | undefined;
  // What claude's get_context_usage said: the model's window and where it compacts on its own.
  window?: number | undefined;
  compactAt?: number | undefined;
  // The get_context_usage request waiting for its answer (after a /compact: its count is the context now).
  contextAsk?: { readonly id: string; readonly compacted: boolean } | undefined;
}

/**
 * Issue #106: a Codex app-server's side of a session: its JSON-RPC requests waiting for an answer,
 * the thread (Codex's conversation) and the Codex turn running, and the items it started (a file
 * change's paths, for its approval request).
 */
export interface CodexLink {
  nextId: number;
  readonly calls: Map<number, (reply: { readonly result?: any; readonly error?: { readonly message?: string } }) => void>;
  threadId: string | undefined;
  turnId: string | undefined;
  readonly items: Map<string, Record<string, any>>;
}

/** D203: an edit of the turn, tied to the step (the running Uncut tool call) that made it, so the thread shows it there. */
export function pushEdit(r: Running, edit: AgentEdit) {
  const items = r.turn.items;
  let at: number | undefined;
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]!;
    if (it.kind === "step" && it.status === "running" && /^[a-z]/.test(it.tool ?? "")) {
      at = i;
      break;
    }
  }
  r.turn.edits.push(at === undefined ? edit : { ...edit, at });
}

export interface Running {
  readonly turn: StoredTurn;
  readonly owner: Loaded;
  readonly openId: number;
  // The session it runs in (another one when a stale --resume had to start fresh).
  session: ClaudeSession;
  // The message as claude gets it (prompt, <context>, <editor-context>).
  readonly message: string;
  // export_video's range choices: the In/Out marks and the selected clips' span when the message was sent.
  readonly ranges?:
    | {
        readonly marks?: { readonly from: number; readonly to: number } | undefined;
        readonly selection?: { readonly from: number; readonly to: number } | undefined;
      }
    | undefined;
  // Claude answered something for this message: its note was delivered.
  delivered: boolean;
  // Aborted when the turn stops or ends: a plugin call still running is cancelled (D97).
  readonly abort: AbortController;
  cancelled: boolean;
  // A Stop that the interrupt didn't end in time kills the session.
  interruptTimer: NodeJS.Timeout | undefined;
  // tool_use id → index into turn.items
  readonly steps: Map<string, number>;
  // Live output (D139): the streamed message's blocks (stream index → item), and per message id
  // the streamed text/thinking items its full message replaces (not appends).
  blocks: Map<number, number>;
  messageId: string;
  readonly streamed: Map<string, Array<{ kind: "text" | "thinking"; at: number; used: boolean }>>;
  // This session's turn number (1, 2, …).
  readonly gen: number;
  // The tool calls claude announced in this turn's stream (name + canonical args): a soft log, a
  // bridge call that matches none still runs.
  readonly announced: Array<{ name: string; args: string; used: boolean }>;
  // The revision the turn's note covers: the agent has seen it once claude actually started.
  readonly noteRevision: number;
  // Why the turn was stopped when it wasn't the user's Stop (shown on the card).
  stopReason: string | undefined;
  // What the agent may do in this turn (D184).
  readonly access: AgentAccess;
  // Images to send with the message (D184).
  readonly images: ReadonlyArray<{ readonly mimeType: string; readonly data: string }>;
  // A tool call's input as it streams (stream index → JSON so far), for the now line (D182).
  readonly inputs: Map<number, { at: number; tool: string; json: string; shown: string }>;
  // D188: "Auto" with Settings' skip: storyboard_propose approves itself, the build doesn't wait.
  readonly skipStoryboard: boolean;
  // D237: this turn wrote the brief or proposed a storyboard: its timeline_edits wait for the approval.
  planned: boolean;
  // D295: storyboard proposals with stills in this turn (names their images apart).
  stills?: number;
  // D296: a storyboard this turn proposed waits for the user's answer: timeline_edit, graphic_write
  // and shader_write are refused until they approve it or ask for changes (the stills stay what they see).
  proposing?: boolean;
  // The user sent a storyboard back in this turn: approve "self" is refused for the rest of it.
  storyboardSentBack?: boolean;
  // D189: what the agent looked at in this turn since its last review (a contact sheet of the edit, phone-size frames).
  looked: { sheet: boolean; phone: boolean };
  // D218: the subscription limits and sign-in problems claude reported in this turn (agentLimits.ts).
  readonly limits: TurnLimits;
  // D189: review rounds in this turn.
  reviewRounds: number;
  // Round 2's A2: the turn was reminded once to run the critic before it ends (agentPlan reviewNudge).
  nudged?: boolean;
  // D196: frames of the edit the agent rendered in this turn, by revision (render_frames, contact_sheet): a fix claim needs its moment rendered at the current revision.
  rendered: Array<{ stamp: string; frames: ReadonlyArray<number> }>;
  // D196: graphic files written in this turn (a graphic's change doesn't move the revision).
  graphicWrites: number;
  // D206: tracks the agent's timeline_edits added in this turn (removed at its end when still empty).
  readonly addedTracks: Set<string>;
  // D196: the state the last failed round of this turn reviewed (a new round needs a change).
  reviewedStamp: string | undefined;
  // D217: what the user picked on this turn's ask_user cards (brief_write's use turns on only those skills).
  picked: Array<string>;
  // D194: permission cards one at a time (a parallel call's card waits for the one open).
  permissionQueue: Promise<unknown>;
  // D194: tool_use id → tool name in this turn (to tell web results from file data).
  readonly toolNames: Map<string, string>;
  // D194: media_download's spending in this turn.
  downloads: { bytes: number; count: number };
  // Uncut tools the model called by their bare name (graphic_write, not mcp__uncut__graphic_write):
  // Claude Code answered "No such tool available" and nothing ran; the next Uncut result says so.
  bareCalls?: Array<string>;
}
