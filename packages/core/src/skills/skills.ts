// Uncut's own skills (D207, issue #30; D232, issue #60): production recipes. Since D232 they ship as
// a bundled first-party plugin (plugins/uncut-skills, `contributes.skills`) like any plugin's
// skills; this module keeps what Uncut reasons about by name: their ids (suggestSkills, the
// critic's rubric), the "Review checklist" reader (skillChecklist; the critic checks each line on
// the frames) and the suggestions from a brief. Sources and licences: planning/DECISIONS.md D207.
//
// Browser-safe and pure: the server (store, prompt, critic) and the web read it.
import { isVideoType, type VideoType } from "./rubric.ts";

/** Uncut's own skills by their names (D232: what the user types after /; were builtin-<name> before). */
export const BUILTIN_IDS = {
  launch: "launch-promo",
  demo: "product-demo",
  talking: "talking-head",
  social: "social-cutdown",
  explainer: "explainer",
  titles: "title-sequence",
  motion: "motion-craft",
  sound: "sound-design",
  brand: "brand-application",
  /** D232: the skill "Make from reference" in the Brand tab calls. */
  brandKit: "make-brand-kit",
  /** D292: a one-take, never-cut motion film on the beat (render(t) graphics, uncut:lib/motion.js). */
  film: "motion-film",
} as const;

/** The bundled plugin that ships Uncut's own skills (D232). */
export const SKILLS_PLUGIN_ID = "uncut.skills";

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

const TYPE_SKILL: Readonly<Record<VideoType, string | undefined>> = {
  "launch-promo": BUILTIN_IDS.launch,
  "product-demo": BUILTIN_IDS.demo,
  tutorial: BUILTIN_IDS.demo,
  talk: BUILTIN_IDS.talking,
  vlog: BUILTIN_IDS.talking,
  social: BUILTIN_IDS.social,
  explainer: BUILTIN_IDS.explainer,
  "music-video": undefined,
  meme: BUILTIN_IDS.social,
  gaming: BUILTIN_IDS.social,
  other: undefined,
};
/** Types whose videos usually have motion graphics (Motion craft is suggested). */
const MOTION_TYPES: ReadonlySet<string> = new Set(["launch-promo", "explainer", "social", "music-video"]);
/** Types whose sound design is part of the job (Sound design is suggested). */
const SOUND_TYPES: ReadonlySet<string> = new Set(["launch-promo", "product-demo"]);
/** Types that carry a brand (Brand application is suggested with a kit). */
const BRAND_TYPES: ReadonlySet<string> = new Set(["launch-promo", "product-demo", "tutorial", "talk", "social", "explainer", "other"]);

/**
 * The built-in skills that fit a brief (D207, D217): suggestions only, never turned on by
 * themselves; the user picks (on an ask_user card or the Brief card). The type's own kind of film,
 * then one or two more from the brief's words, formats and length (talking head, launch, demo,
 * explainer over 45 s, titles, social when it has several aspect ratios or asks for cut-downs; a
 * brief with no type and nothing found: Launch promo); Motion craft only for videos with motion
 * graphics (a promo, an explainer, a social cut, a music video, titles), Sound design for a promo or
 * a product video, Brand application with a kit for a branded type; Motion film (D292) after the kinds
 * when the brief asks for one take, no cuts, a morph or a seamless loop (D297: then not Motion craft,
 * whose one-thing-at-a-time rules contradict it). In the order they're listed in.
 */
export function suggestSkills(brief: BriefLike & { readonly type?: string }, o: { readonly hasKit?: boolean } = {}): Array<string> {
  const type = isVideoType(brief.type) ? brief.type : undefined;
  const words = [brief.film, brief.visual, brief.notes, brief.audience];
  const picked = new Set<string>();
  const own = type ? TYPE_SKILL[type] : undefined;
  if (own) picked.add(own);
  const talking = has(/talking|to camera|interview|founder|speaker|podcast|webcam|selfie|vlog|presenter|keynote clip/i, ...words, brief.assets);
  const demo = has(/\bdemo|walk ?-?through|tutorial|how to use|screen ?(record|cap)|recording|capture|\bui\b|app flow|onboarding|feature tour/i, ...words, brief.assets);
  const explainer = has(/explain|how it works|under the hood|architecture|concept|diagram|why it|deep dive/i, ...words);
  const titles = has(/title sequence|titles|kinetic|typograph|lyric|type-?only|text-?only|manifesto|opener|intro sequence/i, ...words);
  const oneTake = has(/one[- ]take|never cut|no cuts|one continuous (shot|take)|motion film|motion study|one shape|morph(s|ing)?\b|keynote[- ]style|seamless loop/i, ...words);
  const launch = has(/launch|announc|release|teaser|promo|introduc|coming soon|is here|now available|\bship|\bv\d|version \d/i, ...words);
  const formats = (brief.formats ?? []).map(ratio).filter((x): x is number => x !== undefined);
  const kinds = new Set(formats.map((r) => (r < 0.7 ? "tall" : r < 0.9 ? "4:5" : r < 1.1 ? "square" : "wide")));
  const multi = kinds.size > 1 || has(/cut-?downs?|every format|all formats|multi-?format|reels.*shorts|shorts.*tiktok/i, ...words, brief.deliverables);
  const length = seconds(brief.duration);
  if (talking) picked.add(BUILTIN_IDS.talking);
  if (launch || (!type && !talking && !demo && !explainer && !titles)) picked.add(BUILTIN_IDS.launch);
  if (demo) picked.add(BUILTIN_IDS.demo);
  if (explainer || (length !== undefined && length > 45 && !talking)) picked.add(BUILTIN_IDS.explainer);
  if (titles) picked.add(BUILTIN_IDS.titles);
  if (multi) picked.add(BUILTIN_IDS.social);
  // At most two kinds of film, the first ones found.
  const kindsPicked = [...picked].slice(0, 2);
  const motion = type ? MOTION_TYPES.has(type) || kindsPicked.some((k) => k === BUILTIN_IDS.launch || k === BUILTIN_IDS.titles) : true;
  const sound = type ? SOUND_TYPES.has(type) || kindsPicked.includes(BUILTIN_IDS.launch) : true;
  const brand = !!o.hasKit && (!type || BRAND_TYPES.has(type));
  const out = [...kindsPicked, ...(oneTake ? [BUILTIN_IDS.film] : []), ...(motion && !oneTake ? [BUILTIN_IDS.motion] : []), ...(sound ? [BUILTIN_IDS.sound] : []), ...(brand ? [BUILTIN_IDS.brand] : [])];
  if (multi && !out.includes(BUILTIN_IDS.social)) out.splice(kindsPicked.length, 0, BUILTIN_IDS.social);
  return out;
}

export { findingKind, guessVideoType, skillIdOf, skillIdsOf, intendedOf, isIntended, isVideoType, OPTIONAL_BAR, REQUIRED_BAR, reviewRubric, RUBRIC_CATEGORIES, rubricBar, scoredCategories, soundProfileFor, VIDEO_TYPE_NAMES, VIDEO_TYPES, DEFECT_KINDS } from "./rubric.ts";
export type { FindingRef, IntendedRef, Rubric, RubricBrief, RubricCategory, RubricLevel, VideoType } from "./rubric.ts";
