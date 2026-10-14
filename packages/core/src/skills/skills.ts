// Uncut's built-in skills (D207, issue #30): production recipes the agent follows when a project
// turns them on (the Brand tab's "This project", or brief_write's suggestion from the brief). Each
// body is plain text in the same shape: what it's for, structure, rules, do and don't, a short
// example and a "Review checklist" whose lines the critic checks on the frames (skillChecklist,
// which reads a user's own skills the same way). Read-only in the Brand tab; a duplicate is the
// user's to edit. Bodies stay short (about 2,000 characters each): every agent message carries
// the chosen ones. Sources and licences: planning/DECISIONS.md D207 (adapted, nothing copied).
//
// Browser-safe and pure: the server (store, prompt, critic) and the Brand tab read it.
import { BUILTIN_BODIES } from "./bodies.ts";

export interface BuiltinSkill {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly body: string;
}

/** Built-in ids start with this, so a user's skill never shadows one by accident. */
export const BUILTIN_PREFIX = "builtin-";

export const BUILTIN_IDS = {
  launch: "builtin-launch-promo",
  demo: "builtin-product-demo",
  talking: "builtin-talking-head",
  social: "builtin-social-cutdown",
  explainer: "builtin-explainer",
  titles: "builtin-title-sequence",
  motion: "builtin-motion-craft",
  sound: "builtin-sound-design",
  brand: "builtin-brand-application",
} as const;

const META: ReadonlyArray<Omit<BuiltinSkill, "body"> & { readonly key: keyof typeof BUILTIN_BODIES }> = [
  { key: "launch", id: BUILTIN_IDS.launch, name: "Launch promo", description: "A 15 to 30 s launch film: hook, problem, reveal, proof, call to action." },
  { key: "demo", id: BUILTIN_IDS.demo, name: "Product demo", description: "A demo built on real UI recordings: tight crops, cursor and state changes that read." },
  { key: "talking", id: BUILTIN_IDS.talking, name: "Talking-head short", description: "A 9:16 short cut from a talking head, with burned-in captions and real b-roll." },
  { key: "social", id: BUILTIN_IDS.social, name: "Social cut-down", description: "One edit delivered as 9:16, 4:5, 1:1 and 16:9 cuts, each safe for its platform." },
  { key: "explainer", id: BUILTIN_IDS.explainer, name: "Explainer", description: "How it works in 30 to 90 s: one idea per beat, diagrams built step by step." },
  { key: "titles", id: BUILTIN_IDS.titles, name: "Title sequence and kinetic type", description: "Type as the picture: a hierarchy, holds you can read, motion that follows the words." },
  { key: "motion", id: BUILTIN_IDS.motion, name: "Motion craft", description: "Springs per object class, holds, readability, and the clichés to avoid." },
  { key: "sound", id: BUILTIN_IDS.sound, name: "Sound design", description: "Few, quiet, synced sound effects; music matched to the pace; ducking under voice." },
  { key: "brand", id: BUILTIN_IDS.brand, name: "Brand application", description: "The kit applied with restraint: colours by role, fonts, logo files, tone." },
];

export const BUILTIN_SKILLS: ReadonlyArray<BuiltinSkill> = META.map(({ key, ...m }) => ({ ...m, body: BUILTIN_BODIES[key] }));

export const builtinSkill = (id: string) => BUILTIN_SKILLS.find((s) => s.id === id);
export const isBuiltinId = (id: string) => id.startsWith(BUILTIN_PREFIX);

/** A checklist's heading: "Review checklist", "Checklist", "Check before handing it over". */
const CHECK_HEAD = /^\s*(review checklist|checklist|check before handing it over|before handing it over)\b/i;
const BULLET = /^\s*[-–]\s+(.*\S)\s*$/;

/** The "Review checklist" lines of a skill's body (the critic checks them), at most 12. */
export function skillChecklist(body: string): Array<string> {
  const lines = body.split(/\r?\n/);
  const at = lines.findIndex((l) => CHECK_HEAD.test(l));
  if (at < 0) return [];
  const out: Array<string> = [];
  for (const l of lines.slice(at + 1)) {
    const m = BULLET.exec(l);
    if (m) out.push(m[1]!.slice(0, 240));
    else if (l.trim() && out.length) break;
  }
  return out.slice(0, 12);
}

/** What suggestSkills reads of a brief. */
export interface BriefLike {
  readonly film: string;
  readonly audience?: string;
  readonly duration?: string;
  readonly formats?: ReadonlyArray<string>;
  readonly assets?: ReadonlyArray<string>;
  readonly visual?: string;
  readonly deliverables?: ReadonlyArray<string>;
  readonly notes?: string;
}

const has = (re: RegExp, ...xs: ReadonlyArray<string | ReadonlyArray<string> | undefined>) => xs.some((x) => (Array.isArray(x) ? x.some((y) => re.test(y)) : typeof x === "string" && re.test(x)));
/** Seconds in a duration like "20 s", "0:45", "1 min", "30-45s" (the largest number). */
function seconds(d: string | undefined): number | undefined {
  if (!d) return undefined;
  const mmss = /(\d+):(\d{2})/.exec(d);
  if (mmss) return Number(mmss[1]) * 60 + Number(mmss[2]);
  const nums = [...d.matchAll(/\d+(?:\.\d+)?/g)].map((m) => Number(m[0]));
  if (!nums.length) return undefined;
  const n = Math.max(...nums);
  return /min/i.test(d) ? n * 60 : n;
}
const ratio = (f: string) => {
  const m = /(\d+)\s*[:x×]\s*(\d+)/.exec(f);
  if (!m) return undefined;
  const a = Number(m[1]);
  const b = Number(m[2]);
  // "1080x1920" or "9:16"
  return a > 0 && b > 0 ? a / b : undefined;
};

/**
 * The built-in skills that fit a brief (D207): one or two kinds of film from its words, formats and
 * length, then always Motion craft and Sound design, and Brand application with a kit. In the
 * order they're listed in.
 */
export function suggestSkills(brief: BriefLike, o: { readonly hasKit?: boolean } = {}): Array<string> {
  const words = [brief.film, brief.visual, brief.notes, brief.audience];
  const picked = new Set<string>();
  const talking = has(/talking|to camera|interview|founder|speaker|podcast|webcam|selfie|vlog|presenter|keynote clip/i, ...words, brief.assets);
  const demo = has(/\bdemo|walk ?-?through|tutorial|how to use|screen ?(record|cap)|recording|capture|\bui\b|app flow|onboarding|feature tour/i, ...words, brief.assets);
  const explainer = has(/explain|how it works|under the hood|architecture|concept|diagram|why it|deep dive/i, ...words);
  const titles = has(/title sequence|titles|kinetic|typograph|lyric|type-?only|text-?only|manifesto|opener|intro sequence/i, ...words);
  const launch = has(/launch|announc|release|teaser|promo|introduc|coming soon|is here|now available|\bship|\bv\d|version \d/i, ...words);
  const formats = (brief.formats ?? []).map(ratio).filter((x): x is number => x !== undefined);
  const kinds = new Set(formats.map((r) => (r < 0.7 ? "tall" : r < 0.9 ? "4:5" : r < 1.1 ? "square" : "wide")));
  const multi = kinds.size > 1 || has(/cut-?downs?|every format|all formats|multi-?format|reels.*shorts|shorts.*tiktok/i, ...words, brief.deliverables);
  const length = seconds(brief.duration);
  if (talking) picked.add(BUILTIN_IDS.talking);
  if (launch || (!talking && !demo && !explainer && !titles)) picked.add(BUILTIN_IDS.launch);
  if (demo) picked.add(BUILTIN_IDS.demo);
  if (explainer || (length !== undefined && length > 45 && !talking)) picked.add(BUILTIN_IDS.explainer);
  if (titles) picked.add(BUILTIN_IDS.titles);
  if (multi) picked.add(BUILTIN_IDS.social);
  // At most two kinds of film, the first ones found.
  const kindsPicked = [...picked].slice(0, 2);
  const out = [...kindsPicked, BUILTIN_IDS.motion, BUILTIN_IDS.sound, ...(o.hasKit ? [BUILTIN_IDS.brand] : [])];
  if (multi && !out.includes(BUILTIN_IDS.social)) out.splice(kindsPicked.length, 0, BUILTIN_IDS.social);
  return out;
}
