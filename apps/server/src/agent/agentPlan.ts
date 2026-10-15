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
/** Skills' bodies in a message, at most this many characters together (D207: room for a film skill, Motion craft, Sound design and Brand application). */
export const SKILLS_CHARS = 14000;

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
  /** A brief exists and its storyboard isn't approved: timeline_edit waits. */
  readonly closed: boolean;
  /** "Auto" with Settings' skip: storyboard_propose approves itself. */
  readonly skip: boolean;
}

/** Whether the build waits for an approved storyboard (D188): only once a brief exists. */
export const gateOf = (plan: AgentPlan, skip: boolean): BuildGate => ({ closed: !!plan.brief && plan.storyboard?.status !== "approved" && !skip, skip });

/** timeline_edit's refusal while the gate is closed, or undefined. */
export function gateRefusal(plan: AgentPlan, gate: BuildGate): string | undefined {
  if (!gate.closed) return undefined;
  const sb = plan.storyboard;
  if (!sb) return "Not done: this video has a brief but no storyboard yet. Propose the shot list with storyboard_propose and build once the user approves it.";
  if (sb.status === "declined") return `Not done: the user asked for changes to the storyboard${sb.note ? ` ("${sb.note}")` : ""}. Change it and propose it again with storyboard_propose; build once it's approved.`;
  return "Not done: the storyboard is waiting for the user's approval. Call storyboard_propose again (or ask them to approve it on the Plan card) and build once it's approved.";
}

/**
 * The <brand> and <plan> blocks of a message: the project's kit and skills (or that there is none
 * and the user's kits by name), the brief, the storyboard and the last review.
 */
export function planContext(brand: { kit?: BrandKit | undefined; files: Readonly<Record<string, string>>; skills: ReadonlyArray<BrandSkill>; others: ReadonlyArray<{ id: string; name: string }>; available?: ReadonlyArray<Pick<BrandSkill, "id" | "name" | "description">> }, plan: AgentPlan, gate: BuildGate): string {
  const parts: Array<string> = [];
  const b: Array<string> = [];
  if (brand.kit) b.push(...kitLines(brand.kit, brand.files));
  else b.push(`No brand kit is chosen for this project.${brand.others.length ? ` The user's kits: ${brand.others.map((k) => `"${k.name}" (${k.id})`).join(", ")}.` : " The user has no kits yet."}`);
  let budget = SKILLS_CHARS;
  for (const s of brand.skills) {
    const body = s.body.length > budget ? `${s.body.slice(0, Math.max(0, budget))}…` : s.body;
    budget -= body.length;
    b.push(`Skill "${s.name}"${s.description ? ` (${s.description})` : ""}:\n${body}`);
  }
  // D207: no skill on yet: what there is, so brief_write's skills can pick (Uncut suggests a set otherwise).
  if (!brand.skills.length && brand.available?.length) {
    const own = brand.available.filter((s) => !s.id.startsWith("builtin-"));
    b.push(`No skills are on for this project. Uncut's: ${brand.available.filter((s) => s.id.startsWith("builtin-")).map((s) => s.id).join(", ")}${own.length ? `; the user's: ${own.map((s) => `${s.id} (${s.name})`).join(", ")}` : ""}. brief_write turns on the ones that fit the brief (its skills, else Uncut's suggestion).`);
  }
  parts.push(`<brand>\n${b.join("\n")}\n</brand>`);
  const p: Array<string> = [];
  if (plan.brief) {
    const br = plan.brief;
    p.push(
      [`Brief${br.by === "user" ? " (edited by the user)" : ""}:`, line(" film", br.film), line(" audience", br.audience), line(" duration", br.duration), line(" formats", br.formats), line(" assets", br.assets), line(" visual", br.visual), line(" hard lines", br.hardLines), line(" deliverables", br.deliverables), line(" notes", br.notes)]
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
  const last = plan.reviews.at(-1);
  if (last) {
    // D195: the critic's findings by id, so the next round's fix claims can name them.
    const open = [...(last.blockers ?? []).map((b) => `${b.id ?? "?"} blocker ${b.kind}${b.at !== undefined ? ` at ${b.at} s` : ""}: ${b.what}`), ...last.defects.map((d) => `${d.id ?? "?"} at ${d.at} s: ${d.what}`)];
    p.push(`Last review (${last.by === "critic" ? "Uncut's critic" : "your own, before the critic"}): round ${last.round}, ${REVIEW_SCORES.map((k) => `${k} ${last.scores[k]}`).join(", ")}${last.passed ? " (passed)" : " (not passed)"}${last.error ? `, ${last.error}` : ""}.${open.length && !last.passed ? `\n${open.join("\n")}` : ""}`);
  }
  // Nothing planned yet: no block (a small edit needs none).
  if (p.length) parts.push(`<plan>\n${p.join("\n")}\n</plan>`);
  return parts.join("\n\n");
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
  const beats = beatsS.map(toTl).filter(inItem);
  const downbeats = beatsS.flatMap((b, i) => (i % 4 === phase ? [toTl(b)] : [])).filter(inItem);
  const hits = onsets
    .map((o) => ({ frame: toTl(o.t), strength: Math.round(o.strength * 100) / 100 }))
    .filter((o) => inItem(o.frame) && o.strength >= 0.6)
    .sort((a, b) => b.strength - a.strength)
    .slice(0, 24)
    .sort((a, b) => a.frame - b.frame);
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
    ...(snaps.length ? { snaps } : {}),
    note: "Timeline frames. Put cuts and state changes on beats, big moments (the reveal, the logo, the end card) on downbeats, and start a whoosh or hit sound 1 to 2 frames before the frame it hits. off is how far the beat is from your frame (move it by that).",
  };
}
