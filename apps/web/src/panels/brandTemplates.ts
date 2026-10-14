// The Brand tab's skill templates (D186): production recipes the agent follows when a project
// uses them. Plain text, short lines, "-" markers at line starts only.

export interface SkillTemplate {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly body: string;
}

const LAUNCH_PROMO = `Launch promo, 20 s, 9:16 first (cut 16:9 and 1:1 from the same edit).

Structure (times in seconds)
- 0 to 2: hook. The product doing its most surprising thing, already moving on frame 1. No logo, no intro card.
- 2 to 6: the problem in one line of type over real footage of the pain.
- 6 to 14: the product. Three beats, one idea each: show it, name it in up to 5 words, move on.
- 14 to 17: proof. One real number, quote or result from the brief. Never invent a metric.
- 17 to 20: end card. Logo, one line, the URL, held still for at least 1.5 s.

Footage
- Real product footage only: screen recordings, device captures, the kit's logos. Never mock UI.
- Crop tight on the part that matters; punch in rather than show a whole screen.
- Shots of 0.8 to 2 s. Nothing static for more than 2 s except the end card.

Type
- Kit fonts only. Headline 96 to 120 px at 1080 wide, body 48 to 56 px, never under 40 px.
- One line on screen at a time, at most 6 words. Kit text colour on the kit background.
- Keep type inside the safe area: 8 % from the sides, 12 % from the top and bottom.

Motion
- Springs for every entrance and exit: stiff for type (damping high, no visible bounce), softer for cards.
- Enter in 8 to 12 frames, exit faster than it entered.
- One move per element per beat. Nothing drifts without a reason.
- Transitions: hard cuts on the beat; a push or a whip only between sections.

Sound
- A track with a clear pulse at 110 to 130 BPM. Cuts and type entrances land on beats.
- A hit or a riser into the end card. Sound effects only on things that move on screen.
- Duck the music under any voice; end on the downbeat, not a fade.

End card
- Logo (light on dark, dark on light), the tagline, the URL in full.
- Same layout every time; the URL readable at phone size.

Check before handing it over
- Frame 1 is interesting with the sound off.
- Every beat says one thing.
- Every product shot is real and current.
`;

const TALKING_HEAD = `Talking head short, 30 to 60 s, 9:16.

Cut
- Cut by the transcript: drop fillers, false starts, repeats and long pauses.
- Keep breaths short; no gap over 0.3 s unless it lands a point.
- The hook is the strongest line said, moved to the start if it stands alone. It plays within the first 2 s.
- One idea per beat; a beat is 3 to 8 s. Cut whole sentences, never mid-word.

Captions
- Burned in, from the transcript, corrected by hand for names and product words.
- 1 to 4 words per line, two lines at most, centred in the lower third above the platform UI.
- Kit body font, bold weight, kit text colour with a soft shadow or a box in the kit background.
- Highlight the key word of each line in the kit accent colour.

Framing
- Punch-ins of 110 to 130 % on emphasis and to hide jump cuts; alternate wide and tight.
- Eyes on the upper third line. Never punch in twice in a row on the same framing.

B-roll
- Only real assets: the project's screen recordings, product captures, photos, the kit's logos.
- Cover a cut or illustrate the exact thing being said, for 1.5 to 4 s.
- Keep the speaker's audio running under b-roll.

Motion and sound
- Springs for captions and lower thirds, quick and without bounce.
- Room tone under every cut; light music ducked well under the voice.
- A soft hit on each punch-in at most; no whooshes on plain cuts.

End
- Last line is the call to action, then an end card with the logo and the URL for 1.5 s.
`;

export const SKILL_TEMPLATES: ReadonlyArray<SkillTemplate> = [
  { id: "launch-promo", name: "Launch promo 20 s", description: "A 20 s launch film: hook, problem, product, proof, end card.", body: LAUNCH_PROMO },
  { id: "talking-head", name: "Talking head short", description: "A vertical short cut from a talking head, with captions and real b-roll.", body: TALKING_HEAD },
];
