// history.db's schema, migrations and connection, and the words for why it can't be used (D12, D71).
import { DatabaseSync } from "node:sqlite";

export const SCHEMA_VERSION = 1;

// Migration i takes the schema from version i to i + 1, inside one transaction.
const MIGRATIONS: ReadonlyArray<string> = [
  `CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
   CREATE TABLE revisions (
     revision INTEGER PRIMARY KEY,
     at TEXT NOT NULL,
     kind TEXT NOT NULL,
     author TEXT NOT NULL CHECK (author IN ('user', 'agent', 'external', 'import')),
     turn_id TEXT,
     summary TEXT,
     label TEXT NOT NULL,
     lines TEXT NOT NULL DEFAULT '[]',
     parent INTEGER,
     boundary INTEGER NOT NULL DEFAULT 0,
     undo_turn TEXT,
     depth INTEGER NOT NULL DEFAULT 0,
     ops TEXT,
     patch TEXT,
     snapshot TEXT
   );
   CREATE INDEX revisions_turn ON revisions (turn_id);
   CREATE TABLE turns (
     id TEXT PRIMARY KEY,
     ord INTEGER NOT NULL,
     prompt TEXT NOT NULL,
     status TEXT NOT NULL,
     started_at TEXT NOT NULL,
     finished_at TEXT,
     start_revision INTEGER,
     end_revision INTEGER,
     data TEXT NOT NULL
   );`,
];

class NewerHistory extends Error {
  readonly version: number;
  constructor(version: number) {
    super(`history.db was made by a newer version of Uncut (format ${version}; this one reads up to ${SCHEMA_VERSION})`);
    this.version = version;
  }
}

/** Another process (a second Uncut on the same project) wrote history.db since this one read it. */
export class Forked extends Error {
  constructor() {
    super("history.db was changed by another copy of Uncut");
  }
}

export const sqliteCode = (error: unknown) => ((error as { code?: unknown }).code === "ERR_SQLITE_ERROR" ? Number((error as { errcode?: unknown }).errcode ?? 0) & 0xff : undefined);

/** Why history.db can't be used, in words, with what to do about it. */
export function problemFor(error: unknown, when: "open" | "write" = "open"): string {
  const code = sqliteCode(error);
  const message = String((error as Error)?.message ?? error);
  if (error instanceof Forked) {
    return "history.db is also being changed by another copy of Uncut (another window or app on this project), so this one's history continues in memory and the two don't mix. Undo and History work until the project is closed, but aren't saved.";
  }
  const reason =
    error instanceof NewerHistory
      ? `${message}.`
      : code === 5 || code === 6
        ? "history.db is in use by another program (it's locked)."
        : code === 11 || code === 26
          ? `history.db is damaged (${message}).`
          : code === 8 || code === 14 || code === 23
            ? `history.db can't be written in this folder (${message}).`
            : code === 13
              ? "The disk is full, so history.db can't grow."
              : `history.db can't be ${when === "open" ? "opened" : "written"} (${message}).`;
  const hint = code === 11 || code === 26 ? " Move history.db out of the project folder to start a new one." : code === 5 || code === 6 ? " Close the other program, then open the project again." : "";
  return `${reason} Undo and History work until the project is closed, but aren't saved.${hint}`;
}

function migrate(db: DatabaseSync) {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)");
    const row = db.prepare("SELECT version FROM schema_version").get() as { version: number } | undefined;
    let version = row ? Number(row.version) : 0;
    if (!row) db.prepare("INSERT INTO schema_version (version) VALUES (0)").run();
    if (version > SCHEMA_VERSION) throw new NewerHistory(version);
    for (; version < SCHEMA_VERSION; version++) db.exec(MIGRATIONS[version]!);
    db.prepare("UPDATE schema_version SET version = ?").run(version);
    db.exec("COMMIT");
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }
}

export function connect(file: string, busyMs: number): DatabaseSync {
  const db = new DatabaseSync(file);
  try {
    db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(busyMs))}`);
    if (file !== ":memory:") {
      // Before the first table exists, so freed pages can be given back after a compaction.
      const pages = db.prepare("PRAGMA page_count").get() as { page_count: number };
      if (Number(pages.page_count) === 0) db.exec("PRAGMA auto_vacuum = INCREMENTAL");
      db.exec("PRAGMA journal_mode = WAL");
      // FULL: a commit is on disk before project.json is written after it, so a power loss can't
      // keep the file's edit and lose its row (which would make the user's own edit look external).
      db.exec("PRAGMA synchronous = FULL");
      const check = db.prepare("PRAGMA quick_check(1)").get() as Record<string, unknown> | undefined;
      const verdict = check ? String(Object.values(check)[0]) : "ok";
      if (verdict !== "ok") throw Object.assign(new Error(verdict), { code: "ERR_SQLITE_ERROR", errcode: 11 });
    }
    migrate(db);
    return db;
  } catch (error) {
    try {
      db.close();
    } catch {}
    throw error;
  }
}
