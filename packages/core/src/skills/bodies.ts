// The built-in skills' bodies (D207, issue #30). Written for Uncut from the research in
// planning/DECISIONS.md D207: practices adapted and reworded, numbers cited there; no source's text
// is copied. Same shape in each: what it's for, structure, rules, do, don't, example, and a
// "Review checklist" (skillChecklist reads it; the critic checks each line on the frames).
// Plain text: "-" only at line starts, never ·, • or * between words.

const LAUNCH = `A launch film of 15 to 30 s for a feed. It sells one promise, not a feature list.

Structure (one job per beat)
- 0 to 2 s: the hook. The product doing its most surprising thing, or the sharpest claim, already moving on frame 0. No logo intro, no company description, no fade from black.
- 2 to 6 s: the problem, one line of type over something real (the slow old way, the error, the mess).
- 6 to 18 s: the reveal. Three beats at most on the real product, each showing one thing and naming it in 5 words or fewer.
- 18 to 23 s: proof. One real number, quote or result that the brief gives. Never invent one.
- Last 3 to 4 s: the call to action. Logo file, one line, the URL, held still: the longest hold in the film.
- Pick one arc and keep it: problem, agitation, product, proof, CTA; or before, after, bridge; or a demo loop.

Rules
- Name the brand on screen within the first 5 s.
- Shots of 0.8 to 2 s, cut on the music's beats (beat_grid); the reveal and the end card on downbeats.
- One line of type at a time, 6 words at most, held for at least 0.3 s a word and never under 1 s.
- Real footage only: captures, screenshots, the kit's logo files. A missing asset is asked for, not mocked up.

Do
- Crop into the part of the UI that matters; punch in rather than show a whole screen.
- Let the reveal breathe: a 1 to 1.5 s hold after the product lands.

Don't
- Don't open on a logo sting, a black frame or a slow zoom.
- Don't list features; show one promise three ways.
- Don't put a new line of text in the last 2 s.

Example
- 0.0 "Your CI takes 40 minutes" over the real red pipeline, 2.0 cut on a downbeat to the product run finishing, 4.5 "Now it takes 4", 7.0 three UI beats, 19.0 one customer number from the brief, 23.0 logo, "Try it free", URL.

Review checklist
- Frame 0 shows motion or the claim, with the sound off.
- The brand is on screen within the first 5 s.
- Every beat says one thing; no beat repeats another's look.
- Every product shot is real footage or a real screenshot, nothing mocked up.
- The proof is from the brief, not invented.
- The end card holds still for at least 2 s with a readable URL.`;

const DEMO = `A product demo built on real UI recordings (captures, screen recordings, device frames).

Structure
- Hook: the end result first (the finished thing, the number going green), 2 s.
- The task in one line: what the viewer will see done.
- Three to six steps, each a real recording: start state, the action, the new state. A UI flow usually spans several beats on the same screen.
- The result again, then the call to action.

Rules
- Crop or punch in to the region that changes; text in the UI must be readable at phone size (360 px wide). If it isn't, zoom to 150 to 250 % on that region.
- One state change per beat. Hold the new state 1 to 1.5 s after it lands, so the eye catches up.
- Speed up waiting only, and say so in words ("2x"); never mix speeds without saying it.
- Cursor: one cursor, moving in arcs with an ease, slowing into the target; a click shows a small press (scale 0.95, back on a snap spring). Hide stray or doubled cursors.
- Device frames hold the real capture; an empty phone or browser frame is a defect, never a style.

Do
- Cut on the action: cut as the click lands or as the panel starts to move, never in the dead time after.
- Label a step with a short callout next to the thing it names, kit body font, at least 40 px at 1080 wide.

Don't
- Don't show a whole desktop at 1:1; nobody can read it on a phone.
- Don't add a click sound to a text appearing or to typing; clicks go on real clicks.
- Don't put glow, blur or gradients on UI: it stops looking like the product.

Example
- Capture of "Deploy" pressed, punch in 180 % on the log, 3x on the build with "3x" in the corner, hold 1.2 s on "Live", end card.

Review checklist
- Every screen shown is a real capture of the product, no empty device frame.
- UI text that matters is readable at 360 px wide.
- Each step shows a visible state change and holds it at least 1 s.
- One cursor at most, and it moves to what the step is about.
- Any speed change is labelled on screen.`;

const TALKING = `A 9:16 short of 30 to 60 s cut from a talking head, with burned-in captions and real b-roll.

Structure
- The hook is the strongest line said, moved to the start if it stands alone, playing in the first 2 s.
- One idea per beat, 3 to 8 s each, whole sentences only.
- The last line is the call to action, then an end card with the logo file and URL for 2 s.

Cut
- Cut by the transcript (transcript_edit): fillers, false starts, repeats, pauses over 0.3 s, unless a pause lands a point.
- Hide jump cuts with a punch-in of 110 to 130 % on emphasis; alternate wide and tight, never two punch-ins in a row on the same framing.
- Use J and L cuts on b-roll: the voice runs on under the picture change, so the story never stops for a cut.

Captions
- From the transcript (captions_make), names and product words corrected by hand.
- Groups of 2 to 6 words or at most 2.5 s, breaking at a pause, a comma or a sentence end; each on screen at least 0.5 s.
- At most 2 lines (3 in 9:16), up to 90 % of the width, in the lower middle: clear of the top 15 % and the bottom 35 %, and of the right 18 % where the app's buttons are.
- Kit body font, bold, kit text colour with a box or soft shadow; one key word per line in the accent colour at most.

Do
- Eyes on the upper third line; keep the face in the same place across cuts.
- B-roll illustrates the exact thing being said, 1.5 to 4 s, with the speaker's audio under it.

Don't
- Don't caption with a template animation on every word; a cut-in is enough.
- Don't add whooshes on plain cuts; a soft hit on a punch-in at most.
- Don't let music compete: ducked well under the voice or none.

Example
- "We deleted our staging server." 0 to 2 s, punch-in 120 % on "deleted", b-roll of the real dashboard while the voice continues, CTA line, end card.

Review checklist
- The first 2 s carry the strongest line, with captions on frame 0.
- Captions are readable at 360 px wide and stay out of the platform's UI zones.
- No caption group longer than 6 words or shorter than 0.5 s on screen.
- No visible jump cut without a punch-in or b-roll over it.
- The voice is clear: music ducked under it, no effect over a word.`;

const SOCIAL = `One edit delivered in several formats: 9:16, 4:5, 1:1 and 16:9, each built for its feed, not letterboxed.

Structure
- Build the master in the most demanding format the brief needs (usually 9:16 or 4:5), then make each other format its own project or cut.
- Per format: reframe each shot (punch in, move the crop), re-flow the type, re-check every hold.
- Shorter cuts (6 s, 15 s) keep the hook, the one strongest beat and the end card; drop beats, never speed them up.

Rules
- Safe areas at 1080 x 1920: text out of the top 15 % and the bottom 35 %, and clear of the right 18 % (TikTok and Shorts buttons). 4:5 and 1:1: 8 % from every edge.
- Captions or supers on every line that matters: many people watch muted.
- Type sizes from the shorter side: headline at least 84 px, body at least 44 px at 1080.
- Frame 0 is the thumbnail and the autoplay: the claim or motion, never black.

Do
- 4:5 (1080 x 1350) for X, LinkedIn and Instagram feeds; 9:16 for Reels, TikTok and Shorts; 16:9 for YouTube, sites and decks.
- Check every format at phone size before handing it over.

Don't
- Don't pillarbox a 16:9 edit into 9:16 with blurred bars.
- Don't keep a layout that crops the logo or the URL in a narrower format.
- Don't copy the master's text positions blindly; re-place them per format.

Example
- Master 4:5 25 s; 9:16 with captions raised above the bottom 35 %; 1:1 with the end card re-flowed; 6 s cut: hook, reveal, end card.

Review checklist
- Each format fills its frame; no letterbox or blurred bars.
- All text and logos sit inside that format's safe area.
- Text is readable at 360 px wide in every format.
- Shorter cuts keep the hook and the end card.`;

const EXPLAINER = `How it works, in 30 to 90 s: a concept, an architecture, a workflow. Clarity over flash.

Structure
- Hook: the question the viewer has, or the surprising answer, in the first 3 s.
- Context in one beat: what exists today and why it falls short.
- The idea in steps, one per beat: each beat adds one element to a diagram or one step to a flow.
- A real example on the product (a capture) that proves the idea.
- Recap in one line, then the call to action.

Rules
- Build diagrams step by step: each new box or arrow arrives when the voice or the caption names it, in the later half of its beat, not all at once at the start.
- One focal element per frame; everything that isn't the focus is still and dimmed.
- Voice or supers of 6 to 20 words a beat. Hold text at least 0.3 s a word.
- Arrows and paths draw along their direction with an ease; boxes land with a settle spring.
- Keep the same layout for the diagram across beats so the viewer's map holds; move the camera, not the boxes.

Do
- Use the kit's colours by meaning: one accent for the thing that's new, the rest neutral.
- Label every element in the diagram with real names from the product.

Don't
- Don't fill the screen with the full diagram on the first frame.
- Don't add icons or numbers the brief doesn't give.
- Don't let a beat run past 8 s with nothing new on screen.

Example
- "Where does a request go?" 0 to 3 s; client box, then edge box, arrow drawing between them as the caption names it; capture of the real trace; "One hop instead of four", CTA.

Review checklist
- Every diagram builds step by step; nothing appears before it is named.
- Each frame has one clear focal element.
- Labels use real product names; no invented figures.
- No stretch over 8 s without a visible change.`;

const TITLES = `Titles and kinetic typography: type is the picture. Openers, manifestos, word-led promos, end cards.

Structure
- A hierarchy: one headline size, one support size, one small label size; never more than three.
- Rhythm in two speeds: quick runs (about 0.4 s a word or short phrase) for energy, statement holds (1.5 s or more) for what must be read. Alternate them.
- The climax word or line gets the one special treatment (the accent colour, a bigger size or a different move), once.
- The last card is the longest hold.

Rules
- Hold every line at least 0.3 s a word after its entrance finishes, never under 1 s; one line on screen at a time unless it's a list being built.
- Each beat has one entrance; nothing from the previous beat lingers.
- Motion follows reading order: words enter left to right or top to bottom, a few frames apart (2 to 4 frames stagger), and settle on a snap or land spring with no visible bounce.
- Cut type on the music's beats; the climax on a downbeat.
- Type at least 84 px for headlines and 44 px for support at 1080 wide; tracking tighter as size grows; kit fonts only.

Do
- Use scale, position and weight changes on the words themselves; let the empty space work.
- Exit faster than you entered, or cut out on the beat.

Don't
- Don't centre a gradient title on a dark field with a glow: the default AI look.
- Don't fade every line in and out; most lines simply cut in.
- Don't animate every letter, or use typewriter reveals for anything but code.
- Don't put dots, bullets or stars between words; use commas or line breaks.

Example
- "Builds." "Tests." "Deploys." at 0.4 s each on beats, then "All in one place" held 1.8 s, accent on "one", end card held 3 s.

Review checklist
- No more than three type sizes, kit fonts only.
- Every line is fully readable for at least 0.3 s a word.
- Only one moment gets special treatment.
- No centred gradient-plus-glow title, no fade on every line.
- Type sits inside the safe margin and reads at 360 px wide.`;

const MOTION = `Motion craft: every move has a reason, starts and lands well, and leaves time to read.

Springs by object class (Uncut's presets)
- Type and small UI (buttons, chips, cursor presses): snap, quick and critically damped, no visible bounce.
- Panels, cards, screenshots, device frames: settle, a little slower, no overshoot you can see.
- Headlines and hero moments: land, a firm arrival with at most a hint of overshoot.
- bounce only when the brand is playful and the brief says so; bounciness is the fastest way to look cheap.
- Opacity and colour changes: no spring, a short ease (150 to 250 ms).

Timing
- Entrances 8 to 12 frames at 30 fps (250 to 400 ms); exits shorter (6 to 8 frames) or a cut.
- Big moves over a long distance at most about 600 ms; anything slower feels like a drag.
- Stagger related elements 2 to 4 frames apart in reading order, image first, its label trailing.
- Hold after every arrival: at least 0.3 s a word for text, 1 s for a UI state, before the next change.

Rules
- One focal element moves at a time; everything else holds still.
- Ease in and out, never linear (except a deliberate constant scroll). Curved paths over straight diagonals for travel.
- Cut on motion: a cut at the peak of a move, the next shot moving the same way at the same speed.
- render(t) graphics are pure functions of t: springs from uncut:lib, seeded random, no timers.

Banned clichés
- A centred gradient title on a dark field.
- Everything fading in, or every text with the same entrance.
- Glow, bloom or drop shadows on UI and screenshots.
- Corner labels and pill tags with no reason to be there.
- A floating blob or orb as the background; a stray decorative cursor.
- Slow push-ins and breathing loops to fill time.
- Everything on screen in the first quarter of a scene.

Review checklist
- Every move settles cleanly; no linear drifts, jitter or visible bounce on type and UI.
- Only one thing moves at a time in each beat.
- Every text and UI state holds long enough to read before the next change.
- None of the banned clichés is on screen.
- Moves follow reading order and the music's beats.`;

const SOUND = `Sound design: sound makes the picture land. Fewer, quieter, exactly in sync. When in doubt, leave it out.

Music
- Pick music for the pace: punchy cuts every 1 to 2 s want 110 to 130 BPM with a clear pulse (music_list tempo fast); calm demos or explainers 80 to 100 BPM. Never a slow lo-fi loop under a fast edit.
- Run beat_grid once the music is placed; cuts and state changes on beats, the reveal and end card on downbeats.
- Fade in about 1 s unless it starts on a hit; end on a downbeat or a 2 s fade; never make the video longer for the music.
- Under a voice: duck it (audio.duck, about -12 dB) or keep it 15 to 20 dB under the voice; the voice always wins.

Sound effects: when
- Only on a real visual event: a cut it carries, an element landing, a real click by a cursor or finger, the reveal, the logo.
- At most one effect per event and at most 4 in any 10 s; a 20 s promo usually needs 3 to 6 in total.
- One big hit (boom, impact) in a film, on the moment that matters most; a riser only into that moment.
- Vary by meaning: whooshes for movement between scenes, a soft tick for a UI press, a hit for the reveal. The same file at most twice.
- No meme sounds (airhorn, bruh, laugh, record scratch) unless the user asked for that joke.
- No UI clicks on text appearing or as typing; typing gets a real keyboard sound or nothing.
- A cut on the beat needs no whoosh: the music already carries it.

Sound effects: how
- 6 to 12 dB under the music (gainDb), since the bundled effects are peak-normalised and jump out at the same gain.
- Start a whoosh or hit 1 to 2 frames before the frame it hits; a riser ends on the frame it builds to.
- Short fades on effects that ring past their moment; nothing over a spoken word.

Mix
- Aim for about -14 LUFS integrated and a true peak under -1 dBTP for social and YouTube.
- Read the mix blind: list every sound with its time (project_check's sound findings, the critic's sound sheet). If the list alone sounds like a meme reel or a click track, cut it down.

Review checklist
- Every sound effect lands on something that changes on screen.
- No more than 4 effects in any 10 s, no file more than twice, one big hit at most.
- Effects sit under the music; the voice is never masked.
- The music's tempo fits the cutting, and cuts land on its beats.
- No meme sound or UI click the picture doesn't call for.`;

const BRAND = `Brand application: the kit, applied with restraint, so the video looks like the product and nothing else.

Rules
- Colours by role: the kit's background and text colours carry most of the frame; the accent appears once or twice per beat, on the thing that matters. Never a colour outside the kit (the style guide's palette counts).
- Fonts: the kit's families and weights only, its files loaded; one family for type unless the kit names a second for code or display.
- Logos: the kit's files only, the right one for the background (light, dark, mark), never redrawn, traced, recoloured, stretched or retyped. Clear space around it at least the height of its mark.
- Tone and copy: the kit's tone, its taglines and URLs exactly as written; plain words, no filler ("seamlessly", "unlock", "supercharge").
- Real product: the brief's real captures and screenshots, at their real colours.
- The project's theme uses the kit (update_project theme), so components and graphics match.

Do
- Use the kit's examples and style guide for grammar (shot lengths, transitions, type scale), never for content.
- Check the logo at phone size on the end card: it must be crisp and centred in its space.

Don't
- Don't invent a logo, an app icon, product UI, metrics, quotes or customer logos.
- Don't bring a reference video's colours or fonts into the kit.
- Don't decorate: no gradients, glows or textures the kit doesn't have.

Example
- Kit near-black background, off-white text, one green accent: titles off-white on near-black, the accent only on "4 minutes" and the CTA button, logo-light on the end card with its URL.

Review checklist
- Only the kit's colours, fonts and logo files are on screen.
- The logo is the kit's file, on a background it was made for, never distorted.
- The accent marks what matters, not everything.
- Copy matches the kit's tone; taglines and URLs are exact.
- Nothing invented: no fake UI, metrics, quotes or logos.`;

export const BUILTIN_BODIES = { launch: LAUNCH, demo: DEMO, talking: TALKING, social: SOCIAL, explainer: EXPLAINER, titles: TITLES, motion: MOTION, sound: SOUND, brand: BRAND } as const;
