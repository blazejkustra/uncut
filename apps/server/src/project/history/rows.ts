// history.db's row and record types and how a raw SQLite row reads (D12, D71).
import type { Op, Project } from "@uncut/core";

export type RowKind = "initial" | "edit" | "undo-turn" | "external" | "undo" | "redo" | "jump";
export type Author = "user" | "agent" | "external" | "import";
export type ListedKind = Exclude<RowKind, "undo" | "redo">;
export const ALIASES: ReadonlySet<RowKind> = new Set(["undo", "redo", "jump"]);

export interface HistoryOptions {
  readonly maxRows?: number;
  readonly snapshotEvery?: number;
  readonly busyMs?: number;
}

/** A revision as the editor sees it (no state, no ops). */
export interface Row {
  readonly revision: number;
  readonly at: string;
  readonly kind: RowKind;
  readonly author: Author;
  readonly turnId: string | undefined;
  readonly summary: string | undefined;
  readonly label: string;
  readonly lines: ReadonlyArray<string>;
  // The revision this one's state builds on (edits, undone turns) or restores (aliases).
  readonly parent: number | undefined;
  // Initial, external and compacted-to rows: the log starts after them.
  readonly boundary: boolean;
  readonly undoTurn: string | undefined;
  // Patches between this state and the nearest snapshot.
  readonly depth: number;
  // Stores a patch or a snapshot (aliases don't, unless compaction gave them one).
  readonly stored: boolean;
}

export interface NewRow {
  readonly kind: RowKind;
  readonly author: Author;
  readonly revision: number;
  readonly label: string;
  readonly at?: string | undefined;
  readonly lines?: ReadonlyArray<string> | undefined;
  readonly turnId?: string | undefined;
  readonly summary?: string | undefined;
  readonly ops?: ReadonlyArray<Op> | undefined;
  readonly undoTurn?: string | undefined;
  /** The state after this revision (every kind but the aliases). */
  readonly project?: Project | undefined;
  /** Aliases: the revision whose state they restore. */
  readonly target?: number | undefined;
}

export interface Cursor {
  readonly past: ReadonlyArray<number>;
  readonly future: ReadonlyArray<number>;
}

/** An agent turn as stored: a few columns to query, the whole turn as JSON. */
export interface TurnRecord {
  readonly id: string;
  readonly prompt: string;
  readonly status: string;
  readonly startedAt: string;
  readonly finishedAt?: string | undefined;
  readonly startRevision?: number | undefined;
  readonly endRevision?: number | undefined;
  readonly data: unknown;
}

export interface AgentRecord {
  readonly sessionId: string | undefined;
  readonly pendingNote: string | undefined;
  /** D295: when the current chat started (New chat), if one did. */
  readonly threadStart: string | undefined;
  readonly turns: ReadonlyArray<unknown>;
  /** When agent/turns.json was moved in, if it was. */
  readonly migratedAt: string | undefined;
}

export type RawRow = {
  revision: number;
  at: string;
  kind: string;
  author: string;
  turn_id: string | null;
  summary: string | null;
  label: string;
  lines: string;
  parent: number | null;
  boundary: number;
  undo_turn: string | null;
  depth: number;
  stored: number;
};

export const toRow = (r: RawRow): Row => ({
  revision: Number(r.revision),
  at: r.at,
  kind: r.kind as RowKind,
  author: r.author as Author,
  turnId: r.turn_id ?? undefined,
  summary: r.summary ?? undefined,
  label: r.label,
  lines: parseLines(r.lines),
  parent: r.parent === null ? undefined : Number(r.parent),
  boundary: Number(r.boundary) === 1,
  undoTurn: r.undo_turn ?? undefined,
  depth: Number(r.depth),
  stored: Number(r.stored) === 1,
});

const parseLines = (text: string): ReadonlyArray<string> => {
  try {
    const value = JSON.parse(text) as unknown;
    return Array.isArray(value) ? value.filter((l): l is string => typeof l === "string") : [];
  } catch {
    return [];
  }
};

export const ROW_COLUMNS = "revision, at, kind, author, turn_id, summary, label, lines, parent, boundary, undo_turn, depth, (patch IS NOT NULL OR snapshot IS NOT NULL) AS stored";
