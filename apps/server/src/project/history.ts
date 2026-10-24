// history.db (D12, D71): the project's revisions, the undo/redo cursor and the agent's turns, in
// <project>/history.db (SQLite through node:sqlite, WAL). project.json stays the source of truth:
// this file only says how the project got there, and a project without it (copied to another Mac,
// cloned from git: it is gitignored) opens with a history that starts at that moment.
//
// Every app revision is a row. Edits and undone turns store the patch from their parent's state
// (a full snapshot every SNAPSHOT_EVERY patches along a chain); the first revision and changes made
// outside Uncut store a snapshot and are boundaries. Undo, redo and History jumps are alias rows:
// their state is the revision they restore (`parent`). So the state of any revision is its nearest
// snapshot plus a few patches, and the edit log of a revision (what Undo turn replays) is the edit
// rows on its parent chain back to the boundary, minus the turns undone on the way.
//
// The cursor (past / future: the revisions ⌘Z and ⇧⌘Z go to) is kept in meta. Retention: the last
// maxRows revisions; older ones go in one transaction and the oldest kept rows become boundaries
// with snapshots. Nothing here throws for storage trouble: a history.db that can't be opened or
// written (damaged, locked, read-only, from a newer Uncut) is replaced by an in-memory database with
// the same schema, and `problem` says why, for the editor to show.
import { join } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";

import type { LogEntry, Op, Project } from "@uncut/core";

import { applyPatch, diff } from "./jsonPatch.ts";
import {
  type HistoryOptions,
  type Row,
  ROW_COLUMNS,
  type RawRow,
  toRow,
  type Cursor,
  ALIASES,
  type ListedKind,
  type NewRow,
  type AgentRecord,
  type TurnRecord,
} from "./history/rows.ts";
import { connect, problemFor, Forked, sqliteCode } from "./history/schema.ts";
export { SCHEMA_VERSION, problemFor } from "./history/schema.ts";
export type { RowKind, Author, ListedKind, HistoryOptions, Row, NewRow, Cursor, TurnRecord, AgentRecord } from "./history/rows.ts";

export const HISTORY_FILE = "history.db";
/** Revisions kept (a project with more drops its oldest, keeping their result as a snapshot). */
export const MAX_ROWS = 1000;
/** Compaction runs once this many rows are over the limit, so it isn't a cost on every edit. */
export const COMPACT_SLACK = 100;
/** A full snapshot instead of a patch after this many patches along a chain. */
export const SNAPSHOT_EVERY = 50;
/** How long a write waits for another connection's lock before giving up (then: in memory). */
export const BUSY_MS = 1000;

// The connection in use per project folder, so the agent's turn records and the project's
// revisions share one (an agent turn can finish after its project was closed: then a short-lived
// connection is opened for the write).
const registry = new Map<string, HistoryDb>();

/** Run `f` with the folder's history: the open project's, or one opened just for this. */
export function withHistory<T>(dir: string, f: (history: HistoryDb) => T): T {
  const open = registry.get(dir);
  if (open && !open.closed) return f(open);
  const history = HistoryDb.open(dir, {}, false);
  try {
    return f(history);
  } finally {
    history.close();
  }
}

export class HistoryDb {
  readonly dir: string;
  readonly file: string;
  private db: DatabaseSync;
  private readonly options: Required<HistoryOptions>;
  private readonly statements = new Map<string, StatementSync>();
  private readonly rows = new Map<number, Row>();
  private readonly meta = new Map<string, string>();
  // A few recent states by revision (the head among them), so undo and edits don't rebuild.
  private readonly states = new Map<number, Project>();
  private readonly registered: boolean;
  /** Saved to history.db (false: in memory only, see `problem`). */
  persistent: boolean;
  /** Why the history isn't saved, when it isn't. */
  problem: string | undefined;
  closed = false;

  /** Never throws: a history.db that can't be used becomes an in-memory history with a problem. */
  static open(dir: string, options: HistoryOptions = {}, register = true): HistoryDb {
    const opts: Required<HistoryOptions> = {
      maxRows: options.maxRows ?? MAX_ROWS,
      snapshotEvery: options.snapshotEvery ?? SNAPSHOT_EVERY,
      busyMs: options.busyMs ?? BUSY_MS,
    };
    const file = join(dir, HISTORY_FILE);
    if (register) registry.get(dir)?.close();
    let history: HistoryDb;
    try {
      history = new HistoryDb(dir, file, connect(file, opts.busyMs), true, undefined, opts, register);
    } catch (error) {
      history = new HistoryDb(dir, file, connect(":memory:", opts.busyMs), false, problemFor(error), opts, register);
    }
    if (register) registry.set(dir, history);
    return history;
  }

  private constructor(
    dir: string,
    file: string,
    db: DatabaseSync,
    persistent: boolean,
    problem: string | undefined,
    options: Required<HistoryOptions>,
    registered: boolean,
  ) {
    this.dir = dir;
    this.file = file;
    this.db = db;
    this.persistent = persistent;
    this.problem = problem;
    this.options = options;
    this.registered = registered;
    try {
      this.load();
    } catch (error) {
      // Tables that can't be read: start over in memory.
      this.toMemory(error, false);
    }
  }

  private load() {
    this.rows.clear();
    this.meta.clear();
    this.states.clear();
    for (const r of this.stmt(`SELECT ${ROW_COLUMNS} FROM revisions ORDER BY revision`).all() as Array<RawRow>) this.rows.set(Number(r.revision), toRow(r));
    for (const m of this.stmt("SELECT key, value FROM meta").all() as Array<{ key: string; value: string }>) this.meta.set(m.key, m.value);
  }

  private stmt(sql: string): StatementSync {
    let s = this.statements.get(sql);
    if (!s) this.statements.set(sql, (s = this.db.prepare(sql)));
    return s;
  }

  /** Switch to an in-memory database, keeping what can be copied from the file. */
  private toMemory(error: unknown, copy: boolean) {
    const reason = problemFor(error, copy ? "write" : "open");
    // Forked: keep this process's own line (its head, cursor); rows the other one added go.
    const ours = error instanceof Forked ? { head: this.meta.get("head"), past: this.meta.get("past"), future: this.meta.get("future") } : undefined;
    try {
      this.db.close();
    } catch {}
    this.statements.clear();
    this.db = connect(":memory:", this.options.busyMs);
    this.persistent = false;
    this.problem = reason;
    if (copy) {
      try {
        this.db.exec(`ATTACH DATABASE '${this.file.replace(/'/g, "''")}' AS old`);
        this.db.exec(
          "BEGIN; INSERT INTO revisions SELECT * FROM old.revisions; INSERT INTO meta SELECT * FROM old.meta; INSERT INTO turns SELECT * FROM old.turns; COMMIT;",
        );
        this.db.exec("DETACH DATABASE old");
        if (ours) {
          if (ours.head !== undefined) this.db.prepare("DELETE FROM revisions WHERE revision > ?").run(Number(ours.head));
          for (const [k, v] of Object.entries(ours)) {
            if (v === undefined) this.db.prepare("DELETE FROM meta WHERE key = ?").run(k);
            else this.db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(k, v);
          }
        }
      } catch {
        if (this.db.isTransaction) this.db.exec("ROLLBACK");
        try {
          this.db.exec("DETACH DATABASE old");
        } catch {}
        // Nothing could be copied: keep the newest state we know as the start of a new history.
        const head = this.head;
        const state = head === undefined ? undefined : this.states.get(head);
        this.db.exec("DELETE FROM revisions; DELETE FROM meta; DELETE FROM turns;");
        if (head !== undefined && state) {
          this.stmt("INSERT INTO revisions (revision, at, kind, author, label, boundary, snapshot) VALUES (?, ?, 'initial', 'import', ?, 1, ?)").run(
            head,
            new Date().toISOString(),
            "History restarted (history.db stopped saving)",
            JSON.stringify(state),
          );
          this.stmt("INSERT INTO meta (key, value) VALUES ('head', ?)").run(String(head));
        }
        const keep = state;
        this.load();
        if (head !== undefined && keep) this.states.set(head, keep);
        return;
      }
    } else {
      this.rows.clear();
      this.meta.clear();
    }
    const states = new Map(this.states);
    this.load();
    for (const [k, v] of states) if (this.rows.has(k)) this.states.set(k, v);
  }

  /**
   * One write transaction. `f` does the SQL and returns what to apply in memory once it commits.
   * If the file fails (locked, disk full, removed), the history moves to memory and `f` runs again.
   */
  private write<T>(f: () => () => T): T {
    const attempt = () => {
      this.db.exec("BEGIN IMMEDIATE");
      let apply: () => T;
      try {
        // Another process wrote since we read: don't interleave two histories in one file.
        if (this.persistent) {
          const onDisk = this.stmt("SELECT value FROM meta WHERE key = 'head'").get() as { value: string } | undefined;
          if (onDisk?.value !== this.meta.get("head")) throw new Forked();
        }
        apply = f();
        this.db.exec("COMMIT");
      } catch (error) {
        if (this.db.isTransaction) this.db.exec("ROLLBACK");
        throw error;
      }
      return apply();
    };
    try {
      return attempt();
    } catch (error) {
      if (!this.persistent || (sqliteCode(error) === undefined && !(error instanceof Forked))) throw error;
      this.toMemory(error, true);
      return attempt();
    }
  }

  /** The file's contents can't be used (a broken chain, unreadable rows): continue in memory. */
  abandon(error: unknown) {
    this.toMemory(
      Object.assign(new Error(`its contents can't be read: ${(error as Error)?.message ?? error}`), { code: "ERR_SQLITE_ERROR", errcode: 11 }),
      false,
    );
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try {
      this.db.close();
    } catch {}
    this.statements.clear();
    if (this.registered && registry.get(this.dir) === this) registry.delete(this.dir);
  }

  // ---- revisions ----

  /** The current revision, if there is any history yet. */
  get head(): number | undefined {
    const v = this.meta.get("head");
    return v === undefined ? undefined : Number(v);
  }

  get cursor(): Cursor {
    return { past: this.numbers("past"), future: this.numbers("future") };
  }

  private numbers(key: string): Array<number> {
    try {
      const v = JSON.parse(this.meta.get(key) ?? "[]") as unknown;
      return Array.isArray(v) ? v.filter((n): n is number => Number.isInteger(n) && this.rows.has(n)) : [];
    } catch {
      return [];
    }
  }

  row(revision: number): Row {
    const r = this.rows.get(revision);
    if (!r) throw new Error(`revision ${revision} isn't in the history`);
    return r;
  }

  has(revision: number) {
    return this.rows.has(revision);
  }

  get size() {
    return this.rows.size;
  }

  /** The revision whose stored state `revision` has (an alias restores another's). */
  resolve(revision: number): number {
    let r = this.row(revision);
    for (let i = 0; ALIASES.has(r.kind) && !r.stored && r.parent !== undefined; i++) {
      if (i > this.rows.size) throw new Error("history has an alias cycle");
      r = this.row(r.parent);
    }
    return r.revision;
  }

  private remember(revision: number, project: Project) {
    this.states.delete(revision);
    this.states.set(revision, project);
    while (this.states.size > 8) this.states.delete(this.states.keys().next().value!);
  }

  /** The project as it was at `revision` (shared: don't change it). */
  stateAt(revision: number): Project {
    const cached = this.states.get(revision);
    if (cached) return cached;
    const patches: Array<string> = [];
    let r = this.row(revision);
    let doc: unknown;
    for (let guard = 0; ; guard++) {
      if (guard > this.rows.size + 1) throw new Error("history has a parent cycle");
      if (ALIASES.has(r.kind) && !r.stored) {
        r = this.row(r.parent!);
        continue;
      }
      const hit = this.states.get(r.revision);
      if (hit) {
        doc = structuredClone(hit);
        break;
      }
      const stored = this.stmt("SELECT patch, snapshot FROM revisions WHERE revision = ?").get(r.revision) as
        | { patch: string | null; snapshot: string | null }
        | undefined;
      if (stored?.snapshot != null) {
        doc = JSON.parse(stored.snapshot);
        break;
      }
      if (stored?.patch == null || r.parent === undefined) throw new Error(`revision ${r.revision} has no stored state`);
      patches.push(stored.patch);
      r = this.row(r.parent);
    }
    for (let i = patches.length - 1; i >= 0; i--) doc = applyPatch(doc, JSON.parse(patches[i]!));
    const project = doc as Project;
    this.remember(revision, project);
    return project;
  }

  /**
   * The edit log of `revision` (the edit rows on its chain since the boundary, minus turns undone on
   * the way) and the boundary it starts from: what core's undoTurn replays.
   */
  logAt(revision: number): { readonly log: Array<LogEntry>; readonly initial: number } {
    const removed = new Set<string>();
    const picked: Array<Row> = [];
    let r = this.row(revision);
    for (let guard = 0; !r.boundary && r.parent !== undefined; guard++) {
      if (guard > this.rows.size) throw new Error("history has a parent cycle");
      if (r.kind === "undo-turn" && r.undoTurn) removed.add(r.undoTurn);
      if (r.kind === "edit" && !(r.turnId && removed.has(r.turnId))) picked.push(r);
      r = this.row(r.parent);
    }
    const log = picked.reverse().map((e): LogEntry => {
      const stored = this.stmt("SELECT ops FROM revisions WHERE revision = ?").get(e.revision) as { ops: string | null } | undefined;
      return {
        revision: e.revision,
        at: e.at,
        actor: e.author === "agent" ? "agent" : "user",
        ops: stored?.ops ? (JSON.parse(stored.ops) as Array<Op>) : [],
        ...(e.turnId ? { turnId: e.turnId } : {}),
        ...(e.summary ? { summary: e.summary } : {}),
      };
    });
    return { log, initial: r.revision };
  }

  /** The boundary row the chain of `revision` starts from. */
  boundaryOf(revision: number): Row {
    let r = this.row(revision);
    for (let guard = 0; !r.boundary && r.parent !== undefined; guard++) {
      if (guard > this.rows.size) throw new Error("history has a parent cycle");
      r = this.row(r.parent);
    }
    return r;
  }

  /** Revisions on the chain of `revision` (itself included), through outside changes, back to the start. */
  lineage(revision: number): Set<number> {
    const out = new Set<number>();
    let r: Row | undefined = this.rows.get(revision);
    while (r && !out.has(r.revision)) {
      out.add(r.revision);
      if (r.parent === undefined) break;
      r = this.rows.get(r.parent);
    }
    return out;
  }

  /** Rows newest first (undo/redo steps left out), at most `limit`, and how many there are in all. */
  listed(limit: number): { readonly rows: ReadonlyArray<Row & { readonly kind: ListedKind }>; readonly total: number } {
    const all = [...this.rows.values()].filter((r): r is Row & { readonly kind: ListedKind } => r.kind !== "undo" && r.kind !== "redo");
    return { rows: all.slice(-limit).reverse(), total: all.length };
  }

  /**
   * Add a revision and set the cursor, in one transaction. Returns the cursor as stored (compaction
   * drops revisions that are gone; a history that fell back to memory may have lost it).
   */
  record(input: NewRow, cursor: Cursor): Cursor {
    return this.write(() => {
      const head = this.head;
      if (head !== undefined && input.revision <= head) throw new Error(`revision ${input.revision} isn't after the head (${head})`);
      const at = input.at ?? new Date().toISOString();
      let parent: number | undefined;
      let patch: string | null = null;
      let snapshot: string | null = null;
      let depth = 0;
      let boundary = false;
      let state: Project;
      if (ALIASES.has(input.kind)) {
        if (input.target === undefined) throw new Error(`a ${input.kind} needs the revision it restores`);
        parent = this.resolve(input.target);
        depth = this.row(parent).depth;
        state = input.project ?? this.stateAt(parent);
      } else {
        if (!input.project) throw new Error(`a ${input.kind} needs its project`);
        state = input.project;
        if (input.kind === "initial" || input.kind === "external" || head === undefined) {
          boundary = true;
          snapshot = JSON.stringify(state);
          // An outside change still follows the revision it replaced (for History's "current");
          // as a boundary, the log and the state stop here.
          if (input.kind === "external" && head !== undefined) parent = head;
        } else {
          parent = head;
          depth = this.row(head).depth + 1;
          if (depth >= this.options.snapshotEvery) {
            depth = 0;
            snapshot = JSON.stringify(state);
          } else patch = JSON.stringify(diff(this.stateAt(head), state));
        }
      }
      const lines = JSON.stringify(input.lines ?? []);
      this.stmt(
        "INSERT INTO revisions (revision, at, kind, author, turn_id, summary, label, lines, parent, boundary, undo_turn, depth, ops, patch, snapshot) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        input.revision,
        at,
        input.kind,
        input.author,
        input.turnId ?? null,
        input.summary ?? null,
        input.label,
        lines,
        parent ?? null,
        boundary ? 1 : 0,
        input.undoTurn ?? null,
        depth,
        input.ops ? JSON.stringify(input.ops) : null,
        patch,
        snapshot,
      );
      const row: Row = {
        revision: input.revision,
        at,
        kind: input.kind,
        author: input.author,
        turnId: input.turnId,
        summary: input.summary,
        label: input.label,
        lines: input.lines ?? [],
        parent,
        boundary,
        undoTurn: input.undoTurn,
        depth,
        stored: patch !== null || snapshot !== null,
      };
      // Compaction, planned against the rows with the new one (it needs states before they go).
      const rowsAfter = new Map(this.rows).set(row.revision, row);
      const plan = this.planCompaction(rowsAfter, row, state);
      if (plan) {
        for (const [revision, project] of plan.materialise) {
          this.stmt("UPDATE revisions SET snapshot = ?, patch = NULL, parent = NULL, boundary = 1, depth = 0 WHERE revision = ?").run(
            JSON.stringify(project),
            revision,
          );
        }
        this.stmt("DELETE FROM revisions WHERE revision < ?").run(plan.cut);
      }
      const keep = (list: ReadonlyArray<number>) => list.filter((n) => n === input.revision || (rowsAfter.has(n) && (!plan || n >= plan.cut)));
      const stored: Cursor = { past: keep(cursor.past), future: keep(cursor.future) };
      const setMeta = this.stmt("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
      setMeta.run("head", String(input.revision));
      setMeta.run("past", JSON.stringify(stored.past));
      setMeta.run("future", JSON.stringify(stored.future));
      return () => {
        this.rows.set(row.revision, row);
        if (plan) {
          for (const [revision, project] of plan.materialise) {
            const old = this.rows.get(revision)!;
            this.rows.set(revision, { ...old, parent: undefined, boundary: true, depth: 0, stored: true });
            this.remember(revision, project);
          }
          for (const revision of [...this.rows.keys()]) if (revision < plan.cut) (this.rows.delete(revision), this.states.delete(revision));
        }
        this.meta.set("head", String(input.revision));
        this.meta.set("past", JSON.stringify(stored.past));
        this.meta.set("future", JSON.stringify(stored.future));
        this.remember(input.revision, state);
        if (plan && this.persistent) {
          try {
            this.db.exec("PRAGMA incremental_vacuum");
          } catch {}
        }
        return stored;
      };
    });
  }

  /**
   * Keep the newest maxRows revisions that hold a change (undo, redo and jump rows don't count, so
   * stepping back through the history doesn't push it out; they're capped at 4 × maxRows rows in
   * all). Kept rows whose parent goes become boundaries with a snapshot; so does an undone turn
   * whose turn had edits that go (its log could no longer leave them out). Undefined: nothing to do.
   */
  private planCompaction(rows: ReadonlyMap<number, Row>, added: Row, addedState: Project) {
    const { maxRows } = this.options;
    const changes = [...rows.values()].filter((r) => !ALIASES.has(r.kind)).map((r) => r.revision);
    const all = [...rows.keys()];
    let cut: number | undefined;
    if (changes.length > maxRows + COMPACT_SLACK) cut = changes[changes.length - maxRows]!;
    if (all.length > 4 * maxRows + COMPACT_SLACK) cut = Math.max(cut ?? -Infinity, all[all.length - 4 * maxRows]!);
    if (cut === undefined) return undefined;
    const goneTurns = new Set<string>();
    for (const r of rows.values()) if (r.revision < cut && r.turnId) goneTurns.add(r.turnId);
    const materialise = new Map<number, Project>();
    for (const r of rows.values()) {
      if (r.revision < cut || r.boundary) continue;
      const orphan = r.parent !== undefined && r.parent < cut;
      const blind = r.kind === "undo-turn" && r.undoTurn !== undefined && goneTurns.has(r.undoTurn);
      if (orphan || blind) materialise.set(r.revision, r.revision === added.revision ? addedState : this.stateAt(r.revision));
    }
    return { cut, materialise };
  }

  // ---- agent ----

  agent(): AgentRecord {
    const turns = (this.stmt("SELECT data FROM turns ORDER BY ord").all() as Array<{ data: string }>).flatMap((t) => {
      try {
        return [JSON.parse(t.data) as unknown];
      } catch {
        return [];
      }
    });
    return {
      sessionId: this.meta.get("agent.sessionId"),
      pendingNote: this.meta.get("agent.pendingNote"),
      threadStart: this.meta.get("agent.threadStart"),
      turns,
      migratedAt: this.meta.get("agent.turnsJsonMigratedAt"),
    };
  }

  /**
   * Save the agent's state: the given turns (upserted; `order` is every turn id in order, for the
   * ones given), the claude session and the pending note.
   */
  saveAgent(input: {
    readonly sessionId: string | undefined;
    readonly pendingNote: string | undefined;
    /** D295: the current chat's start; left as it is when not given. */
    readonly threadStart?: string | undefined;
    readonly turns: ReadonlyArray<TurnRecord>;
    readonly order?: ReadonlyArray<string> | undefined;
    readonly migratedAt?: string | undefined;
  }) {
    this.write(() => {
      const upsert = this.stmt(
        `INSERT INTO turns (id, ord, prompt, status, started_at, finished_at, start_revision, end_revision, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET ord = excluded.ord, prompt = excluded.prompt, status = excluded.status, started_at = excluded.started_at,
         finished_at = excluded.finished_at, start_revision = COALESCE(excluded.start_revision, turns.start_revision),
         end_revision = COALESCE(excluded.end_revision, turns.end_revision), data = excluded.data`,
      );
      const order = new Map((input.order ?? input.turns.map((t) => t.id)).map((id, i) => [id, i]));
      input.turns.forEach((t, i) =>
        upsert.run(
          t.id,
          order.get(t.id) ?? i,
          t.prompt,
          t.status,
          t.startedAt,
          t.finishedAt ?? null,
          t.startRevision ?? null,
          t.endRevision ?? null,
          JSON.stringify(t.data),
        ),
      );
      const setMeta = this.stmt("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
      const delMeta = this.stmt("DELETE FROM meta WHERE key = ?");
      const changes: Array<[string, string | undefined]> = [
        ["agent.sessionId", input.sessionId],
        ["agent.pendingNote", input.pendingNote || undefined],
        ...(input.migratedAt ? ([["agent.turnsJsonMigratedAt", input.migratedAt]] as Array<[string, string]>) : []),
        ...("threadStart" in input ? ([["agent.threadStart", input.threadStart]] as Array<[string, string | undefined]>) : []),
      ];
      for (const [k, v] of changes) v === undefined ? delMeta.run(k) : setMeta.run(k, v);
      return () => {
        for (const [k, v] of changes) v === undefined ? this.meta.delete(k) : this.meta.set(k, v);
      };
    });
  }
}
