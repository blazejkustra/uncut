/**
 * Whether the film is meant as one take (no cuts, no holds: the motion-film skill, or the brief's
 * words) and as a loop (the brief's words only, since the skill no longer prescribes one). D296: and whether it is footage first (the brief's words name footage, or the
 * timeline has video or pictures), where the footage should fill the frame.
 */
/** Words that make a film UI first: it shows an app's interface. */
const UI_WORDS = /\b(app|UI|interface|screens?|composer|timeline|cursor|software|the program)\b/i;

/**
 * Phrases that ask for one take. "cut off/out/into" is cropping or trimming, not an edit cut;
 * "uncut" is the app's name; "one-shot" usually means one prompt. English only: other languages aren't detected (the skill or the brief
 * still make the film one take, with findings rather than blockers).
 */
const ONE_TAKE =
  /\b(?:one|single)[- ]take\b|\boner\b|\b(?:one|single) (?:continuous|unbroken) (?:shot|take|move|camera move)\b|\bcontinuous (?:shot|take)\b|\b(?:never|don'?t|do not) cut\b(?! ?(?:off|out|into|down|back|short))|\b(?:no|zero|without(?: any)?) (?:hard )?cuts?\b|\bwith no (?:hard )?cuts?\b/gi;
/** Before a phrase in its clause: it is negated ("not one take", "doesn't need to be one take"). */
export const NEGATED =
  /\b(?:not|no need|needn'?t|isn'?t|aren'?t|don'?t|doesn'?t|do not|does not|won'?t|instead of|rather than|forget|skip|drop|avoid|nor)\b[^.;!?\n]{0,30}$/i;
/** An alternative or a release: "one take or cuts, your call", "cuts are fine", "up to you". */
const OPTIONAL =
  /\bor (?:hard )?cuts?\b|\bcuts? or\b|\bcuts? (?:are|is) (?:fine|ok(?:ay)?|allowed|welcome)\b|\byour call\b|\bup to you\b|\beither way\b|\bif you (?:want|like|prefer)\b|\boptional(?:ly)?\b/i;

/** A request's clauses: sentences, and the turns "but", "actually", "however" start. */
export const clauses = (text: string): Array<string> => text.split(/(?<=[.;!?\n])\s*|\s+(?:but|actually|however)\s+/i);

/**
 * Whether these words ask for one take: some clause has a one-take phrase that isn't negated or
 * offered as one option. Conservative (a miss leaves cuts as findings; a false ask fails rounds):
 * the last clause that speaks to it wins, so "one take" then "actually, cuts are fine" is no ask.
 */
export function asksOneTake(text: string): boolean {
  let verdict = false;
  for (const clause of clauses(text)) {
    const hits = [...clause.matchAll(ONE_TAKE)];
    const release = OPTIONAL.test(clause) || /\b(?:add|use|with) (?:a |some )?(?:hard )?cuts?\b|\bcuts? (?:are|is) (?:fine|ok(?:ay)?|allowed)\b/i.test(clause);
    if (!hits.length) {
      if (release && /\bcuts?\b/i.test(clause)) verdict = false;
      continue;
    }
    verdict = !release && hits.some((m) => !NEGATED.test(clause.slice(0, m.index)));
  }
  return verdict;
}

/** Footage named in a request: the shots a cut goes between. */
// "shot" and "take" alone aren't footage: "one continuous shot, cut on the beat" asks for one take.
const FOOTAGE_NOUN = /\b(?:footage|drone|clips?|shots|b-?roll|aerials?|videos)\b/i;
/** A cut as an edit: "cut", "cuts", "cutting", "chop", "intercut", "beat cuts". */
const CUT_VERB = /\b(?:cut|cuts|cutting|chop(?:ped|ping)?|intercut)\b/i;
/** The beat, the music it lands on. */
const BEAT = /\b(?:beats?|rhythm|music|song|track|tempo|drums?|bpm)\b/i;

/**
 * D306: whether these words ask for the footage cut on the beat: some clause names footage, a cut and
 * the beat (or the music) together, not negated ("cut the drone clips to the song", "footage cut on
 * the beat", "beat cuts between the drone shots"). Then cuts between footage shots are what the user
 * asked for, and only the user's own one-take words make the other cuts block.
 */
export function asksFootageCuts(text: string): boolean {
  return clauses(text).some((clause) => {
    const cut = CUT_VERB.exec(clause);
    if (!cut || !FOOTAGE_NOUN.test(clause) || !BEAT.test(clause)) return false;
    return !NEGATED.test(clause.slice(0, cut.index)) && !/\b(?:don'?t|do not|never|no)\s+cut/i.test(clause);
  });
}

/**
 * Phrases in the user's own words that make the film a loop: "seamless loop", "loops forever",
 * "a looping video", "make it loop", "last frame = first". A loop the film shows or mentions
 * ("the loop diagram", "the feedback loop", "in the loop") isn't one.
 */
const LOOP_ASK =
  /\bseamless(?:ly)? (?:loop|looping|loops|repeat)s?\b|\bloops? (?:seamlessly|forever|endlessly|back|perfectly|smoothly)\b|\b(?:looping|loopable|looped|infinite|endless) (?:video|gif|animation|clip|film|background|bg|reel|sequence)\b|\b(?:make|let|have) (?:it|the (?:film|video|animation)) loop\b|\b(?:it|the (?:film|video|animation)) (?:should|must|needs to|has to|will) loop\b|\b(?:as|into) a (?:seamless |perfect )?loop\b|\blast frame (?:is|=|equals|matches) (?:the )?first\b/i;

/** Whether the user's own words ask for a film that loops (LOOP_ASK, not negated in its clause). */
export function asksLoop(text: string): boolean {
  return clauses(text).some((clause) => {
    const m = LOOP_ASK.exec(clause);
    return !!m && !NEGATED.test(clause.slice(0, m.index));
  });
}

/**
 * What the film is (the brief's words, the active skills) and what the user asked for in their own
 * words (`request`): `asked` when the request itself asks for one take. A1-noskill3 asked for "one
 * take on the beat" with the motion-film skill off, and its four hard cuts were findings only: the
 * request decides that cuts fail the round, whatever skills are on (hard in motionFindings).
 */
export function motionIntent(o: { readonly skills: ReadonlyArray<string>; readonly words: string; readonly hasFootage?: boolean; readonly request?: string }): {
  oneTake: boolean;
  loop: boolean;
  footage: boolean;
  asked: boolean;
  footageCuts: boolean;
} {
  const film = o.skills.includes("motion-film");
  const asked = asksOneTake(o.request ?? "");
  return {
    asked,
    footageCuts: asksFootageCuts(o.request ?? ""),
    oneTake: film || asked || asksOneTake(o.words),
    // The loop seam only matters when the user asked for a loop (argent-e2e: "the loop diagram's style" in the brief).
    loop: asksLoop(o.request ?? ""),
    // Rehearsal 3: a UI-first film names its footage too (the preview plays it), but its frames are a
    // calm canvas around one UI element by design, so its words naming the app's UI keep it UI first.
    footage: !!o.hasFootage || (/\b(footage|drone|b-?roll|clips?|travel|photos?|aerials?)\b/i.test(o.words) && !UI_WORDS.test(o.words)),
  };
}
