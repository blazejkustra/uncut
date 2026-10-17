// The templates that ship with Uncut (issue #111): Uncut's own, original briefs. Each is the text
// of a template file (templates.ts: front matter, Markdown, placeholders), kept here as strings so
// the server and the web bundle them with no files to package; Duplicate writes one out as the
// user's own .md file. General on purpose: they name no product and invent nothing; the facts come
// from the project through the placeholders.
import { parseTemplate, type Template } from "./templates.ts";

const KEYNOTE = `---
name: Keynote one take
description: A product launch film made from the product's own UI: one continuous take, every scene morphs out of the last, a cursor drives it, on the beat.
---

<inputs>
Use only what this project has; don't ask for more and don't invent anything.
- Project: {{project}}
- Brand: {{kit}}
- Media:
{{media}}
- Song: {{music}}
- Canvas: {{canvas}}. Length: {{length|about 30 s, or the song's length}}.
</inputs>

<direction>
A launch film in the style of a keynote reveal, told entirely with the product's own interface. One continuous take: the camera never cuts and nothing fades. Each scene is built out of the one before it: a button grows into the next panel, a card folds into a list, a shape floods the frame and shrinks into the next view.
The look is the product itself, rebuilt as clean, flat vector graphics from the kit and any screenshots in the media: its real colours, fonts, corner radii and spacing, its accent colour only on the one thing selected. The brand's logo files are used as they are, never redrawn.
When the product has a prompt box or composer, the film opens on it, and the first action is a real request typed into it in big type, word by word on the beat. If the kit has claude-mark.svg, the composer's model picker shows that mark beside the model name, exactly as in the app; paste the file in, never redraw it.
A cursor causes every change. It moves on a soft curve, rests, clicks, types, drags. Nothing changes without a visible reason.
The camera pushes in so the moment that matters fills the frame and reads on a phone, then glides to the next one. The cursor scales with the camera.
Never: crossfades, blur-ins, 3D flips, particles, glows, gradients on interface chrome, panels or features the product doesn't have, made-up numbers or quotes, holds longer than a second, anything that looks like a stock template.
</direction>

<structure>
{{tempo|The song's tempo}}, {{beats|one change on every beat}}: something happens on every beat, one big change per bar.
- Open: the product's first screen, already moving on frame 0, filling the frame. The cursor arrives and does the first real action.
- Build: each feature grows out of the last. One feature per bar or two, each shown doing its one job, named in a few words at most.
- Drop ({{drop|the song's biggest moment}}): the biggest reveal lands here, the product's most impressive moment, edge to edge.
- Proof: only what's true, from the kit or the media. If there's nothing to prove with, skip it.
- Close: the interface collapses into the logo, and the tagline and URL rise out of a mask line if the kit has them, landing on the last downbeat. The last frame matches the first, so the film loops.
</structure>

<build>
- One motion graphic spanning the whole film, every frame a pure function of time: no CSS transitions, timers or state carried between frames.
- Moves settle on springs; a value with several targets is the sum of one spring per change, so any frame can be drawn on its own.
- Typing is a function of time too: the visible characters come from t.
- Footage inside the film: downscale it to the canvas first, re-encode it all-intra so any frame seeks fast, and wait for each seek to finish before drawing.
- Find the beat grid and the drop from the song before placing anything. Start on a downbeat; put big changes on downbeats and the reveal on the drop.
- Music only, no added effects unless asked; master around -14 LUFS.
- Check a still per beat, then scan the whole film for one-frame pops (a frame that differs from its neighbours far more than they differ from each other), cramped text and anything unreadable at phone size.
</build>

<gotchas>
- A shape that floods the frame must overscale past the corners, or the edges show for a frame.
- Text that changes inside a morphing shape needs its own mask.
- A child set visible shows through a hidden parent; let children inherit visibility.
- will-change on anything the camera scales renders its text blurry; leave it off.
- The last frame has to match the first, cursor included, or the loop jumps.
- Everything on screen must exist in the product. When unsure, leave it out.
</gotchas>

<start>
Write the beat map first (a state per bar, on the song's real beats) and check four stills: the open, the first build, the drop and the close. Then build the whole film, check your own work, and leave the finished film with the song on the timeline.
</start>
`;

const ONE_SHAPE = `---
name: One shape, never cut
description: A one-take film where a single shape carries every scene, morphing from one state to the next on the beat, with no cuts.
---

<inputs>
Use only what this project has; don't ask for more and don't invent anything.
- Project: {{project}}
- Brand: {{kit}}
- Footage and images:
{{footage}}
- Song: {{music}}
- Canvas: {{canvas}}. Length: {{length|the song's length}}.
</inputs>

<direction>
One hero shape, a rounded rectangle or a pill, is on screen from the first frame to the last and never leaves it. Every scene happens inside it or is made from it: it holds a clip, stretches into a title bar, splits into a row of cards, floods the frame and contracts again. There are no cuts, wipes or fades; every change is the shape changing.
When the film is about footage, the shape carries the clips and is large: at rest it fills most of the frame, and it goes full bleed on the biggest moments. Footage stays sharp, never zoomed until it softens.
Words are few and big: a headline of one to three words at a time, rising out of a mask line, readable on a phone.
Never: hard cuts, crossfades, blur-ins, slices or tiles, bouncy easing, particles, glows, frames that are nearly empty, holds over a second except the end.
</direction>

<structure>
{{tempo|The song's tempo}}, {{beats|a change on nearly every beat}}.
- Open: the shape is already moving on frame 0, holding the strongest image or a big headline.
- Middle: a new state every bar, each made out of the last. Vary the form (inset, full bleed, pill, split) so no two bars look the same.
- Drop ({{drop|the song's biggest moment}}): the shape floods the frame with the best shot.
- End: the shape settles into the logo or a last word from the kit, held about a second, and springs back to the first frame's shape so it loops.
</structure>

<build>
- One motion graphic for the whole film; every frame is a pure function of time.
- Morphs take about 0.4 s, moves about 0.8 s, settling softly. One main move at a time; the next can start as it settles.
- Read the song's beat grid and drop first, start on a downbeat, and put transitions on the kick.
- Check one still per bar, then scan for one-frame pops and near-empty frames.
</build>

<gotchas>
- A flood must overscale past the corners and take about a third of a second, or the corners pop and half the frame changes at once.
- A clip inside a shape is drawn at its shown size or larger; never upscale a small file into a full-bleed frame.
- The last frame must equal the first, or the loop stutters.
</gotchas>

<start>
Plan a state per bar on the song's real beats, check four stills (the open, the drop, the busiest moment, the end), then build the film and check it before you finish.
</start>
`;

const BEAT_CUT = `---
name: Beat-cut reel
description: A fast reel of the best moments of your footage, cut on the song's beats, with the biggest shot on the drop.
---

<inputs>
Use only what this project has; don't ask for more and don't invent anything.
- Project: {{project}}
- Footage:
{{footage}}
- Song: {{music}}
- Brand: {{kit}}
- Canvas: {{canvas}}. Length: {{length|the song's length}}.
</inputs>

<direction>
A reel that feels edited to the music: every cut lands on a beat, the energy follows the song. Pick the strongest moments of the footage: steady, sharp, well exposed, something moving in the frame. Leave out shaky, blurred or frozen stretches and gaps in the recording.
Fill the canvas: reframe each shot for this aspect ratio rather than letterboxing it, keeping the subject where the eye already is from the shot before.
Text is optional and sparse: at most a short title at the start and the brand at the end, using the kit's fonts and logo files.
Never: speed ramps or effects on every cut, the same shot twice, transitions that hide weak footage, invented captions or claims.
</direction>

<structure>
{{tempo|The song's tempo}}, {{beats|cut on the beats}}.
- Open: the most striking shot on frame 0, already in motion. No fade from black.
- Build: shots of one or two beats, wider first, getting tighter and faster towards the drop.
- Drop ({{drop|the song's biggest moment}}): the best shot of all lands exactly here.
- After the drop: the fastest cutting, then slow down for the last bar.
- End: the last shot or the logo held on the final downbeat, the music ending with it, not cut off.
</structure>

<build>
- Analyse the footage for clean stretches and the song for its beat grid and drop before cutting.
- Place every cut on a beat frame; big changes on downbeats.
- Trim the song so it ends on a phrase, and fade only its last beat if it has to stop early.
- Keep the music around -14 LUFS; mute the clips' own sound unless it adds something.
- Watch it through once at full speed and fix any cut that lands off the beat.
</build>

<gotchas>
- A clip trimmed past a drop in its recording jumps; check the cut points.
- Two similar shots in a row read as a jump cut; separate them or pick one.
</gotchas>

<start>
Pick the shots and lay out the beat map first, then cut the reel, check it against the beats, and leave it on the timeline with the song.
</start>
`;

const TALKING_HEAD = `---
name: Talking head with subtitles
description: A tight cut of someone talking to camera, with the filler taken out and burned-in subtitles from the transcript.
---

<inputs>
Use only what this project has; don't ask for more and don't invent anything.
- Project: {{project}}
- Media:
{{media}}
- Brand: {{kit}}
- Canvas: {{canvas}}. Length: {{length|as long as the strongest take needs, under a minute for a social cut}}.
</inputs>

<direction>
A clean, tight cut of the speaker that keeps their meaning and their voice. Cut from the transcript: take out fillers, false starts, repeats and long pauses, keep whole sentences, and keep a pause when it lands a point. Never change what was said or the order that changes its meaning.
Open on the strongest line that stands on its own; it can move to the start if it makes sense there.
Hide jump cuts with a gentle punch-in on emphasis, alternating framings, or real b-roll from the media over the voice. Keep the face in the same place across cuts.
Subtitles on every line, from the transcript with names and product words spelled right: short groups of a few words, at most two lines, placed clear of the platform's buttons and the bottom of the frame, in the kit's font. One highlighted word per line at most.
Never: words the speaker didn't say, captions that bounce on every word, music that competes with the voice, effects over speech.
</direction>

<structure>
- Hook: the strongest line in the first two seconds, subtitled from frame 0.
- Body: one idea per beat of the talk, a few seconds each, in the speaker's order.
- Close: the call to action as said, then the logo and URL from the kit if there is one.
</structure>

<build>
- Transcribe first, then cut by the transcript.
- Make the subtitles from the same transcript after cutting, and read them through once against the audio.
- Voice clear and levelled around -14 LUFS; any music ducked well under it, or none.
- Check the hook, every punch-in and the subtitles at phone size.
</build>

<gotchas>
- A cut in the middle of a breath sounds wrong; cut in the gaps.
- Subtitles that sit too low get covered by the platform's interface.
</gotchas>

<start>
Transcribe, propose the cut as a list of the lines you keep, then make it, add the subtitles, and check the result before finishing.
</start>
`;

/** Uncut's built-in templates, in the order the menu lists them. */
export const BUILTIN_TEMPLATES: ReadonlyArray<Template> = [
  ["keynote-one-take", KEYNOTE],
  ["one-shape-never-cut", ONE_SHAPE],
  ["beat-cut-reel", BEAT_CUT],
  ["talking-head-subtitles", TALKING_HEAD],
].map(([id, text]) => ({ ...parseTemplate(text!, id!), builtin: true as const }));

export const BUILTIN_TEMPLATE_IDS: ReadonlySet<string> = new Set(BUILTIN_TEMPLATES.map((t) => t.id));
