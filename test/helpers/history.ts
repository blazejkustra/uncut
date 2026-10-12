// Reads a project's history.db (D71) from a test: the agent's turns and the revisions. A second
// connection is fine while the server has the file open (WAL: readers see committed writes).
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const historyFile = (dir: string) => join(dir, "history.db");

/** What the agent saved: { sessionId, pendingNote, turns } (turns as the Agent tab shows them). */
export function readAgentHistory(dir: string): { sessionId?: string; pendingNote?: string; turns: Array<any> } {
  if (!existsSync(historyFile(dir))) return { turns: [] };
  const db = new DatabaseSync(historyFile(dir), { readOnly: true });
  try {
    const meta = new Map((db.prepare("SELECT key, value FROM meta").all() as Array<{ key: string; value: string }>).map((m) => [m.key, m.value]));
    const turns = (db.prepare("SELECT data FROM turns ORDER BY ord").all() as Array<{ data: string }>).map((t) => JSON.parse(t.data));
    return { sessionId: meta.get("agent.sessionId"), pendingNote: meta.get("agent.pendingNote"), turns };
  } finally {
    db.close();
  }
}

/** Every revision row (no states), oldest first, and the meta table. */
export function readRevisions(dir: string): { rows: Array<{ revision: number; kind: string; author: string; label: string; turn_id: string | null; parent: number | null; boundary: number }>; meta: Map<string, string> } {
  const db = new DatabaseSync(historyFile(dir), { readOnly: true });
  try {
    const rows = db.prepare("SELECT revision, kind, author, label, turn_id, parent, boundary FROM revisions ORDER BY revision").all() as Array<any>;
    const meta = new Map((db.prepare("SELECT key, value FROM meta").all() as Array<{ key: string; value: string }>).map((m) => [m.key, m.value]));
    return { rows: rows.map((r) => ({ ...r })), meta };
  } finally {
    db.close();
  }
}
