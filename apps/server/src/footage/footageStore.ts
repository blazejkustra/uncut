// The footage index: every clip's speech and stored visual descriptions, searchable across projects.
// One SQLite file in the user data dir with an FTS5 table, keyed by the analysis fingerprint, so a
// clip copied between projects is indexed once. Everything in it can be rebuilt from the analysis
// caches except the descriptions, so a file that can't be opened is started over.
import { rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

export const FORMAT = 1;
/** Words per stored passage, and how many a passage shares with the next, so a phrase over the seam is found. */
export const PASSAGE_WORDS = 40;
export const PASSAGE_OVERLAP = 10;
const CONTEXT_WORDS = 8;

export type FootageSource = "speech" | "visual";
export type ClipKind = "video" | "image" | "audio";

export interface TimedWord {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}
export interface Passage {
  readonly start: number;
  readonly end: number;
  readonly text: string;
  /** start, end per word, in text's order. */
  readonly times: ReadonlyArray<number>;
}
export interface VisualNote {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}
export interface Place {
  readonly dir: string;
  readonly project: string;
  readonly mediaId: string;
  readonly fingerprint: string;
  readonly path: string;
  readonly stamp: string;
  readonly name: string;
  readonly kind: ClipKind;
}
export interface StoreHit {
  readonly id: string;
  readonly fingerprint: string;
  readonly source: FootageSource;
  readonly start: number;
  readonly end: number;
  readonly before: string;
  readonly match: string;
  readonly after: string;
  readonly places: ReadonlyArray<Place>;
}
export interface SearchOptions {
  readonly query: string;
  /** Only clips of this project folder. */
  readonly dir?: string | undefined;
  readonly limit: number;
}

const SCHEMA = `
  CREATE TABLE clips (fingerprint TEXT PRIMARY KEY, indexed_at TEXT NOT NULL);
  CREATE TABLE places (
    dir TEXT NOT NULL,
    media_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    project TEXT NOT NULL,
    path TEXT NOT NULL,
    stamp TEXT NOT NULL,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    PRIMARY KEY (dir, media_id)
  );
  CREATE INDEX places_fingerprint ON places (fingerprint);
  CREATE TABLE projects (dir TEXT PRIMARY KEY, auto INTEGER NOT NULL);
  CREATE TABLE passages (
    id INTEGER PRIMARY KEY,
    fingerprint TEXT NOT NULL,
    source TEXT NOT NULL,
    start REAL NOT NULL,
    end REAL NOT NULL,
    text TEXT NOT NULL,
    times TEXT
  );
  CREATE INDEX passages_clip ON passages (fingerprint, source);
  CREATE VIRTUAL TABLE passages_fts USING fts5(text, content='passages', content_rowid='id', tokenize='unicode61 remove_diacritics 2');
  CREATE TRIGGER passages_add AFTER INSERT ON passages BEGIN
    INSERT INTO passages_fts (rowid, text) VALUES (new.id, new.text);
  END;
  CREATE TRIGGER passages_remove AFTER DELETE ON passages BEGIN
    INSERT INTO passages_fts (passages_fts, rowid, text) VALUES ('delete', old.id, old.text);
  END;
`;

const twoPlaces = (seconds: number) => Math.round(seconds * 100) / 100;

const fold = (text: string) => text.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");

/** The search terms of a text, folded the way the FTS tokenizer folds it. */
export const termsOf = (text: string) =>
  fold(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

/** A transcript's words as overlapping passages. */
export function speechPassages(words: ReadonlyArray<TimedWord>): Array<Passage> {
  const clean = words.map((w) => ({ ...w, text: w.text.replace(/\s+/g, "") })).filter((w) => w.text);
  const passages: Array<Passage> = [];
  const step = PASSAGE_WORDS - PASSAGE_OVERLAP;
  for (let at = 0; at === 0 || at + PASSAGE_OVERLAP < clean.length; at += step) {
    const part = clean.slice(at, at + PASSAGE_WORDS);
    if (!part.length) break;
    passages.push({
      start: twoPlaces(part[0]!.start),
      end: twoPlaces(part.at(-1)!.end),
      text: part.map((w) => w.text).join(" "),
      times: part.flatMap((w) => [twoPlaces(w.start), twoPlaces(w.end)]),
    });
  }
  return passages;
}

/** The last word of the shortest run starting at `first` that holds every term, if one does. */
function runEnd(matches: ReadonlyArray<ReadonlyArray<string>>, first: number, termCount: number) {
  const seen = new Set<string>();
  for (let last = first; last < matches.length; last++) {
    for (const term of matches[last]!) seen.add(term);
    if (seen.size === termCount) return last;
  }
  return undefined;
}

/** The shortest run of words holding every term, as [first, last]; the first matching word when no run holds all (an any-word search). */
export function matchedWords(words: ReadonlyArray<string>, terms: ReadonlyArray<string>): readonly [number, number] | undefined {
  const matches = words.map((word) => {
    const parts = termsOf(word);
    return terms.filter((term) => parts.some((part) => part.startsWith(term)));
  });
  const termCount = new Set(terms).size;
  let best: readonly [number, number] | undefined;
  matches.forEach((here, first) => {
    if (!here.length) return;
    const last = runEnd(matches, first, termCount);
    if (last !== undefined && (!best || last - first < best[1] - best[0])) best = [first, last];
  });
  if (best) return best;
  const firstMatch = matches.findIndex((here) => here.length > 0);
  return firstMatch >= 0 ? [firstMatch, firstMatch] : undefined;
}

interface PassageRow {
  readonly fingerprint: string;
  readonly source: FootageSource;
  readonly start: number;
  readonly end: number;
  readonly text: string;
  readonly times: string | null;
}

const hitId = (row: PassageRow, start: number) => `${row.fingerprint}:${row.source}:${start}`;

function toHit(row: PassageRow, terms: ReadonlyArray<string>): Omit<StoreHit, "places"> {
  const base = { fingerprint: row.fingerprint, source: row.source };
  const words = row.text.split(" ");
  const span = row.times ? matchedWords(words, terms) : undefined;
  if (!span) return { ...base, id: hitId(row, row.start), start: row.start, end: row.end, before: "", match: row.text, after: "" };
  const times = JSON.parse(row.times!) as ReadonlyArray<number>;
  const [first, last] = span;
  const start = times[first * 2]!;
  return {
    ...base,
    id: hitId(row, start),
    start,
    end: times[last * 2 + 1]!,
    before: words.slice(Math.max(0, first - CONTEXT_WORDS), first).join(" "),
    match: words.slice(first, last + 1).join(" "),
    after: words.slice(last + 1, last + 1 + CONTEXT_WORDS).join(" "),
  };
}

function connect(file: string) {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
  const { user_version: version } = db.prepare("PRAGMA user_version").get() as { user_version: number };
  if (version === FORMAT) return db;
  if (version !== 0) {
    db.close();
    throw new Error(`it has format ${version}, this Uncut reads ${FORMAT}`);
  }
  db.exec(`BEGIN IMMEDIATE; ${SCHEMA} PRAGMA user_version = ${FORMAT}; COMMIT;`);
  return db;
}

function openOrReset(file: string) {
  try {
    return connect(file);
  } catch (error) {
    console.error(`[uncut] starting the footage index over: ${(error as Error).message}`);
  }
  try {
    for (const suffix of ["", "-wal", "-shm"]) rmSync(`${file}${suffix}`, { force: true });
    return connect(file);
  } catch (error) {
    console.error(`[uncut] the footage index stays in memory: ${(error as Error).message}`);
    return connect(":memory:");
  }
}

interface PlaceRow {
  readonly dir: string;
  readonly media_id: string;
  readonly fingerprint: string;
  readonly project: string;
  readonly path: string;
  readonly stamp: string;
  readonly name: string;
  readonly kind: ClipKind;
}
const placeOf = ({ media_id, ...rest }: PlaceRow): Place => ({ ...rest, mediaId: media_id });

const PASSAGE_FIELDS = "p.fingerprint, p.source, p.start, p.end, p.text, p.times";
const PASSAGE_ORDER = "ORDER BY bm25(passages_fts), p.start LIMIT ?";

export class FootageStore {
  private readonly db: DatabaseSync;

  constructor(file: string) {
    this.db = openOrReset(file);
  }

  close() {
    this.db.close();
  }

  private transaction(work: () => void) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      work();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** The fingerprint already known for this media at this file state, so an unchanged file isn't read again. */
  knownFingerprint(dir: string, mediaId: string, path: string, stamp: string) {
    const known = this.db.prepare("SELECT fingerprint FROM places WHERE dir = ? AND media_id = ? AND path = ? AND stamp = ?").get(dir, mediaId, path, stamp);
    return (known as { fingerprint: string } | undefined)?.fingerprint;
  }

  /** What a project holds now, replacing what was known of it. */
  setPlaces(dir: string, places: ReadonlyArray<Place>) {
    const insert = this.db.prepare(
      "INSERT OR REPLACE INTO places (dir, media_id, fingerprint, project, path, stamp, name, kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    this.transaction(() => {
      this.db.prepare("DELETE FROM places WHERE dir = ?").run(dir);
      for (const p of places) insert.run(dir, p.mediaId, p.fingerprint, p.project, p.path, p.stamp, p.name, p.kind);
    });
  }

  /** Forgets the projects that are gone and every clip no project holds, with what was stored for them. */
  prune(gone: ReadonlyArray<string>) {
    const remove = this.db.prepare("DELETE FROM places WHERE dir = ?");
    this.transaction(() => {
      for (const dir of gone) remove.run(dir);
      this.db.exec(`DELETE FROM passages WHERE fingerprint NOT IN (SELECT fingerprint FROM places);
                    DELETE FROM clips WHERE fingerprint NOT IN (SELECT fingerprint FROM places);`);
    });
  }

  projectDirs() {
    return (this.db.prepare("SELECT DISTINCT dir FROM places").all() as unknown as ReadonlyArray<{ dir: string }>).map((row) => row.dir);
  }

  places(fingerprint: string) {
    return (this.db.prepare("SELECT * FROM places WHERE fingerprint = ?").all(fingerprint) as unknown as ReadonlyArray<PlaceRow>).map(placeOf);
  }

  isIndexed(fingerprint: string) {
    return this.db.prepare("SELECT 1 FROM clips WHERE fingerprint = ?").get(fingerprint) !== undefined;
  }

  /** A clip's speech, replacing what was stored; no passages records a clip without any. */
  putSpeech(fingerprint: string, passages: ReadonlyArray<Passage>) {
    const insert = this.db.prepare("INSERT INTO passages (fingerprint, source, start, end, text, times) VALUES (?, 'speech', ?, ?, ?, ?)");
    this.transaction(() => {
      this.db.prepare("DELETE FROM passages WHERE fingerprint = ? AND source = 'speech'").run(fingerprint);
      for (const p of passages) insert.run(fingerprint, p.start, p.end, p.text, JSON.stringify(p.times));
      this.db.prepare("INSERT OR REPLACE INTO clips (fingerprint, indexed_at) VALUES (?, ?)").run(fingerprint, new Date().toISOString());
    });
  }

  /** Descriptions of what's on screen; each replaces the ones it overlaps. */
  putNotes(fingerprint: string, notes: ReadonlyArray<VisualNote>) {
    const overlapping = this.db.prepare("DELETE FROM passages WHERE fingerprint = ? AND source = 'visual' AND start <= ? AND end >= ?");
    const insert = this.db.prepare("INSERT INTO passages (fingerprint, source, start, end, text) VALUES (?, 'visual', ?, ?, ?)");
    this.transaction(() => {
      for (const note of notes) {
        overlapping.run(fingerprint, note.end, note.start);
        insert.run(fingerprint, twoPlaces(note.start), twoPlaces(note.end), note.text.replace(/\s+/g, " ").trim());
      }
    });
  }

  /** Clips with their speech indexed, in this project and in all of them; images have no speech and don't count. */
  counts(dir: string | undefined) {
    const count = (where: string, ...params: ReadonlyArray<string>) =>
      (this.db.prepare(`SELECT COUNT(DISTINCT p.fingerprint) AS n FROM places p ${where}`).get(...params) as { n: number }).n;
    const indexed = "JOIN clips c ON c.fingerprint = p.fingerprint WHERE p.kind != 'image'";
    return {
      clips: dir === undefined ? 0 : count("WHERE p.kind != 'image' AND p.dir = ?", dir),
      indexed: dir === undefined ? 0 : count(`${indexed} AND p.dir = ?`, dir),
      everywhere: count(indexed),
    };
  }

  isAuto(dir: string) {
    const row = this.db.prepare("SELECT auto FROM projects WHERE dir = ?").get(dir) as { auto: number } | undefined;
    return row?.auto === 1;
  }

  setAuto(dir: string, auto: boolean) {
    this.db.prepare("INSERT OR REPLACE INTO projects (dir, auto) VALUES (?, ?)").run(dir, auto ? 1 : 0);
  }

  private rows(expression: string, dir: string | undefined, limit: number) {
    const from = `SELECT ${PASSAGE_FIELDS} FROM passages_fts JOIN passages p ON p.id = passages_fts.rowid WHERE passages_fts MATCH ?`;
    const rows =
      dir === undefined
        ? this.db.prepare(`${from} ${PASSAGE_ORDER}`).all(expression, limit)
        : this.db.prepare(`${from} AND p.fingerprint IN (SELECT fingerprint FROM places WHERE dir = ?) ${PASSAGE_ORDER}`).all(expression, dir, limit);
    return rows as unknown as ReadonlyArray<PassageRow>;
  }

  /** The best moments for a query: every word (prefixes count) in one passage, else any of them; "in quotes" is a phrase. */
  search({ query, dir, limit }: SearchOptions): ReadonlyArray<StoreHit> {
    const terms = termsOf(query);
    if (!terms.length) return [];
    const trimmed = query.trim();
    const phrase = trimmed.length > 2 && trimmed.startsWith('"') && trimmed.endsWith('"');
    const parts = phrase ? [`"${terms.join(" ")}"*`] : terms.map((term) => `"${term}"*`);
    const fetched = limit * 3 + 10;
    const every = this.rows(parts.join(" "), dir, fetched);
    const rows = every.length || parts.length === 1 ? every : this.rows(parts.join(" OR "), dir, fetched);
    const seen = new Set<string>();
    const hits: Array<StoreHit> = [];
    for (const row of rows) {
      const hit = toHit(row, terms);
      if (seen.has(hit.id) || hits.length === limit) continue;
      seen.add(hit.id);
      hits.push({ ...hit, places: this.places(hit.fingerprint) });
    }
    return hits;
  }
}
