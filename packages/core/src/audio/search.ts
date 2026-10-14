// Sound search in people's words (D208): meme names and their spellings ("fahh", "faaah", "vine
// boom", "ba dum tss"), synonyms ("swoosh" finds whooshes, "keyboard" finds typing), and a ranking
// by how well a sound matches, its licence and its length. Browser-safe: the Sound effects tab, the
// server's online search and the agent's library_search share it.
//
// Many meme sounds are clips from videos, games or TV, so nobody can give them away: no free source
// has the real "Fahh", "Vine boom" or "Taco Bell bong". An alias maps such a name to a search that
// finds free (CC0 / CC BY) sound-alikes and says so (`note`); the user's own folders hold the rest.

/** Lower case, accents off, anything but letters and digits a space. */
export function normalizeText(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** A word with its runs of a letter as one ("faaahhh" and "fah" are the same; "boom" is "bom"). */
export const squash = (word: string) => word.replace(/([a-z])\1+/g, "$1");

/** The words of a text, squashed. */
export const wordsOf = (text: string) => normalizeText(text).split(" ").filter(Boolean).map(squash);

/** The text as one squashed run with no spaces ("Vine-Boom", "vineboom" and "viiine boom" agree). */
const runOf = (text: string) => squash(normalizeText(text).replace(/ /g, ""));

/**
 * Words that mean the same sound, for search: a query word finds any of its group. Squashed (as
 * wordsOf gives them), so "boom" is written "bom" and "woosh" "wosh".
 */
const SYNONYM_GROUPS: ReadonlyArray<ReadonlyArray<string>> = [
  ["whosh", "swosh", "wosh", "swish", "swop", "whip", "swep"],
  ["swipe", "slide", "flick", "wipe"],
  ["click", "tap", "pres", "button", "mouse"],
  ["pop", "plop", "bubble", "blip", "drop"],
  ["bom", "impact", "hit", "thud", "bang", "punch", "thump"],
  ["riser", "rise", "build", "uplifter", "swel", "tension"],
  ["ding", "chime", "ping", "bel", "bong"],
  ["notification", "alert", "mesage"],
  ["suces", "win", "achievement", "complete", "done", "confirm", "level"],
  ["glitch", "distortion", "static", "interference", "stuter"],
  ["typing", "keyboard", "keys", "type", "keystroke"],
  ["aplause", "clap", "claping", "cheer"],
  ["laugh", "laughter", "laughing", "sitcom"],
  ["sparkle", "shimer", "twinkle", "magic", "shine"],
  ["eror", "wrong", "fail", "denied", "buzer"],
  ["camera", "shuter", "screnshot", "snap", "photo"],
  ["toggle", "switch"],
];
const SYNONYMS = new Map<string, ReadonlyArray<string>>();
for (const group of SYNONYM_GROUPS) for (const w of group) SYNONYMS.set(w, group);

/** A word and the words that mean the same. */
export const synonymsOf = (word: string): ReadonlyArray<string> => SYNONYMS.get(squash(word)) ?? [squash(word)];

/** A sound people ask for by name: how they spell it, what to search for online, and the bundled sounds that answer it. */
export interface SoundAlias {
  readonly id: string;
  /** How the app writes it. */
  readonly name: string;
  /** What people type (spelling variants are covered by squash; these are the different words). */
  readonly variants: ReadonlyArray<string>;
  /** The online search that finds CC0 / CC BY sounds for it (each checked on Openverse, D208). */
  readonly online: string;
  /** A Freesound tag that narrows a Freesound search to it (with the user's key). */
  readonly tag?: string;
  /** Bundled sounds that answer it (ids in assets/sfx/library.json). */
  readonly bundled: ReadonlyArray<string>;
  /** The name is a clip nobody may give away: results are free sound-alikes. */
  readonly clip?: boolean;
  /** Shown as a meme chip in the Sound effects tab. */
  readonly chip?: boolean;
}

/**
 * Meme and popular sounds by name (D208). Every `online` query returned CC0 / CC BY results on
 * Openverse on 2026-10-14 ("fahh", "vine boom", "anime wow", "emotional damage" and "meme" return
 * none, so those names search for what the sound is instead).
 */
export const SOUND_ALIASES: ReadonlyArray<SoundAlias> = [
  { id: "fahh", name: "Fahh", variants: ["fahh", "faah", "fahhh", "fah meme"], online: "frustrated yell", tag: "yell", bundled: ["frustrated-yell"], clip: true, chip: true },
  { id: "boom", name: "Vine boom", variants: ["vine boom", "vineboom", "boom meme"], online: "bass boom", tag: "boom", bundled: ["bass-boom", "impact-boom"], clip: true, chip: true },
  { id: "bruh", name: "Bruh", variants: ["bruh", "bro", "bruh moment"], online: "bruh", tag: "bruh", bundled: ["bruh"], chip: true },
  { id: "airhorn", name: "Airhorn", variants: ["airhorn", "air horn", "mlg horn", "dj horn", "mlg"], online: "airhorn", tag: "airhorn", bundled: ["airhorn"], chip: true },
  { id: "scratch", name: "Record scratch", variants: ["record scratch", "vinyl scratch", "scratch"], online: "record scratch", tag: "scratch", bundled: ["record-scratch"], chip: true },
  { id: "trombone", name: "Sad trombone", variants: ["sad trombone", "wah wah", "womp womp", "wah wah wah", "fail trombone", "sad horn"], online: "sad trombone", tag: "trombone", bundled: ["sad-trombone"], chip: true },
  { id: "wow", name: "Wow", variants: ["wow", "owen wilson wow", "anime wow", "woah", "whoa"], online: "wow", tag: "wow", bundled: ["wow"], chip: true },
  { id: "oof", name: "Oof", variants: ["oof", "roblox oof", "ouch"], online: "oof", tag: "oof", bundled: ["oof"], chip: true },
  { id: "crickets", name: "Crickets", variants: ["crickets", "cricket", "awkward silence", "awkward"], online: "crickets", tag: "crickets", bundled: ["crickets"], chip: true },
  { id: "rimshot", name: "Rimshot", variants: ["rimshot", "ba dum tss", "badum tss", "ba dum tiss", "badumtss", "joke drum"], online: "rimshot", tag: "rimshot", bundled: ["rimshot"], chip: true },
  { id: "drumroll", name: "Drum roll", variants: ["drum roll", "drumroll"], online: "drum roll", tag: "drumroll", bundled: ["drum-roll"], chip: true },
  { id: "boing", name: "Boing", variants: ["boing", "cartoon boing", "bounce", "spring"], online: "cartoon boing", tag: "boing", bundled: ["boing"], chip: true },
  { id: "bassdrop", name: "Bass drop", variants: ["bass drop", "drop the bass", "wub"], online: "bass drop", tag: "bass-drop", bundled: ["bass-drop"], chip: true },
  { id: "ding", name: "Ding", variants: ["ding", "correct answer", "correct"], online: "ding", tag: "ding", bundled: ["ding", "glass-ping"], chip: true },
  { id: "laugh", name: "Laugh", variants: ["laugh track", "sitcom laugh", "crowd laugh", "laugh", "laughing"], online: "laugh", tag: "laugh", bundled: ["crowd-laugh"], chip: true },
  { id: "applause", name: "Applause", variants: ["applause", "clapping", "claps"], online: "applause", tag: "applause", bundled: ["applause"] },
  { id: "error", name: "Error", variants: ["windows error", "error sound", "wrong buzzer", "wrong answer", "error"], online: "error", tag: "error", bundled: ["error"] },
  { id: "dramatic", name: "Dun dun dun", variants: ["dun dun dun", "dun dun", "dramatic sting"], online: "dun dun dun", tag: "dramatic", bundled: [], clip: true },
  { id: "tacobell", name: "Taco Bell bong", variants: ["taco bell bong", "taco bell"], online: "bong", tag: "bong", bundled: ["bong"], clip: true },
  { id: "huh", name: "Huh", variants: ["huh", "huh cat"], online: "huh", tag: "huh", bundled: [] },
];

/** The alias a query names, when it names one (the whole query, spelling and spaces aside). */
export function aliasOf(query: string): SoundAlias | undefined {
  const run = runOf(query);
  if (!run) return undefined;
  return SOUND_ALIASES.find((a) => a.variants.some((v) => runOf(v) === run) || runOf(a.name) === run);
}

/** What a query asks for: its words, their synonyms, and the alias it names. */
export interface ExpandedQuery {
  readonly text: string;
  /** Each query word with the words that mean the same (all squashed). */
  readonly groups: ReadonlyArray<ReadonlyArray<string>>;
  readonly alias?: SoundAlias | undefined;
  /** What goes online: the alias's search, else the query as typed. */
  readonly online: string;
  /** Said with the results when the alias is a clip: why these are sound-alikes. */
  readonly note?: string | undefined;
}

export function clipNote(alias: SoundAlias) {
  return `"${alias.name}" is a clip from a video, so it isn't free to use: these are free sound-alikes. Add the clip from a folder of your own (Folders).`;
}

export function expandQuery(query: string): ExpandedQuery {
  const text = query.replace(/\s+/g, " ").trim();
  const alias = aliasOf(text);
  const groups = wordsOf(text).map((w) => synonymsOf(w));
  return { text, groups, alias, online: alias ? alias.online : text, ...(alias?.clip ? { note: clipNote(alias) } : {}) };
}

/** Something a search can rank: a title, tags, maybe a category name, a licence and a length. */
export interface Rankable {
  readonly title: string;
  readonly tags?: ReadonlyArray<string> | undefined;
  readonly category?: string | undefined;
  readonly license?: string | undefined;
  readonly seconds?: number | undefined;
}

/**
 * How well a sound answers a query (0: not at all): each query word (or a synonym) in the title
 * counts most, in a tag or the category less; an alias's variants and tags count too. A CC0 sound
 * and a length that suits the kind (a sound effect of 0.2 to 4 s; music over a minute) rank higher.
 */
export function scoreSound(sound: Rankable, q: ExpandedQuery, kind: "sfx" | "music" = "sfx"): number {
  const title = new Set(wordsOf(sound.title));
  const tags = new Set([...(sound.tags ?? []).flatMap(wordsOf), ...wordsOf(sound.category ?? "")]);
  const titleRun = runOf(sound.title);
  let match = 0;
  let missing = 0;
  for (const group of q.groups) {
    const exact = group[0]!;
    if (title.has(exact) || [...title].some((w) => w.length > 3 && w.startsWith(exact) && exact.length > 2)) match += 3;
    else if (tags.has(exact)) match += 2;
    else if (group.some((w) => title.has(w))) match += 1.5;
    else if (group.some((w) => tags.has(w))) match += 1;
    else missing++;
  }
  if (q.alias) {
    const runs = [q.alias.name, ...q.alias.variants, q.alias.online].map(runOf);
    if (runs.some((r) => r.length > 2 && titleRun.includes(r))) match += 4;
    else if (wordsOf(q.alias.online).every((w) => title.has(w) || tags.has(w))) match += 2;
    if (q.alias.tag && tags.has(squash(q.alias.tag.replace(/-/g, " ").split(" ")[0]!))) match += 1;
  }
  if (match === 0) return 0;
  if (q.groups.length && missing === q.groups.length && !q.alias) return 0;
  let score = match - missing * 2;
  if (sound.license === "cc0" || sound.license === "CC0-1.0") score += 1.5;
  const s = sound.seconds;
  if (s !== undefined) {
    if (kind === "sfx") score += s >= 0.15 && s <= 4 ? 2 : s <= 10 ? 1 : s > 30 ? -2 : 0;
    else score += s >= 60 ? 1 : s < 15 ? -1 : 0;
  }
  return Math.max(score, 0.01);
}

/** The items best first (stable: equal scores keep the source's order); those that don't match at all stay, last. */
export function rankSounds<T extends Rankable>(items: ReadonlyArray<T>, query: string, kind: "sfx" | "music" = "sfx"): Array<T> {
  const q = expandQuery(query);
  return items
    .map((item, i) => ({ item, i, score: scoreSound(item, q, kind) }))
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map((e) => e.item);
}

/**
 * Whether a sound matches a query for a local list (the bundled pack, the user's folders): every
 * query word (or a synonym, or a word it starts) is in its title, tags, category or extra words,
 * or the query names an alias the sound answers.
 */
export function matchesQuery(sound: Rankable & { readonly id?: string; readonly extra?: string }, q: ExpandedQuery): boolean {
  if (!q.groups.length) return true;
  if (q.alias && sound.id && q.alias.bundled.includes(sound.id)) return true;
  const hay = new Set([...wordsOf(sound.title), ...(sound.tags ?? []).flatMap(wordsOf), ...wordsOf(sound.category ?? ""), ...wordsOf(sound.extra ?? "")]);
  const words = [...hay];
  return q.groups.every((group) => group.some((w) => hay.has(w) || (w.length >= 3 && words.some((h) => h.startsWith(w)))));
}
