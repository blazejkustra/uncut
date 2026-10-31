import { existsSync, realpathSync, renameSync } from "node:fs";
import { readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { type AgentCard, AgentContext, type AgentEdit, type AgentMention, AGENT_IMAGE_NAME, type AgentFolder, DEFAULT_AGENT_ID } from "@uncut/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { normBrief, normStoryboard, normReview } from "../../brand/store.ts";
import { withHistory, type TurnRecord } from "../../project/history.ts";
import type { StoredTurn } from "../session/types.ts";

/** A tool_result's words: its text, or its text blocks joined (pictures left out). */
export const resultText = (content: unknown): string =>
  isString(content)
    ? content
    : Array.isArray(content)
      ? (content as Array<Record<string, unknown>>)
          .filter((x) => x?.type === "text" && isString(x.text))
          .map((x) => x.text as string)
          .join("\n")
      : "";

const historyFile = (dir: string) => join(dir, "agent", "turns.json");

export const isString = (v: unknown): v is string => typeof v === "string";
const STATUSES = new Set(["running", "done", "error", "cancelled"]);
/** D194: a built-in tool's answer kept on its step, at most this many characters. */
export const RESULT_MAX = 4000;

/** A card item read back (D186–D190): the known fields, normalised. */
function storedCard(raw: unknown): AgentCard {
  const c = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const type = (["question", "brief", "storyboard", "review", "brand"] as const).find((t) => t === c.type) ?? "brand";
  const q = c.question && typeof c.question === "object" ? (c.question as Record<string, unknown>) : undefined;
  const a = c.answer && typeof c.answer === "object" ? (c.answer as Record<string, unknown>) : undefined;
  const brief = normBrief(c.brief);
  const storyboard = normStoryboard(c.storyboard);
  const review = normReview(c.review);
  return {
    type,
    ...(q && isString(q.question)
      ? {
          question: {
            question: q.question,
            options: (Array.isArray(q.options) ? q.options : [])
              .filter((o): o is { label: string; detail?: string } => !!o && typeof o === "object" && isString(o.label))
              .map((o) => ({ label: o.label, ...(isString(o.detail) ? { detail: o.detail } : {}) })),
            multi: q.multi === true,
            freeText: q.freeText !== false,
          },
        }
      : {}),
    ...(a ? { answer: { choices: Array.isArray(a.choices) ? a.choices.filter(isString) : [], ...(isString(a.text) ? { text: a.text } : {}) } } : {}),
    ...(isString(c.outcome) ? { outcome: c.outcome } : {}),
    ...(brief ? { brief } : {}),
    ...(storyboard ? { storyboard } : {}),
    ...(review ? { review } : {}),
    ...(isString(c.text) ? { text: c.text } : {}),
  };
}

/** A turn read back from disk, or undefined when it isn't one. Turns cut off by a quit say so. */
function storedTurn(raw: unknown): StoredTurn | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const t = raw as Record<string, unknown>;
  if (!isString(t.id) || !isString(t.prompt) || !isString(t.startedAt) || !isString(t.status) || !STATUSES.has(t.status)) return undefined;
  const items = Array.isArray(t.items)
    ? t.items
        .filter(
          (i): i is StoredTurn["items"][number] =>
            !!i &&
            typeof i === "object" &&
            (i.kind === "text" || i.kind === "step" || i.kind === "thinking" || (i.kind === "card" && !!i.card && typeof i.card === "object")) &&
            isString(i.text),
        )
        .map(({ live: _live, doing: _doing, error, card, result, ...i }) => ({
          ...i,
          ...(isString(error) ? { error } : {}),
          ...(isString(result) ? { result: result.slice(0, RESULT_MAX) } : {}),
          ...(i.kind === "card" ? { card: storedCard(card) } : {}),
        }))
    : [];
  const edits = Array.isArray(t.edits)
    ? t.edits.filter((e): e is AgentEdit => !!e && typeof e === "object" && typeof e.revision === "number" && isString(e.summary) && Array.isArray(e.lines))
    : [];
  const interrupted = t.status === "running";
  return {
    id: t.id,
    prompt: t.prompt,
    startedAt: t.startedAt,
    status: interrupted ? "error" : (t.status as StoredTurn["status"]),
    items: items.map((i) => (i.status === "running" ? { ...i, status: "error" as const } : i)),
    edits,
    ...(Array.isArray(t.mentions)
      ? {
          mentions: t.mentions
            .filter(
              (m): m is { kind: AgentMention["kind"]; label: string } =>
                !!m &&
                typeof m === "object" &&
                isString(m.label) &&
                ["media", "item", "track", "marker", "moment", "range", "effect", "transition", "region"].includes(m.kind),
            )
            .map((m) => ({ kind: m.kind, label: m.label })),
        }
      : {}),
    ...(Array.isArray(t.images) ? { images: t.images.filter((x): x is string => isString(x) && AGENT_IMAGE_NAME.test(x)) } : {}),
    ...(isString(t.model) ? { model: t.model } : {}),
    ...(isString(t.note) ? { note: t.note } : {}),
    ...(Array.isArray(t.folders)
      ? {
          folders: t.folders
            .filter((f): f is AgentFolder => !!f && typeof f === "object" && isString(f.path) && typeof f.files === "number" && typeof f.folders === "number")
            .slice(0, 16)
            .map((f) => ({ path: f.path, files: f.files, folders: f.folders, ...(isString(f.problem) ? { problem: f.problem } : {}) })),
        }
      : {}),
    ...(isString(t.finishedAt) ? { finishedAt: t.finishedAt } : {}),
    ...(interrupted ? { error: "Interrupted: Uncut stopped while the agent was working." } : isString(t.error) ? { error: t.error } : {}),
    ...(typeof t.seconds === "number" ? { seconds: t.seconds } : {}),
    ...(isString(t.undoneAt) ? { undoneAt: t.undoneAt } : {}),
    ...(isString(t.redoneAt) ? { redoneAt: t.redoneAt } : {}),
    ...(t.kind === "compact" ? { kind: "compact" as const } : {}),
    ...(t.compacted && typeof t.compacted === "object" ? { compacted: compactedOf(t.compacted) } : {}),
    ...(typeof t.spend === "number" && Number.isFinite(t.spend) && t.spend > 0 ? { spend: t.spend } : {}),
    ...(Array.isArray(t.graphics) ? { graphics: t.graphics.filter(isString).slice(-200) } : {}),
    ...(t.cleanup && typeof t.cleanup === "object" ? { cleanup: cleanupOf(t.cleanup) } : {}),
    ...(isString(t.agentId) ? { agentId: t.agentId } : {}),
  };
}

/** A stored turn-end clean-up (D206). */
const compactedOf = (raw: object): NonNullable<StoredTurn["compacted"]> => {
  const c = raw as { trigger?: unknown; before?: unknown; after?: unknown };
  return {
    trigger: isString(c.trigger) ? c.trigger : "auto",
    ...(typeof c.before === "number" ? { before: c.before } : {}),
    ...(typeof c.after === "number" ? { after: c.after } : {}),
  };
};

const cleanupOf = (raw: object): NonNullable<StoredTurn["cleanup"]> => {
  const c = raw as { graphics?: unknown; tracks?: unknown; restored?: unknown };
  return {
    graphics: Array.isArray(c.graphics) ? c.graphics.filter(isString) : [],
    tracks: Array.isArray(c.tracks) ? c.tracks.filter(isString) : [],
    ...(c.restored === true ? { restored: true } : {}),
  };
};

interface History {
  readonly sessionId: string | undefined;
  readonly turns: Array<StoredTurn>;
  readonly pendingNote: string | undefined;
  readonly threadStart?: string | undefined;
  /** Turns saved as running with no agent left to finish them: the next save writes how they ended. */
  readonly orphaned?: ReadonlyArray<string>;
  readonly context?: AgentContext | undefined;
  readonly readError?: string;
}

/** The folder a project's conversation belongs to, the same however the project was opened. */
export const sessionDirOf = (dir: string) => {
  try {
    return realpathSync.native(dir);
  } catch {
    return dir;
  }
};

/**
 * The stored conversation for this folder. A copy (the folder it was saved from still holds a
 * project) starts a conversation of its own at this moment; a moved project keeps its own.
 */
function conversationHere(
  dir: string,
  stored: {
    readonly sessionId: string | undefined;
    readonly sessionDir: string | undefined;
    readonly threadStart: string | undefined;
    readonly context: string | undefined;
  },
) {
  const from = stored.sessionDir;
  const copied = !!stored.sessionId && !!from && from !== sessionDirOf(dir) && existsSync(join(from, "project.json"));
  return copied
    ? { sessionId: undefined, threadStart: new Date().toISOString(), context: undefined }
    : { sessionId: stored.sessionId, threadStart: stored.threadStart, context: storedContext(stored.context) };
}

const orphanedIn = (turns: ReadonlyArray<unknown>) =>
  turns.flatMap((t) => {
    const { id, status } = t as { id?: unknown; status?: unknown };
    return status === "running" && isString(id) ? [id] : [];
  });

const decodeContext = Schema.decodeUnknownOption(AgentContext);
function storedContext(json: string | undefined): AgentContext | undefined {
  if (!json) return undefined;
  try {
    return Option.getOrUndefined(decodeContext(JSON.parse(json)));
  } catch {
    return undefined;
  }
}

/** agent/turns.json (D51, before history.db): none is an empty history; one that can't be read is an error, never "empty". */
export async function readHistory(dir: string): Promise<History> {
  let text: string;
  try {
    text = await readFile(historyFile(dir), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { sessionId: undefined, turns: [], pendingNote: undefined };
    return { sessionId: undefined, turns: [], pendingNote: undefined, readError: (error as Error).message };
  }
  try {
    const parsed = JSON.parse(text) as { sessionId?: unknown; turns?: unknown; pendingNote?: unknown };
    if (!Array.isArray(parsed.turns)) throw new Error("no turns");
    return {
      sessionId: isString(parsed.sessionId) ? parsed.sessionId : undefined,
      turns: parsed.turns.map(storedTurn).filter((t): t is StoredTurn => t !== undefined),
      pendingNote: isString(parsed.pendingNote) && parsed.pendingNote ? parsed.pendingNote : undefined,
    };
  } catch {
    // Not JSON (or not ours): set it aside rather than overwrite it with the next turn.
    await rename(historyFile(dir), join(dir, "agent", `turns.unreadable-${Date.now()}.json`)).catch(() => {});
    return { sessionId: undefined, turns: [], pendingNote: undefined };
  }
}

const byStart = (a: StoredTurn, b: StoredTurn) => Date.parse(a.startedAt) - Date.parse(b.startedAt);

/**
 * The agent's history (D71): from history.db, after moving in an agent/turns.json left from before
 * (its turns history.db doesn't have yet, its session and note when history.db has none), which is
 * then renamed so it's read once. A turns.json that can't be read stops here (turns are refused, the
 * file is left alone). A history in memory (history.db unusable) reads turns.json but keeps it.
 */
export async function loadAgentHistory(dir: string, agentId: string = DEFAULT_AGENT_ID): Promise<History> {
  if (agentId !== DEFAULT_AGENT_ID) {
    return withHistory(dir, (db) => {
      const stored = db.agent(agentId);
      return {
        ...conversationHere(dir, stored),
        turns: stored.turns.map(storedTurn).filter((t): t is StoredTurn => t !== undefined),
        pendingNote: stored.pendingNote,
        orphaned: orphanedIn(stored.turns),
      };
    });
  }
  const legacy = await readHistory(dir);
  if (legacy.readError) return legacy;
  return withHistory(dir, (db) => {
    const stored = db.agent();
    const turns = stored.turns.map(storedTurn).filter((t): t is StoredTurn => t !== undefined);
    if (!existsSync(historyFile(dir))) return { ...conversationHere(dir, stored), turns, pendingNote: stored.pendingNote, orphaned: orphanedIn(stored.turns) };
    const known = new Set(turns.map((t) => t.id));
    const merged = [...turns, ...legacy.turns.filter((t) => !known.has(t.id))].sort(byStart);
    const sessionId = stored.sessionId ?? legacy.sessionId;
    const pendingNote = stored.pendingNote ?? legacy.pendingNote;
    if (db.persistent) {
      db.saveAgent({ sessionId, pendingNote, turns: merged.map((t) => turnRecord(t)), migratedAt: new Date().toISOString() });
      // The save can have moved the history to memory (the file failed): then turns.json stays.
      if (db.persistent) {
        try {
          renameSync(historyFile(dir), join(dir, "agent", `turns.migrated-${Date.now()}.json`));
        } catch (error) {
          console.error(`[uncut] moved the agent history into history.db but couldn't rename agent/turns.json: ${(error as Error).message}`);
        }
      }
    }
    return { sessionId, turns: merged, pendingNote, threadStart: stored.threadStart, context: storedContext(stored.context) };
  });
}

export const turnRecord = (t: StoredTurn, bounds?: { start?: number; end?: number }): TurnRecord => ({
  id: t.id,
  prompt: t.prompt,
  status: t.status,
  startedAt: t.startedAt,
  finishedAt: t.finishedAt,
  startRevision: bounds?.start,
  endRevision: bounds?.end,
  data: t,
});
