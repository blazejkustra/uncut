// The production process the agent follows (U7–U9, U15–U17, U19; D186–D191), pure: what each
// message says about the brand kit, skills and plan, the build gate, ask_user's card and answer,
// brand_write's merge and the beat grid (the critic is agentCritic.ts). agent.ts runs them with its state.
import type { AgentAnswer, AgentPlan, AgentQuestion, BrandKit, BrandSkill, BrandStyle } from "@uncut/contracts";
import { REVIEW_SCORES } from "@uncut/contracts";

import { normHex, normStyle } from "../brand/store.ts";
import type { BeatsResult } from "../analysis/beats.ts";

/** How long a question or storyboard card waits for the user (they may be thinking it over). */
export const QUESTION_MS = 15 * 60_000;
export { REVIEW_PASS, REVIEW_ROUNDS } from "./agentCritic.ts";
/** A skill's instructions in a message (a /name the user called), at most this many characters (D232). */
export const SKILL_CHARS = 20000;

/**
 * D232 (issue #60): the <skill> blocks of a message for the skills the user called with /name: the
 * whole instructions of each (the user asked for it, so it comes with the message, not a skill_read).
 */
export function skillBlocks(skills: ReadonlyArray<Pick<BrandSkill, "id" | "name" | "body">>): string {
  return skills.map((s) => `<skill name="${s.id}" title="${s.name.replace(/"/g, "'")}">\nThe user called the skill ${s.id} (/${s.id}) for this message: follow its instructions.\n${s.body.slice(0, SKILL_CHARS)}\n</skill>`).join("\n\n");
}

/** A /name in a message: after a space, a ( or the start, not part of a path (/tmp/x) or a file name. */
const SKILL_CALL = /(?<![^\s(])\/([a-z0-9]+(?:-[a-z0-9]+)*)(?![\w/.-]*[\w/])/g;

/** D232: the /names in a message that are installed skills, in order, without repeats (a path never is one). */
export function calledSkills(text: string, names: ReadonlyArray<string>): Array<string> {
  const known = new Set(names);
  const out: Array<string> = [];
  for (const m of text.matchAll(SKILL_CALL)) if (known.has(m[1]!) && !out.includes(m[1]!)) out.push(m[1]!);
  return out;
}

/**
 * D232: the message as claude gets it: each called /name as words ("(skill launch-promo)"), so a
 * message that starts with one is never read as one of Claude Code's own slash commands.
 */
export const skillCallsAsWords = (text: string, called: ReadonlyArray<string>) => (called.length ? text.replace(SKILL_CALL, (m, name: string) => (called.includes(name) ? `(skill ${name})` : m)) : text);

/**
 * D232, D236 (#60 review M2): the user's text as claude gets it. Called skills become words; any
 * other leading /word (/init, /clear, /compact, a typo, a skill no longer installed) is never read
 * as one of Claude Code's own slash commands: the message is prefixed so it doesn't start with /.
 */
export function userMessageText(text: string, called: ReadonlyArray<string>): string {
  const out = skillCallsAsWords(text, called);
  return /^[\s\u200b-\u200d\u2060\ufeff]*\//.test(out) ? `The user wrote: ${out.trimStart()}` : out;
}

const line = (label: string, value: string | ReadonlyArray<string> | undefined) => {
  const v = Array.isArray(value) ? value.filter(Boolean).join("; ") : typeof value === "string" ? value.trim() : "";
  return v ? `${label}: ${v}` : "";
};

/** The kit in a few lines (also brand_read's summary). */
export function kitLines(kit: BrandKit, files: Readonly<Record<string, string>>): Array<string> {
  const logo = (k: "light" | "dark" | "mark", label: string) => {
    const name = kit.logos[k];
    return name ? `${label}: ${name}${files[name] ? ` (${files[name]})` : " (missing)"}` : "";
  };
  return [
    `Kit "${kit.name}" (${kit.id}, ${kit.scope === "global" ? "the user's" : "this project's"})`,
    line("What it is", kit.about ?? ""),
    line("Colours", kit.colors.map((c) => `${c.hex} ${c.role}${c.name ? ` (${c.name})` : ""}`)),
    line("Fonts", kit.fonts.map((f) => `${f.family} for ${f.role}${f.weight ? ` ${f.weight}` : ""}${f.file ? ` (file ${f.file}, loaded everywhere)` : ""}`)),
    logo("light", "Logo on light backgrounds"),
    logo("dark", "Logo on dark backgrounds"),
    logo("mark", "Logo mark"),
    line("Tone", kit.tone),
    line("Taglines", kit.taglines),
    line("URLs", kit.urls),
    line("Do", kit.dos),
    line("Don't", kit.donts),
    line("Examples", kit.examples),
    kit.style ? styleLine(kit.style) : "",
  ].filter(Boolean);
}

export const styleLine = (s: BrandStyle) =>
  [
    `Style guide${s.source ? ` (from ${s.source})` : ""}:`,
    line(" palette", s.palette.map((p) => `${p.hex}${p.role ? ` ${p.role}` : ""}`)),
    line(" type", s.type),
    line(" shot lengths", s.shotLengths),
    line(" transitions", s.transitions),
    line(" camera", s.camera),
    line(" grain", s.grain),
    line(" notes", s.notes),
  ]
    .filter(Boolean)
    .join(";");

export interface BuildGate {
  /** timeline_edit waits: the storyboard isn't approved and this turn is planning the video (D237). */
  readonly closed: boolean;
  /** A brief exists and its storyboard isn't approved (whether or not this turn is held by it). */
  readonly waiting: boolean;
  /** "Auto" with Settings' skip: storyboard_propose approves itself. */
  readonly skip: boolean;
}

/**
 * Whether the build waits for an approved storyboard (D188, D237). It waits only once a brief exists,
 * the storyboard isn't approved, and `planning`: this turn wrote the brief or proposed a storyboard,
 * so it is building the planned video. A later turn's edits (a small change while the storyboard is
 * pending or sent back) aren't held.
 */
export const gateOf = (plan: AgentPlan, skip: boolean, planning = false): BuildGate => {
  const waiting = !!plan.brief && plan.storyboard?.status !== "approved" && !skip;
  return { closed: waiting && planning, waiting, skip };
};

/**
 * D237 (review finding 3): while the planned video waits for its storyboard (a brief with no
 * storyboard, or one proposed or declined), a later turn may still make small edits, but at most
 * this many new items per timeline_edit (a title and its background). More is building scenes.
 */
export const SMALL_EDIT_INSERTS = 2;

/** The new items a timeline_edit's ops would add (insert_item, insert_text, insert_device_frame). */
export const insertCount = (ops: unknown): number =>
  Array.isArray(ops) ? ops.filter((o) => ["insert_item", "insert_text", "insert_device_frame"].includes(String((o as { op?: unknown } | null)?.op))).length : 0;

/** timeline_edit's refusal while the gate is closed (or, while it waits, for an edit that builds scenes), or undefined. */
export function gateRefusal(plan: AgentPlan, gate: BuildGate, ops?: unknown): string | undefined {
  if (!gate.closed) {
    if (!gate.waiting || ops === undefined) return undefined;
    const n = insertCount(ops);
    if (n <= SMALL_EDIT_INSERTS) return undefined;
    const sb = plan.storyboard;
    const why = !sb ? "this video has a brief but no storyboard yet" : sb.status === "declined" ? `the user sent the storyboard back${sb.note ? ` ("${sb.note}")` : ""}` : "the storyboard is still waiting for the user's approval";
    return `Not done: ${why}, and this edit adds ${n} items, which is building the planned video. While the storyboard isn't approved only small edits go ahead (at most ${SMALL_EDIT_INSERTS} new items per edit). Ask the user (ask_user) whether to build without it, or change the storyboard and propose it again with storyboard_propose.`;
  }
  const sb = plan.storyboard;
  if (!sb) return "Not done: this video has a brief but no storyboard yet. Propose the shot list with storyboard_propose and build once the user approves it.";
  if (sb.status === "declined") return `Not done: the user asked for changes to the storyboard${sb.note ? ` ("${sb.note}")` : ""}. Change it and propose it again with storyboard_propose; build once it's approved.`;
  return "Not done: the storyboard is waiting for the user's approval. Call storyboard_propose again (or ask them to approve it on the Plan card) and build once it's approved.";
}

/**
 * D296: the refusal of timeline_edit, graphic_write and shader_write while a storyboard this turn
 * proposed waits for the user: its stills are what they approve, so nothing changes under them.
 */
export const PROPOSE_LOCK = "Not done: the storyboard you proposed is waiting for the user's answer, and its stills show the edit as it is now, so nothing changes until they approve it or ask for changes. Don't edit; end your turn saying the storyboard waits on the Plan card. Once approved, build to match the stills; to change what they show (copy, logo, end card), propose again.";

/**
 * The <brand> and <plan> blocks of a message: the project's kit and skills (or that there is none
 * and the user's kits by name), the brief, the storyboard and the last review.
 */
export function planContext(brand: { kit?: BrandKit | undefined; files: Readonly<Record<string, string>>; skills: ReadonlyArray<Pick<BrandSkill, "id" | "name">>; others: ReadonlyArray<{ id: string; name: string }> }, plan: AgentPlan, gate: BuildGate): string {
  const parts: Array<string> = [];
  const b: Array<string> = [];
  if (brand.kit) b.push(...kitLines(brand.kit, brand.files));
  else b.push(`No brand kit is chosen for this project.${brand.others.length ? ` The user's kits: ${brand.others.map((k) => `"${k.name}" (${k.id})`).join(", ")}. A product the request names: its kit (brand_read) if one matches; else ask_user once, don't search the disk or the web for it.` : " The user has no kits yet."}`);
  // D232: the skills this project uses (read with skill_read or called with /name) by name; the system
  // prompt lists every installed skill, and skill_read gives one's instructions (progressive disclosure).
  if (brand.skills.length) b.push(`Skills this project uses: ${brand.skills.map((x) => `${x.name} (${x.id})`).join(", ")}. Follow every rule in them (skill_read gives one's instructions again); the critic checks their review checklists.`);
  parts.push(`<brand>\n${b.join("\n")}\n</brand>`);
  const block = planOnly(plan, gate);
  if (block) parts.push(block);
  return parts.join("\n\n");
}

/** The <plan> block alone (the brief, the storyboard, the last review); "" when nothing is planned. Also plan_read's answer (D266). */
export function planOnly(plan: AgentPlan, gate: BuildGate): string {
  const p: Array<string> = [];
  if (plan.brief) {
    const br = plan.brief;
    p.push(
      [`Brief${br.by === "user" ? " (edited by the user)" : ""}:`, line(" film", br.film), line(" type", br.type), line(" audience", br.audience), line(" duration", br.duration), line(" formats", br.formats), line(" assets", br.assets), line(" visual", br.visual), line(" hard lines", br.hardLines), line(" deliverables", br.deliverables), line(" notes", br.notes)]
        .filter(Boolean)
        .join("\n"),
    );
  }
  const sb = plan.storyboard;
  if (sb) {
    const beats = sb.beats.map((x, i) => `${i + 1}. ${x.start}–${x.end} s ${x.title}: ${x.entry} → ${x.exit} (${x.purpose})${x.assets.length ? ` [${x.assets.join(", ")}]` : ""}${x.sound ? ` on ${x.sound}` : ""}`);
    p.push(`Storyboard (${sb.status}${sb.status === "approved" && sb.approvedBy === "setting" ? " by the setting" : ""}${sb.note ? `, the user said: ${sb.note}` : ""}): ${sb.summary}\n${beats.join("\n")}`);
  }
  if (gate.closed) p.push(sb ? "The build waits for the storyboard's approval." : "The build waits for a storyboard (storyboard_propose).");
  else if (gate.waiting) p.push(`${sb ? "The storyboard isn't approved" : "There is no storyboard yet"}: a small edit the user asks for goes ahead (at most ${SMALL_EDIT_INSERTS} new items per timeline_edit); building the planned video waits for an approved storyboard (storyboard_propose).`);
  const last = plan.reviews.at(-1);
  if (last) {
    // D195: the critic's findings by id, so the next round's fix claims can name them.
    const open = [...(last.blockers ?? []).map((b) => `${b.id ?? "?"} blocker ${b.kind}${b.at !== undefined ? ` at ${b.at} s` : ""}: ${b.what}`), ...last.defects.map((d) => `${d.id ?? "?"} at ${d.at} s: ${d.what}`)];
    p.push(`Last review (${last.by === "critic" ? "Uncut's critic" : "your own, before the critic"}): round ${last.round}, ${REVIEW_SCORES.filter((k) => last.scores[k] !== undefined).map((k) => `${k} ${last.scores[k]}`).join(", ")}${last.passed ? " (passed)" : " (not passed)"}${last.error ? `, ${last.error}` : ""}.${open.length && !last.passed ? `\n${open.join("\n")}` : ""}`);
  }
  // Nothing planned yet: no block (a small edit needs none).
  return p.length ? `<plan>\n${p.join("\n")}\n</plan>` : "";
}

/** ask_user's question from its arguments, or why it isn't one. */
export function questionOf(args: Record<string, unknown>): AgentQuestion | { problem: string } {
  const question = typeof args.question === "string" ? args.question.trim().slice(0, 400) : "";
  if (!question) return { problem: "question is the question to ask, in plain words." };
  const raw = Array.isArray(args.options) ? args.options : [];
  if (raw.length > 6) return { problem: "Give at most 6 options." };
  const options = raw.flatMap((o) => {
    const x = (o && typeof o === "object" ? o : typeof o === "string" ? { label: o } : {}) as Record<string, unknown>;
    const label = typeof x.label === "string" ? x.label.trim().slice(0, 80) : "";
    const detail = typeof x.detail === "string" ? x.detail.trim().slice(0, 200) : "";
    return label ? [{ label, ...(detail ? { detail } : {}) }] : [];
  });
  return { question, options, multi: args.multi === true && options.length > 1, freeText: args.freeText !== false || options.length === 0 };
}

/** The user's answer as the agent reads it. */
export function answerOut(q: AgentQuestion, outcome: "answered" | "skipped" | "timeout" | "stopped", answer?: AgentAnswer) {
  if (outcome === "stopped") return { answered: false, message: "The turn was stopped." };
  if (outcome !== "answered" || !answer) {
    return { answered: false, message: outcome === "timeout" ? "Nobody answered the question in 15 minutes." : "The user skipped the question.", next: "Don't invent what was asked about: go on with what you know, say in one line what you assumed, or stop and ask in your reply." };
  }
  const choices = answer.choices.filter((c) => q.options.some((o) => o.label === c));
  const text = answer.text?.trim();
  return { answered: true, ...(choices.length ? { choices } : {}), ...(text ? { text } : {}) };
}

/** brand_write: the kit after merging the call's fields into it (a field passed replaces that field). */
export function mergeKit(base: BrandKit, args: Record<string, unknown>): BrandKit | { problem: string } {
  const out: { -readonly [K in keyof BrandKit]: BrandKit[K] } = { ...base };
  if (typeof args.name === "string" && args.name.trim()) out.name = args.name.trim().slice(0, 80);
  if (Array.isArray(args.colors)) {
    const colors = args.colors.flatMap((c) => {
      const o = (c && typeof c === "object" ? c : {}) as Record<string, unknown>;
      const hex = typeof o.hex === "string" ? normHex(o.hex) : undefined;
      return hex ? [{ hex, role: typeof o.role === "string" && o.role.trim() ? o.role.trim().slice(0, 60) : "accent", ...(typeof o.name === "string" && o.name.trim() ? { name: o.name.trim().slice(0, 60) } : {}) }] : [];
    });
    if (args.colors.length && !colors.length) return { problem: "colors need hex values like #0b1d3a." };
    out.colors = colors;
  }
  if (Array.isArray(args.fonts)) {
    out.fonts = args.fonts.flatMap((f) => {
      if (!f || typeof f !== "object" || typeof (f as Record<string, unknown>).family !== "string") return [];
      const o = f as Record<string, unknown>;
      const family = String(o.family).trim().slice(0, 80);
      if (!family) return [];
      // D198: `file` is a kit file, a path or an address (brand_write brings it in); a family that had a file keeps it.
      const file = typeof o.file === "string" && o.file.trim() ? o.file.trim().slice(0, 2000) : base.fonts.find((x) => x.family.toLowerCase() === family.toLowerCase() && x.file)?.file;
      return [{ family, role: String(o.role ?? "body").slice(0, 40), ...(typeof o.weight === "number" ? { weight: o.weight } : {}), ...(file ? { file } : {}) }];
    });
  }
  if (typeof args.tone === "string") out.tone = args.tone.slice(0, 4000);
  if (typeof args.about === "string") {
    const about = args.about.trim().slice(0, 2000);
    if (about) out.about = about;
    else delete out.about;
  }
  for (const k of ["taglines", "urls", "dos", "donts"] as const) if (Array.isArray(args[k])) out[k] = (args[k] as Array<unknown>).filter((x): x is string => typeof x === "string" && x.trim() !== "").slice(0, 40);
  if (args.style !== undefined) {
    const style = normStyle(args.style);
    if (!style) return { problem: "style is { palette, type, shotLengths, transitions, camera, grain, notes? }." };
    if (!style.palette.length) return { problem: "style.palette needs hex colours like #0b1d3a." };
    out.style = style;
  }
  return out;
}

/**
 * D198: what a brand_write would change in a kit's colours and fonts that it had already (a
 * field the kit had nothing in yet isn't a change), each as its lines before and after. A font
 * file added to a family that's there isn't a change of the fonts.
 */
export function kitChanges(before: BrandKit, after: BrandKit): Array<{ field: string; before: Array<string>; after: Array<string> }> {
  const out: Array<{ field: string; before: Array<string>; after: Array<string> }> = [];
  const colour = (c: BrandKit["colors"][number]) => `${c.hex} ${c.role}${c.name ? ` (${c.name})` : ""}`;
  const font = (f: BrandKit["fonts"][number]) => `${f.family} for ${f.role}${f.weight ? ` ${f.weight}` : ""}`;
  const differ = (a: ReadonlyArray<string>, b: ReadonlyArray<string>) => a.length !== b.length || a.some((x, i) => x.toLowerCase() !== b[i]!.toLowerCase());
  if (before.colors.length && differ(before.colors.map(colour), after.colors.map(colour))) out.push({ field: "Colours", before: before.colors.map(colour), after: after.colors.map(colour) });
  if (before.fonts.length && differ(before.fonts.map(font), after.fonts.map(font))) out.push({ field: "Fonts", before: before.fonts.map(font), after: after.fonts.map(font) });
  return out;
}

/** The music item beat_grid reads: the asked one, else the longest audio item. */
export interface GridItem {
  readonly id: string;
  readonly media: string;
  readonly start: number;
  readonly in: number;
  readonly duration: number;
  readonly speed: number;
}

/** D296: a drop by level: the low bands' 2 bars after the beat at least this many times the 2 bars before, */
export const DROP_LEVEL_RISE = 2;
/** that beat at least this many times the 2 beats before it (a step, not a ramp), */
export const DROP_STEP = 1.5;
/** and the bar after it at least this share of the loudest bar (the drop is the loud part). */
export const DROP_LOUD = 0.6;

const meanOf = (xs: ReadonlyArray<number>) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/**
 * The drop. D296: by level when the analysis has beatLevels: the beat where the low bands (kick,
 * bass) step up: the 2 bars after it at least DROP_LEVEL_RISE times the 2 bars before, the beat
 * itself DROP_STEP times the 2 beats before it, and the bar after it loud (DROP_LOUD of the loudest
 * bar); the biggest such rise, any beat from the third bar on (a drop lands on a downbeat, so the
 * grid's downbeats follow it: `beat` is its index). Without levels (D295) by onsets: the downbeat after which
 * the next 2 bars carry the most onset strength vs the 2 bars before, at least 1.5 times. An even
 * build gets undefined either way. Seconds of the media.
 */
export function dropOf(beats: ReadonlyArray<number>, phase: number, onsets: ReadonlyArray<{ t: number; strength: number }>, levels?: ReadonlyArray<number>): { seconds: number; rise: number; beat: number } | undefined {
  if (beats.length < 16) return undefined;
  if (levels && levels.length === beats.length) {
    const n = levels.length;
    const bars = Array.from({ length: Math.max(0, n - 3) }, (_, i) => meanOf(levels.slice(i, i + 4)));
    const loudest = Math.max(...bars, 0);
    let best: { seconds: number; rise: number; beat: number } | undefined;
    for (let i = 8; i + 4 <= n; i++) {
      const before = meanOf(levels.slice(i - 8, i));
      const after = meanOf(levels.slice(i, Math.min(n, i + 8)));
      const rise = after / Math.max(before, 0.01);
      const step = levels[i]! / Math.max(meanOf(levels.slice(i - 2, i)), 0.01);
      if (rise >= DROP_LEVEL_RISE && step >= DROP_STEP && bars[i]! >= DROP_LOUD * loudest && (!best || rise > best.rise)) best = { seconds: beats[i]!, rise: Math.round(rise * 10) / 10, beat: i };
    }
    return best;
  }
  const energy = (from: number, to: number) => onsets.reduce((sum, o) => (o.t >= from && o.t < to ? sum + o.strength : sum), 0);
  let best: { seconds: number; rise: number; beat: number } | undefined;
  for (let i = phase + 8; i + 8 <= beats.length; i += 4) {
    const before = energy(beats[i - 8]!, beats[i]!);
    const after = energy(beats[i]!, i + 8 < beats.length ? beats[i + 8]! : Infinity);
    const rise = after / Math.max(before, 0.5);
    if (rise >= 1.5 && (!best || rise > best.rise)) best = { seconds: beats[i]!, rise: Math.round(rise * 10) / 10, beat: i };
  }
  return best;
}

/**
 * The beat grid in timeline frames (D191): beats, downbeats (one beat in 4: the phase whose beats
 * carry the most onset strength) and the strongest hits, inside the item; snaps of the given
 * frames to the nearest beat and downbeat.
 */
export function beatGrid(result: BeatsResult, item: GridItem, fps: number, range?: { start: number; end: number }, snap?: ReadonlyArray<number>) {
  const toTl = (seconds: number) => Math.round(item.start + (seconds * fps - item.in) / (item.speed || 1));
  const end = item.start + item.duration;
  const inItem = (f: number) => f >= item.start && f < end && (!range || (f >= range.start && f < range.end));
  const beatsS = result.beats ?? [];
  const onsets = result.onsets ?? [];
  // Onset strength near each beat (within a quarter beat).
  const half = result.bpm ? 60 / result.bpm / 4 : 0.1;
  const weight = beatsS.map((b) => onsets.reduce((sum, o) => (Math.abs(o.t - b) <= half ? sum + o.strength : sum), 0));
  let phase = 0;
  let best = -1;
  for (let p = 0; p < 4; p++) {
    const w = weight.reduce((sum, x, i) => (i % 4 === p ? sum + x : sum), 0);
    if (w > best) {
      best = w;
      phase = p;
    }
  }
  // D296: a drop by level lands on a downbeat: the downbeats follow it.
  const drop = dropOf(beatsS, phase, onsets, result.beatLevels);
  if (drop) phase = drop.beat % 4;
  const beats = beatsS.map(toTl).filter(inItem);
  const downbeats = beatsS.flatMap((b, i) => (i % 4 === phase ? [toTl(b)] : [])).filter(inItem);
  const hits = onsets
    .map((o) => ({ frame: toTl(o.t), strength: Math.round(o.strength * 100) / 100 }))
    .filter((o) => inItem(o.frame) && o.strength >= 0.6)
    .sort((a, b) => b.strength - a.strength)
    .slice(0, 24)
    .sort((a, b) => a.frame - b.frame);
  // The drop counts anywhere in the item, a range or not.
  const inClip = (seconds: number) => toTl(seconds) >= item.start && toTl(seconds) < end;
  const nearest = (list: ReadonlyArray<number>, f: number) => list.reduce<number | undefined>((acc, x) => (acc === undefined || Math.abs(x - f) < Math.abs(acc - f) ? x : acc), undefined);
  const snaps = (snap ?? []).map((f) => {
    const beat = nearest(beats, f);
    const down = nearest(downbeats, f);
    return { frame: f, ...(beat !== undefined ? { beat, off: beat - f } : {}), ...(down !== undefined ? { downbeat: down } : {}) };
  });
  return {
    item: item.id,
    bpm: result.bpm ?? null,
    confidence: result.confidence ?? 0,
    beatFrames: result.bpm ? Math.round((60 / result.bpm) * fps * 100) / 100 : null,
    beats: beats.slice(0, 400),
    downbeats: downbeats.slice(0, 120),
    hits,
    // The downbeat where the music gets much busier (the drop), when there is one inside the item.
    drop: drop && inClip(drop.seconds) ? { frame: toTl(drop.seconds), rise: drop.rise } : null,
    ...(snaps.length ? { snaps } : {}),
    note: "Timeline frames. Put cuts and state changes on beats, big moments (the reveal, the logo, the end card) on downbeats, and start a whoosh or hit sound 1 to 2 frames before the frame it hits. off is how far the beat is from your frame (move it by that). drop is the downbeat where the kick and bass step up (rise: how many times louder the 2 bars after it are than the 2 before; else where the onsets get 1.5 times busier), null on an even track: land the reveal there.",
  };
}
