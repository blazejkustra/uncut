/* uncutUI (Uncut, MIT): Uncut's own editor UI for a film about Uncut itself: the real app's markup
   and CSS, generated from its React components (scripts/ui-parts.ts), as live DOM (crisp at any
   size). Load it with the marker uncut:lib/ui.js (a script tag with that src). Dark, as the app.
   READABLE: every word the viewer must read stands at least 3 % of the frame's height (its letters; a font
   of 4.2 %). Two calls get there: a piece at its default type (4.8 % of the height; a smaller type is
   smaller words, and type sizes the piece's FIRST line: a thread's 12 px step rows come out 12/13 of its
   message, so give steps their own "turn.steps" key), or uncutUI.frameText(el, world, { width, height })
   as the camera key on the stage. render_frames lists every word under 3 % in each frame it draws.
   Build the film from PIECES: one element of the UI on its own (the composer, a step row, a lane of
   clips, the filter slider, the preview, Export, Saved), set LARGE on a calm canvas (60 to 90 % of
   the width, its text 4.5 % of the frame's height or more), each one morphing into the next. A whole
   panel only briefly, and only when its words read on a phone; never a camera panning over a
   desktop-sized window: that reads as a screen recording. Or the whole program as the STAGE: the
   editor mounted live (its panels follow props every frame), blurred behind a big hero piece, then
   in focus while a camera (uncutMotion.camera) pushes into the region where the work happens.
     uncutUI.sequence(host, t, keys, { dur: 0.9 })    // ONE shell carried through keys (call it every frame):
       keys: [{ at, piece: "composer", props }, { at: 2, piece: "message", props, carry: [["input", "text"]] }, ...]
       piece: "part.slot" (or "part"); props: the part's props below; index: the nth match. Big by default:
       centred in the host, 86 % of its width, its words type px tall (default 4.8 % of the host's height:
       the layout narrows so they wrap and set large). x, y: its centre; width: host px; type: words' height
       (0: the app's); size: its own layout size in app px instead; height: a taller or wider shell; pad,
       radius, background, color (restyles); theme: "light" (white surfaces, dark words) or the app's dark;
       press: the shell's scale (uncutMotion.click's .button); fit: "contain" | "cover" (default cover for
       preview.frame); shadow: false; dur: its morph; from: "down" (default), "up", "left", "right", "none".
       From each key's at the shell's centre, size, radius and colour travel to it in dur s (a calm glide:
       eases off, slows down longer than it sped up, no overshoot) while the new content pushes in from its
       side out of a blur and the old leaves by the other, both at one uniform scale (never two legible
       pictures at once); carry: selectors (or [old's, new's]) that travel instead, the prompt shrinking
       into its message. A leaving preview frame stays put, cropped by the shell. The same piece twice (one more step) grows without a swap. Pure in t.
       A swapped-in piece reads from about at + 0.6 dur and is at rest at at + dur: start the key at least its dur before
       the moment it shows (a frame mid-swap is blurred and dim by design; render_frames names a word softened by a swap).
       typing: { at, dur, from }: props.text typed in (from characters at at, all of it by at + dur), the shell
       growing a line at a time over 0.22 s at each wrap, its toolbar riding the bottom edge: pass the WHOLE text
       (also in a fly's from key), never a slice you cut per frame, which makes the card jump a line per wrap.
       Returns { x, y, w, h, r, p, key, el, type } (el: the shown piece's element, for find and rectIn).
     uncutUI.piece(host, "export.high", { props, width, x, y, ... })  // one piece alone (sequence's key at rest)
     uncutUI.mount(host, "editor", { width: 1440, height: 1000, blur, dim, ...props })  // the program as a live stage:
       call it every frame; each panel is rebuilt only when its props change (clips moving, steps growing,
       the playhead, an export's progress). blur (px on screen at its scale) and dim (0..1): the program
       behind a hero. width, height: the window it lays out in (the real responsive layout). time: t, so a
       running step's spinner turns (pass it every frame).
     uncutUI.fly(fx, t, { at, dur: 0.9, from, to, arc, leave, fit, id })  // one element travelling into its place,
       call it every frame for every flight: from a piece key (the big hero composer, shown at rest before at,
       its Send pressed), an element (a media tile, the prompt's text) or a rect, to an element in the stage
       (the editor's composer, a timeline clip, the preview's frame); rect, radius and colour travel on an arc
       (host px, negative: up) while the start's look hands over to the landing element's own; the landing
       element is hidden until it lands, then the real one shows. leave: the from element goes at at (the
       prompt leaving the composer); fit: "cover" (default) | "contain" (text into a bubble); id: one per
       flight in the air. fx: a layer above the stage's camera (rects are measured on screen, so a moving
       camera is fine), best once the camera has settled; several flights go one after another, each
       leaving as the last lands. Returns { x, y, w, h, p, el } (el: the hero piece's element while it is up).
     uncutUI.rectIn(el, host)                         // { x, y, w, h }: an element's rect in host px (aim a click at Send)
     uncutUI.frameText(el, host, { width, height, text: 0.048, safe: 72 })  // a camera key { x, y, zoom } on el's
       words (host: the world div the camera moves) zoomed until their font is text of the frame's height (a piece's
       4.8 %), kept whole inside the safe inset; returns text (the share they get) and fits (false: too wide to set
       that large: framing the agent panel's whole width leaves its 12 px steps about 2 % tall; set them as a piece)
     uncutUI.mount(host, name, props)                 // a whole part (returns its root): rarely, briefly
     uncutUI.parts()                                  // editor, topbar, agent, message, turn, review, timeline, preview,
                                                      // composer, storyboard, export, exportProgress, inspector, effects, menu
     uncutUI.slots(name), uncutUI.size(name)          // its slots (what a piece can be); its box in the app, CSS px
     uncutUI.find(root, slot), uncutUI.findAll(root, slot)  // a slot's element (or any CSS selector's) in a part or piece
   Pieces (part.slot): composer, composer.box, composer.send; message; turn.steps, turn.step, turn.edit,
     turn.review; storyboard.beat, storyboard.approve; review.score; timeline.main, timeline.lane, timeline.clip,
     timeline.playhead; preview.frame, preview.play; inspector.amount (a filter's slider), inspector.effect,
     inspector.filter; effects.warm (any look: natural, cool, vintage, film, bw, vivid), effects.tile, effects.filters;
     export.draft, export.standard, export.high, export.export; exportProgress.job (status and bar), exportProgress.progress, exportProgress.bar;
     topbar.export, topbar.saved, topbar.title; menu (the whole menu), menu.addToChat, menu.item.
   Props (every part): text { slot: "..." }; press { slot: scale }; highlight, hide (keeps its room), remove (slot
   or [slots]); background (mount: "none" or a colour behind a part that isn't opaque). Each part's own:
       composer: text (typed so far; empty disables Send), caret, placeholder, context ("Playhead 00:00:12:00"),
         chips: ["DJI 0063"] (each "@DJI 0063" in text drawn as the app's chip: right-click a clip, Add to chat, and
         the composer holds "@<its name> " with the caret after it; a typing key's from past the chip types after it)
       message: text (the user's prompt bubble), chips (as the composer's: the sent prompt keeps its chip)
       turn: steps: ["Read the brand kit", ...], done (rows done, the rest running), edit (the edit row's label),
         reply (the agent's answer), review (true, or the review's props: its card in the turn), status
       storyboard: summary, beats: [{ start, end, title, lines: ["..."] }], count (the first n)
       review: scores { hook, readability, motion, variety, sound, brand } (0 to 10), progress 0..1, status, title
       timeline: clips: [{ track: "Main" | "Text" | "Graphics" | "Audio" | "Sound effects" | index, start, duration
         (s), name, image, media (its media id), in (s into the media), selected, color }]: the whole timeline
         (it starts empty); playhead (s)
       preview: frame (your canvas or img: it fills the frame; false: empty), time (s: the timecode), duration
         (s: the length after it; an editor's is its clips' end), canvas ("1080×1350, 60 fps"). Without a frame,
         the editor's preview shows the clip under the playhead (timeline.playhead, else preview.time): its
         media's frame at in + (playhead - start) through uncut.frame, else its image; a gap is black
       inspector: title (the clip's name), filter (the look's name on its slider), amount (0 to 100),
         filter: false, effects: false (those sections out)
       effects: active (the look picked: "warm"; none: ""), target ("On DJI 0063")
       export: quality ("draft" | "standard" | "high"), file ("Launch film.mp4"), motionBlur, duration (s: the range)
       exportProgress: progress 0..1 ("Rendering... 42%"), eta (s left)
       topbar: exportLabel ("Exporting 42%"), title (the project's name)
       menu: a timeline clip's right-click menu as the app builds it for a video clip on Main (Add to chat ⌘L,
         Split S, Copy, Paste, Duplicate, Delete, Ripple delete, Speed, Rename, Replace media, Show in Media,
         Reveal in Finder, Lock), "Add to chat" highlighted under the pointer; active: the row under the pointer
         (an entry id: "add-to-chat", "split", "copy", ...; "": none). Its top-left corner goes at the pointer.
       agent (the side panel), editor (the window, 1920 x 900): the parts inside by name ({ composer: { text } });
         editor: media: [{ name, meta, image, duration }] (the library's tiles), side: "inspector" (that tab, its
         props: inspector), library: "effects" (that panel, props: effects), export or exportProgress (that dialog
         over the window); a running step (turn: done) shows the app's spinner
   An image is a data: or blob: URL: await uncut.url(id, seconds) once before the first frame (an uncut:media/
   marker only resolves in the graphic's own HTML). No run fact of the fixture shows unless you pass it: no prompt
   in a message, no clips, media tiles, steps, reply, edit count or review card in a turn (review: true
   is a blank card), no export progress; the review says "Reviewing" with empty bars, no round, model,
   time or time left; the project's title, length and canvas, a tile's length badge, the clip named in the
   Inspector and Effects, its timings and the export's file name start blank too (topbar title, preview
   duration and canvas, media duration, inspector title, effects target, export duration and file). Run facts are real or absent: pass a result,
   round, score or timing only from this run's real results (review_submit, beat_grid), never invented.
     uncutUI.cursor(host, { x, y, scale, size: 28 })  // the macOS pointer, its tip at (x, y) in host px
     uncutUI.timecode(seconds, fps), uncutUI.css()    // "00:00:12:30"; the parts' CSS (added once by mount)
   The fonts are the Mac's system UI fonts, as in the app; nothing loads from the network. */
/* uncut-ui-inputs: 88b9ebbc4d27943d7f3a39daf46efc4028fcd23c435686c84427fe854bfbc2cb */
(function () {
var DATA = {"css":".uncut-ui .composer-ctx .ellipsis{min-width: 0px}\n.uncut-ui .critic-row .critic-head{align-items: center; gap: 10px; padding: 8px 10px}\n.uncut-ui .critic-icon{background: var(--raised); border-radius: 50%; flex: 0 0 auto; place-items: center; width: 22px; height: 22px; display: grid}\n.uncut-ui .critic-row .critic-icon svg{width: 13px; height: 13px; color: var(--muted)}\n.uncut-ui .critic-icon.passed svg{color: var(--ok)}\n.uncut-ui .critic-text{flex-direction: column; flex: 1 1 0%; gap: 2px; min-width: 0px; display: flex}\n.uncut-ui .critic-title{align-items: baseline; gap: 8px; min-width: 0px; display: flex}\n.uncut-ui .critic-name{white-space: nowrap; font-weight: 500}\n.uncut-ui .critic-status{background: 0px 0px; padding: 0px}\n.uncut-ui .critic-status.passed{color: var(--ok)}\n.uncut-ui .agent{position: relative}\n.uncut-ui .agent-add svg.lucide{width: 15px; height: 15px}\n.uncut-ui .tile-chat{width: 22px; height: 22px; color: var(--fg); opacity: 0; background: rgba(0, 0, 0, 0.6); border-radius: 50%; place-items: center; padding: 0px; display: grid; position: absolute; top: 4px; right: 30px}\n.uncut-ui .tile-chat.second{right: 56px}\n.uncut-ui .tile-chat svg.lucide{width: 13px; height: 13px}\n.uncut-ui .media-bar > span:first-child{text-overflow: ellipsis; min-width: 0px; overflow: hidden}\n.uncut-ui .media-bar-tools{flex: 0 0 auto}\n.uncut-ui .media-bar{container-type: inline-size}\n.uncut-ui .media-bar-tools{margin-left: auto}\n.uncut-ui .clip.video::before{content: \"\"; z-index: 1; pointer-events: none; background: linear-gradient(rgba(0, 0, 0, 0.6), rgba(0, 0, 0, 0.15) 75%); position: absolute; inset: 0px}\n.uncut-ui .clip.graphic{height: 32px; top: 4px; bottom: auto}\n.uncut-ui .el-note{z-index: 2; color: var(--muted); font-size: 10px; position: absolute; top: 3px; right: 4px}\n.uncut-ui .app > .banners{z-index: 2147483500}\n.uncut-ui .app{--focus-col: clamp(360px, 34vw, 560px)}\n.uncut-ui .layout-toggles{border-radius: var(--radius-sm); align-items: center; gap: 1px; margin-right: 4px; padding: 1px; display: inline-flex}\n.uncut-ui .layout-toggles .icon-btn[aria-pressed=\"false\"]{color: var(--muted); opacity: 0.6}\n.uncut-ui .rail{--rail-fade-top: 0px; --rail-fade-end: 0px; mask-image: linear-gradient(to bottom, transparent 0, #000 var(--rail-fade-top), #000 calc(100% - var(--rail-fade-end)), transparent 100%)}\n.uncut-ui .wordmark{align-items: center; gap: 8px; min-width: 0px; display: flex}\n.uncut-ui .wordmark-name{flex: 0 0 auto; align-items: center; gap: 7px; display: inline-flex}\n.uncut-ui .wordmark-mark{width: 11px; height: 13px; color: var(--fg); flex: 0 0 auto}\n.uncut-ui .wordmark-text{letter-spacing: -0.02em; background-image: linear-gradient(118deg, var(--fg) 0 40%, #fff 45%, #a9bcff 50%, #fff 55%, var(--fg) 60% 100%); color: rgba(0, 0, 0, 0); background-position: 100% 0px; background-size: 300% 100%; background-clip: text; font-weight: 650}\n.uncut-ui .wordmark-slash{background: var(--border-strong); flex: 0 0 auto; width: 1px; height: 14px; transform: rotate(28deg)}\n.uncut-ui .wordmark .project-title{padding: 4px 2px}\n.uncut-ui{--bg: #0a0a0a; --panel: #111; --panel-2: #161616; --raised: #1c1c1c; --border: #ffffff12; --border-strong: #ffffff1f; --fg: #ededed; --muted: #9a9a9a; --dim: #7d7d7d; --select: #6d8cff; --select-soft: #6d8cff29; --ok: #4ade80; --warn: #fbbf24; --error: #f87171; --radius: 10px; --radius-sm: 6px; --font: -apple-system, BlinkMacSystemFont, \"SF Pro Text\", \"Inter\", system-ui, sans-serif; --mono: \"SF Mono\", ui-monospace, Menlo, monospace; --lightningcss-light:; --lightningcss-dark: initial; color-scheme: dark}\n.uncut-ui, .uncut-ui *{box-sizing: border-box}\n.uncut-ui{color: var(--fg); font: 13px/1.4 var(--font)}\n.uncut-ui button{font: inherit; color: inherit; cursor: pointer; background: 0px 0px; border: 0px}\n.uncut-ui button:disabled{cursor: not-allowed; opacity: 0.45}\n.uncut-ui input{font: inherit; color: inherit}\n.uncut-ui svg.lucide{stroke-width: 1.75px; flex: 0 0 auto; width: 16px; height: 16px}\n.uncut-ui .muted{color: var(--muted)}\n.uncut-ui .small{font-size: 11px}\n.uncut-ui .mono{font-family: var(--mono)}\n.uncut-ui .ellipsis{white-space: nowrap; text-overflow: ellipsis; min-width: 0px; overflow: hidden}\n.uncut-ui .icon-btn{border-radius: var(--radius-sm); width: 28px; height: 28px; color: var(--muted); justify-content: center; align-items: center; display: inline-flex}\n.uncut-ui .icon-btn.active{color: var(--fg); background: var(--raised)}\n.uncut-ui .btn{border-radius: var(--radius-sm); border: 1px solid var(--border-strong); white-space: nowrap; flex: 0 0 auto; align-items: center; gap: 6px; height: 28px; padding: 0px 12px; display: inline-flex}\n.uncut-ui .btn svg.lucide{width: 14px; height: 14px}\n.uncut-ui .btn.primary{background: var(--fg); color: rgb(0, 0, 0); border-color: rgba(0, 0, 0, 0); font-weight: 500}\n.uncut-ui .btn.ghost{color: var(--muted); border-color: rgba(0, 0, 0, 0)}\n.uncut-ui .modal{background: var(--panel); border: 1px solid var(--border-strong); border-radius: 14px}\n.uncut-ui .modal.wiz{border-radius: 16px; width: 640px; max-width: 100%; overflow: hidden}\n.uncut-ui .wiz-panel{background: rgba(255, 255, 255, 0.02); border-top: 1px solid rgba(255, 255, 255, 0.05); padding: 22px 24px 20px}\n.uncut-ui .wiz-panel h1{letter-spacing: -0.02em; margin: 0px; font-size: 24px; font-weight: 600}\n.uncut-ui .wiz-lead{color: var(--muted); margin: 10px 0px 18px; font-size: 14px; line-height: 1.6}\n.uncut-ui .wiz-list{flex-direction: column; gap: 8px; display: flex}\n.uncut-ui .wiz-cards{grid-template-columns: repeat(3, 1fr); gap: 8px; display: grid}\n.uncut-ui .wiz-cards.four{grid-template-columns: repeat(4, 1fr)}\n.uncut-ui .wiz-card{border: 1px solid var(--border); background: var(--bg); text-align: left; border-radius: 10px; flex-direction: column; align-items: flex-start; gap: 2px; padding: 12px; font-weight: 500; display: flex}\n.uncut-ui .wiz-card span{color: var(--muted); font-size: 12px; font-weight: 400}\n.uncut-ui .wiz-card.active{border-color: var(--fg)}\n.uncut-ui .wiz-field{border: 1px solid var(--border); background: var(--bg); border-radius: 10px; align-items: center; gap: 12px; min-height: 46px; padding: 6px 8px 6px 14px; display: flex}\n.uncut-ui .wiz-field > span:first-child{width: 48px; color: var(--muted); flex: 0 0 auto; font-size: 12px}\n.uncut-ui .wiz-field b{flex: 1 1 0%; font-weight: 500}\n.uncut-ui .wiz-field input{background: 0px 0px; border: 0px; outline: 0px; flex: 1 1 0%; min-width: 0px; height: 32px; padding: 0px; font-size: 14px}\n.uncut-ui .wiz-meta{color: var(--dim); margin: 12px 0px 0px; font-size: 12px}\n.uncut-ui .wiz-foot{justify-content: flex-end; align-items: center; gap: 8px; margin-top: 22px; display: flex}\n.uncut-ui .form-fields{margin-top: 12px}\n.uncut-ui .app{--lib-col: clamp(200px, 20vw, 272px); --side-col: clamp(260px, 24vw, 320px); --bottom-row: clamp(170px, 30vh, 280px); grid-template-columns: 56px var(--lib-col) minmax(0, 1fr) var(--side-col); grid-template-rows: 40px minmax(0, 1fr) minmax(0, var(--bottom-row)); grid-template-areas: \"top top top top\" \"rail lib stage side\" \"bottom bottom bottom bottom\"; height: 100vh; display: grid; position: relative; overflow: clip}\n.uncut-ui .resizer{z-index: 20; position: relative}\n.uncut-ui .resizer.v{cursor: col-resize; grid-row: 2; width: 7px}\n.uncut-ui .resizer.h{cursor: row-resize; grid-area: bottom; align-self: start; height: 7px; margin-top: -3px}\n.uncut-ui .resizer-lib{grid-column: 2; justify-self: end; margin-right: -4px}\n.uncut-ui .resizer-side{grid-column: 4; justify-self: start; margin-left: -4px}\n.uncut-ui .resizer::after{content: \"\"; background: var(--select); opacity: 0; pointer-events: none; border-radius: 2px; position: absolute}\n.uncut-ui .resizer.v::after{width: 2px; margin-left: -1px; top: 0px; bottom: 0px; left: 50%}\n.uncut-ui .resizer.h::after{height: 2px; margin-top: -1px; top: 50%; left: 0px; right: 0px}\n.uncut-ui input,.uncut-ui textarea,.uncut-ui .msg-user,.uncut-ui .turn .reply{user-select: text}\n.uncut-ui input[type=\"checkbox\"],.uncut-ui input[type=\"range\"]{user-select: none}\n.uncut-ui .topbar{border-bottom: 1px solid var(--border); app-region: drag; user-select: none; grid-area: top; align-items: center; gap: 6px; padding: 0px 10px 0px 80px; display: flex}\n.uncut-ui .topbar button{app-region: no-drag}\n.uncut-ui .brand{letter-spacing: -0.01em; font-weight: 600}\n.uncut-ui .project-title{color: var(--muted); white-space: nowrap; text-overflow: ellipsis; min-width: 0px; padding: 4px 8px; overflow: hidden}\n.uncut-ui .topbar-spacer{flex: 1 1 0%}\n.uncut-ui .saved{color: var(--dim); align-items: center; gap: 5px; margin-right: 6px; font-size: 12px; display: flex}\n.uncut-ui .saved svg.lucide{width: 14px; height: 14px}\n.uncut-ui .banners{z-index: 30; pointer-events: none; flex-direction: column; gap: 6px; width: min(680px, 100% - 32px); display: flex; position: absolute; top: 48px; left: 50%; transform: translate(-50%)}\n.uncut-ui .rail{border-right: 1px solid var(--border); scrollbar-width: none; flex-direction: column; grid-area: rail; align-items: center; gap: 2px; min-height: 0px; padding: 8px 0px; display: flex; overflow: hidden auto}\n.uncut-ui .rail button{border-radius: var(--radius-sm); width: 52px; color: var(--muted); flex-direction: column; flex: 0 0 auto; align-items: center; gap: 3px; padding: 7px 0px 5px; display: flex}\n.uncut-ui .rail button span{font-size: 10px}\n.uncut-ui .rail button.active{color: var(--fg); background: var(--raised)}\n.uncut-ui .library{border-right: 1px solid var(--border); background: var(--panel); flex-direction: column; grid-area: lib; display: flex; overflow: auto}\n.uncut-ui .lib-head{flex: 0 0 auto; justify-content: space-between; align-items: center; height: 48px; padding: 0px 14px; font-weight: 600; display: flex}\n.uncut-ui .stage{flex-direction: column; grid-area: stage; min-width: 0px; min-height: 0px; display: flex; position: relative; container: stage / size}\n.uncut-ui .stage-canvas{background: rgb(8, 8, 8); flex: 1 1 0%; justify-content: center; align-items: center; min-height: 0px; padding: 18px; display: flex}\n.uncut-ui .frame{isolation: isolate; outline: 1px solid var(--border); background: rgb(0, 0, 0); position: relative; overflow: hidden; container-type: size}\n.uncut-ui .pv-canvas{transform-origin: 0px 0px; position: absolute; top: 0px; left: 0px; container-type: size}\n.uncut-ui .pv-layer{position: absolute; inset: 0px}\n.uncut-ui .pv-box{width: 100%; height: 100%; position: absolute; top: 0px; left: 0px; overflow: hidden}\n.uncut-ui .pv-box > video{object-fit: contain; width: 100%; max-width: none; height: 100%; position: absolute; top: 0px; left: 0px}\n.uncut-ui .pv-layer > canvas.pv-gpu{pointer-events: none; width: 100%; height: 100%; display: block; position: absolute; top: 0px; left: 0px}\n.uncut-ui .pv-missing{padding: calc(16px / var(--pv-scale)); text-align: center; color: var(--muted); font-size: calc(12px / var(--pv-scale)); background: repeating-linear-gradient(135deg, #111 0 calc(10px / var(--pv-scale)), #0d0d0d calc(10px / var(--pv-scale)) calc(20px / var(--pv-scale))); place-items: center; display: grid; position: absolute; inset: 0px}\n.uncut-ui .pv-overlay{z-index: 100000; pointer-events: none}\n.uncut-ui .transport{border-top: 1px solid var(--border); flex: 0 0 auto; align-items: center; gap: 10px; height: 40px; min-height: 40px; padding: 0px 12px; display: flex; overflow: hidden}\n.uncut-ui .transport > *,.uncut-ui .transport-mid > *{flex: 0 0 auto}\n.uncut-ui .timecode{font: 12px var(--mono); white-space: nowrap}\n.uncut-ui .transport > [data-testid=\"canvas-info\"]{white-space: nowrap; flex: 0 0 auto}\n.uncut-ui .transport > .transport-mid{flex: 1 0 auto; justify-content: center; gap: 4px; display: flex}\n.uncut-ui .icon-btn.play{color: var(--fg)}\n.uncut-ui .side{border-left: 1px solid var(--border); background: var(--panel); flex-direction: column; grid-area: side; min-height: 0px; display: flex}\n.uncut-ui .tabs{border-bottom: 1px solid var(--border); gap: 2px; padding: 6px; display: flex}\n.uncut-ui .tabs button{border-radius: var(--radius-sm); height: 28px; color: var(--muted); flex: 1 1 0%}\n.uncut-ui .tabs button.active{background: var(--raised); color: var(--fg)}\n.uncut-ui .side-body{flex-direction: column; flex: 1 1 0%; min-height: 0px; display: flex; overflow: auto}\n.uncut-ui .insp-title{align-items: center; gap: 8px; padding: 12px 14px 4px; font-weight: 600; display: flex}\n.uncut-ui .insp-sub{color: var(--muted); padding: 0px 14px 8px; font-size: 11px}\n.uncut-ui .group{border-bottom: 1px solid var(--border); padding: 12px 14px}\n.uncut-ui .group-label{color: var(--muted); margin-bottom: 8px; font-size: 11px}\n.uncut-ui .field-row{grid-template-columns: 1fr 1fr; gap: 8px; display: grid}\n.uncut-ui .field{border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--panel-2); align-items: center; gap: 6px; min-width: 0px; height: 28px; padding: 0px 8px; display: flex}\n.uncut-ui .field .k{color: var(--dim); white-space: nowrap; flex: 0 0 auto; font-size: 11px}\n.uncut-ui .field .v{font-family: var(--mono); margin-left: auto; font-size: 12px}\n.uncut-ui .field.input{outline: 0px; width: 100%}\n.uncut-ui .bottom{border-top: 1px solid var(--border); background: var(--panel); flex-direction: column; grid-area: bottom; min-width: 0px; display: flex}\n.uncut-ui .bottom-toolbar{border-bottom: 1px solid var(--border); flex: 0 0 auto; align-items: center; gap: 12px; height: 38px; padding: 0px 8px; display: flex}\n.uncut-ui .seg{border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 2px; display: flex}\n.uncut-ui .seg button{color: var(--muted); border-radius: 4px; padding: 3px 10px}\n.uncut-ui .seg button.active{background: var(--raised); color: var(--fg)}\n.uncut-ui .bottom-body{flex: 1 1 0%; min-height: 0px; overflow: auto}\n.uncut-ui .tl{grid-template-rows: 1fr; grid-template-columns: 184px 1fr; width: max-content; min-width: 100%; min-height: 100%; display: grid; position: relative}\n.uncut-ui .tl-heads{z-index: 3; background: var(--panel); position: sticky; left: 0px}\n.uncut-ui .tl-corner{border-bottom: 1px solid var(--border); border-right: 1px solid var(--border); z-index: 2; background: var(--panel); height: 44px; position: sticky; top: 0px}\n.uncut-ui .tl-lanes{z-index: 0; position: relative}\n.uncut-ui .tl-ruler{z-index: 8; border-bottom: 1px solid var(--border); background: var(--panel); height: 44px; position: sticky; top: 0px}\n.uncut-ui .tl-ruler .tick{border-left: 1px solid var(--border-strong); position: absolute; top: 24px; bottom: 0px}\n.uncut-ui .tl-ruler .tick span{font: 10px var(--mono); color: var(--dim); position: absolute; top: -2px; left: 4px}\n.uncut-ui .tl-head{border-bottom: 1px solid var(--border); border-right: 1px solid var(--border); align-items: center; gap: 4px; height: 40px; padding: 0px 6px 0px 10px; display: flex}\n.uncut-ui .tl-head .name{white-space: nowrap; flex: 1 1 0%; align-items: center; gap: 6px; min-width: 0px; font-size: 12px; display: flex}\n.uncut-ui .tl-head .name .badge{color: var(--muted); display: inline-flex}\n.uncut-ui .tl-head .name .badge svg.lucide{width: 13px; height: 13px}\n.uncut-ui .tl-head .icon-btn{width: 22px; height: 22px}\n.uncut-ui .tl-head .icon-btn svg.lucide{width: 13px; height: 13px}\n.uncut-ui .tl-head.main{background: var(--panel-2); height: 52px}\n.uncut-ui .tl-lane{border-bottom: 1px solid var(--border); height: 40px; position: relative}\n.uncut-ui .tl-lane.main{background: var(--panel-2); height: 52px}\n.uncut-ui .playhead{height: calc(var(--tl-view-h,200px) - 1px); background: var(--fg); z-index: 4; pointer-events: none; width: 1px; position: absolute; top: 0px}\n.uncut-ui .playhead-handle{pointer-events: auto; cursor: ew-resize; width: 15px; height: 44px; position: absolute; top: 0px; left: -7px}\n.uncut-ui .playhead::before{content: \"\"; border-right: 5px solid rgba(0, 0, 0, 0); border-bottom: 5px solid rgba(0, 0, 0, 0); border-left: 5px solid rgba(0, 0, 0, 0); border-image: none; border-top: 7px solid var(--fg); position: absolute; top: 0px; left: -5px}\n.uncut-ui .bottom{position: relative}\n.uncut-ui .modal-layer{z-index: 50; background: rgba(0, 0, 0, 0.6); flex-direction: column; padding: 24px; display: flex; position: fixed; inset: 0px; overflow: auto}\n.uncut-ui .modal-layer > .modal{flex: 0 0 auto; margin: auto}\n.uncut-ui .link-btn{color: var(--muted); border-radius: var(--radius-sm); align-items: center; gap: 5px; padding: 3px 7px; font-size: 12px; display: inline-flex}\n.uncut-ui .link-btn svg.lucide{width: 14px; height: 14px}\n.uncut-ui .wiz-foot p{color: var(--muted); flex: 1 1 0%; margin: 0px; font-size: 12px; line-height: 1.5}\n.uncut-ui .wiz-foot{justify-content: space-between; gap: 20px}\n.uncut-ui .library{position: relative}\n.uncut-ui .lib-section{padding: 6px 14px 14px}\n.uncut-ui .lib-label{color: var(--muted); margin: 4px 0px 8px; font-size: 11px}\n.uncut-ui .grid2{grid-template-columns: repeat(auto-fill, minmax(80px, 1fr)); gap: 8px; display: grid}\n.uncut-ui .tile{border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--panel-2); text-align: left; cursor: pointer; min-width: 0px; overflow: hidden}\n.uncut-ui .thumb{aspect-ratio: 16 / 10; color: var(--dim); background: repeating-linear-gradient(135deg, rgb(26, 26, 26) 0px, rgb(26, 26, 26) 6px, rgb(22, 22, 22) 6px, rgb(22, 22, 22) 12px); justify-content: center; align-items: center; display: flex; position: relative; overflow: hidden}\n.uncut-ui .thumb .dur{font: 10px var(--mono); color: var(--fg); background: rgba(0, 0, 0, 0.6); border-radius: 3px; padding: 0px 4px; position: absolute; bottom: 4px; right: 4px}\n.uncut-ui .tile-name{white-space: nowrap; text-overflow: ellipsis; padding: 5px 7px 0px; font-size: 11px; overflow: hidden}\n.uncut-ui .tile-sub{color: var(--muted); padding: 1px 7px 6px; font-size: 10px; line-height: 1.35}\n.uncut-ui [data-testid=\"media-tile\"] .tile-name{white-space: normal; overflow-wrap: anywhere; -webkit-line-clamp: 2; -webkit-box-orient: vertical; line-height: 1.3; display: -webkit-box}\n.uncut-ui .media-bar{white-space: nowrap; justify-content: space-between; align-items: center; gap: 6px; display: flex}\n.uncut-ui .media-bar-tools{align-items: center; gap: 2px; display: inline-flex}\n.uncut-ui .media-bar-tools .icon-btn{width: 22px; height: 22px}\n.uncut-ui .media-bar-tools .icon-btn svg.lucide{width: 13px; height: 13px}\n.uncut-ui .media-bar-tools .icon-btn.active{color: var(--fg); background: var(--raised)}\n.uncut-ui .media-sort{background: var(--panel-2); height: 22px; color: var(--fg); border: 1px solid var(--border); border-radius: var(--radius-sm); margin-right: 4px; padding: 0px 4px; font-size: 11px}\n.uncut-ui .tile-used{background: var(--select); color: rgb(0, 0, 0); pointer-events: none; border-radius: 3px; height: 15px; padding: 0px 5px; font-size: 10px; font-weight: 600; line-height: 15px; position: absolute; top: 4px; left: 4px}\n.uncut-ui .toolbar-spacer{flex: 1 1 0%}\n.uncut-ui .bottom-body{overscroll-behavior: contain}\n.uncut-ui .tl-ruler{cursor: ew-resize; user-select: none}\n.uncut-ui .tl-ruler .tick span{white-space: nowrap}\n.uncut-ui .clip{cursor: pointer; user-select: none; border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 5px; flex-direction: column; justify-content: space-between; padding: 3px 6px; font-size: 11px; display: flex; position: absolute; top: 4px; bottom: 4px; overflow: hidden; container: clip / inline-size}\n.uncut-ui .clip .nm,.uncut-ui .clip .meta{z-index: 1; white-space: nowrap; text-overflow: ellipsis; position: relative; overflow: hidden}\n.uncut-ui .clip .meta{font: 10px var(--mono); color: rgba(255, 255, 255, 0.6)}\n.uncut-ui .clip.video{background: rgb(29, 29, 29)}\n.uncut-ui .clip.video .nm,.uncut-ui .clip.video .meta{text-shadow: rgb(0, 0, 0) 0px 1px 3px}\n.uncut-ui .clip .strip{opacity: 0.85; background-repeat: repeat-x; background-size: auto 100%; position: absolute; inset: 0px}\n.uncut-ui .clip .filmstrip{pointer-events: none; overflow: hidden}\n.uncut-ui .clip.text{background: rgb(59, 47, 92); border-color: rgb(90, 74, 138)}\n.uncut-ui .clip.audio{background: rgb(23, 53, 42); border-color: rgb(36, 80, 58)}\n.uncut-ui .clip.graphic{background: rgb(42, 44, 51); border-color: rgb(72, 75, 86)}\n.uncut-ui .tile{position: relative}\n.uncut-ui .tile[draggable=\"true\"]{cursor: grab}\n.uncut-ui .tile-add{background: var(--fg); color: rgb(0, 0, 0); opacity: 0; border-radius: 50%; place-items: center; width: 22px; height: 22px; padding: 0px; display: grid; position: absolute; top: 4px; right: 4px}\n.uncut-ui .tile-add svg.lucide{stroke-width: 2.25px; width: 14px; height: 14px}\n.uncut-ui .tile-analyze{width: 22px; height: 22px; color: var(--fg); opacity: 0; background: rgba(0, 0, 0, 0.6); border-radius: 50%; place-items: center; padding: 0px; display: grid; position: absolute; top: 4px; right: 30px}\n.uncut-ui .tile-analyze svg.lucide{width: 13px; height: 13px}\n.uncut-ui .agent{flex-direction: column; flex: 1 1 0%; min-height: 0px; display: flex}\n.uncut-ui .agent-thread{overscroll-behavior: contain; flex-direction: column; flex: 1 1 0%; gap: 10px; min-height: 0px; padding: 12px; display: flex; overflow: auto}\n.uncut-ui .turn-wrap{flex-direction: column; gap: 6px; display: flex}\n.uncut-ui .msg-user{background: var(--raised); border-radius: var(--radius); white-space: pre-wrap; overflow-wrap: anywhere; align-self: flex-end; max-width: 88%; padding: 7px 10px}\n.uncut-ui .turn{flex-direction: column; gap: 5px; padding: 2px 0px 0px; display: flex}\n.uncut-ui .turn > .reply{border: 1px solid var(--border); border-radius: var(--radius); background: var(--panel-2); align-self: flex-start; max-width: 100%; padding: 2px 10px 4px}\n.uncut-ui .turn > .worklog,.uncut-ui .turn > .edit-row{padding: 0px 4px}\n.uncut-ui .step{color: var(--muted); align-items: flex-start; gap: 6px; font-size: 12px; line-height: 1.4; display: flex}\n.uncut-ui .step svg.lucide{width: 13px; height: 13px; margin-top: 2px}\n.uncut-ui .reply p{overflow-wrap: anywhere; margin: 6px 0px 2px; line-height: 1.5}\n.uncut-ui .turn-edits{display: inline-flex; position: relative}\n.uncut-ui .turn-edits-list{flex-direction: column; gap: 6px; display: flex}\n.uncut-ui .turn-edits-label{border: 1px solid var(--border); border-radius: var(--radius-sm); color: var(--muted); font-style: inherit; font-variant: inherit; font-weight: inherit; font-stretch: inherit; line-height: inherit; font-family: inherit; font-optical-sizing: inherit; font-size-adjust: inherit; font-kerning: inherit; font-feature-settings: inherit; font-variation-settings: inherit; font-language-override: inherit; cursor: pointer; background: 0px 0px; align-items: center; gap: 4px; padding: 1px 6px; font-size: 11px; display: inline-flex}\n.uncut-ui .turn-edits-label svg.lucide{width: 11px; height: 11px}\n.uncut-ui .turn-edit-summary{font-size: 12px; font-weight: 500}\n.uncut-ui .turn-edit-line{color: var(--muted); overflow-wrap: anywhere; padding-left: 10px; font-size: 11px; line-height: 1.4}\n.uncut-ui .turn-foot{color: var(--dim); white-space: nowrap; flex-wrap: nowrap; align-items: center; gap: 6px; min-width: 0px; min-height: 24px; padding: 0px 2px 0px 4px; font-size: 11px; display: flex}\n.uncut-ui .turn-status{text-overflow: ellipsis; flex: 0 1 auto; min-width: 0px; display: block; overflow: hidden}\n.uncut-ui .turn-foot > .turn-edits,.uncut-ui .turn-foot > .link-btn{flex: 0 0 auto}\n.uncut-ui .turn-wrap{container: turn / inline-size}\n.uncut-ui .turn-foot .spacer{flex: 1 1 0%}\n.uncut-ui .turn-foot .link-btn svg.lucide{width: 13px; height: 13px}\n.uncut-ui .composer{border: 1px solid var(--border-strong); border-radius: var(--radius); background: var(--panel-2); flex-direction: column; flex: 0 0 auto; margin: 0px 12px 12px; display: flex}\n.uncut-ui .composer-ctx{color: var(--dim); align-items: center; gap: 6px; min-width: 0px; padding: 7px 10px 0px; font-size: 11px; display: flex}\n.uncut-ui .composer-ctx svg.lucide{width: 12px; height: 12px}\n.uncut-ui .composer{position: relative}\n.uncut-ui .composer-box{display: grid; position: relative}\n.uncut-ui .composer-box > textarea,.uncut-ui .composer-hl{font: 13px/1.45 var(--font); white-space: pre-wrap; overflow-wrap: anywhere; letter-spacing: normal; grid-area: 1 / 1; min-height: 58px; max-height: 180px; padding: 6px 10px}\n.uncut-ui .composer textarea{resize: none; color: var(--fg); background: 0px 0px; border: 0px; outline: 0px; position: relative; overflow-y: auto}\n.uncut-ui .composer-hl{color: rgba(0, 0, 0, 0); pointer-events: none; overflow: hidden}\n.uncut-ui .composer-hl mark.chip,.uncut-ui .msg-user mark.chip{background: var(--select-soft); color: inherit; border-radius: 4px; box-shadow: rgba(109, 140, 255, 0.3) 0px 0px 0px 1px}\n.uncut-ui .msg-user mark.chip{color: rgb(201, 212, 255); padding: 0px 2px}\n.uncut-ui .composer-at{color: var(--dim)}\n.uncut-ui .composer-at svg.lucide{width: 14px; height: 14px}\n.uncut-ui .sr-only{clip: rect(0px, 0px, 0px, 0px); white-space: nowrap; width: 1px; height: 1px; position: absolute; overflow: hidden}\n.uncut-ui .turn-wrap{user-select: text; cursor: auto}\n.uncut-ui .turn-wrap button,.uncut-ui .turn-wrap svg,.uncut-ui .turn-wrap .sr-only,.uncut-ui .copy-btn{user-select: none}\n.uncut-ui .turn-wrap .edit-step{cursor: pointer}\n.uncut-ui .copy-btn{flex: 0 0 auto; width: 22px; height: 22px}\n.uncut-ui .copy-btn svg.lucide{width: 12px; height: 12px}\n.uncut-ui .reply{position: relative}\n.uncut-ui .reply .reply-copy{opacity: 0; background: var(--panel-2); position: absolute; top: 2px; right: 2px}\n.uncut-ui .insp-chat{flex: 0 0 auto; align-items: center; gap: 4px; font-weight: 500; display: inline-flex}\n.uncut-ui .insp-chat svg.lucide{width: 12px; height: 12px}\n.uncut-ui .composer textarea::placeholder{color: var(--dim)}\n.uncut-ui .composer-foot{align-items: center; gap: 8px; padding: 0px 6px 6px 10px; display: flex}\n.uncut-ui .composer-spacer{flex: 1 1 0px; min-width: 0px}\n.uncut-ui .composer{container-type: inline-size}\n.uncut-ui .composer-foot{flex-wrap: nowrap; gap: 2px; min-width: 0px; padding-left: 4px}\n.uncut-ui .composer-foot > .icon-btn,.uncut-ui .composer-foot > .send{flex: 0 0 auto}\n.uncut-ui .composer-choices{flex-wrap: nowrap; flex: 0 1 auto; align-items: center; gap: 1px; min-width: 0px; display: flex}\n.uncut-ui .composer-choices .choice{border-radius: var(--radius-sm); height: 24px; color: var(--muted); white-space: nowrap; flex: 0 0 auto; align-items: center; gap: 4px; padding: 0px 6px; font-size: 12px; display: inline-flex}\n.uncut-ui .composer-choices .choice svg.lucide{flex: 0 0 auto; width: 12px; height: 12px}\n.uncut-ui .composer-choices .choice.model{flex: 0 1 auto; min-width: 0px; overflow: hidden}\n.uncut-ui .composer-choices .choice.model .choice-label{text-overflow: ellipsis; flex: 0 100 auto; min-width: 0px; overflow: hidden}\n.uncut-ui .composer-choices .choice.model .provider-wordmark{flex: 0 0 auto}\n.uncut-ui .composer-choices .choice svg.choice-caret{width: 11px; height: 11px}\n.uncut-ui .send{background: var(--fg); color: rgb(0, 0, 0); border-radius: 50%; place-items: center; width: 26px; height: 26px; display: grid}\n.uncut-ui .send svg.lucide{width: 15px; height: 15px}\n.uncut-ui .send:disabled{background: var(--raised); color: var(--dim); opacity: 1}\n.uncut-ui .toolbar-sep{background: var(--border-strong); width: 1px; height: 16px; margin: 0px 4px}\n.uncut-ui .icon-btn.on{color: var(--fg)}\n.uncut-ui .clip .edge{z-index: 2; cursor: ew-resize; width: 6px; position: absolute; top: 0px; bottom: 0px}\n.uncut-ui .clip .edge.start{border-radius: 5px 0px 0px 5px; left: 0px}\n.uncut-ui .clip .edge.end{border-radius: 0px 5px 5px 0px; right: 0px}\n.uncut-ui .tool-picker{align-items: center; gap: 2px; display: flex}\n.uncut-ui .kv-row{border-bottom: 1px solid var(--border); justify-content: space-between; align-items: center; gap: 12px; padding: 4px 0px; font-size: 12px; display: flex}\n.uncut-ui .kv-row:last-child{border-bottom: 0px}\n.uncut-ui .kv-row .mono{text-align: right}\n.uncut-ui .small-btn{height: 22px; padding: 0px 6px; font-size: 11px}\n.uncut-ui .slider-row{grid-template-columns: 1fr 92px; align-items: center; gap: 8px; margin-bottom: 8px; display: grid}\n.uncut-ui .slider{width: 100%; accent-color: var(--select)}\n.uncut-ui .num-field input{text-align: right; width: 100%; min-width: 0px; color: inherit; background: 0px 0px; border: 0px; outline: 0px}\n.uncut-ui .num-field input::-webkit-inner-spin-button{display: none}\n.uncut-ui .check-row{align-items: center; gap: 8px; margin-bottom: 8px; font-size: 12px; display: flex}\n.uncut-ui .clip .wave{pointer-events: none; width: 100%; height: 100%; position: absolute; bottom: 0px; left: 0px; right: 0px}\n.uncut-ui .clip.audio .wave{top: 0px}\n.uncut-ui .clip .fade-handle{z-index: 3; cursor: ew-resize; opacity: 0; background: rgb(255, 255, 255); border: 1px solid rgba(0, 0, 0, 0.55); border-radius: 3px; width: 12px; height: 12px; margin-left: -6px; margin-right: -6px; position: absolute; top: 1px; box-shadow: rgba(0, 0, 0, 0.45) 0px 1px 3px}\n.uncut-ui .clip .fade-handle::before{content: \"\"; position: absolute; inset: -4px -5px -6px}\n.uncut-ui .clip.audio .fade-handle{opacity: 0.55}\n.uncut-ui .track-volume{display: inline-flex; position: relative}\n.uncut-ui .export-head{justify-content: space-between; align-items: center; margin-bottom: 16px; display: flex}\n.uncut-ui .export-fields{margin-top: 12px}\n.uncut-ui .export-label{margin: 16px 0px 8px}\n.uncut-ui .export-note{color: var(--muted); margin: 0px auto 0px 0px; font-size: 12px}\n.uncut-ui .export-status{justify-content: space-between; gap: 12px; margin-bottom: 8px; font-size: 13px; display: flex}\n.uncut-ui .export-bar{background: var(--raised); border-radius: 3px; height: 6px; overflow: hidden}\n.uncut-ui .export-bar > div{background: var(--fg); border-radius: 3px; height: 100%}\n.uncut-ui .export-btn{margin-right: 4px}\n.uncut-ui .export-advanced-toggle{color: var(--muted); cursor: pointer; background: 0px 0px; border: 0px; align-items: center; gap: 4px; margin-top: 10px; padding: 2px 0px; font-size: 12px; display: inline-flex}\n.uncut-ui .export-advanced-toggle svg.lucide{width: 14px; height: 14px}\n.uncut-ui .fx-tile{cursor: pointer}\n.uncut-ui .fx-tile.active{border-color: var(--select); box-shadow: inset 0 0 0 1px var(--select)}\n.uncut-ui .fx-thumb{aspect-ratio: 16 / 9; background: rgb(13, 13, 13)}\n.uncut-ui .fx-thumb canvas{width: 100%; height: 100%; display: block; position: absolute; inset: 0px}\n.uncut-ui .fx-thumb-overlay{transform-origin: 0px 0px; pointer-events: none; width: 1920px; height: 1080px; position: absolute; top: 0px; left: 0px}\n.uncut-ui .fx-none svg.lucide{width: 22px; height: 22px; color: var(--dim)}\n.uncut-ui .fx-entry{border-top: 1px solid var(--border); flex-direction: column; gap: 4px; padding: 4px 0px 6px; display: flex}\n.uncut-ui .fx-entry:first-child{border-top: 0px}\n.uncut-ui .fx-entry-head{color: var(--fg); justify-content: space-between; align-items: center; font-size: 11px; display: flex}\n.uncut-ui .fx-entry-head .icon-btn{width: 22px; height: 22px}\n.uncut-ui .fx-entry-head .icon-btn svg.lucide{width: 14px; height: 14px}\n.uncut-ui .tr-search{align-items: center; display: flex; position: relative}\n.uncut-ui .tr-search .input{flex: 1 1 0%; padding-right: 26px}\n.uncut-ui .cut-point{z-index: 3; cursor: pointer; border-radius: 3px; width: 12px; height: 18px; margin-left: -6px; position: absolute; top: 2px}\n.uncut-ui .cut-point::after{content: \"\"; background: 0px 0px; border-radius: 1px; width: 2px; position: absolute; top: 3px; bottom: 3px; left: 5px}\n.uncut-ui .field-row.key-row{grid-template-columns: 1fr 24px 1fr 24px; align-items: center}\n.uncut-ui .slider-row.key-row{grid-template-columns: 1fr 120px 24px}\n.uncut-ui .key-btn{width: 24px; height: 24px}\n.uncut-ui .key-btn svg{width: 12px; height: 12px}\n.uncut-ui .seg.fit{margin-top: 8px}\n.uncut-ui .seg.fit button{flex: 1 1 0%}\n.uncut-ui .clip .envelope{z-index: 2; pointer-events: none; width: 100%; height: 100%; position: absolute; inset: 0px; overflow: visible}\n.uncut-ui .clip .envelope .env-line{fill: none; stroke: rgb(243, 201, 107); stroke-width: 1.5px; vector-effect: non-scaling-stroke}\n.uncut-ui .music-filters{flex-direction: column; gap: 6px; margin-bottom: 6px; display: flex}\n.uncut-ui .music-filters .input{height: 26px}\n.uncut-ui .approval{border-radius: var(--radius-sm); background: rgba(251, 191, 36, 0.08); border: 1px solid rgba(251, 191, 36, 0.4); flex-direction: column; gap: 6px; margin-top: 8px; padding: 10px 12px; display: flex}\n.uncut-ui .approval-text{font-size: 13px; font-weight: 600}\n.uncut-ui .approval-sub{color: var(--muted); font-size: 11px}\n.uncut-ui .approval-btns{flex-wrap: wrap; justify-content: flex-end; gap: 8px; display: flex}\n.uncut-ui .export-subs{border: 1px solid var(--border); background: var(--bg); border-radius: 10px; gap: 2px; padding: 6px 12px; display: grid}\n.uncut-ui .export-sub-row{align-items: center; gap: 10px; min-height: 30px; font-size: 13px; display: flex}\n.uncut-ui .export-sub-row .muted{font-size: 12px}\n.uncut-ui .grow{flex: 1 1 0%}\n.uncut-ui .check-row{align-items: center; gap: 8px; font-size: 12px; display: flex}\n.uncut-ui .stage-canvas{position: relative; overflow: hidden}\n.uncut-ui .zoom-select{background: var(--panel-2); height: 24px; color: var(--fg); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 0px 4px; font-size: 11px}\n.uncut-ui .stage-canvas > .frame{flex: 0 0 auto}\n.uncut-ui .ctx-menu{z-index: 80; backdrop-filter: blur(18px) saturate(1.4); user-select: none; background: rgba(30, 30, 30, 0.92); border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 9px; outline: none; min-width: 220px; padding: 5px; font-size: 13px; position: fixed; box-shadow: rgba(0, 0, 0, 0.55) 0px 12px 32px, rgba(0, 0, 0, 0.6) 0px 0px 0px 0.5px}\n.uncut-ui .ctx-item{height: 24px; color: var(--fg); cursor: pointer; white-space: nowrap; border-radius: 5px; align-items: center; gap: 6px; padding: 0px 10px 0px 4px; display: flex}\n.uncut-ui .ctx-item.active{background: var(--select); color: rgb(255, 255, 255)}\n.uncut-ui .ctx-item.disabled{color: var(--dim); cursor: not-allowed}\n.uncut-ui .ctx-item.danger:not(.disabled):not(.active){color: rgb(255, 138, 138)}\n.uncut-ui .ctx-check{justify-content: center; width: 14px; display: inline-flex}\n.uncut-ui .ctx-label{flex: 1 1 0%}\n.uncut-ui .ctx-key{color: var(--muted); letter-spacing: 0.02em; padding-left: 18px; font-size: 12px}\n.uncut-ui .ctx-item.active .ctx-key{color: rgba(255, 255, 255, 0.8)}\n.uncut-ui .ctx-more{width: 12px; height: 12px; color: var(--muted); margin-left: 8px}\n.uncut-ui .ctx-sep{background: rgba(255, 255, 255, 0.09); height: 1px; margin: 4px 8px}\n.uncut-ui .speed-row{flex-wrap: wrap; gap: 4px; display: flex}\n.uncut-ui .speed-row .small-btn.active{background: var(--select); color: rgb(255, 255, 255); border-color: rgba(0, 0, 0, 0)}\n.uncut-ui .psec{border-bottom: 1px solid var(--border); padding: 4px 14px 10px}\n.uncut-ui .psec-head{justify-content: space-between; align-items: center; min-height: 30px; display: flex}\n.uncut-ui .psec-title{color: var(--fg); letter-spacing: 0.01em; border-radius: 4px; align-items: center; gap: 4px; margin-left: -4px; padding: 2px 4px; font-size: 11px; font-weight: 600; display: inline-flex}\n.uncut-ui .psec-title svg.lucide{width: 12px; height: 12px; color: var(--dim)}\n.uncut-ui .psec-head .icon-btn{width: 22px; height: 22px}\n.uncut-ui .psec-head .icon-btn svg.lucide{width: 14px; height: 14px}\n.uncut-ui .psec-body{flex-direction: column; gap: 6px; display: flex}\n.uncut-ui .psec-body[hidden]{display: none}\n.uncut-ui .psec-actions{align-items: center; gap: 6px; display: flex}\n.uncut-ui .psec-body .group{border-bottom: 0px; padding: 2px 0px 6px}\n.uncut-ui .psec-body .group + .group{border-top: 1px solid var(--border); padding-top: 8px}\n.uncut-ui .fx-entry-head{gap: 6px}\n.uncut-ui .fx-entry-head .grow{flex: 1 1 0%; min-width: 0px}\n.uncut-ui .fx-power{display: inline-flex}\n.uncut-ui .prop{grid-template-columns: 70px minmax(0px, 1fr) 18px; align-items: center; gap: 6px; min-height: 28px; display: grid}\n.uncut-ui .prop-k{color: var(--muted); white-space: nowrap; text-overflow: ellipsis; font-size: 11px; overflow: hidden}\n.uncut-ui .prop-v{align-items: center; min-width: 0px; display: flex}\n.uncut-ui .prop-v > *{flex: 1 1 0%; min-width: 0px}\n.uncut-ui .prop-reset-gap{width: 18px; height: 18px}\n.uncut-ui .icon-btn svg.lucide{width: 15px; height: 15px}\n.uncut-ui .nfield{border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--panel-2); align-items: center; min-width: 0px; height: 28px; display: flex; overflow: hidden}\n.uncut-ui .nfield input{min-width: 0px; height: 100%; color: var(--fg); font: 12px var(--mono); text-align: left; background: 0px 0px; border: 0px; outline: 0px; flex: 1 1 0%; padding: 0px 6px}\n.uncut-ui .nfield-u{color: var(--dim); flex: 0 0 auto; padding-right: 8px; font-size: 11px}\n.uncut-ui .slider-num{grid-template-columns: minmax(0px, 1fr) 76px; align-items: center; gap: 8px; width: 100%; display: grid}\n.uncut-ui .ptoggle{background: var(--raised); border: 1px solid var(--border-strong); border-radius: 9px; flex: 0 0 auto; width: 30px; height: 18px; position: relative}\n.uncut-ui .ptoggle span{background: var(--muted); border-radius: 50%; width: 12px; height: 12px; position: absolute; top: 2px; left: 2px}\n.uncut-ui .ptoggle.on{background: var(--select); border-color: rgba(0, 0, 0, 0)}\n.uncut-ui .ptoggle.on span{background: rgb(255, 255, 255); transform: translate(12px)}\n.uncut-ui .psec-head .icon-btn,.uncut-ui .ptoggle,.uncut-ui .psec-title{padding: 0px}\n.uncut-ui .psec-title{padding: 2px 4px}\n.uncut-ui .insp-title .grow{flex: 1 1 0%; min-width: 0px}\n.uncut-ui .approval-text svg{vertical-align: -2px; width: 14px; height: 14px; color: var(--muted); margin-right: 6px}\n.uncut-ui .storyboard-card{border-color: var(--select); background: var(--select-soft)}\n.uncut-ui .beats{flex-direction: column; gap: 6px; display: flex}\n.uncut-ui .beat{border-left: 2px solid var(--select); background: var(--panel); border-radius: 0 var(--radius-sm) var(--radius-sm) 0; flex-direction: column; gap: 2px; padding: 6px 8px; font-size: 12px; line-height: 1.35; display: flex}\n.uncut-ui .beat-head{align-items: baseline; gap: 8px; display: flex}\n.uncut-ui .beat-time{font-family: var(--mono); color: var(--muted); flex: 0 0 auto; font-size: 11px}\n.uncut-ui .card-item{border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--panel-2); flex-direction: column; font-size: 12px; display: flex}\n.uncut-ui .card-head{color: var(--fg); font-style: inherit; font-variant: inherit; font-weight: inherit; font-stretch: inherit; line-height: inherit; font-family: inherit; font-optical-sizing: inherit; font-size-adjust: inherit; font-kerning: inherit; font-feature-settings: inherit; font-variation-settings: inherit; font-language-override: inherit; text-align: left; cursor: pointer; background: 0px 0px; border: 0px; align-items: center; gap: 6px; width: 100%; padding: 6px 8px; font-size: 12px; display: flex}\n.uncut-ui .card-head svg{width: 13px; height: 13px; color: var(--muted); flex: 0 0 auto}\n.uncut-ui .card-item .scores{padding: 0px 8px 8px}\n.uncut-ui .card-outcome{background: var(--raised); color: var(--muted); border-radius: 8px; flex: 0 0 auto; padding: 1px 6px; font-size: 11px}\n.uncut-ui .scores{flex-direction: column; gap: 3px; display: flex}\n.uncut-ui .score{grid-template-columns: 112px 1fr 26px; align-items: center; gap: 8px; font-size: 12px; display: grid}\n.uncut-ui .score-bar{background: var(--raised); border-radius: 3px; height: 6px; overflow: hidden}\n.uncut-ui .score-bar > span{background: var(--ok); height: 100%; display: block}\n.uncut-ui .score-value{font-family: var(--mono); text-align: right}\n.uncut-ui .plan-strip{z-index: 3; border-bottom: 1px solid var(--border); flex: 0 0 auto; justify-content: flex-end; padding: 6px 12px; display: flex; position: relative}\n.uncut-ui .plan-chip-btn{border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--panel); color: var(--fg); font-style: inherit; font-variant: inherit; font-weight: inherit; font-stretch: inherit; line-height: inherit; font-family: inherit; font-optical-sizing: inherit; font-size-adjust: inherit; font-kerning: inherit; font-feature-settings: inherit; font-variation-settings: inherit; font-language-override: inherit; cursor: pointer; align-items: center; gap: 6px; padding: 3px 9px; font-size: 12px; display: inline-flex}\n.uncut-ui .plan-chip-btn svg{width: 12px; height: 12px; color: var(--muted); flex: 0 0 auto}\n.uncut-ui .plan-state{color: var(--muted); flex: 0 0 auto; font-size: 10px}\n.uncut-ui .plan-state.approved{color: var(--ok)}\n.uncut-ui .card-item{scroll-margin-top: 8px}\n.uncut-ui .review-by{padding: 0px 8px 6px}\n.uncut-ui .storyboard-card .approval-btns .btn{align-items: center; gap: 4px; display: inline-flex}\n.uncut-ui .storyboard-card .approval-btns .btn svg{width: 12px; height: 12px}\n.uncut-ui .agent-thread{overflow-x: hidden}\n.uncut-ui .storyboard-card,.uncut-ui .storyboard-card .beats,.uncut-ui .beat{min-width: 0px}\n.uncut-ui .step .grow{flex: 1 1 0%; min-width: 0px}\n.uncut-ui .step svg.lucide.step-chev{opacity: 0.6; width: 12px; height: 12px}\n.uncut-ui .agent-strip{align-items: center; gap: 8px}\n.uncut-ui .agent-strip .spacer{flex: 1 1 0%}\n.uncut-ui .agent-strip{justify-content: flex-start; padding-left: 8px}\n.uncut-ui .agent-new-chat svg.lucide{width: 15px; height: 15px}\n.uncut-ui .plan-chip-wrap{display: flex}\n.uncut-ui .edit-step{cursor: pointer; color: var(--fg)}\n.uncut-ui .edit-step svg.lucide:first-child{color: var(--select)}\n.uncut-ui .num-field .k{cursor: ew-resize; user-select: none}\n.uncut-ui .rail button{position: relative}\n.uncut-ui .provider-mark{width: 16px; height: 16px; color: var(--fg); flex: 0 0 auto; justify-content: center; align-items: center; display: inline-flex}\n.uncut-ui .provider-mark .provider-logo{width: 100%; height: 100%; display: block}\n.uncut-ui .provider-wordmark{letter-spacing: -0.01em; color: var(--fg); font-weight: 600}\n.uncut-ui .composer-choices .choice .provider-wordmark{font-size: 12px}\n.uncut-ui{--ease: cubic-bezier(.2, 0, 0, 1); --fast: .12s}\n.uncut-ui select{font: 12px var(--font); color: var(--fg); border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--panel-2); cursor: pointer; height: 28px; padding: 0px 6px}\n.uncut-ui input[type=\"checkbox\"],.uncut-ui input[type=\"range\"]{cursor: pointer}\n.uncut-ui label:has(> input[type=\"checkbox\"]){cursor: pointer}\n.uncut-ui .tool-picker .icon-btn.on{background: var(--raised)}\n.uncut-ui{text-align:left;-webkit-font-smoothing:antialiased}.uncut-ui .uncut-ui-caret{display:inline-block;width:1.5px;height:1.2em;margin:0 -1.5px 0 0;vertical-align:-0.25em;background:var(--fg)}.uncut-ui.uncut-ui-light{--bg:#fff;--panel:#fff;--panel-2:#fff;--raised:#efeeea;--border:#00000010;--border-strong:#0000001c;--fg:#111;--muted:#62625e;--dim:#9a9993;--select-soft:#6d8cff24;color-scheme:light;color:var(--fg)}.uncut-ui.uncut-ui-light .send:not(:disabled){color:#fff}.uncut-ui.uncut-ui-light .clip{border-color:#0000001a}","parts":{"composer":{"html":"\u003cdiv class=\"composer\" data-testid=\"composer\">\u003cdiv class=\"composer-ctx\" data-testid=\"agent-context\">\u00010\u0002\u003cspan class=\"ellipsis\">Playhead 00:00:00:00\u003c/span>\u003c/div>\u003cdiv class=\"composer-box\">\u003cdiv class=\"composer-hl\">Make a 28 s launch film for Uncut on the Electro Dreams beat, the drone clips as the film being edited.​\u003c/div>\u003ctextarea id=\"agent-input\" data-testid=\"agent-input\" rows=\"3\" placeholder=\"Ask for an edit; @ to point at media or a clip, / for a skill or a template\">Make a 28 s launch film for Uncut on the Electro Dreams beat, the drone clips as the film being edited.\u003c/textarea>\u003c/div>\u003cdiv class=\"composer-foot\">\u003cbutton class=\"icon-btn composer-at\" data-testid=\"agent-attach\">\u00011\u0002\u003c/button>\u003cbutton class=\"icon-btn composer-at\" data-testid=\"agent-at\">\u00012\u0002\u003c/button>\u003cdiv class=\"composer-choices\">\u003cbutton class=\"choice provider\" data-testid=\"agent-provider\" data-provider=\"claude\">\u003cspan class=\"provider-mark sm\" data-testid=\"provider-mark\" data-provider=\"claude\">\u00013\u0002\u003c/span>\u003c/button>\u003cbutton class=\"choice model\" data-testid=\"agent-model\" data-model=\"\">\u003cspan class=\"provider-wordmark\" data-testid=\"provider-wordmark\" data-provider=\"claude\">Claude\u003c/span>\u003cspan class=\"choice-label\">Default\u003c/span>\u00014\u0002\u003c/button>\u003cbutton class=\"choice\" data-testid=\"agent-effort\" data-effort=\"\">\u00015\u0002\u003cspan class=\"choice-label\">Auto\u003c/span>\u003c/button>\u003cbutton class=\"choice\" data-testid=\"agent-access\" data-access=\"auto\">\u00016\u0002\u003cspan class=\"choice-label\">Auto\u003c/span>\u003c/button>\u003c/div>\u003cspan class=\"composer-spacer\">\u003c/span>\u003cbutton class=\"send\" data-testid=\"agent-send\">\u00017\u0002\u003c/button>\u003c/div>\u003c/div>","width":415,"height":127,"ancestors":[{"tag":"div","cls":"app","attrs":{},"vars":"--side-col:clamp(240px, 440px, 40vw)"},{"tag":"aside","cls":"side","attrs":{},"vars":""},{"tag":"div","cls":"side-body","attrs":{},"vars":""},{"tag":"div","cls":"agent","attrs":{},"vars":""}]},"storyboard":{"html":"\u003cdiv class=\"approval storyboard-card\" data-testid=\"agent-storyboard\" data-id=\"ap-1\">\u003cdiv class=\"approval-text\">\u00018\u0002One take on Electro Dreams: the composer, the agent's plan, the timeline building, the preview flooding full-frame on the drop, the critic's card, the export.\u003c/div>\u003cdiv class=\"beats\">\u003cdiv class=\"beat\" data-testid=\"agent-storyboard-beat\">\u003cdiv class=\"beat-head\">\u003cspan class=\"beat-time\">1. 0 s to 2 s\u003c/span>\u003cb>Hook\u003c/b>\u003c/div>\u003cdiv class=\"beat-line\">\"Edit videos by talking to an agent\" huge on the canvas \u003cspan class=\"muted\">→\u003c/span> The empty composer under it\u003c/div>\u003cdiv class=\"beat-line muted\">Stop the scroll with the claim\u003c/div>\u003cdiv class=\"beat-line small muted\">Kit fonts, composer UI, on Downbeat 0\u003c/div>\u003c/div>\u003cdiv class=\"beat\" data-testid=\"agent-storyboard-beat\">\u003cdiv class=\"beat-head\">\u003cspan class=\"beat-time\">2. 2 s to 6 s\u003c/span>\u003cb>Typing the prompt\u003c/b>\u003c/div>\u003cdiv class=\"beat-line\">The cursor clicks into the composer \u003cspan class=\"muted\">→\u003c/span> Prompt typed; Send pressed at 6.0\u003c/div>\u003cdiv class=\"beat-line muted\">Show you typing this prompt\u003c/div>\u003cdiv class=\"beat-line small muted\">Composer UI, on Click on 2.5, send on 6.0\u003c/div>\u003c/div>\u003cdiv class=\"beat\" data-testid=\"agent-storyboard-beat\">\u003cdiv class=\"beat-head\">\u003cspan class=\"beat-time\">3. 6 s to 12 s\u003c/span>\u003cb>It edits the timeline\u003c/b>\u003c/div>\u003cdiv class=\"beat-line\">The panel morphs into the editor \u003cspan class=\"muted\">→\u003c/span> Camera pushes onto the preview\u003c/div>\u003cdiv class=\"beat-line muted\">The agent putting clips on real tracks\u003c/div>\u003cdiv class=\"beat-line small muted\">DJI 0055, DJI 0063, DJI 0068, on A clip lands on every beat\u003c/div>\u003c/div>\u003cdiv class=\"beat\" data-testid=\"agent-storyboard-beat\">\u003cdiv class=\"beat-head\">\u003cspan class=\"beat-time\">4. 12 s to 18 s\u003c/span>\u003cb>Drop: the film plays\u003c/b>\u003c/div>\u003cdiv class=\"beat-line\">The preview floods full-frame \u003cspan class=\"muted\">→\u003c/span> Shots grow out of each other\u003c/div>\u003cdiv class=\"beat-line muted\">The reveal: the edited film itself\u003c/div>\u003cdiv class=\"beat-line small muted\">DJI 0063, DJI 0050, on Drop 12.0\u003c/div>\u003c/div>\u003c/div>\u003cdiv class=\"approval-sub\">The build waits for your approval.\u003c/div>\u003cdiv class=\"approval-btns\">\u003cbutton class=\"btn ghost\" data-testid=\"agent-storyboard-edit\">\u00019\u0002Edit\u003c/button>\u003cbutton class=\"btn ghost\" data-testid=\"agent-storyboard-change\">Ask for changes\u003c/button>\u003cbutton class=\"btn primary\" data-testid=\"agent-storyboard-approve\">Approve\u003c/button>\u003c/div>\u003c/div>","width":400,"height":533,"ancestors":[{"tag":"div","cls":"app","attrs":{},"vars":"--side-col:clamp(240px, 440px, 40vw)"},{"tag":"aside","cls":"side","attrs":{},"vars":""},{"tag":"div","cls":"side-body","attrs":{},"vars":""},{"tag":"div","cls":"agent","attrs":{},"vars":""},{"tag":"div","cls":"agent-thread","attrs":{},"vars":""},{"tag":"div","cls":"turn-wrap","attrs":{"data-turn":"turn-1","data-status":"running","data-undo":"none"},"vars":""},{"tag":"div","cls":"turn running","attrs":{},"vars":""}],"backdrop":"rgb(17, 17, 17)","radius":"6px"},"editor":{"html":"\u003cdiv class=\"app\" data-testid=\"editor\" style=\"--side-col: clamp(240px, 440px, 40vw);\">\u003cheader class=\"topbar\">\u003cdiv class=\"wordmark\" data-testid=\"wordmark\" data-busy=\"false\">\u003cspan class=\"brand wordmark-name\">\u000110\u0002\u003cspan class=\"wordmark-text\" data-testid=\"wordmark-text\">Uncut\u003c/span>\u003c/span>\u003cspan class=\"wordmark-slash\">\u003c/span>\u003cdiv class=\"project-title\" data-testid=\"project-title\">Launch film\u003c/div>\u003c/div>\u003cdiv class=\"topbar-spacer\">\u003c/div>\u003cdiv class=\"layout-toggles\">\u003cbutton class=\"icon-btn\" data-testid=\"toggle-lib\">\u000111\u0002\u003c/button>\u003cbutton class=\"icon-btn\" data-testid=\"toggle-bottom\">\u000112\u0002\u003c/button>\u003cbutton class=\"icon-btn\" data-testid=\"toggle-side\">\u000113\u0002\u003c/button>\u003cbutton class=\"icon-btn\" data-testid=\"toggle-focus\">\u000114\u0002\u003c/button>\u003c/div>\u003cdiv class=\"saved\" data-testid=\"saved\">\u000115\u0002Saved\u003c/div>\u003cbutton class=\"icon-btn\" data-testid=\"undo\">\u000116\u0002\u003c/button>\u003cbutton class=\"icon-btn\" data-testid=\"redo\" disabled=\"\">\u000117\u0002\u003c/button>\u003cbutton class=\"btn export-btn\" data-testid=\"export-button\" data-running=\"false\">\u000118\u0002Export\u003c/button>\u003cbutton class=\"icon-btn\" data-testid=\"open-settings\">\u000119\u0002\u003c/button>\u003cbutton class=\"icon-btn\" data-testid=\"close-project\">\u000120\u0002\u003c/button>\u003c/header>\u003cdiv class=\"banners\">\u003c/div>\u003cnav class=\"rail\" data-testid=\"rail\" data-more-up=\"false\" data-more-down=\"false\" data-scrollbars=\"off\" data-order=\"media,transcript,text,elements,audio,sfx,transitions,effects,capture,generate,brand,skills\" data-hidden=\"\">\u003cbutton class=\"active\" data-testid=\"rail-media\" data-rail=\"media\">\u000121\u0002\u003cspan>Media\u003c/span>\u003c/button>\u003cbutton data-testid=\"rail-transcript\" data-rail=\"transcript\">\u000122\u0002\u003cspan>Transcript\u003c/span>\u003c/button>\u003cbutton data-testid=\"rail-text\" data-rail=\"text\">\u000123\u0002\u003cspan>Text\u003c/span>\u003c/button>\u003cbutton data-testid=\"rail-elements\" data-rail=\"elements\">\u000124\u0002\u003cspan>Elements\u003c/span>\u003c/button>\u003cbutton data-testid=\"rail-audio\" data-rail=\"audio\">\u000125\u0002\u003cspan>Audio\u003c/span>\u003c/button>\u003cbutton data-testid=\"rail-sfx\" data-rail=\"sfx\">\u000126\u0002\u003cspan>Sounds\u003c/span>\u003c/button>\u003cbutton data-testid=\"rail-transitions\" data-rail=\"transitions\">\u000127\u0002\u003cspan>Transitions\u003c/span>\u003c/button>\u003cbutton data-testid=\"rail-effects\" data-rail=\"effects\">\u000128\u0002\u003cspan>Effects\u003c/span>\u003c/button>\u003cbutton data-testid=\"rail-capture\" data-rail=\"capture\">\u000129\u0002\u003cspan>Capture\u003c/span>\u003c/button>\u003cbutton data-testid=\"rail-generate\" data-rail=\"generate\">\u00016\u0002\u003cspan>Generate\u003c/span>\u003c/button>\u003cbutton data-testid=\"rail-brand\" data-rail=\"brand\">\u000130\u0002\u003cspan>Brand\u003c/span>\u003c/button>\u003cbutton data-testid=\"rail-skills\" data-rail=\"skills\">\u000131\u0002\u003cspan>Skills\u003c/span>\u003c/button>\u003c/nav>\u003caside class=\"library\" data-testid=\"library\">\u003cdiv class=\"lib-head\">Media\u003cbutton class=\"icon-btn\" data-testid=\"import-plus\">\u000132\u0002\u003c/button>\u003c/div>\u003cdiv class=\"lib-section\">\u003cdiv class=\"lib-label media-bar\">\u003cspan>In this project\u003c/span>\u003cspan class=\"media-bar-tools\">\u003cselect class=\"media-sort\" data-testid=\"media-sort\">\u003coption value=\"date\">Date added\u003c/option>\u003coption value=\"name\">Name\u003c/option>\u003coption value=\"duration\">Length\u003c/option>\u003coption value=\"type\">Type\u003c/option>\u003c/select>\u003cbutton class=\"icon-btn active\" data-testid=\"media-view-grid\">\u000133\u0002\u003c/button>\u003cbutton class=\"icon-btn\" data-testid=\"media-view-list\">\u000134\u0002\u003c/button>\u003c/span>\u003c/div>\u003cdiv class=\"grid2\" data-testid=\"media-grid\" data-view=\"grid\" data-sort=\"date\">\u003cdiv class=\"tile\" data-testid=\"media-tile\" data-id=\"m-typing\" data-used=\"true\">\u003cdiv class=\"thumb\">\u000135\u0002\u003cspan class=\"tile-used\" data-testid=\"media-used\">Used\u003c/span>\u003cspan class=\"dur\" data-testid=\"duration\">00:02\u003c/span>\u003cbutton class=\"tile-add\" data-testid=\"add-to-timeline\">\u000132\u0002\u003c/button>\u003cbutton class=\"tile-chat second\" data-testid=\"media-add-to-chat\">\u00012\u0002\u003c/button>\u003cbutton class=\"tile-analyze\" data-testid=\"analyze\">\u000126\u0002\u003c/button>\u003c/div>\u003cdiv class=\"tile-name\" data-testid=\"tile-name\">Keyboard typing\u003c/div>\u003cdiv class=\"tile-sub\" data-testid=\"tile-meta\">Audio\u003c/div>\u003c/div>\u003cdiv class=\"tile\" data-testid=\"media-tile\" data-id=\"m-whoosh\" data-used=\"true\">\u003cdiv class=\"thumb\">\u000135\u0002\u003cspan class=\"tile-used\" data-testid=\"media-used\">Used\u003c/span>\u003cspan class=\"dur\" data-testid=\"duration\">00:00\u003c/span>\u003cbutton class=\"tile-add\" data-testid=\"add-to-timeline\">\u000132\u0002\u003c/button>\u003cbutton class=\"tile-chat second\" data-testid=\"media-add-to-chat\">\u00012\u0002\u003c/button>\u003cbutton class=\"tile-analyze\" data-testid=\"analyze\">\u000126\u0002\u003c/button>\u003c/div>\u003cdiv class=\"tile-name\" data-testid=\"tile-name\">Airy whoosh\u003c/div>\u003cdiv class=\"tile-sub\" data-testid=\"tile-meta\">Audio\u003c/div>\u003c/div>\u003cdiv class=\"tile\" data-testid=\"media-tile\" data-id=\"m-click\" data-used=\"true\">\u003cdiv class=\"thumb\">\u000135\u0002\u003cspan class=\"tile-used\" data-testid=\"media-used\">Used\u003c/span>\u003cspan class=\"dur\" data-testid=\"duration\">00:00\u003c/span>\u003cbutton class=\"tile-add\" data-testid=\"add-to-timeline\">\u000132\u0002\u003c/button>\u003cbutton class=\"tile-chat second\" data-testid=\"media-add-to-chat\">\u00012\u0002\u003c/button>\u003cbutton class=\"tile-analyze\" data-testid=\"analyze\">\u000126\u0002\u003c/button>\u003c/div>\u003cdiv class=\"tile-name\" data-testid=\"tile-name\">Mouse click\u003c/div>\u003cdiv class=\"tile-sub\" data-testid=\"tile-meta\">Audio\u003c/div>\u003c/div>\u003cdiv class=\"tile\" data-testid=\"media-tile\" data-id=\"m-dji-0068\" data-used=\"true\">\u003cdiv class=\"thumb\">\u000121\u0002\u003cspan class=\"tile-used\" data-testid=\"media-used\">Used\u003c/span>\u003cspan class=\"dur\" data-testid=\"duration\">00:22\u003c/span>\u003cbutton class=\"tile-add\" data-testid=\"add-to-timeline\">\u000132\u0002\u003c/button>\u003cbutton class=\"tile-chat\" data-testid=\"media-add-to-chat\">\u00012\u0002\u003c/button>\u003c/div>\u003cdiv class=\"tile-name\" data-testid=\"tile-name\">DJI 0068\u003c/div>\u003cdiv class=\"tile-sub\" data-testid=\"tile-meta\">3840×2160, 50 fps\u003c/div>\u003c/div>\u003cdiv class=\"tile\" data-testid=\"media-tile\" data-id=\"m-dji-0063\" data-used=\"true\">\u003cdiv class=\"thumb\">\u000121\u0002\u003cspan class=\"tile-used\" data-testid=\"media-used\">Used\u003c/span>\u003cspan class=\"dur\" data-testid=\"duration\">00:48\u003c/span>\u003cbutton class=\"tile-add\" data-testid=\"add-to-timeline\">\u000132\u0002\u003c/button>\u003cbutton class=\"tile-chat\" data-testid=\"media-add-to-chat\">\u00012\u0002\u003c/button>\u003c/div>\u003cdiv class=\"tile-name\" data-testid=\"tile-name\">DJI 0063\u003c/div>\u003cdiv class=\"tile-sub\" data-testid=\"tile-meta\">3840×2160, 50 fps\u003c/div>\u003c/div>\u003cdiv class=\"tile\" data-testid=\"media-tile\" data-id=\"m-dji-0055\" data-used=\"true\">\u003cdiv class=\"thumb\">\u000121\u0002\u003cspan class=\"tile-used\" data-testid=\"media-used\">Used\u003c/span>\u003cspan class=\"dur\" data-testid=\"duration\">00:38\u003c/span>\u003cbutton class=\"tile-add\" data-testid=\"add-to-timeline\">\u000132\u0002\u003c/button>\u003cbutton class=\"tile-chat\" data-testid=\"media-add-to-chat\">\u00012\u0002\u003c/button>\u003c/div>\u003cdiv class=\"tile-name\" data-testid=\"tile-name\">DJI 0055\u003c/div>\u003cdiv class=\"tile-sub\" data-testid=\"tile-meta\">3840×2160, 50 fps\u003c/div>\u003c/div>\u003cdiv class=\"tile\" data-testid=\"media-tile\" data-id=\"m-dji-0050\" data-used=\"true\">\u003cdiv class=\"thumb\">\u000121\u0002\u003cspan class=\"tile-used\" data-testid=\"media-used\">Used\u003c/span>\u003cspan class=\"dur\" data-testid=\"duration\">00:31\u003c/span>\u003cbutton class=\"tile-add\" data-testid=\"add-to-timeline\">\u000132\u0002\u003c/button>\u003cbutton class=\"tile-chat\" data-testid=\"media-add-to-chat\">\u00012\u0002\u003c/button>\u003c/div>\u003cdiv class=\"tile-name\" data-testid=\"tile-name\">DJI 0050\u003c/div>\u003cdiv class=\"tile-sub\" data-testid=\"tile-meta\">3840×2160, 50 fps\u003c/div>\u003c/div>\u003cdiv class=\"tile\" data-testid=\"media-tile\" data-id=\"m-music\" data-used=\"true\">\u003cdiv class=\"thumb\">\u000135\u0002\u003cspan class=\"tile-used\" data-testid=\"media-used\">Used\u003c/span>\u003cspan class=\"dur\" data-testid=\"duration\">00:28\u003c/span>\u003cbutton class=\"tile-add\" data-testid=\"add-to-timeline\">\u000132\u0002\u003c/button>\u003cbutton class=\"tile-chat second\" data-testid=\"media-add-to-chat\">\u00012\u0002\u003c/button>\u003cbutton class=\"tile-analyze\" data-testid=\"analyze\">\u000126\u0002\u003c/button>\u003c/div>\u003cdiv class=\"tile-name\" data-testid=\"tile-name\">electro-dreams.mp3\u003c/div>\u003cdiv class=\"tile-sub\" data-testid=\"tile-meta\">Audio\u003c/div>\u003c/div>\u003c/div>\u003c/div>\u003c/aside>\u003cmain class=\"stage\" data-testid=\"stage\">\u003cdiv class=\"stage-canvas\" data-testid=\"stage-canvas\" data-zoom=\"fit\">\u003cdiv class=\"frame\" data-testid=\"preview-frame\" data-frame=\"0\" data-playing=\"false\" style=\"width: 411px; height: 514px; background: rgb(0, 0, 0);\">\u003c/div>\u003c/div>\u003cdiv class=\"transport\">\u003cspan class=\"timecode\" data-testid=\"timecode\">00:00:00:00\u003cspan class=\"tc-end\"> / 00:00:28:00\u003c/span>\u003c/span>\u003cdiv class=\"transport-mid\">\u003cbutton class=\"icon-btn tp-jump\" data-testid=\"to-start\" disabled=\"\">\u000136\u0002\u003c/button>\u003cbutton class=\"icon-btn tp-step\" data-testid=\"step-back\" disabled=\"\">\u000137\u0002\u003c/button>\u003cbutton class=\"icon-btn play\" data-testid=\"play\">\u000138\u0002\u003c/button>\u003cbutton class=\"icon-btn tp-step\" data-testid=\"step-forward\">\u000139\u0002\u003c/button>\u003cbutton class=\"icon-btn tp-jump\" data-testid=\"to-end\">\u000140\u0002\u003c/button>\u003c/div>\u003cspan class=\"muted small\" data-testid=\"canvas-info\">1080×1350\u003cspan class=\"canvas-fps\">, 60 fps\u003c/span>\u003c/span>\u003cselect class=\"zoom-select\" data-testid=\"preview-zoom\">\u003coption value=\"fit\">Fit\u003c/option>\u003coption value=\"0.5\">50%\u003c/option>\u003coption value=\"1\">100%\u003c/option>\u003coption value=\"2\">200%\u003c/option>\u003c/select>\u003cbutton class=\"icon-btn tp-region\" data-testid=\"preview-region\">\u000141\u0002\u003c/button>\u003cbutton class=\"icon-btn tp-hand\" data-testid=\"preview-hand\">\u000142\u0002\u003c/button>\u003cbutton class=\"icon-btn\" data-testid=\"preview-fullscreen\">\u000143\u0002\u003c/button>\u003c/div>\u003c/main>\u003caside class=\"side\">\u003cdiv class=\"tabs\">\u003cbutton data-testid=\"tab-inspector\">Inspector\u003c/button>\u003cbutton class=\"active\" data-testid=\"tab-agent\">Agent\u003c/button>\u003cbutton data-testid=\"tab-history\">History\u003c/button>\u003c/div>\u003cdiv class=\"side-body\">\u003cdiv class=\"agent\" data-testid=\"agent-panel\">\u003cdiv class=\"plan-strip agent-strip\" data-testid=\"agent-strip\">\u003cbutton class=\"icon-btn agent-new-chat\" data-testid=\"agent-new-chat\">\u000144\u0002\u003c/button>\u003cbutton class=\"icon-btn agent-compact\" data-testid=\"agent-compact\">\u000145\u0002\u003c/button>\u003cbutton class=\"icon-btn agent-add\" data-testid=\"agent-add\">\u000132\u0002\u003c/button>\u003cspan class=\"spacer\">\u003c/span>\u003cdiv class=\"plan-chip-wrap\" data-testid=\"agent-plan\">\u003cbutton class=\"plan-chip-btn\" data-testid=\"plan-chip\">\u000146\u0002Plan\u003cspan class=\"plan-state approved\">Planned\u003c/span>\u003c/button>\u003c/div>\u003c/div>\u003cdiv class=\"agent-thread\" data-testid=\"agent-thread\" data-ui-scroll=\"52\">\u003cdiv class=\"turn-wrap\" data-testid=\"agent-turn\" data-turn=\"turn-1\" data-status=\"done\" data-undo=\"available\">\u003cdiv class=\"msg-user\" data-testid=\"agent-prompt\">Make a 28 s launch film for Uncut on the Electro Dreams beat, the drone clips as the film being edited.\u003c/div>\u003cdiv class=\"turn done\" data-testid=\"agent-stream\">\u003cdiv class=\"worklog\">\u003cdiv class=\"step\" data-testid=\"agent-step\" data-status=\"done\" data-tool=\"graphic_write\">\u000115\u0002\u003cspan class=\"grow\">Wrote graphic film.html\u003c/span>\u003c/div>\u003c/div>\u003cdiv class=\"edit-row\" data-testid=\"agent-edit-row\">\u003cdiv class=\"step edit-step\" data-testid=\"agent-step\" data-status=\"done\" data-tool=\"edit\">\u000147\u0002\u003cspan class=\"grow\">Placed the clips on Main\u003c/span>\u000148\u0002\u003c/div>\u003c/div>\u003cdiv class=\"card-item critic-row open\" data-testid=\"agent-card\" data-type=\"review\" data-status=\"passed\" data-passed=\"true\">\u003cbutton class=\"card-head critic-head\">\u003cspan class=\"critic-icon passed\">\u00015\u0002\u003c/span>\u003cspan class=\"critic-text\">\u003cspan class=\"critic-title\">\u003cspan class=\"critic-name\">Critic, round 2\u003c/span>\u003cspan class=\"card-outcome critic-status passed\" data-testid=\"critic-status\">Passed\u003c/span>\u003c/span>\u003c/span>\u000149\u0002\u003c/button>\u003cdiv class=\"review-by small muted\" data-testid=\"agent-review-by\" data-by=\"critic\">Independent critic\u003c/div>\u003cdiv class=\"scores\" data-testid=\"agent-review-scores\">\u003cdiv class=\"score ok required\" data-testid=\"agent-review-score\" data-score=\"hook\" data-value=\"9\" data-applies=\"required\">\u003cspan class=\"score-name\">Hook in 2 s\u003c/span>\u003cspan class=\"score-bar\">\u003cspan style=\"width: 90%;\">\u003c/span>\u003c/span>\u003cspan class=\"score-value\">9\u003c/span>\u003c/div>\u003cdiv class=\"score ok required\" data-testid=\"agent-review-score\" data-score=\"readability\" data-value=\"8\" data-applies=\"required\">\u003cspan class=\"score-name\">Phone readability\u003c/span>\u003cspan class=\"score-bar\">\u003cspan style=\"width: 80%;\">\u003c/span>\u003c/span>\u003cspan class=\"score-value\">8\u003c/span>\u003c/div>\u003cdiv class=\"score ok required\" data-testid=\"agent-review-score\" data-score=\"motion\" data-value=\"9\" data-applies=\"required\">\u003cspan class=\"score-name\">Motion\u003c/span>\u003cspan class=\"score-bar\">\u003cspan style=\"width: 90%;\">\u003c/span>\u003c/span>\u003cspan class=\"score-value\">9\u003c/span>\u003c/div>\u003cdiv class=\"score ok optional\" data-testid=\"agent-review-score\" data-score=\"variety\" data-value=\"8\" data-applies=\"optional\">\u003cspan class=\"score-name\">Variety\u003cspan class=\"muted\"> (optional)\u003c/span>\u003c/span>\u003cspan class=\"score-bar\">\u003cspan style=\"width: 80%;\">\u003c/span>\u003c/span>\u003cspan class=\"score-value\">8\u003c/span>\u003c/div>\u003cdiv class=\"score ok required\" data-testid=\"agent-review-score\" data-score=\"sound\" data-value=\"9\" data-applies=\"required\">\u003cspan class=\"score-name\">Sound sync\u003c/span>\u003cspan class=\"score-bar\">\u003cspan style=\"width: 90%;\">\u003c/span>\u003c/span>\u003cspan class=\"score-value\">9\u003c/span>\u003c/div>\u003cdiv class=\"score ok optional\" data-testid=\"agent-review-score\" data-score=\"brand\" data-value=\"9\" data-applies=\"optional\">\u003cspan class=\"score-name\">Brand\u003cspan class=\"muted\"> (optional)\u003c/span>\u003c/span>\u003cspan class=\"score-bar\">\u003cspan style=\"width: 90%;\">\u003c/span>\u003c/span>\u003cspan class=\"score-value\">9\u003c/span>\u003c/div>\u003c/div>\u003c/div>\u003cdiv class=\"reply\" data-testid=\"agent-reply\">\u003cp>The film is built on the Electro Dreams beat: it opens on the claim, types your prompt, builds the timeline, floods the preview on the drop and ends on the export.\u003c/p>\u003cbutton type=\"button\" class=\"icon-btn copy-btn reply-copy\" data-testid=\"agent-copy\">\u000150\u0002\u003c/button>\u003c/div>\u003c/div>\u003cdiv class=\"turn-foot\">\u003cdiv class=\"turn-edits\" data-testid=\"agent-edits\">\u003cbutton class=\"turn-edits-label\" data-testid=\"agent-edits-toggle\">\u000147\u00022 edits\u003c/button>\u003cdiv class=\"sr-only\">\u003cdiv class=\"turn-edits-list\">\u003cdiv class=\"turn-edit\" data-testid=\"agent-edit\">\u003cdiv class=\"turn-edit-summary\">Placed the clips on Main\u003c/div>\u003cdiv class=\"turn-edit-line\">Added DJI 0055\u003c/div>\u003cdiv class=\"turn-edit-line\">Added DJI 0063\u003c/div>\u003cdiv class=\"turn-edit-line\">Added DJI 0068\u003c/div>\u003cdiv class=\"turn-edit-line\">Added DJI 0050\u003c/div>\u003c/div>\u003cdiv class=\"turn-edit\" data-testid=\"agent-edit\">\u003cdiv class=\"turn-edit-summary\">Added sound effects\u003c/div>\u003cdiv class=\"turn-edit-line\">Added Keyboard typing\u003c/div>\u003cdiv class=\"turn-edit-line\">Added Mouse click\u003c/div>\u003c/div>\u003c/div>\u003c/div>\u003c/div>\u003cspan class=\"turn-status\">Claude Code\u003c/span>\u003cspan class=\"spacer\">\u003c/span>\u003cbutton class=\"link-btn\" data-testid=\"agent-undo-turn\" data-turn=\"turn-1\">\u000116\u0002Undo\u003cspan class=\"undo-word\"> turn\u003c/span>\u003c/button>\u003c/div>\u003c/div>\u003c/div>\u003cdiv class=\"composer\" data-testid=\"composer\">\u003cdiv class=\"composer-ctx\" data-testid=\"agent-context\">\u00010\u0002\u003cspan class=\"ellipsis\">Playhead 00:00:00:00\u003c/span>\u003c/div>\u003cdiv class=\"composer-box\">\u003cdiv class=\"composer-hl\">​\u003c/div>\u003ctextarea id=\"agent-input\" data-testid=\"agent-input\" rows=\"3\" placeholder=\"Ask for an edit; @ to point at media or a clip, / for a skill or a template\">\u003c/textarea>\u003c/div>\u003cdiv class=\"composer-foot\">\u003cbutton class=\"icon-btn composer-at\" data-testid=\"agent-attach\">\u00011\u0002\u003c/button>\u003cbutton class=\"icon-btn composer-at\" data-testid=\"agent-at\">\u00012\u0002\u003c/button>\u003cdiv class=\"composer-choices\">\u003cbutton class=\"choice provider\" data-testid=\"agent-provider\" data-provider=\"claude\">\u003cspan class=\"provider-mark sm\" data-testid=\"provider-mark\" data-provider=\"claude\">\u00013\u0002\u003c/span>\u003c/button>\u003cbutton class=\"choice model\" data-testid=\"agent-model\" data-model=\"\">\u003cspan class=\"provider-wordmark\" data-testid=\"provider-wordmark\" data-provider=\"claude\">Claude\u003c/span>\u003cspan class=\"choice-label\">Default\u003c/span>\u00014\u0002\u003c/button>\u003cbutton class=\"choice\" data-testid=\"agent-effort\" data-effort=\"\">\u00015\u0002\u003cspan class=\"choice-label\">Auto\u003c/span>\u003c/button>\u003cbutton class=\"choice\" data-testid=\"agent-access\" data-access=\"auto\">\u00016\u0002\u003cspan class=\"choice-label\">Auto\u003c/span>\u003c/button>\u003c/div>\u003cspan class=\"composer-spacer\">\u003c/span>\u003cbutton class=\"send\" data-testid=\"agent-send\" disabled=\"\">\u00017\u0002\u003c/button>\u003c/div>\u003c/div>\u003c/div>\u003c/div>\u003c/aside>\u003csection class=\"bottom\">\u003cdiv class=\"bottom-toolbar\">\u003cdiv class=\"seg\" data-testid=\"bottom-tabs\">\u003cbutton class=\"active\" data-testid=\"bottom-timeline\">Timeline\u003c/button>\u003cbutton data-testid=\"bottom-mixer\">Mixer\u003c/button>\u003c/div>\u003cspan class=\"muted small\">5 tracks\u003c/span>\u003cdiv class=\"toolbar-spacer\">\u003c/div>\u003cdiv class=\"tool-picker\" data-testid=\"tool-picker\">\u003cbutton class=\"icon-btn on\" data-testid=\"tool-select\">\u00010\u0002\u003c/button>\u003cbutton class=\"icon-btn\" data-testid=\"tool-blade\">\u000151\u0002\u003c/button>\u003cbutton class=\"icon-btn\" data-testid=\"tool-hand\">\u000142\u0002\u003c/button>\u003c/div>\u003cdiv class=\"toolbar-sep\">\u003c/div>\u003cbutton class=\"icon-btn\" data-testid=\"split\">\u000152\u0002\u003c/button>\u003cbutton class=\"icon-btn\" data-testid=\"delete-item\" disabled=\"\">\u000153\u0002\u003c/button>\u003cbutton class=\"icon-btn on\" data-testid=\"snap-toggle\">\u000154\u0002\u003c/button>\u003cbutton class=\"icon-btn on\" data-testid=\"skim-toggle\">\u000155\u0002\u003c/button>\u003cbutton class=\"icon-btn on\" data-testid=\"link-overlays\">\u000156\u0002\u003c/button>\u003cdiv class=\"toolbar-sep\">\u003c/div>\u003cbutton class=\"icon-btn\" data-testid=\"zoom-out\">\u000157\u0002\u003c/button>\u003cbutton class=\"icon-btn\" data-testid=\"zoom-in\">\u000158\u0002\u003c/button>\u003cbutton class=\"icon-btn\" data-testid=\"zoom-fit\">\u000159\u0002\u003c/button>\u003c/div>\u003cdiv class=\"bottom-body\">\u003cdiv class=\"tl\" data-testid=\"timeline\" data-ppf=\"1.000595238095238\" data-zoom=\"1\" style=\"--tl-view-h: 216px;\">\u003cdiv class=\"tl-heads\" data-testid=\"track-heads\">\u003cdiv class=\"tl-corner\">\u003c/div>\u003cdiv class=\"tl-head\" data-testid=\"track\" data-id=\"t-text\" data-kind=\"text\">\u003cdiv class=\"name\">\u000123\u0002\u003cspan class=\"ellipsis\" data-testid=\"track-name\">Text\u003c/span>\u003c/div>\u003cbutton class=\"icon-btn\" data-testid=\"track-hide\">\u000160\u0002\u003c/button>\u003cbutton class=\"icon-btn\" data-testid=\"track-lock\">\u000161\u0002\u003c/button>\u003c/div>\u003cdiv class=\"tl-head\" data-testid=\"track\" data-id=\"t-gfx\" data-kind=\"video\">\u003cdiv class=\"name\">\u000162\u0002\u003cspan class=\"ellipsis\" data-testid=\"track-name\">Graphics\u003c/span>\u003c/div>\u003cbutton class=\"icon-btn\" data-testid=\"track-hide\">\u000160\u0002\u003c/button>\u003cbutton class=\"icon-btn\" data-testid=\"track-lock\">\u000161\u0002\u003c/button>\u003c/div>\u003cdiv class=\"tl-head main\" data-testid=\"track\" data-id=\"t-main\" data-kind=\"video\" data-main=\"true\">\u003cdiv class=\"name\">\u000121\u0002\u003cspan class=\"ellipsis\" data-testid=\"track-name\">Main\u003c/span>\u003cspan class=\"badge\">\u000154\u0002\u003c/span>\u003c/div>\u003cbutton class=\"icon-btn\" data-testid=\"track-hide\">\u000160\u0002\u003c/button>\u003cbutton class=\"icon-btn\" data-testid=\"track-lock\">\u000161\u0002\u003c/button>\u003c/div>\u003cdiv class=\"tl-head\" data-testid=\"track\" data-id=\"t-music\" data-kind=\"audio\">\u003cdiv class=\"name\">\u000135\u0002\u003cspan class=\"ellipsis\" data-testid=\"track-name\">Audio\u003c/span>\u003c/div>\u003cdiv class=\"track-volume\">\u003cbutton class=\"icon-btn\" data-testid=\"track-volume\">\u000163\u0002\u003c/button>\u003c/div>\u003cbutton class=\"icon-btn\" data-testid=\"track-mute\">\u000164\u0002\u003c/button>\u003cbutton class=\"icon-btn\" data-testid=\"track-lock\">\u000161\u0002\u003c/button>\u003c/div>\u003cdiv class=\"tl-head\" data-testid=\"track\" data-id=\"t-sfx\" data-kind=\"audio\">\u003cdiv class=\"name\">\u000135\u0002\u003cspan class=\"ellipsis\" data-testid=\"track-name\">Sound effects\u003c/span>\u003c/div>\u003cdiv class=\"track-volume\">\u003cbutton class=\"icon-btn\" data-testid=\"track-volume\">\u000163\u0002\u003c/button>\u003c/div>\u003cbutton class=\"icon-btn\" data-testid=\"track-mute\">\u000164\u0002\u003c/button>\u003cbutton class=\"icon-btn\" data-testid=\"track-lock\">\u000161\u0002\u003c/button>\u003c/div>\u003c/div>\u003cdiv class=\"tl-lanes tool-select\" data-testid=\"lanes\" data-tool=\"select\" style=\"width: 1881px;\">\u003cdiv class=\"tl-ruler\" data-testid=\"ruler\">\u003cdiv class=\"tick\" style=\"left: 0px;\">\u003cspan>0s\u003c/span>\u003c/div>\u003cdiv class=\"tick\" style=\"left: 120.071px;\">\u003cspan>2s\u003c/span>\u003c/div>\u003cdiv class=\"tick\" style=\"left: 240.143px;\">\u003cspan>4s\u003c/span>\u003c/div>\u003cdiv class=\"tick\" style=\"left: 360.214px;\">\u003cspan>6s\u003c/span>\u003c/div>\u003cdiv class=\"tick\" style=\"left: 480.286px;\">\u003cspan>8s\u003c/span>\u003c/div>\u003cdiv class=\"tick\" style=\"left: 600.357px;\">\u003cspan>10s\u003c/span>\u003c/div>\u003cdiv class=\"tick\" style=\"left: 720.429px;\">\u003cspan>12s\u003c/span>\u003c/div>\u003cdiv class=\"tick\" style=\"left: 840.5px;\">\u003cspan>14s\u003c/span>\u003c/div>\u003cdiv class=\"tick\" style=\"left: 960.571px;\">\u003cspan>16s\u003c/span>\u003c/div>\u003cdiv class=\"tick\" style=\"left: 1080.64px;\">\u003cspan>18s\u003c/span>\u003c/div>\u003cdiv class=\"tick\" style=\"left: 1200.71px;\">\u003cspan>20s\u003c/span>\u003c/div>\u003cdiv class=\"tick\" style=\"left: 1320.79px;\">\u003cspan>22s\u003c/span>\u003c/div>\u003cdiv class=\"tick\" style=\"left: 1440.86px;\">\u003cspan>24s\u003c/span>\u003c/div>\u003cdiv class=\"tick\" style=\"left: 1560.93px;\">\u003cspan>26s\u003c/span>\u003c/div>\u003cdiv class=\"tick\" style=\"left: 1681px;\">\u003cspan>28s\u003c/span>\u003c/div>\u003cdiv class=\"tick\" style=\"left: 1801.07px;\">\u003cspan>30s\u003c/span>\u003c/div>\u003cdiv class=\"playhead\" data-testid=\"playhead\" data-frame=\"0\" style=\"left: 0px;\">\u003cdiv class=\"playhead-handle\">\u003c/div>\u003c/div>\u003c/div>\u003cdiv class=\"tl-lane\" data-testid=\"lane\" data-track=\"t-text\">\u003cdiv class=\"clip text\" data-type=\"text\" data-testid=\"timeline-item\" data-item=\"title\" data-start=\"30\" data-duration=\"330\" style=\"left: 30.0179px; width: 328.196px;\">\u003cspan class=\"nm\">Edit videos by talking\u003c/span>\u003cspan class=\"meta\">5.5s\u003c/span>\u003cdiv class=\"edge start\" data-edge=\"start\" data-testid=\"trim-start\">\u003c/div>\u003cdiv class=\"edge end\" data-edge=\"end\" data-testid=\"trim-end\">\u003c/div>\u003c/div>\u003c/div>\u003cdiv class=\"tl-lane\" data-testid=\"lane\" data-track=\"t-gfx\">\u003cdiv class=\"clip graphic\" data-type=\"graphic\" data-testid=\"timeline-item\" data-item=\"end\" data-start=\"1320\" data-duration=\"360\" style=\"left: 1320.79px; width: 358.214px;\">\u003cspan class=\"nm\">End card\u003c/span>\u003cspan class=\"el-note\" data-testid=\"elements-none\">One block\u003c/span>\u003cspan class=\"meta\">6.0s\u003c/span>\u003cdiv class=\"edge start\" data-edge=\"start\" data-testid=\"trim-start\">\u003c/div>\u003cdiv class=\"edge end\" data-edge=\"end\" data-testid=\"trim-end\">\u003c/div>\u003c/div>\u003c/div>\u003cdiv class=\"tl-lane main\" data-testid=\"lane\" data-track=\"t-main\">\u003cdiv class=\"clip video\" data-type=\"clip\" data-testid=\"timeline-item\" data-item=\"c1\" data-start=\"0\" data-duration=\"420\" style=\"left: 0px; width: 418.25px;\">\u003cdiv class=\"strip filmstrip\" data-testid=\"filmstrip\" data-media=\"m-dji-0055\" data-ready=\"false\">\u003c/div>\u003cspan class=\"nm\">DJI 0055\u003c/span>\u003cspan class=\"meta\">7.0s\u003c/span>\u003cdiv class=\"edge start\" data-edge=\"start\" data-testid=\"trim-start\">\u003c/div>\u003cdiv class=\"edge end\" data-edge=\"end\" data-testid=\"trim-end\">\u003c/div>\u003c/div>\u003cdiv class=\"clip video\" data-type=\"clip\" data-testid=\"timeline-item\" data-item=\"c2\" data-start=\"420\" data-duration=\"420\" style=\"left: 420.25px; width: 418.25px;\">\u003cdiv class=\"strip filmstrip\" data-testid=\"filmstrip\" data-media=\"m-dji-0063\" data-ready=\"false\">\u003c/div>\u003cspan class=\"nm\">DJI 0063\u003c/span>\u003cspan class=\"meta\">7.0s\u003c/span>\u003cdiv class=\"edge start\" data-edge=\"start\" data-testid=\"trim-start\">\u003c/div>\u003cdiv class=\"edge end\" data-edge=\"end\" data-testid=\"trim-end\">\u003c/div>\u003c/div>\u003cdiv class=\"clip video\" data-type=\"clip\" data-testid=\"timeline-item\" data-item=\"c3\" data-start=\"840\" data-duration=\"360\" style=\"left: 840.5px; width: 358.214px;\">\u003cdiv class=\"strip filmstrip\" data-testid=\"filmstrip\" data-media=\"m-dji-0068\" data-ready=\"false\">\u003c/div>\u003cspan class=\"nm\">DJI 0068\u003c/span>\u003cspan class=\"meta\">6.0s\u003c/span>\u003cdiv class=\"edge start\" data-edge=\"start\" data-testid=\"trim-start\">\u003c/div>\u003cdiv class=\"edge end\" data-edge=\"end\" data-testid=\"trim-end\">\u003c/div>\u003c/div>\u003cdiv class=\"clip video\" data-type=\"clip\" data-testid=\"timeline-item\" data-item=\"c4\" data-start=\"1200\" data-duration=\"480\" style=\"left: 1200.71px; width: 478.286px;\">\u003cdiv class=\"strip filmstrip\" data-testid=\"filmstrip\" data-media=\"m-dji-0050\" data-ready=\"false\">\u003c/div>\u003cspan class=\"nm\">DJI 0050\u003c/span>\u003cspan class=\"meta\">8.0s\u003c/span>\u003cdiv class=\"edge start\" data-edge=\"start\" data-testid=\"trim-start\">\u003c/div>\u003cdiv class=\"edge end\" data-edge=\"end\" data-testid=\"trim-end\">\u003c/div>\u003c/div>\u003cdiv class=\"cut-point\" data-testid=\"cut-point\" data-item=\"c2\" data-frame=\"420\" style=\"left: 420.25px;\">\u003c/div>\u003cdiv class=\"cut-point\" data-testid=\"cut-point\" data-item=\"c3\" data-frame=\"840\" style=\"left: 840.5px;\">\u003c/div>\u003cdiv class=\"cut-point\" data-testid=\"cut-point\" data-item=\"c4\" data-frame=\"1200\" style=\"left: 1200.71px;\">\u003c/div>\u003c/div>\u003cdiv class=\"tl-lane\" data-testid=\"lane\" data-track=\"t-music\">\u003cdiv class=\"clip audio\" data-type=\"audio\" data-testid=\"timeline-item\" data-item=\"music\" data-start=\"0\" data-duration=\"1680\" style=\"left: 0px; width: 1679px;\">\u003cimg class=\"wave\" style=\";width:1677px;height:29px\" src=\"\u000165\u0002\">\u000166\u0002\u003cspan class=\"nm\">electro-dreams.mp3\u003c/span>\u003cspan class=\"meta\">28.0s\u003c/span>\u003cdiv class=\"edge start\" data-edge=\"start\" data-testid=\"trim-start\">\u003c/div>\u003cdiv class=\"edge end\" data-edge=\"end\" data-testid=\"trim-end\">\u003c/div>\u003cdiv class=\"fade-handle in\" data-fade=\"in\" data-testid=\"fade-in-handle\" style=\"left: 13px;\">\u003c/div>\u003cdiv class=\"fade-handle out\" data-fade=\"out\" data-testid=\"fade-out-handle\" style=\"right: 13px;\">\u003c/div>\u003c/div>\u003c/div>\u003cdiv class=\"tl-lane\" data-testid=\"lane\" data-track=\"t-sfx\">\u003cdiv class=\"clip audio\" data-type=\"audio\" data-testid=\"timeline-item\" data-item=\"sx1\" data-start=\"150\" data-duration=\"174\" style=\"left: 150.089px; width: 172.104px;\">\u003cimg class=\"wave\" style=\";width:170.09375px;height:29px\" src=\"\u000167\u0002\">\u000168\u0002\u003cspan class=\"nm\">Keyboard typing\u003c/span>\u003cspan class=\"meta\">2.9s\u003c/span>\u003cdiv class=\"edge start\" data-edge=\"start\" data-testid=\"trim-start\">\u003c/div>\u003cdiv class=\"edge end\" data-edge=\"end\" data-testid=\"trim-end\">\u003c/div>\u003cdiv class=\"fade-handle in\" data-fade=\"in\" data-testid=\"fade-in-handle\" style=\"left: 13px;\">\u003c/div>\u003cdiv class=\"fade-handle out\" data-fade=\"out\" data-testid=\"fade-out-handle\" style=\"right: 13px;\">\u003c/div>\u003c/div>\u003cdiv class=\"clip audio\" data-type=\"audio\" data-testid=\"timeline-item\" data-item=\"sx2\" data-start=\"360\" data-duration=\"18\" style=\"left: 360.214px; width: 16.0107px;\">\u003cimg class=\"wave\" style=\";width:14px;height:29px\" src=\"\u000169\u0002\">\u000170\u0002\u003cspan class=\"nm\">Mouse click\u003c/span>\u003cspan class=\"meta\">0.3s\u003c/span>\u003cdiv class=\"edge start\" data-edge=\"start\" data-testid=\"trim-start\">\u003c/div>\u003cdiv class=\"edge end\" data-edge=\"end\" data-testid=\"trim-end\">\u003c/div>\u003cdiv class=\"fade-handle in\" data-fade=\"in\" data-testid=\"fade-in-handle\" style=\"left: 3.01071px;\">\u003c/div>\u003cdiv class=\"fade-handle out\" data-fade=\"out\" data-testid=\"fade-out-handle\" style=\"right: 3.01071px;\">\u003c/div>\u003c/div>\u003cdiv class=\"clip audio\" data-type=\"audio\" data-testid=\"timeline-item\" data-item=\"sx3\" data-start=\"696\" data-duration=\"48\" style=\"left: 696.414px; width: 46.0286px;\">\u003cimg class=\"wave\" style=\";width:44.015625px;height:29px\" src=\"\u000171\u0002\">\u000172\u0002\u003cspan class=\"nm\">Airy whoosh\u003c/span>\u003cspan class=\"meta\">0.8s\u003c/span>\u003cdiv class=\"edge start\" data-edge=\"start\" data-testid=\"trim-start\">\u003c/div>\u003cdiv class=\"edge end\" data-edge=\"end\" data-testid=\"trim-end\">\u003c/div>\u003cdiv class=\"fade-handle in\" data-fade=\"in\" data-testid=\"fade-in-handle\" style=\"left: 13px;\">\u003c/div>\u003cdiv class=\"fade-handle out\" data-fade=\"out\" data-testid=\"fade-out-handle\" style=\"right: 13px;\">\u003c/div>\u003c/div>\u003cdiv class=\"clip audio\" data-type=\"audio\" data-testid=\"timeline-item\" data-item=\"sx4\" data-start=\"1230\" data-duration=\"18\" style=\"left: 1230.73px; width: 16.0107px;\">\u003cimg class=\"wave\" style=\";width:14px;height:29px\" src=\"\u000169\u0002\">\u000170\u0002\u003cspan class=\"nm\">Mouse click\u003c/span>\u003cspan class=\"meta\">0.3s\u003c/span>\u003cdiv class=\"edge start\" data-edge=\"start\" data-testid=\"trim-start\">\u003c/div>\u003cdiv class=\"edge end\" data-edge=\"end\" data-testid=\"trim-end\">\u003c/div>\u003cdiv class=\"fade-handle in\" data-fade=\"in\" data-testid=\"fade-in-handle\" style=\"left: 3.01071px;\">\u003c/div>\u003cdiv class=\"fade-handle out\" data-fade=\"out\" data-testid=\"fade-out-handle\" style=\"right: 3.01071px;\">\u003c/div>\u003c/div>\u003c/div>\u003c/div>\u003c/div>\u003c/div>\u003c/section>\u003cdiv class=\"resizer v resizer-lib\" data-testid=\"resize-lib\">\u003c/div>\u003cdiv class=\"resizer v resizer-side\" data-testid=\"resize-side\">\u003c/div>\u003cdiv class=\"resizer h resizer-bottom\" data-testid=\"resize-bottom\">\u003c/div>\u003c/div>","width":1920,"height":900,"ancestors":[],"backdrop":"rgb(10, 10, 10)","radius":"0px"},"topbar":{"html":"\u003cheader class=\"topbar\">\u003cdiv class=\"wordmark\" data-testid=\"wordmark\" data-busy=\"false\">\u003cspan class=\"brand wordmark-name\">\u000110\u0002\u003cspan class=\"wordmark-text\" data-testid=\"wordmark-text\">Uncut\u003c/span>\u003c/span>\u003cspan class=\"wordmark-slash\">\u003c/span>\u003cdiv class=\"project-title\" data-testid=\"project-title\">Launch film\u003c/div>\u003c/div>\u003cdiv class=\"topbar-spacer\">\u003c/div>\u003cdiv class=\"layout-toggles\">\u003cbutton class=\"icon-btn\" data-testid=\"toggle-lib\">\u000111\u0002\u003c/button>\u003cbutton class=\"icon-btn\" data-testid=\"toggle-bottom\">\u000112\u0002\u003c/button>\u003cbutton class=\"icon-btn\" data-testid=\"toggle-side\">\u000113\u0002\u003c/button>\u003cbutton class=\"icon-btn\" data-testid=\"toggle-focus\">\u000114\u0002\u003c/button>\u003c/div>\u003cdiv class=\"saved\" data-testid=\"saved\">\u000115\u0002Saved\u003c/div>\u003cbutton class=\"icon-btn\" data-testid=\"undo\">\u000116\u0002\u003c/button>\u003cbutton class=\"icon-btn\" data-testid=\"redo\" disabled=\"\">\u000117\u0002\u003c/button>\u003cbutton class=\"btn export-btn\" data-testid=\"export-button\" data-running=\"false\">\u000118\u0002Export\u003c/button>\u003cbutton class=\"icon-btn\" data-testid=\"open-settings\">\u000119\u0002\u003c/button>\u003cbutton class=\"icon-btn\" data-testid=\"close-project\">\u000120\u0002\u003c/button>\u003c/header>","width":1920,"height":40,"ancestors":[{"tag":"div","cls":"app","attrs":{},"vars":"--side-col:clamp(240px, 440px, 40vw)"}],"backdrop":"rgb(10, 10, 10)","radius":"0px"},"agent":{"html":"\u003caside class=\"side\">\u003cdiv class=\"tabs\">\u003cbutton data-testid=\"tab-inspector\">Inspector\u003c/button>\u003cbutton class=\"active\" data-testid=\"tab-agent\">Agent\u003c/button>\u003cbutton data-testid=\"tab-history\">History\u003c/button>\u003c/div>\u003cdiv class=\"side-body\">\u003cdiv class=\"agent\" data-testid=\"agent-panel\">\u003cdiv class=\"plan-strip agent-strip\" data-testid=\"agent-strip\">\u003cbutton class=\"icon-btn agent-new-chat\" data-testid=\"agent-new-chat\">\u000144\u0002\u003c/button>\u003cbutton class=\"icon-btn agent-compact\" data-testid=\"agent-compact\">\u000145\u0002\u003c/button>\u003cbutton class=\"icon-btn agent-add\" data-testid=\"agent-add\">\u000132\u0002\u003c/button>\u003cspan class=\"spacer\">\u003c/span>\u003cdiv class=\"plan-chip-wrap\" data-testid=\"agent-plan\">\u003cbutton class=\"plan-chip-btn\" data-testid=\"plan-chip\">\u000146\u0002Plan\u003cspan class=\"plan-state approved\">Planned\u003c/span>\u003c/button>\u003c/div>\u003c/div>\u003cdiv class=\"agent-thread\" data-testid=\"agent-thread\" data-ui-scroll=\"52\">\u003cdiv class=\"turn-wrap\" data-testid=\"agent-turn\" data-turn=\"turn-1\" data-status=\"done\" data-undo=\"available\">\u003cdiv class=\"msg-user\" data-testid=\"agent-prompt\">Make a 28 s launch film for Uncut on the Electro Dreams beat, the drone clips as the film being edited.\u003c/div>\u003cdiv class=\"turn done\" data-testid=\"agent-stream\">\u003cdiv class=\"worklog\">\u003cdiv class=\"step\" data-testid=\"agent-step\" data-status=\"done\" data-tool=\"graphic_write\">\u000115\u0002\u003cspan class=\"grow\">Wrote graphic film.html\u003c/span>\u003c/div>\u003c/div>\u003cdiv class=\"edit-row\" data-testid=\"agent-edit-row\">\u003cdiv class=\"step edit-step\" data-testid=\"agent-step\" data-status=\"done\" data-tool=\"edit\">\u000147\u0002\u003cspan class=\"grow\">Placed the clips on Main\u003c/span>\u000148\u0002\u003c/div>\u003c/div>\u003cdiv class=\"card-item critic-row open\" data-testid=\"agent-card\" data-type=\"review\" data-status=\"passed\" data-passed=\"true\">\u003cbutton class=\"card-head critic-head\">\u003cspan class=\"critic-icon passed\">\u00015\u0002\u003c/span>\u003cspan class=\"critic-text\">\u003cspan class=\"critic-title\">\u003cspan class=\"critic-name\">Critic, round 2\u003c/span>\u003cspan class=\"card-outcome critic-status passed\" data-testid=\"critic-status\">Passed\u003c/span>\u003c/span>\u003c/span>\u000149\u0002\u003c/button>\u003cdiv class=\"review-by small muted\" data-testid=\"agent-review-by\" data-by=\"critic\">Independent critic\u003c/div>\u003cdiv class=\"scores\" data-testid=\"agent-review-scores\">\u003cdiv class=\"score ok required\" data-testid=\"agent-review-score\" data-score=\"hook\" data-value=\"9\" data-applies=\"required\">\u003cspan class=\"score-name\">Hook in 2 s\u003c/span>\u003cspan class=\"score-bar\">\u003cspan style=\"width: 90%;\">\u003c/span>\u003c/span>\u003cspan class=\"score-value\">9\u003c/span>\u003c/div>\u003cdiv class=\"score ok required\" data-testid=\"agent-review-score\" data-score=\"readability\" data-value=\"8\" data-applies=\"required\">\u003cspan class=\"score-name\">Phone readability\u003c/span>\u003cspan class=\"score-bar\">\u003cspan style=\"width: 80%;\">\u003c/span>\u003c/span>\u003cspan class=\"score-value\">8\u003c/span>\u003c/div>\u003cdiv class=\"score ok required\" data-testid=\"agent-review-score\" data-score=\"motion\" data-value=\"9\" data-applies=\"required\">\u003cspan class=\"score-name\">Motion\u003c/span>\u003cspan class=\"score-bar\">\u003cspan style=\"width: 90%;\">\u003c/span>\u003c/span>\u003cspan class=\"score-value\">9\u003c/span>\u003c/div>\u003cdiv class=\"score ok optional\" data-testid=\"agent-review-score\" data-score=\"variety\" data-value=\"8\" data-applies=\"optional\">\u003cspan class=\"score-name\">Variety\u003cspan class=\"muted\"> (optional)\u003c/span>\u003c/span>\u003cspan class=\"score-bar\">\u003cspan style=\"width: 80%;\">\u003c/span>\u003c/span>\u003cspan class=\"score-value\">8\u003c/span>\u003c/div>\u003cdiv class=\"score ok required\" data-testid=\"agent-review-score\" data-score=\"sound\" data-value=\"9\" data-applies=\"required\">\u003cspan class=\"score-name\">Sound sync\u003c/span>\u003cspan class=\"score-bar\">\u003cspan style=\"width: 90%;\">\u003c/span>\u003c/span>\u003cspan class=\"score-value\">9\u003c/span>\u003c/div>\u003cdiv class=\"score ok optional\" data-testid=\"agent-review-score\" data-score=\"brand\" data-value=\"9\" data-applies=\"optional\">\u003cspan class=\"score-name\">Brand\u003cspan class=\"muted\"> (optional)\u003c/span>\u003c/span>\u003cspan class=\"score-bar\">\u003cspan style=\"width: 90%;\">\u003c/span>\u003c/span>\u003cspan class=\"score-value\">9\u003c/span>\u003c/div>\u003c/div>\u003c/div>\u003cdiv class=\"reply\" data-testid=\"agent-reply\">\u003cp>The film is built on the Electro Dreams beat: it opens on the claim, types your prompt, builds the timeline, floods the preview on the drop and ends on the export.\u003c/p>\u003cbutton type=\"button\" class=\"icon-btn copy-btn reply-copy\" data-testid=\"agent-copy\">\u000150\u0002\u003c/button>\u003c/div>\u003c/div>\u003cdiv class=\"turn-foot\">\u003cdiv class=\"turn-edits\" data-testid=\"agent-edits\">\u003cbutton class=\"turn-edits-label\" data-testid=\"agent-edits-toggle\">\u000147\u00022 edits\u003c/button>\u003cdiv class=\"sr-only\">\u003cdiv class=\"turn-edits-list\">\u003cdiv class=\"turn-edit\" data-testid=\"agent-edit\">\u003cdiv class=\"turn-edit-summary\">Placed the clips on Main\u003c/div>\u003cdiv class=\"turn-edit-line\">Added DJI 0055\u003c/div>\u003cdiv class=\"turn-edit-line\">Added DJI 0063\u003c/div>\u003cdiv class=\"turn-edit-line\">Added DJI 0068\u003c/div>\u003cdiv class=\"turn-edit-line\">Added DJI 0050\u003c/div>\u003c/div>\u003cdiv class=\"turn-edit\" data-testid=\"agent-edit\">\u003cdiv class=\"turn-edit-summary\">Added sound effects\u003c/div>\u003cdiv class=\"turn-edit-line\">Added Keyboard typing\u003c/div>\u003cdiv class=\"turn-edit-line\">Added Mouse click\u003c/div>\u003c/div>\u003c/div>\u003c/div>\u003c/div>\u003cspan class=\"turn-status\">Claude Code\u003c/span>\u003cspan class=\"spacer\">\u003c/span>\u003cbutton class=\"link-btn\" data-testid=\"agent-undo-turn\" data-turn=\"turn-1\">\u000116\u0002Undo\u003cspan class=\"undo-word\"> turn\u003c/span>\u003c/button>\u003c/div>\u003c/div>\u003c/div>\u003cdiv class=\"composer\" data-testid=\"composer\">\u003cdiv class=\"composer-ctx\" data-testid=\"agent-context\">\u00010\u0002\u003cspan class=\"ellipsis\">Playhead 00:00:00:00\u003c/span>\u003c/div>\u003cdiv class=\"composer-box\">\u003cdiv class=\"composer-hl\">​\u003c/div>\u003ctextarea id=\"agent-input\" data-testid=\"agent-input\" rows=\"3\" placeholder=\"Ask for an edit; @ to point at media or a clip, / for a skill or a template\">\u003c/textarea>\u003c/div>\u003cdiv class=\"composer-foot\">\u003cbutton class=\"icon-btn composer-at\" data-testid=\"agent-attach\">\u00011\u0002\u003c/button>\u003cbutton class=\"icon-btn composer-at\" data-testid=\"agent-at\">\u00012\u0002\u003c/button>\u003cdiv class=\"composer-choices\">\u003cbutton class=\"choice provider\" data-testid=\"agent-provider\" data-provider=\"claude\">\u003cspan class=\"provider-mark sm\" data-testid=\"provider-mark\" data-provider=\"claude\">\u00013\u0002\u003c/span>\u003c/button>\u003cbutton class=\"choice model\" data-testid=\"agent-model\" data-model=\"\">\u003cspan class=\"provider-wordmark\" data-testid=\"provider-wordmark\" data-provider=\"claude\">Claude\u003c/span>\u003cspan class=\"choice-label\">Default\u003c/span>\u00014\u0002\u003c/button>\u003cbutton class=\"choice\" data-testid=\"agent-effort\" data-effort=\"\">\u00015\u0002\u003cspan class=\"choice-label\">Auto\u003c/span>\u003c/button>\u003cbutton class=\"choice\" data-testid=\"agent-access\" data-access=\"auto\">\u00016\u0002\u003cspan class=\"choice-label\">Auto\u003c/span>\u003c/button>\u003c/div>\u003cspan class=\"composer-spacer\">\u003c/span>\u003cbutton class=\"send\" data-testid=\"agent-send\" disabled=\"\">\u00017\u0002\u003c/button>\u003c/div>\u003c/div>\u003c/div>\u003c/div>\u003c/aside>","width":440,"height":590,"ancestors":[{"tag":"div","cls":"app","attrs":{},"vars":"--side-col:clamp(240px, 440px, 40vw)"}]},"message":{"html":"\u003cdiv class=\"msg-user\" data-testid=\"agent-prompt\">Make a 28 s launch film for Uncut on the Electro Dreams beat, the drone clips as the film being edited.\u003c/div>","width":352,"height":50,"ancestors":[{"tag":"div","cls":"app","attrs":{},"vars":"--side-col:clamp(240px, 440px, 40vw)"},{"tag":"aside","cls":"side","attrs":{},"vars":""},{"tag":"div","cls":"side-body","attrs":{},"vars":""},{"tag":"div","cls":"agent","attrs":{},"vars":""},{"tag":"div","cls":"agent-thread","attrs":{},"vars":""},{"tag":"div","cls":"turn-wrap","attrs":{"data-turn":"turn-1","data-status":"done","data-undo":"available"},"vars":""}]},"turn":{"html":"\u003cdiv class=\"turn done\" data-testid=\"agent-stream\">\u003cdiv class=\"worklog\">\u003cdiv class=\"step\" data-testid=\"agent-step\" data-status=\"done\" data-tool=\"graphic_write\">\u000115\u0002\u003cspan class=\"grow\">Wrote graphic film.html\u003c/span>\u003c/div>\u003c/div>\u003cdiv class=\"edit-row\" data-testid=\"agent-edit-row\">\u003cdiv class=\"step edit-step\" data-testid=\"agent-step\" data-status=\"done\" data-tool=\"edit\">\u000147\u0002\u003cspan class=\"grow\">Placed the clips on Main\u003c/span>\u000148\u0002\u003c/div>\u003c/div>\u003cdiv class=\"card-item critic-row open\" data-testid=\"agent-card\" data-type=\"review\" data-status=\"passed\" data-passed=\"true\">\u003cbutton class=\"card-head critic-head\">\u003cspan class=\"critic-icon passed\">\u00015\u0002\u003c/span>\u003cspan class=\"critic-text\">\u003cspan class=\"critic-title\">\u003cspan class=\"critic-name\">Critic, round 2\u003c/span>\u003cspan class=\"card-outcome critic-status passed\" data-testid=\"critic-status\">Passed\u003c/span>\u003c/span>\u003c/span>\u000149\u0002\u003c/button>\u003cdiv class=\"review-by small muted\" data-testid=\"agent-review-by\" data-by=\"critic\">Independent critic\u003c/div>\u003cdiv class=\"scores\" data-testid=\"agent-review-scores\">\u003cdiv class=\"score ok required\" data-testid=\"agent-review-score\" data-score=\"hook\" data-value=\"9\" data-applies=\"required\">\u003cspan class=\"score-name\">Hook in 2 s\u003c/span>\u003cspan class=\"score-bar\">\u003cspan style=\"width: 90%;\">\u003c/span>\u003c/span>\u003cspan class=\"score-value\">9\u003c/span>\u003c/div>\u003cdiv class=\"score ok required\" data-testid=\"agent-review-score\" data-score=\"readability\" data-value=\"8\" data-applies=\"required\">\u003cspan class=\"score-name\">Phone readability\u003c/span>\u003cspan class=\"score-bar\">\u003cspan style=\"width: 80%;\">\u003c/span>\u003c/span>\u003cspan class=\"score-value\">8\u003c/span>\u003c/div>\u003cdiv class=\"score ok required\" data-testid=\"agent-review-score\" data-score=\"motion\" data-value=\"9\" data-applies=\"required\">\u003cspan class=\"score-name\">Motion\u003c/span>\u003cspan class=\"score-bar\">\u003cspan style=\"width: 90%;\">\u003c/span>\u003c/span>\u003cspan class=\"score-value\">9\u003c/span>\u003c/div>\u003cdiv class=\"score ok optional\" data-testid=\"agent-review-score\" data-score=\"variety\" data-value=\"8\" data-applies=\"optional\">\u003cspan class=\"score-name\">Variety\u003cspan class=\"muted\"> (optional)\u003c/span>\u003c/span>\u003cspan class=\"score-bar\">\u003cspan style=\"width: 80%;\">\u003c/span>\u003c/span>\u003cspan class=\"score-value\">8\u003c/span>\u003c/div>\u003cdiv class=\"score ok required\" data-testid=\"agent-review-score\" data-score=\"sound\" data-value=\"9\" data-applies=\"required\">\u003cspan class=\"score-name\">Sound sync\u003c/span>\u003cspan class=\"score-bar\">\u003cspan style=\"width: 90%;\">\u003c/span>\u003c/span>\u003cspan class=\"score-value\">9\u003c/span>\u003c/div>\u003cdiv class=\"score ok optional\" data-testid=\"agent-review-score\" data-score=\"brand\" data-value=\"9\" data-applies=\"optional\">\u003cspan class=\"score-name\">Brand\u003cspan class=\"muted\"> (optional)\u003c/span>\u003c/span>\u003cspan class=\"score-bar\">\u003cspan style=\"width: 90%;\">\u003c/span>\u003c/span>\u003cspan class=\"score-value\">9\u003c/span>\u003c/div>\u003c/div>\u003c/div>\u003cdiv class=\"reply\" data-testid=\"agent-reply\">\u003cp>The film is built on the Electro Dreams beat: it opens on the claim, types your prompt, builds the timeline, floods the preview on the drop and ends on the export.\u003c/p>\u003cbutton type=\"button\" class=\"icon-btn copy-btn reply-copy\" data-testid=\"agent-copy\">\u000150\u0002\u003c/button>\u003c/div>\u003c/div>","width":400,"height":310,"ancestors":[{"tag":"div","cls":"app","attrs":{},"vars":"--side-col:clamp(240px, 440px, 40vw)"},{"tag":"aside","cls":"side","attrs":{},"vars":""},{"tag":"div","cls":"side-body","attrs":{},"vars":""},{"tag":"div","cls":"agent","attrs":{},"vars":""},{"tag":"div","cls":"agent-thread","attrs":{},"vars":""},{"tag":"div","cls":"turn-wrap","attrs":{"data-turn":"turn-1","data-status":"done","data-undo":"available"},"vars":""}],"backdrop":"rgb(17, 17, 17)","radius":"0px"},"review":{"html":"\u003cdiv class=\"card-item critic-row open\" data-testid=\"agent-card\" data-type=\"review\" data-status=\"passed\" data-passed=\"true\">\u003cbutton class=\"card-head critic-head\">\u003cspan class=\"critic-icon passed\">\u00015\u0002\u003c/span>\u003cspan class=\"critic-text\">\u003cspan class=\"critic-title\">\u003cspan class=\"critic-name\">Critic, round 2\u003c/span>\u003cspan class=\"card-outcome critic-status passed\" data-testid=\"critic-status\">Passed\u003c/span>\u003c/span>\u003c/span>\u000149\u0002\u003c/button>\u003cdiv class=\"review-by small muted\" data-testid=\"agent-review-by\" data-by=\"critic\">Independent critic\u003c/div>\u003cdiv class=\"scores\" data-testid=\"agent-review-scores\">\u003cdiv class=\"score ok required\" data-testid=\"agent-review-score\" data-score=\"hook\" data-value=\"9\" data-applies=\"required\">\u003cspan class=\"score-name\">Hook in 2 s\u003c/span>\u003cspan class=\"score-bar\">\u003cspan style=\"width: 90%;\">\u003c/span>\u003c/span>\u003cspan class=\"score-value\">9\u003c/span>\u003c/div>\u003cdiv class=\"score ok required\" data-testid=\"agent-review-score\" data-score=\"readability\" data-value=\"8\" data-applies=\"required\">\u003cspan class=\"score-name\">Phone readability\u003c/span>\u003cspan class=\"score-bar\">\u003cspan style=\"width: 80%;\">\u003c/span>\u003c/span>\u003cspan class=\"score-value\">8\u003c/span>\u003c/div>\u003cdiv class=\"score ok required\" data-testid=\"agent-review-score\" data-score=\"motion\" data-value=\"9\" data-applies=\"required\">\u003cspan class=\"score-name\">Motion\u003c/span>\u003cspan class=\"score-bar\">\u003cspan style=\"width: 90%;\">\u003c/span>\u003c/span>\u003cspan class=\"score-value\">9\u003c/span>\u003c/div>\u003cdiv class=\"score ok optional\" data-testid=\"agent-review-score\" data-score=\"variety\" data-value=\"8\" data-applies=\"optional\">\u003cspan class=\"score-name\">Variety\u003cspan class=\"muted\"> (optional)\u003c/span>\u003c/span>\u003cspan class=\"score-bar\">\u003cspan style=\"width: 80%;\">\u003c/span>\u003c/span>\u003cspan class=\"score-value\">8\u003c/span>\u003c/div>\u003cdiv class=\"score ok required\" data-testid=\"agent-review-score\" data-score=\"sound\" data-value=\"9\" data-applies=\"required\">\u003cspan class=\"score-name\">Sound sync\u003c/span>\u003cspan class=\"score-bar\">\u003cspan style=\"width: 90%;\">\u003c/span>\u003c/span>\u003cspan class=\"score-value\">9\u003c/span>\u003c/div>\u003cdiv class=\"score ok optional\" data-testid=\"agent-review-score\" data-score=\"brand\" data-value=\"9\" data-applies=\"optional\">\u003cspan class=\"score-name\">Brand\u003cspan class=\"muted\"> (optional)\u003c/span>\u003c/span>\u003cspan class=\"score-bar\">\u003cspan style=\"width: 90%;\">\u003c/span>\u003c/span>\u003cspan class=\"score-value\">9\u003c/span>\u003c/div>\u003c/div>\u003c/div>","width":400,"height":185,"ancestors":[{"tag":"div","cls":"app","attrs":{},"vars":"--side-col:clamp(240px, 440px, 40vw)"},{"tag":"aside","cls":"side","attrs":{},"vars":""},{"tag":"div","cls":"side-body","attrs":{},"vars":""},{"tag":"div","cls":"agent","attrs":{},"vars":""},{"tag":"div","cls":"agent-thread","attrs":{},"vars":""},{"tag":"div","cls":"turn-wrap","attrs":{"data-turn":"turn-1","data-status":"done","data-undo":"available"},"vars":""},{"tag":"div","cls":"turn done","attrs":{},"vars":""}]},"timeline":{"html":"\u003csection class=\"bottom\">\u003cdiv class=\"bottom-toolbar\">\u003cdiv class=\"seg\" data-testid=\"bottom-tabs\">\u003cbutton class=\"active\" data-testid=\"bottom-timeline\">Timeline\u003c/button>\u003cbutton data-testid=\"bottom-mixer\">Mixer\u003c/button>\u003c/div>\u003cspan class=\"muted small\">5 tracks\u003c/span>\u003cdiv class=\"toolbar-spacer\">\u003c/div>\u003cdiv class=\"tool-picker\" data-testid=\"tool-picker\">\u003cbutton class=\"icon-btn on\" data-testid=\"tool-select\">\u00010\u0002\u003c/button>\u003cbutton class=\"icon-btn\" data-testid=\"tool-blade\">\u000151\u0002\u003c/button>\u003cbutton class=\"icon-btn\" data-testid=\"tool-hand\">\u000142\u0002\u003c/button>\u003c/div>\u003cdiv class=\"toolbar-sep\">\u003c/div>\u003cbutton class=\"icon-btn\" data-testid=\"split\">\u000152\u0002\u003c/button>\u003cbutton class=\"icon-btn\" data-testid=\"delete-item\" disabled=\"\">\u000153\u0002\u003c/button>\u003cbutton class=\"icon-btn on\" data-testid=\"snap-toggle\">\u000154\u0002\u003c/button>\u003cbutton class=\"icon-btn on\" data-testid=\"skim-toggle\">\u000155\u0002\u003c/button>\u003cbutton class=\"icon-btn on\" data-testid=\"link-overlays\">\u000156\u0002\u003c/button>\u003cdiv class=\"toolbar-sep\">\u003c/div>\u003cbutton class=\"icon-btn\" data-testid=\"zoom-out\">\u000157\u0002\u003c/button>\u003cbutton class=\"icon-btn\" data-testid=\"zoom-in\">\u000158\u0002\u003c/button>\u003cbutton class=\"icon-btn\" data-testid=\"zoom-fit\">\u000159\u0002\u003c/button>\u003c/div>\u003cdiv class=\"bottom-body\">\u003cdiv class=\"tl\" data-testid=\"timeline\" data-ppf=\"1.000595238095238\" data-zoom=\"1\" style=\"--tl-view-h: 216px;\">\u003cdiv class=\"tl-heads\" data-testid=\"track-heads\">\u003cdiv class=\"tl-corner\">\u003c/div>\u003cdiv class=\"tl-head\" data-testid=\"track\" data-id=\"t-text\" data-kind=\"text\">\u003cdiv class=\"name\">\u000123\u0002\u003cspan class=\"ellipsis\" data-testid=\"track-name\">Text\u003c/span>\u003c/div>\u003cbutton class=\"icon-btn\" data-testid=\"track-hide\">\u000160\u0002\u003c/button>\u003cbutton class=\"icon-btn\" data-testid=\"track-lock\">\u000161\u0002\u003c/button>\u003c/div>\u003cdiv class=\"tl-head\" data-testid=\"track\" data-id=\"t-gfx\" data-kind=\"video\">\u003cdiv class=\"name\">\u000162\u0002\u003cspan class=\"ellipsis\" data-testid=\"track-name\">Graphics\u003c/span>\u003c/div>\u003cbutton class=\"icon-btn\" data-testid=\"track-hide\">\u000160\u0002\u003c/button>\u003cbutton class=\"icon-btn\" data-testid=\"track-lock\">\u000161\u0002\u003c/button>\u003c/div>\u003cdiv class=\"tl-head main\" data-testid=\"track\" data-id=\"t-main\" data-kind=\"video\" data-main=\"true\">\u003cdiv class=\"name\">\u000121\u0002\u003cspan class=\"ellipsis\" data-testid=\"track-name\">Main\u003c/span>\u003cspan class=\"badge\">\u000154\u0002\u003c/span>\u003c/div>\u003cbutton class=\"icon-btn\" data-testid=\"track-hide\">\u000160\u0002\u003c/button>\u003cbutton class=\"icon-btn\" data-testid=\"track-lock\">\u000161\u0002\u003c/button>\u003c/div>\u003cdiv class=\"tl-head\" data-testid=\"track\" data-id=\"t-music\" data-kind=\"audio\">\u003cdiv class=\"name\">\u000135\u0002\u003cspan class=\"ellipsis\" data-testid=\"track-name\">Audio\u003c/span>\u003c/div>\u003cdiv class=\"track-volume\">\u003cbutton class=\"icon-btn\" data-testid=\"track-volume\">\u000163\u0002\u003c/button>\u003c/div>\u003cbutton class=\"icon-btn\" data-testid=\"track-mute\">\u000164\u0002\u003c/button>\u003cbutton class=\"icon-btn\" data-testid=\"track-lock\">\u000161\u0002\u003c/button>\u003c/div>\u003cdiv class=\"tl-head\" data-testid=\"track\" data-id=\"t-sfx\" data-kind=\"audio\">\u003cdiv class=\"name\">\u000135\u0002\u003cspan class=\"ellipsis\" data-testid=\"track-name\">Sound effects\u003c/span>\u003c/div>\u003cdiv class=\"track-volume\">\u003cbutton class=\"icon-btn\" data-testid=\"track-volume\">\u000163\u0002\u003c/button>\u003c/div>\u003cbutton class=\"icon-btn\" data-testid=\"track-mute\">\u000164\u0002\u003c/button>\u003cbutton class=\"icon-btn\" data-testid=\"track-lock\">\u000161\u0002\u003c/button>\u003c/div>\u003c/div>\u003cdiv class=\"tl-lanes tool-select\" data-testid=\"lanes\" data-tool=\"select\" style=\"width: 1881px;\">\u003cdiv class=\"tl-ruler\" data-testid=\"ruler\">\u003cdiv class=\"tick\" style=\"left: 0px;\">\u003cspan>0s\u003c/span>\u003c/div>\u003cdiv class=\"tick\" style=\"left: 120.071px;\">\u003cspan>2s\u003c/span>\u003c/div>\u003cdiv class=\"tick\" style=\"left: 240.143px;\">\u003cspan>4s\u003c/span>\u003c/div>\u003cdiv class=\"tick\" style=\"left: 360.214px;\">\u003cspan>6s\u003c/span>\u003c/div>\u003cdiv class=\"tick\" style=\"left: 480.286px;\">\u003cspan>8s\u003c/span>\u003c/div>\u003cdiv class=\"tick\" style=\"left: 600.357px;\">\u003cspan>10s\u003c/span>\u003c/div>\u003cdiv class=\"tick\" style=\"left: 720.429px;\">\u003cspan>12s\u003c/span>\u003c/div>\u003cdiv class=\"tick\" style=\"left: 840.5px;\">\u003cspan>14s\u003c/span>\u003c/div>\u003cdiv class=\"tick\" style=\"left: 960.571px;\">\u003cspan>16s\u003c/span>\u003c/div>\u003cdiv class=\"tick\" style=\"left: 1080.64px;\">\u003cspan>18s\u003c/span>\u003c/div>\u003cdiv class=\"tick\" style=\"left: 1200.71px;\">\u003cspan>20s\u003c/span>\u003c/div>\u003cdiv class=\"tick\" style=\"left: 1320.79px;\">\u003cspan>22s\u003c/span>\u003c/div>\u003cdiv class=\"tick\" style=\"left: 1440.86px;\">\u003cspan>24s\u003c/span>\u003c/div>\u003cdiv class=\"tick\" style=\"left: 1560.93px;\">\u003cspan>26s\u003c/span>\u003c/div>\u003cdiv class=\"tick\" style=\"left: 1681px;\">\u003cspan>28s\u003c/span>\u003c/div>\u003cdiv class=\"tick\" style=\"left: 1801.07px;\">\u003cspan>30s\u003c/span>\u003c/div>\u003cdiv class=\"playhead\" data-testid=\"playhead\" data-frame=\"0\" style=\"left: 0px;\">\u003cdiv class=\"playhead-handle\">\u003c/div>\u003c/div>\u003c/div>\u003cdiv class=\"tl-lane\" data-testid=\"lane\" data-track=\"t-text\">\u003cdiv class=\"clip text\" data-type=\"text\" data-testid=\"timeline-item\" data-item=\"title\" data-start=\"30\" data-duration=\"330\" style=\"left: 30.0179px; width: 328.196px;\">\u003cspan class=\"nm\">Edit videos by talking\u003c/span>\u003cspan class=\"meta\">5.5s\u003c/span>\u003cdiv class=\"edge start\" data-edge=\"start\" data-testid=\"trim-start\">\u003c/div>\u003cdiv class=\"edge end\" data-edge=\"end\" data-testid=\"trim-end\">\u003c/div>\u003c/div>\u003c/div>\u003cdiv class=\"tl-lane\" data-testid=\"lane\" data-track=\"t-gfx\">\u003cdiv class=\"clip graphic\" data-type=\"graphic\" data-testid=\"timeline-item\" data-item=\"end\" data-start=\"1320\" data-duration=\"360\" style=\"left: 1320.79px; width: 358.214px;\">\u003cspan class=\"nm\">End card\u003c/span>\u003cspan class=\"el-note\" data-testid=\"elements-none\">One block\u003c/span>\u003cspan class=\"meta\">6.0s\u003c/span>\u003cdiv class=\"edge start\" data-edge=\"start\" data-testid=\"trim-start\">\u003c/div>\u003cdiv class=\"edge end\" data-edge=\"end\" data-testid=\"trim-end\">\u003c/div>\u003c/div>\u003c/div>\u003cdiv class=\"tl-lane main\" data-testid=\"lane\" data-track=\"t-main\">\u003cdiv class=\"clip video\" data-type=\"clip\" data-testid=\"timeline-item\" data-item=\"c1\" data-start=\"0\" data-duration=\"420\" style=\"left: 0px; width: 418.25px;\">\u003cdiv class=\"strip filmstrip\" data-testid=\"filmstrip\" data-media=\"m-dji-0055\" data-ready=\"false\">\u003c/div>\u003cspan class=\"nm\">DJI 0055\u003c/span>\u003cspan class=\"meta\">7.0s\u003c/span>\u003cdiv class=\"edge start\" data-edge=\"start\" data-testid=\"trim-start\">\u003c/div>\u003cdiv class=\"edge end\" data-edge=\"end\" data-testid=\"trim-end\">\u003c/div>\u003c/div>\u003cdiv class=\"clip video\" data-type=\"clip\" data-testid=\"timeline-item\" data-item=\"c2\" data-start=\"420\" data-duration=\"420\" style=\"left: 420.25px; width: 418.25px;\">\u003cdiv class=\"strip filmstrip\" data-testid=\"filmstrip\" data-media=\"m-dji-0063\" data-ready=\"false\">\u003c/div>\u003cspan class=\"nm\">DJI 0063\u003c/span>\u003cspan class=\"meta\">7.0s\u003c/span>\u003cdiv class=\"edge start\" data-edge=\"start\" data-testid=\"trim-start\">\u003c/div>\u003cdiv class=\"edge end\" data-edge=\"end\" data-testid=\"trim-end\">\u003c/div>\u003c/div>\u003cdiv class=\"clip video\" data-type=\"clip\" data-testid=\"timeline-item\" data-item=\"c3\" data-start=\"840\" data-duration=\"360\" style=\"left: 840.5px; width: 358.214px;\">\u003cdiv class=\"strip filmstrip\" data-testid=\"filmstrip\" data-media=\"m-dji-0068\" data-ready=\"false\">\u003c/div>\u003cspan class=\"nm\">DJI 0068\u003c/span>\u003cspan class=\"meta\">6.0s\u003c/span>\u003cdiv class=\"edge start\" data-edge=\"start\" data-testid=\"trim-start\">\u003c/div>\u003cdiv class=\"edge end\" data-edge=\"end\" data-testid=\"trim-end\">\u003c/div>\u003c/div>\u003cdiv class=\"clip video\" data-type=\"clip\" data-testid=\"timeline-item\" data-item=\"c4\" data-start=\"1200\" data-duration=\"480\" style=\"left: 1200.71px; width: 478.286px;\">\u003cdiv class=\"strip filmstrip\" data-testid=\"filmstrip\" data-media=\"m-dji-0050\" data-ready=\"false\">\u003c/div>\u003cspan class=\"nm\">DJI 0050\u003c/span>\u003cspan class=\"meta\">8.0s\u003c/span>\u003cdiv class=\"edge start\" data-edge=\"start\" data-testid=\"trim-start\">\u003c/div>\u003cdiv class=\"edge end\" data-edge=\"end\" data-testid=\"trim-end\">\u003c/div>\u003c/div>\u003cdiv class=\"cut-point\" data-testid=\"cut-point\" data-item=\"c2\" data-frame=\"420\" style=\"left: 420.25px;\">\u003c/div>\u003cdiv class=\"cut-point\" data-testid=\"cut-point\" data-item=\"c3\" data-frame=\"840\" style=\"left: 840.5px;\">\u003c/div>\u003cdiv class=\"cut-point\" data-testid=\"cut-point\" data-item=\"c4\" data-frame=\"1200\" style=\"left: 1200.71px;\">\u003c/div>\u003c/div>\u003cdiv class=\"tl-lane\" data-testid=\"lane\" data-track=\"t-music\">\u003cdiv class=\"clip audio\" data-type=\"audio\" data-testid=\"timeline-item\" data-item=\"music\" data-start=\"0\" data-duration=\"1680\" style=\"left: 0px; width: 1679px;\">\u003cimg class=\"wave\" style=\";width:1677px;height:29px\" src=\"\u000165\u0002\">\u000166\u0002\u003cspan class=\"nm\">electro-dreams.mp3\u003c/span>\u003cspan class=\"meta\">28.0s\u003c/span>\u003cdiv class=\"edge start\" data-edge=\"start\" data-testid=\"trim-start\">\u003c/div>\u003cdiv class=\"edge end\" data-edge=\"end\" data-testid=\"trim-end\">\u003c/div>\u003cdiv class=\"fade-handle in\" data-fade=\"in\" data-testid=\"fade-in-handle\" style=\"left: 13px;\">\u003c/div>\u003cdiv class=\"fade-handle out\" data-fade=\"out\" data-testid=\"fade-out-handle\" style=\"right: 13px;\">\u003c/div>\u003c/div>\u003c/div>\u003cdiv class=\"tl-lane\" data-testid=\"lane\" data-track=\"t-sfx\">\u003cdiv class=\"clip audio\" data-type=\"audio\" data-testid=\"timeline-item\" data-item=\"sx1\" data-start=\"150\" data-duration=\"174\" style=\"left: 150.089px; width: 172.104px;\">\u003cimg class=\"wave\" style=\";width:170.09375px;height:29px\" src=\"\u000167\u0002\">\u000168\u0002\u003cspan class=\"nm\">Keyboard typing\u003c/span>\u003cspan class=\"meta\">2.9s\u003c/span>\u003cdiv class=\"edge start\" data-edge=\"start\" data-testid=\"trim-start\">\u003c/div>\u003cdiv class=\"edge end\" data-edge=\"end\" data-testid=\"trim-end\">\u003c/div>\u003cdiv class=\"fade-handle in\" data-fade=\"in\" data-testid=\"fade-in-handle\" style=\"left: 13px;\">\u003c/div>\u003cdiv class=\"fade-handle out\" data-fade=\"out\" data-testid=\"fade-out-handle\" style=\"right: 13px;\">\u003c/div>\u003c/div>\u003cdiv class=\"clip audio\" data-type=\"audio\" data-testid=\"timeline-item\" data-item=\"sx2\" data-start=\"360\" data-duration=\"18\" style=\"left: 360.214px; width: 16.0107px;\">\u003cimg class=\"wave\" style=\";width:14px;height:29px\" src=\"\u000169\u0002\">\u000170\u0002\u003cspan class=\"nm\">Mouse click\u003c/span>\u003cspan class=\"meta\">0.3s\u003c/span>\u003cdiv class=\"edge start\" data-edge=\"start\" data-testid=\"trim-start\">\u003c/div>\u003cdiv class=\"edge end\" data-edge=\"end\" data-testid=\"trim-end\">\u003c/div>\u003cdiv class=\"fade-handle in\" data-fade=\"in\" data-testid=\"fade-in-handle\" style=\"left: 3.01071px;\">\u003c/div>\u003cdiv class=\"fade-handle out\" data-fade=\"out\" data-testid=\"fade-out-handle\" style=\"right: 3.01071px;\">\u003c/div>\u003c/div>\u003cdiv class=\"clip audio\" data-type=\"audio\" data-testid=\"timeline-item\" data-item=\"sx3\" data-start=\"696\" data-duration=\"48\" style=\"left: 696.414px; width: 46.0286px;\">\u003cimg class=\"wave\" style=\";width:44.015625px;height:29px\" src=\"\u000171\u0002\">\u000172\u0002\u003cspan class=\"nm\">Airy whoosh\u003c/span>\u003cspan class=\"meta\">0.8s\u003c/span>\u003cdiv class=\"edge start\" data-edge=\"start\" data-testid=\"trim-start\">\u003c/div>\u003cdiv class=\"edge end\" data-edge=\"end\" data-testid=\"trim-end\">\u003c/div>\u003cdiv class=\"fade-handle in\" data-fade=\"in\" data-testid=\"fade-in-handle\" style=\"left: 13px;\">\u003c/div>\u003cdiv class=\"fade-handle out\" data-fade=\"out\" data-testid=\"fade-out-handle\" style=\"right: 13px;\">\u003c/div>\u003c/div>\u003cdiv class=\"clip audio\" data-type=\"audio\" data-testid=\"timeline-item\" data-item=\"sx4\" data-start=\"1230\" data-duration=\"18\" style=\"left: 1230.73px; width: 16.0107px;\">\u003cimg class=\"wave\" style=\";width:14px;height:29px\" src=\"\u000169\u0002\">\u000170\u0002\u003cspan class=\"nm\">Mouse click\u003c/span>\u003cspan class=\"meta\">0.3s\u003c/span>\u003cdiv class=\"edge start\" data-edge=\"start\" data-testid=\"trim-start\">\u003c/div>\u003cdiv class=\"edge end\" data-edge=\"end\" data-testid=\"trim-end\">\u003c/div>\u003cdiv class=\"fade-handle in\" data-fade=\"in\" data-testid=\"fade-in-handle\" style=\"left: 3.01071px;\">\u003c/div>\u003cdiv class=\"fade-handle out\" data-fade=\"out\" data-testid=\"fade-out-handle\" style=\"right: 3.01071px;\">\u003c/div>\u003c/div>\u003c/div>\u003c/div>\u003c/div>\u003c/div>\u003c/section>","width":1920,"height":270,"ancestors":[{"tag":"div","cls":"app","attrs":{},"vars":"--side-col:clamp(240px, 440px, 40vw)"}],"pxPerSecond":59.75,"laneLeft":184},"preview":{"html":"\u003cmain class=\"stage\" data-testid=\"stage\">\u003cdiv class=\"stage-canvas\" data-testid=\"stage-canvas\" data-zoom=\"fit\">\u003cdiv class=\"frame\" data-testid=\"preview-frame\" data-frame=\"0\" data-playing=\"false\" style=\"width: 411px; height: 514px; background: rgb(0, 0, 0);\">\u003c/div>\u003c/div>\u003cdiv class=\"transport\">\u003cspan class=\"timecode\" data-testid=\"timecode\">00:00:00:00\u003cspan class=\"tc-end\"> / 00:00:28:00\u003c/span>\u003c/span>\u003cdiv class=\"transport-mid\">\u003cbutton class=\"icon-btn tp-jump\" data-testid=\"to-start\" disabled=\"\">\u000136\u0002\u003c/button>\u003cbutton class=\"icon-btn tp-step\" data-testid=\"step-back\" disabled=\"\">\u000137\u0002\u003c/button>\u003cbutton class=\"icon-btn play\" data-testid=\"play\">\u000138\u0002\u003c/button>\u003cbutton class=\"icon-btn tp-step\" data-testid=\"step-forward\">\u000139\u0002\u003c/button>\u003cbutton class=\"icon-btn tp-jump\" data-testid=\"to-end\">\u000140\u0002\u003c/button>\u003c/div>\u003cspan class=\"muted small\" data-testid=\"canvas-info\">1080×1350\u003cspan class=\"canvas-fps\">, 60 fps\u003c/span>\u003c/span>\u003cselect class=\"zoom-select\" data-testid=\"preview-zoom\">\u003coption value=\"fit\">Fit\u003c/option>\u003coption value=\"0.5\">50%\u003c/option>\u003coption value=\"1\">100%\u003c/option>\u003coption value=\"2\">200%\u003c/option>\u003c/select>\u003cbutton class=\"icon-btn tp-region\" data-testid=\"preview-region\">\u000141\u0002\u003c/button>\u003cbutton class=\"icon-btn tp-hand\" data-testid=\"preview-hand\">\u000142\u0002\u003c/button>\u003cbutton class=\"icon-btn\" data-testid=\"preview-fullscreen\">\u000143\u0002\u003c/button>\u003c/div>\u003c/main>","width":1152,"height":590,"ancestors":[{"tag":"div","cls":"app","attrs":{},"vars":"--side-col:clamp(240px, 440px, 40vw)"}],"backdrop":"rgb(10, 10, 10)","radius":"0px"},"export":{"html":"\u003cdiv class=\"modal wiz\">\u003cdiv class=\"wiz-panel\">\u003cdiv class=\"export-head\">\u003ch1>Export video\u003c/h1>\u003cbutton class=\"icon-btn\" data-testid=\"export-close\">\u000120\u0002\u003c/button>\u003c/div>\u003cform data-testid=\"export-form\">\u003cdiv class=\"wiz-cards\">\u003cbutton type=\"button\" class=\"wiz-card\" data-testid=\"quality-draft\" data-active=\"false\" data-codec=\"h264\">Draft\u003cspan>720×900, 60 fps\u003c/span>\u003cspan data-testid=\"quality-codec-draft\">H.264, hardware\u003c/span>\u003cspan>Fast, for a quick look\u003c/span>\u003c/button>\u003cbutton type=\"button\" class=\"wiz-card active\" data-testid=\"quality-standard\" data-active=\"true\" data-codec=\"h264\">Standard\u003cspan>1080×1350, 60 fps\u003c/span>\u003cspan data-testid=\"quality-codec-standard\">H.264, hardware\u003c/span>\u003cspan>For sharing anywhere\u003c/span>\u003c/button>\u003cbutton type=\"button\" class=\"wiz-card\" data-testid=\"quality-high\" data-active=\"false\" data-codec=\"h264\">High\u003cspan>1080×1350, 60 fps\u003c/span>\u003cspan data-testid=\"quality-codec-high\">H.264, software\u003c/span>\u003cspan>Full size, the best copy\u003c/span>\u003c/button>\u003c/div>\u003cbutton type=\"button\" class=\"export-advanced-toggle\" data-testid=\"export-advanced\">\u000173\u0002Advanced\u003c/button>\u003cdiv class=\"wiz-list form-fields export-fields\">\u003clabel class=\"wiz-field\">\u003cspan>File\u003c/span>\u003cinput data-testid=\"export-name\" value=\"Launch film.mp4\">\u003c/label>\u003cdiv class=\"wiz-field\">\u003cspan>Folder\u003c/span>\u003cb class=\"ellipsis\" data-testid=\"export-folder\">~/Movies\u003c/b>\u003cbutton type=\"button\" class=\"btn ghost\" data-testid=\"export-change\">Change…\u003c/button>\u003c/div>\u003c/div>\u003cdiv class=\"group-label export-label\">Range\u003c/div>\u003cdiv class=\"seg export-range\" data-testid=\"export-range\">\u003cbutton type=\"button\" class=\"active\" data-testid=\"export-range-all\">Whole timeline\u003c/button>\u003cbutton type=\"button\" data-testid=\"export-range-marks\" disabled=\"\">In to Out\u003c/button>\u003cbutton type=\"button\" data-testid=\"export-range-selection\" disabled=\"\">Selected clips\u003c/button>\u003cbutton type=\"button\" data-testid=\"export-range-custom\">Custom\u003c/button>\u003c/div>\u003cp class=\"wiz-meta\" data-testid=\"export-range-text\" data-from=\"0\" data-to=\"1680\">00:00:00:00 to 00:00:28:00, 28.0 s\u003c/p>\u003cdiv class=\"group-label export-label\">Loudness\u003c/div>\u003cdiv class=\"wiz-cards four\">\u003cbutton type=\"button\" class=\"wiz-card active\" data-testid=\"loudness-normal\" data-active=\"true\">Normal\u003cspan>−14 LUFS\u003c/span>\u003c/button>\u003cbutton type=\"button\" class=\"wiz-card\" data-testid=\"loudness-quiet\" data-active=\"false\">Quieter\u003cspan>−16 LUFS\u003c/span>\u003c/button>\u003cbutton type=\"button\" class=\"wiz-card\" data-testid=\"loudness-broadcast\" data-active=\"false\">Broadcast\u003cspan>−23 LUFS\u003c/span>\u003c/button>\u003cbutton type=\"button\" class=\"wiz-card\" data-testid=\"loudness-off\" data-active=\"false\">As mixed\u003cspan>No change\u003c/span>\u003c/button>\u003c/div>\u003cp class=\"wiz-meta\" data-testid=\"loudness-hint\">Evens out the volume so it plays as loud as other videos on YouTube, Instagram and TikTok. Peaks stay under −1 dBTP (the master limiter).\u003c/p>\u003cdiv class=\"group-label export-label\">Motion\u003c/div>\u003cdiv class=\"export-subs\" data-testid=\"export-motion\">\u003clabel class=\"export-sub-row\">\u003cinput data-testid=\"export-motion-blur\" type=\"checkbox\" checked=\"\">\u003cspan>Motion blur\u003c/span>\u003cspan class=\"muted\">Graphics: 4 sub-frames a frame, a 90° shutter. The preview shows them sharp.\u003c/span>\u003c/label>\u003c/div>\u003cdiv class=\"wiz-foot\">\u003cp class=\"export-note\">Opens in Finder when it's done.\u003c/p>\u003cbutton type=\"button\" class=\"btn ghost\">Cancel\u003c/button>\u003cbutton type=\"submit\" class=\"btn primary\" data-testid=\"export-start\">Export\u003c/button>\u003c/div>\u003c/form>\u003c/div>\u003c/div>","width":640,"height":718,"ancestors":[{"tag":"div","cls":"app","attrs":{},"vars":"--side-col:clamp(240px, 440px, 40vw)"},{"tag":"div","cls":"modal-layer","attrs":{},"vars":""}]},"exportProgress":{"html":"\u003cdiv class=\"modal wiz\">\u003cdiv class=\"wiz-panel\">\u003cdiv class=\"export-head\">\u003ch1>Export video\u003c/h1>\u003cbutton class=\"icon-btn\" data-testid=\"export-close\">\u000120\u0002\u003c/button>\u003c/div>\u003cdiv data-testid=\"export-job\" data-phase=\"rendering\" data-progress=\"0.42\" data-output=\"/Users/you/Movies/Launch film.mp4\">\u003cp class=\"wiz-lead\" data-testid=\"export-job-where\">\u003cb class=\"mono\">Launch film.mp4\u003c/b> in \u003cb data-testid=\"export-job-folder\">Movies\u003c/b>, 1080×1350, 60 fps, H.264, 28.0 s, motion blur\u003c/p>\u003cdiv class=\"export-status\" data-testid=\"export-status\">Rendering… 42%\u003cspan class=\"muted\">About 38 s left\u003c/span>\u003c/div>\u003cdiv class=\"export-bar\" data-testid=\"export-progress\">\u003cdiv style=\"width: 42%;\">\u003c/div>\u003c/div>\u003cdiv class=\"wiz-foot\">\u003cbutton class=\"btn ghost\">Hide\u003c/button>\u003cbutton class=\"btn\" data-testid=\"export-cancel\">Cancel export\u003c/button>\u003c/div>\u003c/div>\u003c/div>\u003c/div>","width":640,"height":217,"ancestors":[{"tag":"div","cls":"app","attrs":{},"vars":"--side-col:clamp(240px, 440px, 40vw)"},{"tag":"div","cls":"modal-layer","attrs":{},"vars":""}]},"inspector":{"html":"\u003caside class=\"side\">\u003cdiv class=\"tabs\">\u003cbutton class=\"active\" data-testid=\"tab-inspector\">Inspector\u003c/button>\u003cbutton data-testid=\"tab-agent\">Agent\u003c/button>\u003cbutton data-testid=\"tab-history\">History\u003c/button>\u003c/div>\u003cdiv class=\"side-body\">\u003cdiv data-testid=\"inspector-item\" data-item=\"c2\">\u003cdiv class=\"insp-title\">\u000121\u0002\u003cspan class=\"ellipsis grow\">DJI 0063\u003c/span>\u003cbutton class=\"small-btn insp-chat\" data-testid=\"insp-add-to-chat\">\u00012\u0002Add to chat\u003c/button>\u003c/div>\u003cdiv class=\"insp-sub\">Clip on Main\u003c/div>\u003csection class=\"psec\" data-testid=\"insp-sec-transform\" data-section=\"transform\" data-open=\"true\">\u003cdiv class=\"psec-head\">\u003cbutton class=\"psec-title\" data-testid=\"insp-sec-transform-toggle\">\u000149\u0002Transform\u003c/button>\u003c/div>\u003cdiv class=\"psec-body\">\u003cdiv data-testid=\"clip-box-editor\">\u003cdiv class=\"group\">\u003cdiv class=\"group-label\">Position &amp; size\u003c/div>\u003cdiv class=\"field-row key-row\">\u003clabel class=\"field num-field\" data-scrub=\"insp-box-x\">\u003cspan class=\"k\">X\u003c/span>\u003cinput class=\"v\" data-testid=\"insp-box-x\" inputmode=\"decimal\" type=\"text\" value=\"0\">\u003c/label>\u003cbutton class=\"icon-btn key-btn none\" data-testid=\"insp-key\" data-prop=\"x\" data-state=\"none\" disabled=\"\">\u000174\u0002\u003c/button>\u003clabel class=\"field num-field\" data-scrub=\"insp-box-y\">\u003cspan class=\"k\">Y\u003c/span>\u003cinput class=\"v\" data-testid=\"insp-box-y\" inputmode=\"decimal\" type=\"text\" value=\"0\">\u003c/label>\u003cbutton class=\"icon-btn key-btn none\" data-testid=\"insp-key\" data-prop=\"y\" data-state=\"none\" disabled=\"\">\u000174\u0002\u003c/button>\u003c/div>\u003cdiv class=\"field-row\">\u003clabel class=\"field num-field\" data-scrub=\"insp-box-w\">\u003cspan class=\"k\">W\u003c/span>\u003cinput class=\"v\" data-testid=\"insp-box-w\" inputmode=\"decimal\" type=\"text\" value=\"1080\">\u003c/label>\u003clabel class=\"field num-field\" data-scrub=\"insp-box-h\">\u003cspan class=\"k\">H\u003c/span>\u003cinput class=\"v\" data-testid=\"insp-box-h\" inputmode=\"decimal\" type=\"text\" value=\"1350\">\u003c/label>\u003c/div>\u003cdiv class=\"seg fit\">\u003cbutton class=\"active\" data-testid=\"insp-fit\" data-fit=\"contain\">Contain\u003c/button>\u003cbutton data-testid=\"insp-fit\" data-fit=\"cover\">Cover\u003c/button>\u003cbutton data-testid=\"insp-fit\" data-fit=\"fill\">Fill\u003c/button>\u003c/div>\u003c/div>\u003cdiv class=\"group\">\u003cdiv class=\"group-label\">Scale and opacity\u003c/div>\u003cdiv class=\"slider-row key-row\">\u003cinput class=\"slider\" data-testid=\"insp-scale\" min=\"10\" max=\"400\" type=\"range\" value=\"100\">\u003clabel class=\"field num-field\" data-scrub=\"insp-scale-num\">\u003cspan class=\"k\">Scale %\u003c/span>\u003cinput class=\"v\" data-testid=\"insp-scale-num\" inputmode=\"decimal\" type=\"text\" value=\"100\">\u003c/label>\u003cbutton class=\"icon-btn key-btn none\" data-testid=\"insp-key\" data-prop=\"scale\" data-state=\"none\" disabled=\"\">\u000174\u0002\u003c/button>\u003c/div>\u003cdiv class=\"slider-row key-row\">\u003cinput class=\"slider\" data-testid=\"insp-opacity\" min=\"0\" max=\"100\" type=\"range\" value=\"100\">\u003clabel class=\"field num-field\" data-scrub=\"insp-opacity-num\">\u003cspan class=\"k\">Opacity %\u003c/span>\u003cinput class=\"v\" data-testid=\"insp-opacity-num\" inputmode=\"decimal\" type=\"text\" value=\"100\">\u003c/label>\u003cbutton class=\"icon-btn key-btn none\" data-testid=\"insp-key\" data-prop=\"opacity\" data-state=\"none\" disabled=\"\">\u000174\u0002\u003c/button>\u003c/div>\u003cdiv class=\"field-row\">\u003clabel class=\"field num-field\" data-scrub=\"insp-radius\">\u003cspan class=\"k\">Radius\u003c/span>\u003cinput class=\"v\" data-testid=\"insp-radius\" inputmode=\"decimal\" type=\"text\" value=\"0\">\u003c/label>\u003c/div>\u003c/div>\u003cdiv class=\"group\">\u003clabel class=\"check-row\">\u003cinput data-testid=\"insp-loop\" type=\"checkbox\">Loop the footage when the clip is longer\u003c/label>\u003clabel class=\"check-row\">\u003cinput data-testid=\"insp-hold\" type=\"checkbox\">Hold the last frame when the clip is longer\u003c/label>\u003cbutton class=\"btn\" data-testid=\"insp-box-reset\" disabled=\"\">\u000175\u0002Reset position and size\u003c/button>\u003c/div>\u003c/div>\u003c/div>\u003c/section>\u003cdiv data-testid=\"effects-editor\">\u003csection class=\"psec\" data-testid=\"insp-filter\" data-section=\"filter\" data-open=\"true\">\u003cdiv class=\"psec-head\">\u003cbutton class=\"psec-title\" data-testid=\"insp-filter-toggle\">\u000149\u0002Filter\u003c/button>\u003cdiv class=\"psec-actions\">\u003cspan class=\"fx-power\">\u003cbutton class=\"ptoggle on\" data-testid=\"insp-filter-power\">\u003cspan>\u003c/span>\u003c/button>\u003c/span>\u003cbutton class=\"icon-btn\" data-testid=\"insp-filter-remove\">\u000120\u0002\u003c/button>\u003c/div>\u003c/div>\u003cdiv class=\"psec-body\">\u003cdiv class=\"prop\" data-testid=\"insp-filter-intensity\">\u003cspan class=\"prop-k\">Warm\u003c/span>\u003cdiv class=\"prop-v\">\u003cdiv class=\"slider-num\">\u003cinput class=\"slider\" data-testid=\"insp-filter-amount-slider\" min=\"0\" max=\"100\" step=\"1\" type=\"range\" value=\"100\">\u003clabel class=\"nfield\">\u003cinput data-testid=\"insp-filter-amount\" inputmode=\"decimal\" type=\"text\" value=\"100\">\u003cspan class=\"nfield-u\">%\u003c/span>\u003c/label>\u003c/div>\u003c/div>\u003cspan class=\"prop-reset-gap\">\u003c/span>\u003c/div>\u003c/div>\u003c/section>\u003csection class=\"psec\" data-testid=\"insp-adjust\" data-section=\"adjust\" data-open=\"false\">\u003cdiv class=\"psec-head\">\u003cbutton class=\"psec-title\" data-testid=\"insp-adjust-toggle\">\u000173\u0002Adjust\u003c/button>\u003c/div>\u003cdiv class=\"psec-body\" hidden=\"\">\u003cdiv class=\"prop\" data-testid=\"insp-adjust-exposure\">\u003cspan class=\"prop-k\">Exposure\u003c/span>\u003cdiv class=\"prop-v\">\u003cdiv class=\"slider-num\">\u003cinput class=\"slider\" data-testid=\"insp-adjust-exposure-value-slider\" min=\"-2\" max=\"2\" step=\"0.05\" type=\"range\" value=\"0\">\u003clabel class=\"nfield\">\u003cinput data-testid=\"insp-adjust-exposure-value\" inputmode=\"decimal\" type=\"text\" value=\"0\">\u003cspan class=\"nfield-u\">EV\u003c/span>\u003c/label>\u003c/div>\u003c/div>\u003cspan class=\"prop-reset-gap\">\u003c/span>\u003c/div>\u003cdiv class=\"prop\" data-testid=\"insp-adjust-contrast\">\u003cspan class=\"prop-k\">Contrast\u003c/span>\u003cdiv class=\"prop-v\">\u003cdiv class=\"slider-num\">\u003cinput class=\"slider\" data-testid=\"insp-adjust-contrast-value-slider\" min=\"-100\" max=\"100\" step=\"1\" type=\"range\" value=\"0\">\u003clabel class=\"nfield\">\u003cinput data-testid=\"insp-adjust-contrast-value\" inputmode=\"decimal\" type=\"text\" value=\"0\">\u003c/label>\u003c/div>\u003c/div>\u003cspan class=\"prop-reset-gap\">\u003c/span>\u003c/div>\u003cdiv class=\"prop\" data-testid=\"insp-adjust-saturation\">\u003cspan class=\"prop-k\">Saturation\u003c/span>\u003cdiv class=\"prop-v\">\u003cdiv class=\"slider-num\">\u003cinput class=\"slider\" data-testid=\"insp-adjust-saturation-value-slider\" min=\"-100\" max=\"100\" step=\"1\" type=\"range\" value=\"0\">\u003clabel class=\"nfield\">\u003cinput data-testid=\"insp-adjust-saturation-value\" inputmode=\"decimal\" type=\"text\" value=\"0\">\u003c/label>\u003c/div>\u003c/div>\u003cspan class=\"prop-reset-gap\">\u003c/span>\u003c/div>\u003cdiv class=\"prop\" data-testid=\"insp-adjust-temperature\">\u003cspan class=\"prop-k\">Temperature\u003c/span>\u003cdiv class=\"prop-v\">\u003cdiv class=\"slider-num\">\u003cinput class=\"slider\" data-testid=\"insp-adjust-temperature-value-slider\" min=\"-100\" max=\"100\" step=\"1\" type=\"range\" value=\"0\">\u003clabel class=\"nfield\">\u003cinput data-testid=\"insp-adjust-temperature-value\" inputmode=\"decimal\" type=\"text\" value=\"0\">\u003c/label>\u003c/div>\u003c/div>\u003cspan class=\"prop-reset-gap\">\u003c/span>\u003c/div>\u003cdiv class=\"prop\" data-testid=\"insp-adjust-tint\">\u003cspan class=\"prop-k\">Tint\u003c/span>\u003cdiv class=\"prop-v\">\u003cdiv class=\"slider-num\">\u003cinput class=\"slider\" data-testid=\"insp-adjust-tint-value-slider\" min=\"-100\" max=\"100\" step=\"1\" type=\"range\" value=\"0\">\u003clabel class=\"nfield\">\u003cinput data-testid=\"insp-adjust-tint-value\" inputmode=\"decimal\" type=\"text\" value=\"0\">\u003c/label>\u003c/div>\u003c/div>\u003cspan class=\"prop-reset-gap\">\u003c/span>\u003c/div>\u003cdiv class=\"prop\" data-testid=\"insp-adjust-highlights\">\u003cspan class=\"prop-k\">Highlights\u003c/span>\u003cdiv class=\"prop-v\">\u003cdiv class=\"slider-num\">\u003cinput class=\"slider\" data-testid=\"insp-adjust-highlights-value-slider\" min=\"-100\" max=\"100\" step=\"1\" type=\"range\" value=\"0\">\u003clabel class=\"nfield\">\u003cinput data-testid=\"insp-adjust-highlights-value\" inputmode=\"decimal\" type=\"text\" value=\"0\">\u003c/label>\u003c/div>\u003c/div>\u003cspan class=\"prop-reset-gap\">\u003c/span>\u003c/div>\u003cdiv class=\"prop\" data-testid=\"insp-adjust-shadows\">\u003cspan class=\"prop-k\">Shadows\u003c/span>\u003cdiv class=\"prop-v\">\u003cdiv class=\"slider-num\">\u003cinput class=\"slider\" data-testid=\"insp-adjust-shadows-value-slider\" min=\"-100\" max=\"100\" step=\"1\" type=\"range\" value=\"0\">\u003clabel class=\"nfield\">\u003cinput data-testid=\"insp-adjust-shadows-value\" inputmode=\"decimal\" type=\"text\" value=\"0\">\u003c/label>\u003c/div>\u003c/div>\u003cspan class=\"prop-reset-gap\">\u003c/span>\u003c/div>\u003cdiv class=\"prop\" data-testid=\"insp-adjust-vibrance\">\u003cspan class=\"prop-k\">Vibrance\u003c/span>\u003cdiv class=\"prop-v\">\u003cdiv class=\"slider-num\">\u003cinput class=\"slider\" data-testid=\"insp-adjust-vibrance-value-slider\" min=\"-100\" max=\"100\" step=\"1\" type=\"range\" value=\"0\">\u003clabel class=\"nfield\">\u003cinput data-testid=\"insp-adjust-vibrance-value\" inputmode=\"decimal\" type=\"text\" value=\"0\">\u003c/label>\u003c/div>\u003c/div>\u003cspan class=\"prop-reset-gap\">\u003c/span>\u003c/div>\u003c/div>\u003c/section>\u003csection class=\"psec\" data-testid=\"insp-effects\" data-section=\"effects\" data-open=\"true\">\u003cdiv class=\"psec-head\">\u003cbutton class=\"psec-title\" data-testid=\"insp-effects-toggle\">\u000149\u0002Effects\u003c/button>\u003c/div>\u003cdiv class=\"psec-body\">\u003cdiv class=\"fx-entry\" data-testid=\"insp-effect\" data-module=\"effect.vignette\" data-off=\"false\">\u003cdiv class=\"fx-entry-head\">\u003cspan class=\"grow\">Vignette\u003c/span>\u003cbutton class=\"icon-btn\" data-testid=\"insp-effect-add-to-chat\">\u00012\u0002\u003c/button>\u003cspan class=\"fx-power\">\u003cbutton class=\"ptoggle on\" data-testid=\"insp-effect-power\">\u003cspan>\u003c/span>\u003c/button>\u003c/span>\u003cbutton class=\"icon-btn\" data-testid=\"insp-effect-remove\">\u000120\u0002\u003c/button>\u003c/div>\u003cdiv class=\"prop\" data-testid=\"insp-effect-amount\">\u003cspan class=\"prop-k\">Amount\u003c/span>\u003cdiv class=\"prop-v\">\u003cdiv class=\"slider-num\">\u003cinput class=\"slider\" data-testid=\"insp-effect-amount-value-slider\" min=\"0\" max=\"1\" step=\"0.01\" type=\"range\" value=\"0.5\">\u003clabel class=\"nfield\">\u003cinput data-testid=\"insp-effect-amount-value\" inputmode=\"decimal\" type=\"text\" value=\"0.5\">\u003c/label>\u003c/div>\u003c/div>\u003cspan class=\"prop-reset-gap\">\u003c/span>\u003c/div>\u003cdiv class=\"prop\" data-testid=\"insp-effect-size\">\u003cspan class=\"prop-k\">Size\u003c/span>\u003cdiv class=\"prop-v\">\u003cdiv class=\"slider-num\">\u003cinput class=\"slider\" data-testid=\"insp-effect-size-value-slider\" min=\"0\" max=\"1\" step=\"0.01\" type=\"range\" value=\"0.5\">\u003clabel class=\"nfield\">\u003cinput data-testid=\"insp-effect-size-value\" inputmode=\"decimal\" type=\"text\" value=\"0.5\">\u003c/label>\u003c/div>\u003c/div>\u003cspan class=\"prop-reset-gap\">\u003c/span>\u003c/div>\u003c/div>\u003c/div>\u003c/section>\u003c/div>\u003csection class=\"psec\" data-testid=\"insp-sec-speed\" data-section=\"speed\" data-open=\"true\">\u003cdiv class=\"psec-head\">\u003cbutton class=\"psec-title\" data-testid=\"insp-sec-speed-toggle\">\u000149\u0002Speed\u003c/button>\u003c/div>\u003cdiv class=\"psec-body\">\u003cdiv data-testid=\"speed-editor\">\u003cdiv class=\"group\">\u003cdiv class=\"speed-row\">\u003cbutton class=\"small-btn\" data-testid=\"insp-speed-0.25\">0.25×\u003c/button>\u003cbutton class=\"small-btn\" data-testid=\"insp-speed-0.5\">0.5×\u003c/button>\u003cbutton class=\"small-btn\" data-testid=\"insp-speed-0.75\">0.75×\u003c/button>\u003cbutton class=\"small-btn active\" data-testid=\"insp-speed-1\">1×\u003c/button>\u003cbutton class=\"small-btn\" data-testid=\"insp-speed-1.25\">1.25×\u003c/button>\u003cbutton class=\"small-btn\" data-testid=\"insp-speed-1.5\">1.5×\u003c/button>\u003cbutton class=\"small-btn\" data-testid=\"insp-speed-2\">2×\u003c/button>\u003cbutton class=\"small-btn\" data-testid=\"insp-speed-3\">3×\u003c/button>\u003cbutton class=\"small-btn\" data-testid=\"insp-speed-4\">4×\u003c/button>\u003c/div>\u003cdiv class=\"field-row\">\u003clabel class=\"field num-field\" data-scrub=\"insp-speed-custom\">\u003cspan class=\"k\">×\u003c/span>\u003cinput class=\"v\" data-testid=\"insp-speed-custom\" inputmode=\"decimal\" type=\"text\" value=\"1\">\u003c/label>\u003c/div>\u003clabel class=\"check-row\">\u003cinput data-testid=\"insp-keep-pitch\" type=\"checkbox\" checked=\"\">Keep pitch\u003c/label>\u003c/div>\u003c/div>\u003c/div>\u003c/section>\u003csection class=\"psec\" data-testid=\"insp-sec-advanced\" data-section=\"advanced\" data-open=\"false\">\u003cdiv class=\"psec-head\">\u003cbutton class=\"psec-title\" data-testid=\"insp-sec-advanced-toggle\">\u000173\u0002Advanced\u003c/button>\u003c/div>\u003cdiv class=\"psec-body\" hidden=\"\">\u003cdiv class=\"group\">\u003cdiv class=\"group-label\">Name\u003c/div>\u003clabel class=\"field num-field\">\u003cspan class=\"k\">Item\u003c/span>\u003cinput class=\"v\" data-testid=\"insp-name\" placeholder=\"DJI 0063\" type=\"text\" value=\"\">\u003c/label>\u003clabel class=\"field num-field\">\u003cspan class=\"k\">Media\u003c/span>\u003cinput class=\"v\" data-testid=\"insp-media-name\" type=\"text\" value=\"DJI 0063\">\u003c/label>\u003c/div>\u003cdiv class=\"group\">\u003cdiv class=\"kv-row\">\u003cspan class=\"muted\">Type\u003c/span>\u003cspan class=\"mono small\" data-testid=\"insp-type\">Clip\u003c/span>\u003c/div>\u003cdiv class=\"kv-row\">\u003cspan class=\"muted\">Track\u003c/span>\u003cspan class=\"mono small\" data-testid=\"insp-track\">Main\u003c/span>\u003c/div>\u003cdiv class=\"kv-row\">\u003cspan class=\"muted\">Start\u003c/span>\u003cspan class=\"mono small\" data-testid=\"insp-start\">00:00:07:00\u003c/span>\u003c/div>\u003cdiv class=\"kv-row\">\u003cspan class=\"muted\">Duration\u003c/span>\u003cspan class=\"mono small\" data-testid=\"insp-duration\">7.00s\u003c/span>\u003c/div>\u003cdiv class=\"kv-row\">\u003cspan class=\"muted\">Media\u003c/span>\u003cspan class=\"mono small\" data-testid=\"insp-media\">DJI 0063\u003c/span>\u003c/div>\u003cdiv class=\"kv-row\">\u003cspan class=\"muted\">Source in\u003c/span>\u003cspan class=\"mono small\" data-testid=\"insp-in\">00:00:09:42\u003c/span>\u003c/div>\u003cdiv class=\"kv-row\">\u003cspan class=\"muted\">Source out\u003c/span>\u003cspan class=\"mono small\" data-testid=\"insp-out\">00:00:16:42\u003c/span>\u003c/div>\u003c/div>\u003c/div>\u003c/section>\u003c/div>\u003c/div>\u003c/aside>","width":440,"height":590,"ancestors":[{"tag":"div","cls":"app","attrs":{},"vars":"--side-col:clamp(240px, 440px, 40vw)"}]},"effects":{"html":"\u003caside class=\"library\" data-testid=\"effects-library\" data-source=\"sample\">\u003cdiv class=\"lib-head\">Effects\u003c/div>\u003cdiv class=\"lib-section\">\u003cdiv class=\"music-filters\">\u003cdiv class=\"tr-search\">\u003cinput class=\"field input\" data-testid=\"effects-search\" placeholder=\"Search filters and effects\" value=\"\">\u003c/div>\u003cdiv class=\"muted small\" data-testid=\"effects-target\">On DJI 0063\u003c/div>\u003c/div>\u003cdiv class=\"lib-label\">Filters\u003c/div>\u003cdiv class=\"grid2 fx-grid\" data-testid=\"filters-grid\">\u003cdiv class=\"tile fx-tile\" data-testid=\"filter-tile\" data-look=\"none\">\u003cdiv class=\"thumb fx-thumb fx-none\" data-testid=\"filter-thumb\">\u000176\u0002\u003c/div>\u003cdiv class=\"tile-name\">None\u003c/div>\u003c/div>\u003cdiv class=\"tile fx-tile\" data-testid=\"filter-tile\" data-look=\"natural\">\u003cdiv class=\"thumb fx-thumb\" data-testid=\"filter-thumb\">\u003cimg style=\";width:108px;height:60.75px\" src=\"\u000177\u0002\">\u003c/div>\u003cdiv class=\"tile-name\">Natural\u003c/div>\u003c/div>\u003cdiv class=\"tile fx-tile active\" data-testid=\"filter-tile\" data-look=\"warm\" data-active=\"true\">\u003cdiv class=\"thumb fx-thumb\" data-testid=\"filter-thumb\">\u003cimg style=\";width:108px;height:60.75px\" src=\"\u000178\u0002\">\u003c/div>\u003cdiv class=\"tile-name\">Warm\u003c/div>\u003c/div>\u003cdiv class=\"tile fx-tile\" data-testid=\"filter-tile\" data-look=\"cool\">\u003cdiv class=\"thumb fx-thumb\" data-testid=\"filter-thumb\">\u003cimg style=\";width:108px;height:60.75px\" src=\"\u000179\u0002\">\u003c/div>\u003cdiv class=\"tile-name\">Cool\u003c/div>\u003c/div>\u003cdiv class=\"tile fx-tile\" data-testid=\"filter-tile\" data-look=\"vintage\">\u003cdiv class=\"thumb fx-thumb\" data-testid=\"filter-thumb\">\u003cimg style=\";width:108px;height:60.75px\" src=\"\u000180\u0002\">\u003c/div>\u003cdiv class=\"tile-name\">Vintage\u003c/div>\u003c/div>\u003cdiv class=\"tile fx-tile\" data-testid=\"filter-tile\" data-look=\"film\">\u003cdiv class=\"thumb fx-thumb\" data-testid=\"filter-thumb\">\u003cimg style=\";width:108px;height:60.75px\" src=\"\u000181\u0002\">\u003c/div>\u003cdiv class=\"tile-name\">Film\u003c/div>\u003c/div>\u003cdiv class=\"tile fx-tile\" data-testid=\"filter-tile\" data-look=\"teal-orange\">\u003cdiv class=\"thumb fx-thumb\" data-testid=\"filter-thumb\">\u003cimg style=\";width:108px;height:60.75px\" src=\"\u000182\u0002\">\u003c/div>\u003cdiv class=\"tile-name\">Teal &amp; Orange\u003c/div>\u003c/div>\u003cdiv class=\"tile fx-tile\" data-testid=\"filter-tile\" data-look=\"bw\">\u003cdiv class=\"thumb fx-thumb\" data-testid=\"filter-thumb\">\u003cimg style=\";width:108px;height:60.75px\" src=\"\u000183\u0002\">\u003c/div>\u003cdiv class=\"tile-name\">B&amp;W\u003c/div>\u003c/div>\u003cdiv class=\"tile fx-tile\" data-testid=\"filter-tile\" data-look=\"noir\">\u003cdiv class=\"thumb fx-thumb\" data-testid=\"filter-thumb\">\u003cimg style=\";width:108px;height:60.75px\" src=\"\u000184\u0002\">\u003c/div>\u003cdiv class=\"tile-name\">Noir\u003c/div>\u003c/div>\u003cdiv class=\"tile fx-tile\" data-testid=\"filter-tile\" data-look=\"fade\">\u003cdiv class=\"thumb fx-thumb\" data-testid=\"filter-thumb\">\u003cimg style=\";width:108px;height:60.75px\" src=\"\u000185\u0002\">\u003c/div>\u003cdiv class=\"tile-name\">Fade\u003c/div>\u003c/div>\u003cdiv class=\"tile fx-tile\" data-testid=\"filter-tile\" data-look=\"vivid\">\u003cdiv class=\"thumb fx-thumb\" data-testid=\"filter-thumb\">\u003cimg style=\";width:108px;height:60.75px\" src=\"\u000186\u0002\">\u003c/div>\u003cdiv class=\"tile-name\">Vivid\u003c/div>\u003c/div>\u003cdiv class=\"tile fx-tile\" data-testid=\"filter-tile\" data-look=\"moody\">\u003cdiv class=\"thumb fx-thumb\" data-testid=\"filter-thumb\">\u003cimg style=\";width:108px;height:60.75px\" src=\"\u000187\u0002\">\u003c/div>\u003cdiv class=\"tile-name\">Moody\u003c/div>\u003c/div>\u003cdiv class=\"tile fx-tile\" data-testid=\"filter-tile\" data-look=\"sepia\">\u003cdiv class=\"thumb fx-thumb\" data-testid=\"filter-thumb\">\u003cimg style=\";width:108px;height:60.75px\" src=\"\u000188\u0002\">\u003c/div>\u003cdiv class=\"tile-name\">Sepia\u003c/div>\u003c/div>\u003cdiv class=\"tile fx-tile\" data-testid=\"filter-tile\" data-look=\"cinematic\">\u003cdiv class=\"thumb fx-thumb\" data-testid=\"filter-thumb\">\u003cimg style=\";width:108px;height:60.75px\" src=\"\u000189\u0002\">\u003c/div>\u003cdiv class=\"tile-name\">Cinematic\u003c/div>\u003c/div>\u003cdiv class=\"tile fx-tile\" data-testid=\"filter-tile\" data-look=\"pastel\">\u003cdiv class=\"thumb fx-thumb\" data-testid=\"filter-thumb\">\u003cimg style=\";width:108px;height:60.75px\" src=\"\u000190\u0002\">\u003c/div>\u003cdiv class=\"tile-name\">Pastel\u003c/div>\u003c/div>\u003cdiv class=\"tile fx-tile\" data-testid=\"filter-tile\" data-look=\"golden\">\u003cdiv class=\"thumb fx-thumb\" data-testid=\"filter-thumb\">\u003cimg style=\";width:108px;height:60.75px\" src=\"\u000191\u0002\">\u003c/div>\u003cdiv class=\"tile-name\">Golden hour\u003c/div>\u003c/div>\u003cdiv class=\"tile fx-tile\" data-testid=\"filter-tile\" data-look=\"arctic\">\u003cdiv class=\"thumb fx-thumb\" data-testid=\"filter-thumb\">\u003cimg style=\";width:108px;height:60.75px\" src=\"\u000192\u0002\">\u003c/div>\u003cdiv class=\"tile-name\">Arctic\u003c/div>\u003c/div>\u003c/div>\u003c/div>\u003c/aside>","width":272,"height":590,"ancestors":[{"tag":"div","cls":"app","attrs":{},"vars":"--side-col:clamp(240px, 440px, 40vw)"}]},"menu":{"html":"\u003cdiv class=\"ctx-menu\" data-testid=\"context-menu\" style=\"\">\u003cdiv data-testid=\"menu-add-to-chat\" class=\"ctx-item active\">\u003cspan class=\"ctx-check\">\u003c/span>\u003cspan class=\"ctx-label\">Add to chat\u003c/span>\u003cspan class=\"ctx-key\">⌘L\u003c/span>\u003c/div>\u003cdiv class=\"ctx-sep\">\u003c/div>\u003cdiv data-testid=\"menu-split\" class=\"ctx-item disabled\">\u003cspan class=\"ctx-check\">\u003c/span>\u003cspan class=\"ctx-label\">Split\u003c/span>\u003cspan class=\"ctx-key\">S\u003c/span>\u003c/div>\u003cdiv class=\"ctx-sep\">\u003c/div>\u003cdiv data-testid=\"menu-copy\" class=\"ctx-item\">\u003cspan class=\"ctx-check\">\u003c/span>\u003cspan class=\"ctx-label\">Copy\u003c/span>\u003cspan class=\"ctx-key\">⌘C\u003c/span>\u003c/div>\u003cdiv data-testid=\"menu-paste\" class=\"ctx-item disabled\">\u003cspan class=\"ctx-check\">\u003c/span>\u003cspan class=\"ctx-label\">Paste\u003c/span>\u003cspan class=\"ctx-key\">⌘V\u003c/span>\u003c/div>\u003cdiv data-testid=\"menu-duplicate\" class=\"ctx-item\">\u003cspan class=\"ctx-check\">\u003c/span>\u003cspan class=\"ctx-label\">Duplicate\u003c/span>\u003cspan class=\"ctx-key\">⌘D\u003c/span>\u003c/div>\u003cdiv class=\"ctx-sep\">\u003c/div>\u003cdiv data-testid=\"menu-delete\" class=\"ctx-item danger\">\u003cspan class=\"ctx-check\">\u003c/span>\u003cspan class=\"ctx-label\">Delete\u003c/span>\u003cspan class=\"ctx-key\">⌫\u003c/span>\u003c/div>\u003cdiv data-testid=\"menu-ripple-delete\" class=\"ctx-item danger\">\u003cspan class=\"ctx-check\">\u003c/span>\u003cspan class=\"ctx-label\">Ripple delete\u003c/span>\u003cspan class=\"ctx-key\">⇧⌫\u003c/span>\u003c/div>\u003cdiv class=\"ctx-sep\">\u003c/div>\u003cdiv data-testid=\"menu-speed\" class=\"ctx-item\">\u003cspan class=\"ctx-check\">\u003c/span>\u003cspan class=\"ctx-label\">Speed\u003c/span>\u000193\u0002\u003c/div>\u003cdiv data-testid=\"menu-rename\" class=\"ctx-item\">\u003cspan class=\"ctx-check\">\u003c/span>\u003cspan class=\"ctx-label\">Rename\u003c/span>\u003c/div>\u003cdiv data-testid=\"menu-replace-media\" class=\"ctx-item\">\u003cspan class=\"ctx-check\">\u003c/span>\u003cspan class=\"ctx-label\">Replace media\u003c/span>\u000193\u0002\u003c/div>\u003cdiv data-testid=\"menu-show-in-media\" class=\"ctx-item\">\u003cspan class=\"ctx-check\">\u003c/span>\u003cspan class=\"ctx-label\">Show in Media\u003c/span>\u003c/div>\u003cdiv data-testid=\"menu-reveal\" class=\"ctx-item\">\u003cspan class=\"ctx-check\">\u003c/span>\u003cspan class=\"ctx-label\">Reveal in Finder\u003c/span>\u003c/div>\u003cdiv class=\"ctx-sep\">\u003c/div>\u003cdiv data-testid=\"menu-lock\" class=\"ctx-item\">\u003cspan class=\"ctx-check\">\u003c/span>\u003cspan class=\"ctx-label\">Lock\u003c/span>\u003c/div>\u003c/div>","width":220,"height":369,"ancestors":[{"tag":"div","cls":"app","attrs":{},"vars":"--side-col:clamp(240px, 440px, 40vw)"}],"backdrop":"rgb(10, 10, 10)","radius":"9px"}},"pool":["\u003csvg xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" class=\"lucide lucide-mouse-pointer2\">\u003cpath d=\"M4.037 4.688a.495.495 0 0 1 .651-.651l16 6.5a.5.5 0 0 1-.063.947l-6.124 1.58a2 2 0 0 0-1.438 1.435l-1.579 6.126a.5.5 0 0 1-.947.063z\">\u003c/path>\u003c/svg>","\u003csvg xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" class=\"lucide lucide-paperclip\">\u003cpath d=\"m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48\">\u003c/path>\u003c/svg>","\u003csvg xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" class=\"lucide lucide-at-sign\">\u003ccircle cx=\"12\" cy=\"12\" r=\"4\">\u003c/circle>\u003cpath d=\"M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8\">\u003c/path>\u003c/svg>","\u003csvg class=\"provider-logo\" preserveAspectRatio=\"xMidYMid\" viewBox=\"0 0 256 257\" fill=\"#d97757\">\u003cpath d=\"m50.228 170.321 50.357-28.257.843-2.463-.843-1.361h-2.462l-8.426-.518-28.775-.778-24.952-1.037-24.175-1.296-6.092-1.297L0 125.796l.583-3.759 5.12-3.434 7.324.648 16.202 1.101 24.304 1.685 17.629 1.037 26.118 2.722h4.148l.583-1.685-1.426-1.037-1.101-1.037-25.147-17.045-27.22-18.017-14.258-10.37-7.713-5.25-3.888-4.925-1.685-10.758 7-7.713 9.397.649 2.398.648 9.527 7.323 20.35 15.75L94.817 91.9l3.889 3.24 1.555-1.102.195-.777-1.75-2.917-14.453-26.118-15.425-26.572-6.87-11.018-1.814-6.61c-.648-2.723-1.102-4.991-1.102-7.778l7.972-10.823L71.42 0 82.05 1.426l4.472 3.888 6.61 15.101 10.694 23.786 16.591 32.34 4.861 9.592 2.592 8.879.973 2.722h1.685v-1.556l1.36-18.211 2.528-22.36 2.463-28.776.843-8.1 4.018-9.722 7.971-5.25 6.222 2.981 5.12 7.324-.713 4.73-3.046 19.768-5.962 30.98-3.889 20.739h2.268l2.593-2.593 10.499-13.934 17.628-22.036 7.778-8.749 9.073-9.657 5.833-4.601h11.018l8.1 12.055-3.628 12.443-11.342 14.388-9.398 12.184-13.48 18.147-8.426 14.518.778 1.166 2.01-.194 30.46-6.481 16.462-2.982 19.637-3.37 8.88 4.148.971 4.213-3.5 8.62-20.998 5.184-24.628 4.926-36.682 8.685-.454.324.519.648 16.526 1.555 7.065.389h17.304l32.21 2.398 8.426 5.574 5.055 6.805-.843 5.184-12.962 6.611-17.498-4.148-40.83-9.721-14-3.5h-1.944v1.167l11.666 11.406 21.387 19.314 26.767 24.887 1.36 6.157-3.434 4.86-3.63-.518-23.526-17.693-9.073-7.972-20.545-17.304h-1.36v1.814l4.73 6.935 25.017 37.59 1.296 11.536-1.814 3.76-6.481 2.268-7.13-1.297-14.647-20.544-15.1-23.138-12.185-20.739-1.49.843-7.194 77.448-3.37 3.953-7.778 2.981-6.48-4.925-3.436-7.972 3.435-15.749 4.148-20.544 3.37-16.333 3.046-20.285 1.815-6.74-.13-.454-1.49.194-15.295 20.999-23.267 31.433-18.406 19.702-4.407 1.75-7.648-3.954.713-7.064 4.277-6.286 25.47-32.405 15.36-20.092 9.917-11.6-.065-1.686h-.583L44.07 198.125l-12.055 1.555-5.185-4.86.648-7.972 2.463-2.593 20.35-13.999-.064.065Z\">\u003c/path>\u003c/svg>","\u003csvg xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" class=\"lucide lucide-chevron-down choice-caret\">\u003cpath d=\"m6 9 6 6 6-6\">\u003c/path>\u003c/svg>","\u003csvg xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" class=\"lucide lucide-gauge\">\u003cpath d=\"m12 14 4-4\">\u003c/path>\u003cpath d=\"M3.34 19a10 10 0 1 1 17.32 0\">\u003c/path>\u003c/svg>","\u003csvg xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" class=\"lucide lucide-sparkles\">\u003cpath d=\"M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z\">\u003c/path>\u003cpath d=\"M20 3v4\">\u003c/path>\u003cpath d=\"M22 5h-4\">\u003c/path>\u003cpath d=\"M4 17v2\">\u003c/path>\u003cpath d=\"M5 18H3\">\u003c/path>\u003c/svg>","\u003csvg xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" class=\"lucide lucide-arrow-up\">\u003cpath d=\"m5 12 7-7 7 7\">\u003c/path>\u003cpath d=\"M12 19V5\">\u003c/path>\u003c/svg>","\u003csvg xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" class=\"lucide lucide-clapperboard\">\u003cpath d=\"M20.2 6 3 11l-.9-2.4c-.3-1.1.3-2.2 1.3-2.5l13.5-4c1.1-.3 2.2.3 2.5 1.3Z\">\u003c/path>\u003cpath d=\"m6.2 5.3 3.1 3.9\">\u003c/path>\u003cpath d=\"m12.4 3.4 3.1 4\">\u003c/path>\u003cpath d=\"M3 11h18v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z\">\u003c/path>\u003c/svg>","\u003csvg xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" class=\"lucide lucide-pencil\">\u003cpath d=\"M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z\">\u003c/path>\u003cpath d=\"m15 5 4 4\">\u003c/path>\u003c/svg>","\u003csvg class=\"wordmark-mark\" viewBox=\"280 230 464 562\">\u003cdefs>\u003cmask id=\"_r_0_\" maskUnits=\"userSpaceOnUse\" x=\"0\" y=\"0\" width=\"1024\" height=\"1024\">\u003crect width=\"1024\" height=\"1024\" fill=\"#fff\">\u003c/rect>\u003cpath d=\"M270 506 L466 403\" stroke=\"#000\" stroke-width=\"26\">\u003c/path>\u003c/mask>\u003c/defs>\u003cpath d=\"M368 318 V560 A144 144 0 0 0 656 560 V318\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"128\" stroke-linecap=\"round\" mask=\"url(#_r_0_)\">\u003c/path>\u003c/svg>","\u003csvg xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" class=\"lucide lucide-panel-left\">\u003crect width=\"18\" height=\"18\" x=\"3\" y=\"3\" rx=\"2\">\u003c/rect>\u003cpath d=\"M9 3v18\">\u003c/path>\u003c/svg>","\u003csvg xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" class=\"lucide lucide-panel-bottom\">\u003crect width=\"18\" height=\"18\" x=\"3\" y=\"3\" rx=\"2\">\u003c/rect>\u003cpath d=\"M3 15h18\">\u003c/path>\u003c/svg>","\u003csvg xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" class=\"lucide lucide-panel-right\">\u003crect width=\"18\" height=\"18\" x=\"3\" y=\"3\" rx=\"2\">\u003c/rect>\u003cpath d=\"M15 3v18\">\u003c/path>\u003c/svg>","\u003csvg xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" class=\"lucide lucide-focus\">\u003ccircle cx=\"12\" cy=\"12\" r=\"3\">\u003c/circle>\u003cpath d=\"M3 7V5a2 2 0 0 1 2-2h2\">\u003c/path>\u003cpath d=\"M17 3h2a2 2 0 0 1 2 2v2\">\u003c/path>\u003cpath d=\"M21 17v2a2 2 0 0 1-2 2h-2\">\u003c/path>\u003cpath d=\"M7 21H5a2 2 0 0 1-2-2v-2\">\u003c/path>\u003c/svg>","\u003csvg xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" class=\"lucide lucide-check\">\u003cpath d=\"M20 6 9 17l-5-5\">\u003c/path>\u003c/svg>","\u003csvg xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" class=\"lucide lucide-undo2\">\u003cpath d=\"M9 14 4 9l5-5\">\u003c/path>\u003cpath d=\"M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11\">\u003c/path>\u003c/svg>","\u003csvg xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" class=\"lucide lucide-redo2\">\u003cpath d=\"m15 14 5-5-5-5\">\u003c/path>\u003cpath d=\"M20 9H9.5A5.5 5.5 0 0 0 4 14.5A5.5 5.5 0 0 0 9.5 20H13\">\u003c/path>\u003c/svg>","\u003csvg xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" class=\"lucide lucide-share\">\u003cpath d=\"M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8\">\u003c/path>\u003cpolyline points=\"16 6 12 2 8 6\">\u003c/polyline>\u003cline x1=\"12\" x2=\"12\" y1=\"2\" y2=\"15\">\u003c/line>\u003c/svg>","\u003csvg xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" class=\"lucide lucide-settings\">\u003cpath d=\"M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z\">\u003c/path>\u003ccircle cx=\"12\" cy=\"12\" r=\"3\">\u003c/circle>\u003c/svg>","\u003csvg xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" class=\"lucide lucide-x\">\u003cpath d=\"M18 6 6 18\">\u003c/path>\u003cpath d=\"m6 6 12 12\">\u003c/path>\u003c/svg>","\u003csvg xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" class=\"lucide lucide-film\">\u003crect width=\"18\" height=\"18\" x=\"3\" y=\"3\" rx=\"2\">\u003c/rect>\u003cpath d=\"M7 3v18\">\u003c/path>\u003cpath d=\"M3 7.5h4\">\u003c/path>\u003cpath d=\"M3 12h18\">\u003c/path>\u003cpath d=\"M3 16.5h4\">\u003c/path>\u003cpath d=\"M17 3v18\">\u003c/path>\u003cpath d=\"M17 7.5h4\">\u003c/path>\u003cpath d=\"M17 16.5h4\">\u003c/path>\u003c/svg>","\u003csvg xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" class=\"lucide lucide-scroll-text\">\u003cpath d=\"M15 12h-5\">\u003c/path>\u003cpath d=\"M15 8h-5\">\u003c/path>\u003cpath d=\"M19 17V5a2 2 0 0 0-2-2H4\">\u003c/path>\u003cpath d=\"M8 21h12a2 2 0 0 0 2-2v-1a1 1 0 0 0-1-1H11a1 1 0 0 0-1 1v1a2 2 0 1 1-4 0V5a2 2 0 1 0-4 0v2a1 1 0 0 0 1 1h3\">\u003c/path>\u003c/svg>","\u003csvg xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" class=\"lucide lucide-type\">\u003cpolyline points=\"4 7 4 4 20 4 20 7\">\u003c/polyline>\u003cline x1=\"9\" x2=\"15\" y1=\"20\" y2=\"20\">\u003c/line>\u003cline x1=\"12\" x2=\"12\" y1=\"4\" y2=\"20\">\u003c/line>\u003c/svg>","\u003csvg xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" class=\"lucide lucide-shapes\">\u003cpath d=\"M8.3 10a.7.7 0 0 1-.626-1.079L11.4 3a.7.7 0 0 1 1.198-.043L16.3 8.9a.7.7 0 0 1-.572 1.1Z\">\u003c/path>\u003crect x=\"3\" y=\"14\" width=\"7\" height=\"7\" rx=\"1\">\u003c/rect>\u003ccircle cx=\"17.5\" cy=\"17.5\" r=\"3.5\">\u003c/circle>\u003c/svg>","\u003csvg xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" class=\"lucide lucide-music\">\u003cpath d=\"M9 18V5l12-2v13\">\u003c/path>\u003ccircle cx=\"6\" cy=\"18\" r=\"3\">\u003c/circle>\u003ccircle cx=\"18\" cy=\"16\" r=\"3\">\u003c/circle>\u003c/svg>","\u003csvg xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" class=\"lucide lucide-audio-waveform\">\u003cpath d=\"M2 13a2 2 0 0 0 2-2V7a2 2 0 0 1 4 0v13a2 2 0 0 0 4 0V4a2 2 0 0 1 4 0v13a2 2 0 0 0 4 0v-4a2 2 0 0 1 2-2\">\u003c/path>\u003c/svg>","\u003csvg xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" class=\"lucide lucide-blend\">\u003ccircle cx=\"9\" cy=\"9\" r=\"7\">\u003c/circle>\u003ccircle cx=\"15\" cy=\"15\" r=\"7\">\u003c/circle>\u003c/svg>","\u003csvg xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" class=\"lucide lucide-palette\">\u003ccircle cx=\"13.5\" cy=\"6.5\" r=\".5\" fill=\"currentColor\">\u003c/circle>\u003ccircle cx=\"17.5\" cy=\"10.5\" r=\".5\" fill=\"currentColor\">\u003c/circle>\u003ccircle cx=\"8.5\" cy=\"7.5\" r=\".5\" fill=\"currentColor\">\u003c/circle>\u003ccircle cx=\"6.5\" cy=\"12.5\" r=\".5\" fill=\"currentColor\">\u003c/circle>\u003cpath d=\"M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z\">\u003c/path>\u003c/svg>","\u003csvg xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" class=\"lucide lucide-circle-dot\">\u003ccircle cx=\"12\" cy=\"12\" r=\"10\">\u003c/circle>\u003ccircle cx=\"12\" cy=\"12\" r=\"1\">\u003c/circle>\u003c/svg>","\u003csvg xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" class=\"lucide lucide-swatch-book\">\u003cpath d=\"M11 17a4 4 0 0 1-8 0V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2Z\">\u003c/path>\u003cpath d=\"M16.7 13H19a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H7\">\u003c/path>\u003cpath d=\"M 7 17h.01\">\u003c/path>\u003cpath d=\"m11 8 2.3-2.3a2.4 2.4 0 0 1 3.404.004L18.6 7.6a2.4 2.4 0 0 1 .026 3.434L9.9 19.8\">\u003c/path>\u003c/svg>","\u003csvg xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" class=\"lucide lucide-book-open\">\u003cpath d=\"M12 7v14\">\u003c/path>\u003cpath d=\"M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z\">\u003c/path>\u003c/svg>","\u003csvg xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" class=\"lucide lucide-plus\">\u003cpath d=\"M5 12h14\">\u003c/path>\u003cpath d=\"M12 5v14\">\u003c/path>\u003c/svg>","\u003csvg xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" class=\"lucide lucide-layout-grid\">\u003crect width=\"7\" height=\"7\" x=\"3\" y=\"3\" rx=\"1\">\u003c/rect>\u003crect width=\"7\" height=\"7\" x=\"14\" y=\"3\" rx=\"1\">\u003c/rect>\u003crect width=\"7\" height=\"7\" x=\"14\" y=\"14\" rx=\"1\">\u003c/rect>\u003crect width=\"7\" height=\"7\" x=\"3\" y=\"14\" rx=\"1\">\u003c/rect>\u003c/svg>","\u003csvg xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" class=\"lucide lucide-list\">\u003cpath d=\"M3 12h.01\">\u003c/path>\u003cpath d=\"M3 18h.01\">\u003c/path>\u003cpath d=\"M3 6h.01\">\u003c/path>\u003cpath d=\"M8 12h13\">\u003c/path>\u003cpath d=\"M8 18h13\">\u003c/path>\u003cpath d=\"M8 6h13\">\u003c/path>\u003c/svg>","\u003csvg xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" class=\"lucide lucide-audio-lines\">\u003cpath d=\"M2 10v3\">\u003c/path>\u003cpath d=\"M6 6v11\">\u003c/path>\u003cpath d=\"M10 3v18\">\u003c/path>\u003cpath d=\"M14 8v7\">\u003c/path>\u003cpath d=\"M18 5v13\">\u003c/path>\u003cpath d=\"M22 10v3\">\u003c/path>\u003c/svg>","\u003csvg xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" class=\"lucide lucide-skip-back\">\u003cpolygon points=\"19 20 9 12 19 4 19 20\">\u003c/polygon>\u003cline x1=\"5\" x2=\"5\" y1=\"19\" y2=\"5\">\u003c/line>\u003c/svg>","\u003csvg xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" class=\"lucide lucide-step-back\">\u003cline x1=\"18\" x2=\"18\" y1=\"20\" y2=\"4\">\u003c/line>\u003cpolygon points=\"14,20 4,12 14,4\">\u003c/polygon>\u003c/svg>","\u003csvg xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" class=\"lucide lucide-play\">\u003cpolygon points=\"6 3 20 12 6 21 6 3\">\u003c/polygon>\u003c/svg>","\u003csvg xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" class=\"lucide lucide-step-forward\">\u003cline x1=\"6\" x2=\"6\" y1=\"4\" y2=\"20\">\u003c/line>\u003cpolygon points=\"10,4 20,12 10,20\">\u003c/polygon>\u003c/svg>","\u003csvg xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" class=\"lucide lucide-skip-forward\">\u003cpolygon points=\"5 4 15 12 5 20 5 4\">\u003c/polygon>\u003cline x1=\"19\" x2=\"19\" y1=\"5\" y2=\"19\">\u003c/line>\u003c/svg>","\u003csvg xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" class=\"lucide lucide-square-dashed-mouse-pointer\">\u003cpath d=\"M12.034 12.681a.498.498 0 0 1 .647-.647l9 3.5a.5.5 0 0 1-.033.943l-3.444 1.068a1 1 0 0 0-.66.66l-1.067 3.443a.5.5 0 0 1-.943.033z\">\u003c/path>\u003cpath d=\"M5 3a2 2 0 0 0-2 2\">\u003c/path>\u003cpath d=\"M19 3a2 2 0 0 1 2 2\">\u003c/path>\u003cpath d=\"M5 21a2 2 0 0 1-2-2\">\u003c/path>\u003cpath d=\"M9 3h1\">\u003c/path>\u003cpath d=\"M9 21h2\">\u003c/path>\u003cpath d=\"M14 3h1\">\u003c/path>\u003cpath d=\"M3 9v1\">\u003c/path>\u003cpath d=\"M21 9v2\">\u003c/path>\u003cpath d=\"M3 14v1\">\u003c/path>\u003c/svg>","\u003csvg xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" class=\"lucide lucide-hand\">\u003cpath d=\"M18 11V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2\">\u003c/path>\u003cpath d=\"M14 10V4a2 2 0 0 0-2-2a2 2 0 0 0-2 2v2\">\u003c/path>\u003cpath d=\"M10 10.5V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2v8\">\u003c/path>\u003cpath d=\"M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15\">\u003c/path>\u003c/svg>","\u003csvg xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" class=\"lucide lucide-maximize\">\u003cpath d=\"M8 3H5a2 2 0 0 0-2 2v3\">\u003c/path>\u003cpath d=\"M21 8V5a2 2 0 0 0-2-2h-3\">\u003c/path>\u003cpath d=\"M3 16v3a2 2 0 0 0 2 2h3\">\u003c/path>\u003cpath d=\"M16 21h3a2 2 0 0 0 2-2v-3\">\u003c/path>\u003c/svg>","\u003csvg xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" class=\"lucide lucide-square-pen\">\u003cpath d=\"M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7\">\u003c/path>\u003cpath d=\"M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z\">\u003c/path>\u003c/svg>","\u003csvg xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" class=\"lucide lucide-fold-vertical\">\u003cpath d=\"M12 22v-6\">\u003c/path>\u003cpath d=\"M12 8V2\">\u003c/path>\u003cpath d=\"M4 12H2\">\u003c/path>\u003cpath d=\"M10 12H8\">\u003c/path>\u003cpath d=\"M16 12h-2\">\u003c/path>\u003cpath d=\"M22 12h-2\">\u003c/path>\u003cpath d=\"m15 19-3-3-3 3\">\u003c/path>\u003cpath d=\"m15 5-3 3-3-3\">\u003c/path>\u003c/svg>","\u003csvg xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" class=\"lucide lucide-clipboard-list\">\u003crect width=\"8\" height=\"4\" x=\"8\" y=\"2\" rx=\"1\" ry=\"1\">\u003c/rect>\u003cpath d=\"M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2\">\u003c/path>\u003cpath d=\"M12 11h4\">\u003c/path>\u003cpath d=\"M12 16h4\">\u003c/path>\u003cpath d=\"M8 11h.01\">\u003c/path>\u003cpath d=\"M8 16h.01\">\u003c/path>\u003c/svg>","\u003csvg xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" class=\"lucide lucide-pencil-line\">\u003cpath d=\"M12 20h9\">\u003c/path>\u003cpath d=\"M16.376 3.622a1 1 0 0 1 3.002 3.002L7.368 18.635a2 2 0 0 1-.855.506l-2.872.838a.5.5 0 0 1-.62-.62l.838-2.872a2 2 0 0 1 .506-.854z\">\u003c/path>\u003cpath d=\"m15 5 3 3\">\u003c/path>\u003c/svg>","\u003csvg xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" class=\"lucide lucide-chevron-right step-chev\">\u003cpath d=\"m9 18 6-6-6-6\">\u003c/path>\u003c/svg>","\u003csvg xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" class=\"lucide lucide-chevron-down\">\u003cpath d=\"m6 9 6 6 6-6\">\u003c/path>\u003c/svg>","\u003csvg xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" class=\"lucide lucide-copy\">\u003crect width=\"14\" height=\"14\" x=\"8\" y=\"8\" rx=\"2\" ry=\"2\">\u003c/rect>\u003cpath d=\"M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2\">\u003c/path>\u003c/svg>","\u003csvg xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" class=\"lucide lucide-slice\">\u003cpath d=\"M11 16.586V19a1 1 0 0 1-1 1H2L18.37 3.63a1 1 0 1 1 3 3l-9.663 9.663a1 1 0 0 1-1.414 0L8 14\">\u003c/path>\u003c/svg>","\u003csvg xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" class=\"lucide lucide-scissors\">\u003ccircle cx=\"6\" cy=\"6\" r=\"3\">\u003c/circle>\u003cpath d=\"M8.12 8.12 12 12\">\u003c/path>\u003cpath d=\"M20 4 8.12 15.88\">\u003c/path>\u003ccircle cx=\"6\" cy=\"18\" r=\"3\">\u003c/circle>\u003cpath d=\"M14.8 14.8 20 20\">\u003c/path>\u003c/svg>","\u003csvg xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" class=\"lucide lucide-trash2\">\u003cpath d=\"M3 6h18\">\u003c/path>\u003cpath d=\"M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6\">\u003c/path>\u003cpath d=\"M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2\">\u003c/path>\u003cline x1=\"10\" x2=\"10\" y1=\"11\" y2=\"17\">\u003c/line>\u003cline x1=\"14\" x2=\"14\" y1=\"11\" y2=\"17\">\u003c/line>\u003c/svg>","\u003csvg xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" class=\"lucide lucide-magnet\">\u003cpath d=\"m6 15-4-4 6.75-6.77a7.79 7.79 0 0 1 11 11L13 22l-4-4 6.39-6.36a2.14 2.14 0 0 0-3-3L6 15\">\u003c/path>\u003cpath d=\"m5 8 4 4\">\u003c/path>\u003cpath d=\"m12 15 4 4\">\u003c/path>\u003c/svg>","\u003csvg xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" class=\"lucide lucide-scan-line\">\u003cpath d=\"M3 7V5a2 2 0 0 1 2-2h2\">\u003c/path>\u003cpath d=\"M17 3h2a2 2 0 0 1 2 2v2\">\u003c/path>\u003cpath d=\"M21 17v2a2 2 0 0 1-2 2h-2\">\u003c/path>\u003cpath d=\"M7 21H5a2 2 0 0 1-2-2v-2\">\u003c/path>\u003cpath d=\"M7 12h10\">\u003c/path>\u003c/svg>","\u003csvg xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" class=\"lucide lucide-link2\">\u003cpath d=\"M9 17H7A5 5 0 0 1 7 7h2\">\u003c/path>\u003cpath d=\"M15 7h2a5 5 0 1 1 0 10h-2\">\u003c/path>\u003cline x1=\"8\" x2=\"16\" y1=\"12\" y2=\"12\">\u003c/line>\u003c/svg>","\u003csvg xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" class=\"lucide lucide-zoom-out\">\u003ccircle cx=\"11\" cy=\"11\" r=\"8\">\u003c/circle>\u003cline x1=\"21\" x2=\"16.65\" y1=\"21\" y2=\"16.65\">\u003c/line>\u003cline x1=\"8\" x2=\"14\" y1=\"11\" y2=\"11\">\u003c/line>\u003c/svg>","\u003csvg xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" class=\"lucide lucide-zoom-in\">\u003ccircle cx=\"11\" cy=\"11\" r=\"8\">\u003c/circle>\u003cline x1=\"21\" x2=\"16.65\" y1=\"21\" y2=\"16.65\">\u003c/line>\u003cline x1=\"11\" x2=\"11\" y1=\"8\" y2=\"14\">\u003c/line>\u003cline x1=\"8\" x2=\"14\" y1=\"11\" y2=\"11\">\u003c/line>\u003c/svg>","\u003csvg xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" class=\"lucide lucide-chevrons-left-right\">\u003cpath d=\"m9 7-5 5 5 5\">\u003c/path>\u003cpath d=\"m15 7 5 5-5 5\">\u003c/path>\u003c/svg>","\u003csvg xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" class=\"lucide lucide-eye\">\u003cpath d=\"M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0\">\u003c/path>\u003ccircle cx=\"12\" cy=\"12\" r=\"3\">\u003c/circle>\u003c/svg>","\u003csvg xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" class=\"lucide lucide-lock-open\">\u003crect width=\"18\" height=\"11\" x=\"3\" y=\"11\" rx=\"2\" ry=\"2\">\u003c/rect>\u003cpath d=\"M7 11V7a5 5 0 0 1 9.9-1\">\u003c/path>\u003c/svg>","\u003csvg xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" class=\"lucide lucide-layers\">\u003cpath d=\"m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z\">\u003c/path>\u003cpath d=\"m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65\">\u003c/path>\u003cpath d=\"m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65\">\u003c/path>\u003c/svg>","\u003csvg xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" class=\"lucide lucide-sliders-horizontal\">\u003cline x1=\"21\" x2=\"14\" y1=\"4\" y2=\"4\">\u003c/line>\u003cline x1=\"10\" x2=\"3\" y1=\"4\" y2=\"4\">\u003c/line>\u003cline x1=\"21\" x2=\"12\" y1=\"12\" y2=\"12\">\u003c/line>\u003cline x1=\"8\" x2=\"3\" y1=\"12\" y2=\"12\">\u003c/line>\u003cline x1=\"21\" x2=\"16\" y1=\"20\" y2=\"20\">\u003c/line>\u003cline x1=\"12\" x2=\"3\" y1=\"20\" y2=\"20\">\u003c/line>\u003cline x1=\"14\" x2=\"14\" y1=\"2\" y2=\"6\">\u003c/line>\u003cline x1=\"8\" x2=\"8\" y1=\"10\" y2=\"14\">\u003c/line>\u003cline x1=\"16\" x2=\"16\" y1=\"18\" y2=\"22\">\u003c/line>\u003c/svg>","\u003csvg xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" class=\"lucide lucide-volume2\">\u003cpath d=\"M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z\">\u003c/path>\u003cpath d=\"M16 9a5 5 0 0 1 0 6\">\u003c/path>\u003cpath d=\"M19.364 18.364a9 9 0 0 0 0-12.728\">\u003c/path>\u003c/svg>","data:image/png;base64,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","\u003csvg class=\"envelope\" data-testid=\"envelope\" data-keys=\"0\" viewBox=\"0 0 1679 100\" preserveAspectRatio=\"none\">\u003cpath class=\"env-line\" d=\"M0.0,25.00L1681.0,25.00\">\u003c/path>\u003c/svg>","data:image/png;base64,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","\u003csvg class=\"envelope\" data-testid=\"envelope\" data-keys=\"0\" viewBox=\"0 0 172.10357142857143 100\" preserveAspectRatio=\"none\">\u003cpath class=\"env-line\" d=\"M0.0,25.00L174.1,25.00\">\u003c/path>\u003c/svg>","data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAdCAYAAACjbey/AAABAElEQVR4AeySwQ2CMBSGW51CHMAN2ARubKBnm3g2wbNu4A026QYOIE5haj8JpqYgxR6V5Oe9pu99/V9hJiKfeIBq6vP2Wm++NWIdmFRKs44AtK2qqS6oXYW/rYP34qnjeADGUfZewIbAPACNQphU2ZGAsQa0u1UpeRfJ0QCArVbKugF0N+L5tYhAlD2AilEAbihEgIhAiDgLAFDaL4BRALB/gBC/fgfGyFPAHUjND4PmUhRuPCyz4yigTLKCk2jeL3LdxTLJV8AGAFJTQCNFnEQzeRfJkQegiVPZpJH4SR4gpMkFvgBYRu5mSG4BUmM7pLivZsa8U227IOvAXU7PHwAAAP//1JOfpQAAAAZJREFUAwAFl2U70GFD7wAAAABJRU5ErkJggg==","\u003csvg class=\"envelope\" data-testid=\"envelope\" data-keys=\"0\" viewBox=\"0 0 16.010714285714286 100\" preserveAspectRatio=\"none\">\u003cpath class=\"env-line\" d=\"M0.0,25.00L18.0,25.00\">\u003c/path>\u003c/svg>","data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAC4AAAAdCAYAAADVV140AAAB9ElEQVR4AeyW0U3DMBCG7XYKygDdIJu0b90AnrHEM1J5hg361m6SDToAZQpk/JH+aSEkjZ0QqSIRH76zfXe/Lw5iYq70uV7h7rDbPLzt7odqPPWga73QcZ9Z6++6Jmof7zNjfPb4vv2ifdz3nUF4MeEO2z0U3t///vBmA6k1S+GSyrUB+UOMLlzX2DoV4Vwb4FWSbJhD+EziqQfUbqIiXJuL17jbcAgSgdZ0KPn9jIjf7qkHHATqctcKLwL4kIwhESAeOBTi3dl3gW/C48Jrh2CWP8RAOdHKoHbxEbtjHXJgE35BOFtOIB6YQTwjuCAW34UC/MUAF+YEMYDP/hjIq/3kwKZJUcIJ+h2683OFOaE1fNnpI4fpSXi6iNTIUXhq51Ljxo6ndi41bux4audS4/57x21e7RxzQqv4stPHqTWrqI4TAJTUiL2eLVb469lybgzibM6c8N6+Ar6JfMirEHJgP90s8wvCERH+8zgWJgBIxohQUDJGxAG2eL5dvID8diO1bX5ehxyqVyt8Gl4HAjglAaCCJJPd38hbWs6pB9SGuvwV4QSBxJ0LrkvSfR7RixV5qAfYTVSEEwRNQf2unUTH5C2Fc3cgJrjLXr4TaLoOTfmDcJtzNZo29blGLeAqQmruCSce8mpQC1IFKy50XOZ1jZ8AAAD//4EPVbwAAAAGSURBVAMAlaAjSs0k+HcAAAAASUVORK5CYII=","\u003csvg class=\"envelope\" data-testid=\"envelope\" data-keys=\"0\" viewBox=\"0 0 46.028571428571425 100\" preserveAspectRatio=\"none\">\u003cpath class=\"env-line\" d=\"M0.0,25.00L48.0,25.00\">\u003c/path>\u003c/svg>","\u003csvg xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" class=\"lucide lucide-chevron-right\">\u003cpath d=\"m9 18 6-6-6-6\">\u003c/path>\u003c/svg>","\u003csvg xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" class=\"lucide lucide-diamond\">\u003cpath d=\"M2.7 10.3a2.41 2.41 0 0 0 0 3.41l7.59 7.59a2.41 2.41 0 0 0 3.41 0l7.59-7.59a2.41 2.41 0 0 0 0-3.41l-7.59-7.59a2.41 2.41 0 0 0-3.41 0Z\">\u003c/path>\u003c/svg>","\u003csvg xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" class=\"lucide lucide-rotate-ccw\">\u003cpath d=\"M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8\">\u003c/path>\u003cpath d=\"M3 3v5h5\">\u003c/path>\u003c/svg>","\u003csvg xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" class=\"lucide lucide-ban\">\u003ccircle cx=\"12\" cy=\"12\" r=\"10\">\u003c/circle>\u003cpath d=\"m4.9 4.9 14.2 14.2\">\u003c/path>\u003c/svg>","data:image/jpeg;base64,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","data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/4gHYSUNDX1BST0ZJTEUAAQEAAAHIAAAAAAQwAABtbnRyUkdCIFhZWiAH4AABAAEAAAAAAABhY3NwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAA9tYAAQAAAADTLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAlkZXNjAAAA8AAAACRyWFlaAAABFAAAABRnWFlaAAABKAAAABRiWFlaAAABPAAAABR3dHB0AAABUAAAABRyVFJDAAABZAAAAChnVFJDAAABZAAAAChiVFJDAAABZAAAAChjcHJ0AAABjAAAADxtbHVjAAAAAAAAAAEAAAAMZW5VUwAAAAgAAAAcAHMAUgBHAEJYWVogAAAAAAAAb6IAADj1AAADkFhZWiAAAAAAAABimQAAt4UAABjaWFlaIAAAAAAAACSgAAAPhAAAts9YWVogAAAAAAAA9tYAAQAAAADTLXBhcmEAAAAAAAQAAAACZmYAAPKnAAANWQAAE9AAAApbAAAAAAAAAABtbHVjAAAAAAAAAAEAAAAMZW5VUwAAACAAAAAcAEcAbwBvAGcAbABlACAASQBuAGMALgAgADIAMAAxADb/2wBDAAkGBwgHBgkIBwgKCgkLDRYPDQwMDRsUFRAWIB0iIiAdHx8kKDQsJCYxJx8fLT0tMTU3Ojo6Iys/RD84QzQ5Ojf/2wBDAQoKCg0MDRoPDxo3JR8lNzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzf/wAARCAA9AGwDASIAAhEBAxEB/8QAGwAAAgMBAQEAAAAAAAAAAAAAAAUCBAYBBwP/xAAxEAABAwIEBQMCBQUAAAAAAAABAAIDBBEFExRhBhIhMVFBcYEiQgckMpGxQ2JyofD/xAAaAQACAwEBAAAAAAAAAAAAAAAAAwIEBgUB/8QAKhEAAQQBAwMDAwUAAAAAAAAAAQACAxEEEhRhEyExBVFSMoGhIkGRsdH/2gAMAwEAAhEDEQA/AK2m2Rptk302yNNsm7/lebLhKNNsjTbJvptkabZG/wCUbLhKNNsjTbJvptkabZG/5RsuEo02yNNsm+m2Rptkb/lGy4SjTbI02yb6bZGm2Rv+UbLhKNNsjTbJvptkabZG/wCUbLhKNNsjTbJvptkabZG/5RsuE40+yNPsmmRsqGK4hR4TDmVclif0xt6ud7BZMSyONBaJ3SaLPhfLT7I0+yybuMa3VmRsMWR2yT4/y8/9ZaHC+JcNr+Vkj9NMftlPS+zu38Jz2TsFlVo8rGkNA/yren2Rp9kzENxcdQu5GyR1nq1pjSvT7I0+y7i2K0GFN/NSgyWuImdXH49PlYjFuJa3EOaOL8vAfsYep9ynxNmk8eFVnyYIex7n2W5jopJb5Ubn278rSVA0xBsRYrDYJxLiuCECiqTk3uYZPqYfj0+LLZQccYbirGCvhNHVA25x9THD37j5/dNkhlaLBtIhzonupwpffT7I0+yYxsZKwPic17D1Dmm4KnkbKn1nro6Y0r0+yNPsrVdU0lBHz1lRHEPTmPU+w7lZ2o4zoWSFsFNNKwfcSG3+Exhmf9ISpJceP6irvEfGEFHzU2Fcs8/Z0pF2M9vJ/wBe68/qqierndPUyPklcernd1DPVihjlrquOmpxeSQ2F+w3K0LPTo4hepZeTMlndRH2VWx8FFj4K2buDzkfRWkzW9WfTf8AlZKoMlNPJBM3lkjcWuHgoiiilvQ/8ImZNDWttWruFY7iWFECmmcYh/SkHMz9vT4smuJ8a4hVwCKmibSXFnvYbuPsfT+d1mc9GepH02Mmz/Si3Nla3SD2XHl8j3PeXOc43LndSSuWPgqWejPU9kPkldY+yjY+Cix8FSz0Z692Q+SOsfZW8NxSvwx/NRTvjBNyzu13uD0Teu4zxaqiEcQjpulnOib1PyeyzuejPSz6dG42T+ExuZK0aR4XZZJZpHSTPfJI43c55JJ+VCx8FSz0Z6nsh8kvrH2SzPTbhfFocOxmGepNoerXOtfluO6zGY5GY5WHgPaWn90xlscHDyF7y+upGU2pfUwiC18znHKfleTY9ijMQxeqqoukb3/R6XAAAPzZZ/McjMcq2PjCEk3at5WU7IaGkUAmOetDhTWSUET3MaSb9SNysbmOX1ZXVUbAyOeVrR2DXkAKeRGZW6QaTvSsuPCmMj26gRX5H+L1bgemp5sRxFksETw2KIgOYDa5crfHVJSwUVCYqaFhdWBpLYwLjkf0XklPjGJUz3Ppq+qic8AOdHM5pcB2vY7ldqMbxSqa1tTiNXMGu5miSdzrHtcXPfqVzx6fKMkTa+wrt9qRmZkc7ZA1tar+1rYVscbaOdwjYCI3G/KPCXxNaY2HlHVo9FmnYhWOaWuqZi0ixBkNiFEVtSBYTyAD+8rQYk7YSdQu1ysWMwg6u9r3X8KKKjquHal9RSU8r210jQ6SJrjYBvTqFhPx5jio8eo46ONkDTSMcRE0NBPPJ49gsfR4/jFBEYqHFK6mjc4vLIah7AXHubA91XxDEazFJWy4lVTVkjW8ofUSGQgdelzfp1P7qi5pLy6/Ks6xQFKlhM8mpdzvc4ch6E39Qm+elbeVhuxjWnyBZTzHKbP0ikuSnOtf/9k=","data:image/jpeg;base64,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","data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/4gHYSUNDX1BST0ZJTEUAAQEAAAHIAAAAAAQwAABtbnRyUkdCIFhZWiAH4AABAAEAAAAAAABhY3NwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAA9tYAAQAAAADTLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAlkZXNjAAAA8AAAACRyWFlaAAABFAAAABRnWFlaAAABKAAAABRiWFlaAAABPAAAABR3dHB0AAABUAAAABRyVFJDAAABZAAAAChnVFJDAAABZAAAAChiVFJDAAABZAAAAChjcHJ0AAABjAAAADxtbHVjAAAAAAAAAAEAAAAMZW5VUwAAAAgAAAAcAHMAUgBHAEJYWVogAAAAAAAAb6IAADj1AAADkFhZWiAAAAAAAABimQAAt4UAABjaWFlaIAAAAAAAACSgAAAPhAAAts9YWVogAAAAAAAA9tYAAQAAAADTLXBhcmEAAAAAAAQAAAACZmYAAPKnAAANWQAAE9AAAApbAAAAAAAAAABtbHVjAAAAAAAAAAEAAAAMZW5VUwAAACAAAAAcAEcAbwBvAGcAbABlACAASQBuAGMALgAgADIAMAAxADb/2wBDAAkGBwgHBgkIBwgKCgkLDRYPDQwMDRsUFRAWIB0iIiAdHx8kKDQsJCYxJx8fLT0tMTU3Ojo6Iys/RD84QzQ5Ojf/2wBDAQoKCg0MDRoPDxo3JR8lNzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzf/wAARCAA9AGwDASIAAhEBAxEB/8QAGwAAAgIDAQAAAAAAAAAAAAAAAAUEBgECAwf/xAAzEAABAwQBAgUBBgYDAAAAAAABAAIDBBETYQUSIQYxQVFxIgcUMkKBkSMkQ1Kh0VNy8P/EABkBAAMBAQEAAAAAAAAAAAAAAAACAwQFAf/EACMRAAICAgICAgMBAAAAAAAAAAABAgMRExIUBCExMiJhcVH/2gAMAwEAAhEDEQA/AM4NIwaTPBpGDS97A+gWYNIwaTPBpGDSOwGgWYNIwaTPBpGDSOwGgWYNIwaTPBpGDSOwGgWYNIwaTPBpGDSOwGgWYNIwaTPBpGDSOwGgWYNIwaTPBpGDSOwGgZ4NIwaTHCofI1lLx0XXUvsT+Fg7ud8BcdTk3hHSfBLLOWDSMGlXD4nqvvJe2KPD/wAR/wB+6d8fz1BWWa9+CU/lk8r6KrKFsVklG2qTwmSMGkYNJhiv3CzhUdki2Ii7BpGDS25LkaPjm/zEl5PSNvdx/wBfqqnyXPVVbdkf8CE/lae5+Sq1xsn/AAjZbXD+lsjpHyXxxufb+0XWpgsbEWKqXE89yPEkCkqDjvcxP+ph/T0/RWmHxbQcixorIjS1INur8THD59P/AHdPOuyPteycPIhJ4awdMGkYNKexjJGB8bmuafItNwVthWfZI1YiLsGkYNKTVz01GzrqpmRj06j3PwPVJJvFNI2QiKCWRo/MbNunjsl8ISUq4/LJXO+J4abqg44CabyMlrtb8e5/wqZUTTVMzpp3ukkd5uctM212pGSVdSyCEXe82F/Ta6sPFhWvk5Mr52M4WPsUWPsVaHeGTi+mqOW3q36bqtzl8Ez4pQWvYbOG0QUJ/VhOM4fZEvjuYr+OIFPKTGP6b+7f29P0TGv8V1tTCI6eNtNcWc5puT8eyQZtozbXr8WDeWeK+aWEDi97i55c5xNyT3JKxY+xWc20Ztp9P7E5sxY+xRY+xWc20Zto0/sObJNByFZx7+qlmewXuW+bT8hM6vxTyNRGGRhkHaznRt7n9/JI820ZtpH4sG8sZXTSwjMj5JXmSVznvd3LnG5K1sfYrObaM20+lf6LzYvzbTHw/wAlFQ8pFNObR92uNvw39VX8hRkKrKKkmmNH8Wmj2F1XTMgzuniEPnk6xb915zzHIMreTqKiPsx7vp7eYAsD/hJMhRkKjTQq23ktdc7Elgn5tpvQBr6Rji0Em/psqs5CujaudjQ1kr2tHkA4gJ7IOawh/DvjRY5SWfR6N4Ogglra5ssMbw1kZAc0G3dymeL6anhpaMxwRMLqoAlrALjpcvMoOTrqdznU9ZUROcAHFkrmk28r2K2m5bkagNE9dUyhp6mh8znWPuLnaydSe5WcvR7ffGxSSWMlpq4420szgxoIjcfLSWsALGmw8h6JG6uqnNLXVEpBFiC891qKqcCwlfb/ALFdGl8M5MdMdecnsH2b0lLU8HO+emhkcKt7bvjBNrN91T/tjZHS8xSspWNhaaZhIjHSCep/sqxS81ylHGY6TkKuBhd1FsU7mgk+tgfNcK2uquQkElfUS1TwOkOneXkD2ufk/us6qexzyV5Ii8bM/wC8O6nuI6T5nYTPMl7elpu1jQdBbZCrISXt5P/Z","data:image/jpeg;base64,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","data:image/jpeg;base64,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","data:image/jpeg;base64,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","data:image/jpeg;base64,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","data:image/jpeg;base64,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","data:image/jpeg;base64,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","data:image/jpeg;base64,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","data:image/jpeg;base64,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","data:image/jpeg;base64,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","data:image/jpeg;base64,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","data:image/jpeg;base64,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","data:image/jpeg;base64,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","\u003csvg xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" class=\"lucide lucide-chevron-right ctx-more\">\u003cpath d=\"m9 18 6-6-6-6\">\u003c/path>\u003c/svg>"]};

const SLOTS = {
  composer: {
    box: ".composer-box",
    input: ".composer-box > textarea",
    text: ".composer-hl",
    context: ".composer-ctx",
    send: ".send",
    attach: ".composer-at",
    model: ".choice.model",
  },
  message: { text: ".msg-user" },
  turn: { reply: ".reply", steps: ".worklog", step: ".worklog .step", edit: ".edit-row", review: ".card-item" },
  storyboard: { summary: ".approval-text", beats: ".beats", beat: ".beat", approve: ".btn.primary", edit: ".approval-btns .btn.ghost" },
  review: { head: ".card-head", status: ".card-outcome", scores: ".scores", score: ".score", bar: ".score-bar > span" },
  timeline: {
    toolbar: ".bottom-toolbar",
    ruler: ".tl-ruler",
    lanes: ".tl-lanes",
    heads: ".tl-heads",
    playhead: ".playhead",
    clip: ".clip",
    lane: ".tl-lane",
    main: ".tl-lane.main",
  },
  preview: { frame: ".frame", transport: ".transport", timecode: ".timecode", play: ".icon-btn.play" },
  inspector: {
    title: ".insp-title",
    filter: '[data-testid="insp-filter"]',
    amount: '[data-testid="insp-filter-intensity"]',
    effects: '[data-testid="insp-effects"]',
    effect: '[data-testid="insp-effect"]',
    transform: '[data-testid="insp-sec-transform"]',
  },
  effects: {
    search: ".tr-search",
    target: '[data-testid="effects-target"]',
    filters: '[data-testid="filters-grid"]',
    tile: '[data-testid="filter-tile"]',
    none: '[data-look="none"]',
    natural: '[data-look="natural"]',
    warm: '[data-look="warm"]',
    cool: '[data-look="cool"]',
    vintage: '[data-look="vintage"]',
    film: '[data-look="film"]',
    bw: '[data-look="bw"]',
    vivid: '[data-look="vivid"]',
  },
  export: {
    close: ".export-head .icon-btn",
    draft: '[data-testid="quality-draft"]',
    standard: '[data-testid="quality-standard"]',
    high: '[data-testid="quality-high"]',
    file: '[data-testid="export-name"]',
    motionBlur: 'input[type="checkbox"]',
    cancel: ".wiz-foot .btn.ghost",
    export: ".wiz-foot .btn.primary",
  },
  exportProgress: {
    job: '[data-testid="export-job"]',
    progress: ".export-status",
    bar: ".export-bar",
    fill: ".export-bar > div",
    cancel: '[data-testid="export-cancel"]',
  },
  topbar: { export: ".export-btn", saved: ".saved", title: ".project-title" },
  agent: { tabs: ".tabs", thread: ".agent-thread", composer: ".composer", send: ".send", plan: ".plan-chip-btn" },
  menu: { item: ".ctx-item", addToChat: '[data-testid="menu-add-to-chat"]', label: ".ctx-label", key: ".ctx-key", sep: ".ctx-sep" },
  editor: {
    topbar: ".topbar",
    export: ".export-btn",
    rail: ".rail",
    library: ".library",
    preview: ".stage",
    frame: ".frame",
    side: ".side",
    composer: ".composer",
    send: ".send",
    thread: ".agent-thread",
    timeline: ".bottom",
    playhead: ".playhead",
  },
};

function parts() {
  return Object.keys(DATA.parts);
}

function slots(name) {
  part(name);
  return Object.keys(SLOTS[name] || {});
}

function size(name) {
  const p = part(name);
  return { width: p.width, height: p.height };
}

function part(name) {
  const p = Object.hasOwn(DATA.parts, name) ? DATA.parts[name] : undefined;
  if (!p) throw new Error(`uncutUI: no part "${name}" (parts: ${parts().join(", ")})`);
  return p;
}

function css() {
  return DATA.css;
}

function ensureCss(doc) {
  if (doc.querySelector("style[data-uncut-ui]")) return;
  const style = doc.createElement("style");
  style.setAttribute("data-uncut-ui", "");

  style.textContent = `${DATA.css}\n[data-uncut-fly-hidden],[data-uncut-fly-hidden] *{visibility:hidden !important}`;
  (doc.head || doc.documentElement).appendChild(style);
}

const SHELL =
  "display:block;position:relative;width:100%;height:100%;margin:0;padding:0;border:0;background:none;box-shadow:none;outline:0;overflow:visible;transform:none;opacity:1;filter:none;backdrop-filter:none;inset:auto;min-width:0;min-height:0;max-width:none;max-height:none;";

function mount(host , name , props) {
  const p = part(name);
  const o = props || {};
  const doc = host.ownerDocument;
  ensureCss(doc);

  const stable = { ...o, scale: undefined, blur: undefined, dim: undefined, time: undefined };
  if (name === "editor") for (const k of EDITOR_LIVE_PROPS) stable[k] = undefined;
  const key = `${name}\n${keyOf(stable)}`;
  let wrap = host.firstElementChild ;
  if (!wrap || wrap.__uiKey !== key) {
    const width = num(o.width, p.width);
    const height = num(o.height, p.height);
    wrap = doc.createElement("div") ;
    wrap.className = "uncut-ui";
    wrap.__uiKey = key;
    wrap.__uiName = name;
    wrap.setAttribute("data-part", name);
    let at = wrap;
    for (const a of p.ancestors) {
      const shell = doc.createElement(a.tag);
      if (a.cls) shell.className = a.cls;
      for (const k of Object.keys(a.attrs)) shell.setAttribute(k, a.attrs[k] );
      shell.setAttribute("style", SHELL + a.vars);
      at.appendChild(shell);
      at = shell;
    }
    const tpl = doc.createElement("template");
    tpl.innerHTML = expand(p.html);
    const root = tpl.content.firstElementChild ;
    root.style.width = `${width}px`;
    root.style.height = `${height}px`;
    root.style.margin = "0";
    root.style.position = root.style.position || "relative";
    at.appendChild(root);
    const back = typeof o.background === "string" ? o.background : p.backdrop;
    wrap.style.cssText = `position:relative;width:${width}px;height:${height}px;transform-origin:0 0${back ? `;background:${back};border-radius:${p.radius || "0"}` : ""}`;
    neutral(root);
    applyProps(name, root, name === "editor" ? { media: o.media } : o);
    host.replaceChildren(wrap);

    for (const el of wrap.querySelectorAll("[data-ui-scroll]")) el.scrollTop = Number(el.getAttribute("data-ui-scroll"));
  }
  const scale = num(o.scale, 1);
  wrap.style.transform = `scale(${scale})`;

  const blur = Math.max(0, num(o.blur, 0));
  const dim = Math.max(0, Math.min(1, num(o.dim, 0)));
  wrap.style.filter =
    `${blur > 0.05 ? `blur(${(blur / Math.max(scale, 0.01)).toFixed(2)}px) ` : ""}${dim > 0.001 ? `brightness(${(1 - dim).toFixed(3)})` : ""}`.trim() || "none";
  const root = rootOf(wrap);
  if (name === "editor") liveEditor(root, o);
  placeElements(name, root, o);
  spin(root, o.time);
  return root;
}

function spin(root , time) {
  const turn = typeof time === "number" && Number.isFinite(time) ? ((time / 0.9) % 1) * 360 : 0;
  for (const el of root.querySelectorAll(".spin")) {
    const st = (el).style;
    st.animation = "none";
    st.transformOrigin = "50% 50%";
    st.transform = `rotate(${turn.toFixed(2)}deg)`;
  }
}

const EDITOR_LIVE_PROPS = [
  "side",
  "library",
  "composer",
  "turn",
  "message",
  "review",
  "inspector",
  "effects",
  "timeline",
  "preview",
  "topbar",
  "export",
  "exportProgress",
  "text",
  "press",
  "highlight",
  "hide",
  "remove",
];

function liveEditor(root , o) {
  const doc = root.ownerDocument;
  if (!root.__pristine) {
    root.__pristine = new Map();
    root.__liveKeys = new Map();
    for (const sel of [".side", ".library", ".bottom", ".stage", ".topbar"]) {
      const el = root.querySelector(sel) ;
      if (el) root.__pristine.set(sel, el.cloneNode(true));
    }
  }
  const sub = (k) => (o[k] && typeof o[k] === "object" ? (o[k]) : undefined);
  const fresh = (name) => {
    const tpl = doc.createElement("template");
    tpl.innerHTML = expand(part(name).html);
    const el = tpl.content.firstElementChild ;
    neutral(el);
    return el;
  };
  const clips = (sub("timeline")?.clips) ?? [];
  const length = clips.reduce((m, c) => Math.max(m, num(c.start, 0) + num(c.duration, 0)), 0);
  const common = keyOf({ text: o.text, press: o.press, highlight: o.highlight, hide: o.hide, remove: o.remove });

  const pristine = (sel) => root.__pristine .get(sel) .cloneNode(true) ;
  const units = [
    {
      sel: ".side",
      spec: [o.side, o.composer, o.turn, o.message, o.review, o.inspector],
      base: () => (o.side === "inspector" ? fresh("inspector") : pristine(".side")),
      apply: (el) => (o.side === "inspector" ? applyProps("inspector", el, sub("inspector") || {}) : nested(el, o, ["composer", "turn", "message", "review"])),
    },
    {
      sel: ".library",
      spec: [o.library, o.effects],
      base: () => (o.library === "effects" ? fresh("effects") : pristine(".library")),
      apply: (el) => {
        if (o.library === "effects") applyProps("effects", el, sub("effects") || {});
        for (const b of root.querySelectorAll(".rail [data-rail]"))
          b.classList.toggle("active", b.getAttribute("data-rail") === (o.library === "effects" ? "effects" : "media"));
      },
    },
    { sel: ".bottom", spec: [o.timeline], base: () => pristine(".bottom"), apply: (el) => applyProps("timeline", el, sub("timeline") || {}) },
    {
      sel: ".stage",
      spec: [o.preview, length],
      base: () => pristine(".stage"),
      apply: (el) => applyProps("preview", el, { duration: length, ...sub("preview") }),
    },
    { sel: ".topbar", spec: [o.topbar], base: () => pristine(".topbar"), apply: (el) => applyProps("topbar", el, sub("topbar") || {}) },
  ];
  let changed = false;
  for (const u of units) {
    if (!root.__pristine.has(u.sel)) continue;
    const key = `${keyOf({ s: u.spec })}\n${common}`;
    if (root.__liveKeys .get(u.sel) === key) continue;
    const next = u.base();
    const cur = root.querySelector(u.sel);
    if (cur) {
      cur.replaceWith(next);
      u.apply(next);
    }
    root.__liveKeys .set(u.sel, key);
    changed = true;
  }

  const dialog = sub("exportProgress") ? "exportProgress" : sub("export") ? "export" : "";
  const dkey = `${dialog}\n${keyOf({ d: dialog ? o[dialog] : null })}\n${common}`;
  if (root.__liveKeys .get("modal") !== dkey) {
    root.querySelector(":scope > .modal-layer")?.remove();
    if (dialog) {
      const layer = doc.createElement("div");
      const anc = part(dialog).ancestors.at(-1);
      layer.className = anc?.cls || "modal-layer";
      if (anc?.vars) layer.setAttribute("style", anc.vars);
      const el = fresh(dialog);
      layer.appendChild(el);
      root.appendChild(layer);
      applyProps(dialog, el, { duration: length, ...sub(dialog) });
    }
    root.__liveKeys .set("modal", dkey);
    changed = true;
  }
  if (changed) applyProps("", root, { text: o.text, press: o.press, highlight: o.highlight, hide: o.hide, remove: o.remove });
}

function rootOf(wrap) {
  let at = wrap;
  while (at.firstElementChild) {
    const next = at.firstElementChild;
    if (next.getAttribute("style")?.startsWith(SHELL)) at = next;
    else return next ;
  }
  return at ;
}

function keyOf(o) {
  return JSON.stringify(o, (k, v) => (k && typeof v === "object" && v !== null && "nodeType" in v ? "[element]" : v));
}

function num(v , fallback) {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function find(root , slot , name) {
  const owner = name || partName(root);
  const sel = (owner && SLOTS[owner]?.[slot]) || slot;
  if (root.matches(sel)) return root ;
  return root.querySelector(sel) ;
}

function findAll(root , slot , name) {
  const owner = name || partName(root);
  const sel = (owner && SLOTS[owner]?.[slot]) || slot;
  return [...(root.matches(sel) ? [root] : []), ...root.querySelectorAll(sel)] ;
}

function partName(el) {
  const wrap = el.closest(".uncut-ui") ;
  return wrap?.__uiName;
}

function list(v) {
  return v === undefined || v === null ? [] : Array.isArray(v) ? v.map(String) : [String(v)];
}

function setText(el , text) {
  if (el && text !== undefined && text !== null) el.textContent = String(text);
}

function setLead(el , text) {
  if (!el) return;
  const node = [...el.childNodes].find((n) => n.nodeType === 3);
  if (node) node.textContent = text;
  else el.insertBefore(el.ownerDocument.createTextNode(text), el.firstChild);
}

function blankReview(card) {
  card.removeAttribute("data-passed");
  setText(card.querySelector(".card-head .grow"), "Review");
  setText(card.querySelector(".critic-name"), "Critic");
  for (const el of card.querySelectorAll(".critic-line, .critic-time")) el.remove();
  const out = card.querySelector(".card-outcome");
  if (out) Object.assign(out, { className: "card-outcome", textContent: "Reviewing" });
  for (const row of card.querySelectorAll(".score")) {
    row.removeAttribute("data-value");
    row.classList.remove("low", "ok");
    const bar = row.querySelector(".score-bar > span") ;
    if (bar) bar.style.width = "0%";
    setText(row.querySelector(".score-value"), "");
  }
}

function neutral(root) {
  for (const card of findAll(root, '.card-item[data-type="review"]')) blankReview(card);
  for (const el of findAll(root, ".plan-state")) el.remove();
  for (const el of findAll(root, ".turn-status")) {
    el.textContent = "";
    el.removeAttribute("title");
  }
  for (const el of findAll(root, ".export-status .muted")) el.textContent = "";

  for (const el of findAll(root, ".export-status")) setLead(el, "Rendering…");
  for (const el of root.querySelectorAll             (".export-bar > div")) el.style.width = "0%";

  for (const el of findAll(root, '[data-testid="export-job-where"]')) el.remove();

  for (const el of root.querySelectorAll(
    '.turn .worklog .step, .turn .reply, .turn-edits, .turn .card-item, .turn .edit-row, [data-testid="media-tile"], .tl-lane .clip',
  ))
    el.remove();

  for (const el of findAll(root, ".msg-user")) el.textContent = "";
  for (const el of findAll(root, ".composer-hl")) el.textContent = "\u200b";
  for (const el of findAll(root, ".composer-box > textarea")) el.textContent = "";
  for (const el of findAll(root, ".composer .send")) el.setAttribute("disabled", "");

  for (const el of findAll(root, ".project-title")) el.textContent = "";
  for (const el of root.querySelectorAll(".timecode .tc-end")) el.textContent = ` / ${timecode(0)}`;
  for (const el of findAll(root, '[data-testid="canvas-info"]')) el.textContent = "";
  for (const el of root.querySelectorAll('.insp-title .grow, [data-testid="insp-media"], [data-testid="insp-duration"]')) el.textContent = "";
  for (const el of root.querySelectorAll('[data-testid="insp-name"], [data-testid="insp-media-name"]')) {
    el.removeAttribute("placeholder");
    el.setAttribute("value", "");
  }
  for (const el of findAll(root, '[data-testid="effects-target"]')) el.textContent = "";
  for (const el of findAll(root, '[data-testid="export-range-text"]')) el.textContent = "";

  for (const el of root.querySelectorAll('[data-testid="insp-start"], [data-testid="insp-in"], [data-testid="insp-out"]')) el.textContent = "";
  for (const el of findAll(root, '[data-testid="export-name"]')) el.setAttribute("value", "");

  for (const el of findAll(root, ".approval-text")) setLead(el, "");
  for (const el of root.querySelectorAll(".beats .beat-time, .beats .beat-head b, .beats .beat-line")) el.textContent = "";
}

function applyProps(name , root , o) {
  const at = (slot) => find(root, slot, name);

  const own = PART_PROPS[name];
  if (own) own(root, o, name);
  const text = o.text ;
  if (text && typeof text === "object") for (const k of Object.keys(text)) setText(at(k), text[k]);
  const press = o.press ;
  if (press && typeof press === "object")
    for (const k of Object.keys(press)) {
      const el = at(k);
      if (el) {
        el.style.transform = `scale(${num(press[k], 1)})`;
        el.style.transformOrigin = "50% 50%";
      }
    }
  for (const k of list(o.highlight)) {
    const el = at(k);
    if (el) {
      el.style.boxShadow = "0 0 0 2px var(--select), 0 0 0 6px rgb(109 140 255 / 22%)";
      el.style.borderRadius = el.style.borderRadius || getRadius(el);
    }
  }
  for (const k of list(o.hide)) for (const el of findAll(root, k, name)) el.style.visibility = "hidden";
  for (const k of list(o.remove)) for (const el of findAll(root, k, name)) if (el !== root) el.remove();
}

function getRadius(el) {
  const view = el.ownerDocument.defaultView;
  return (view && view.getComputedStyle(el).borderRadius) || "6px";
}

function placeElements(name , root , o) {
  const frame = name === "preview" || name === "editor" ? find(root, "frame", name) : null;
  const pic = name === "editor" ? (o.preview)?.frame : o.frame;
  if (frame && pic && typeof pic === "object" && "nodeType" in pic) {
    if ((pic).parentNode !== frame) {
      const el = pic ;
      el.style.width = el.style.width || "100%";
      el.style.height = el.style.height || "100%";
      el.style.display = el.style.display || "block";
      frame.replaceChildren(el);
    }
  } else if (frame && name === "editor") {
    if (pic !== false && pic !== null) stageFootage(frame, o);
    else frame.querySelector(":scope > canvas[data-uncut-footage]")?.remove();
  }
}

function footageAt(o) {
  const tl = o.timeline ;
  const pv = o.preview ;
  const clips = (tl && Array.isArray(tl.clips) ? tl.clips : []) ;
  const ph = num(tl?.playhead, num(pv?.time, 0));
  const picture = (tr) =>
    typeof tr === "number" ? tr === 1 || tr === 2 : !(typeof tr === "string" && /audio|sound|music|sfx|text|caption|subtitle/i.test(tr));
  const shots = clips.filter((c) => c && (typeof c.media === "string" || typeof c.image === "string") && picture(c.track));
  const end = (c) => num(c.start, 0) + Math.max(0.05, num(c.duration, 1));

  const hit = shots.findLast((c) => ph >= num(c.start, 0) && ph < end(c)) ?? shots.findLast((c) => ph > 0 && ph === end(c));
  if (!hit) return undefined;
  const at = Math.max(0, num(hit.in, 0) + Math.min(ph, num(hit.start, 0) + Math.max(0.05, num(hit.duration, 1))) - num(hit.start, 0));
  return typeof hit.media === "string" ? { media: hit.media, at } : { image: hit.image , at };
}

function hold(doc , p) {
  const media = (doc.defaultView)?.__uncutMedia;
  if (media && typeof media.hold === "function") media.hold(p);
}

function stageFootage(frame , o) {
  const doc = frame.ownerDocument;
  const f = footageAt(o);
  let cv = frame.querySelector(":scope > canvas[data-uncut-footage]") ;
  if (!f) {
    if (cv) cv.remove();
    return;
  }
  const w = Math.max(2, Math.round(frame.clientWidth || frame.offsetWidth || 320));
  const h = Math.max(2, Math.round(frame.clientHeight || frame.offsetHeight || 180));
  if (!cv) {
    cv = doc.createElement("canvas") ;
    cv.setAttribute("data-uncut-footage", "");
    cv.style.cssText = "display:block;width:100%;height:100%";
    frame.replaceChildren(cv);
  }

  const k = Math.min(2, 1920 / Math.max(w, h));
  const cw = Math.max(2, Math.round(w * k));
  const ch = Math.max(2, Math.round(h * k));
  const want = `${f.media ?? f.image}|${f.media ? f.at : 0}|${cw}x${ch}`;
  if (cv.__want === want) return;
  cv.__want = want;
  const target = cv;
  const draw = (img) => {
    if (target.__want !== want) return;
    target.width = cw;
    target.height = ch;
    const ctx = target.getContext("2d");
    if (!ctx) return;
    const s = Math.max(cw / img.width, ch / img.height);
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, cw, ch);
    ctx.drawImage(img, (cw - img.width * s) / 2, (ch - img.height * s) / 2, img.width * s, img.height * s);
    target.setAttribute("data-uncut-footage", "");
  };

  const clear = () => {
    if (target.__want !== want) return;
    target.width = cw;
    target.height = ch;
    target.setAttribute("data-uncut-footage", "failed");
  };
  const api = (doc.defaultView)?.uncut;
  let job ;
  if (f.media) {
    if (!api || typeof api.frame !== "function") {
      clear();
      return;
    }
    job = api.frame(f.media, f.at, { width: Math.min(1920, cw) }).then(draw, (e) => {
      clear();
      console.error(`uncutUI: the preview's clip ${f.media} at ${f.at} s couldn't be loaded: ${e instanceof Error ? e.message : String(e)}`);
    });
  } else {
    const img = doc.createElement("img");
    img.src = picture(f.image );
    job = img.decode().then(
      () => draw(img),
      () => clear(),
    );
  }
  hold(doc, job);
}

function timecode(seconds , fps) {
  const f = fps || 60;
  const total = Math.max(0, Math.round(seconds * f));
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(Math.floor(total / f / 3600))}:${pad(Math.floor(total / f / 60) % 60)}:${pad(Math.floor(total / f) % 60)}:${pad(total % f)}`;
}

const PART_PROPS = {
  composer(root, o) {
    if (o.text !== undefined && typeof o.text !== "object") {
      const value = String(o.text);
      const input = find(root, "input", "composer");
      const hl = find(root, "text", "composer");
      if (input) input.textContent = value;
      if (hl) {
        hl.textContent = `${value}\u200b`;
        chipify(hl, o.chips);
      }
      const send = find(root, "send", "composer");
      if (send) value.trim() ? send.removeAttribute("disabled") : send.setAttribute("disabled", "");
    }
    if (o.placeholder !== undefined) find(root, "input", "composer")?.setAttribute("placeholder", String(o.placeholder));
    if (o.caret) {
      const hl = find(root, "text", "composer");
      if (hl) {
        const caret = root.ownerDocument.createElement("span");
        caret.className = "uncut-ui-caret";
        const zw = hl.lastChild;
        if (zw && zw.nodeType === 3 && zw.textContent?.endsWith("\u200b")) zw.textContent = zw.textContent.slice(0, -1);
        hl.appendChild(caret);
        hl.appendChild(root.ownerDocument.createTextNode("\u200b"));
      }
    }
    if (o.context !== undefined) setText(find(root, "context", "composer")?.querySelector("span") ?? null, o.context);
  },
  message(root, o) {
    if (typeof o.text === "string") {
      root.textContent = o.text;
      chipify(root, o.chips);
    }
  },
  menu(root, o) {

    if (o.active !== undefined) {
      for (const el of findAll(root, ".ctx-item")) el.classList.remove("active");
      const id = String(o.active);
      const row = root.querySelector(`[data-testid="menu-${id}"]`) || (id ? find(root, id, "menu") : null);
      row?.classList.add("active");
    }
  },
  turn(root, o) {
    if (typeof o.reply === "string") addCaptured(root, "turn", ".reply", (el) => setText(el.querySelector("p"), o.reply));
    if (typeof o.edit === "string") addCaptured(root, "turn", ".edit-row", (el) => setText(el.querySelector(".grow"), o.edit), ".worklog");

    if (o.review)
      addCaptured(
        root,
        "turn",
        ".card-item",
        (el) => {
          blankReview(el);
          if (typeof o.review === "object") applyProps("review", el, o.review);
        },
        ".edit-row, .worklog",
      );
    if (Array.isArray(o.steps)) fillList(root.querySelector(".worklog"), ".step", o.steps.map(String), (el, s) => setText(el.querySelector(".grow"), s));

    if (typeof o.done === "number")
      [...root.querySelectorAll(".worklog .step")].forEach((el, i) => {
        const running = i >= (o.done);
        el.setAttribute("data-status", running ? "running" : "done");
        const icon = el.querySelector("svg");
        if (running && icon) icon.outerHTML = SPINNER_SVG;
      });
    if (typeof o.status === "string") setText(root.querySelector(".turn-status"), o.status);
  },
  inspector(root, o) {
    if (typeof o.title === "string") {
      setText(find(root, "title", "inspector")?.querySelector(".grow") ?? null, o.title);
      setText(root.querySelector('[data-testid="insp-media"]'), o.title);
    }
    if (typeof o.filter === "string") setText(find(root, "amount", "inspector")?.querySelector(".prop-k") ?? null, o.filter);
    if (typeof o.amount === "number")
      for (const el of find(root, "amount", "inspector")?.querySelectorAll("input") ?? []) el.setAttribute("value", String(Math.round(o.amount)));
    if (o.filter === false) find(root, "filter", "inspector")?.remove();
    if (o.effects === false) find(root, "effects", "inspector")?.remove();
  },
  effects(root, o) {
    if (o.active !== undefined)
      for (const tile of findAll(root, '[data-testid="filter-tile"]')) {
        const on = tile.getAttribute("data-look") === o.active;
        tile.classList.toggle("active", on);
        on ? tile.setAttribute("data-active", "true") : tile.removeAttribute("data-active");
      }
    if (typeof o.target === "string") setText(find(root, "target", "effects"), o.target);
  },
  storyboard(root, o) {
    if (typeof o.summary === "string") {
      const el = find(root, "summary", "storyboard");
      if (el) setLead(el, o.summary);
    }
    if (Array.isArray(o.beats)) {
      const beats = o.beats ;
      fillList(find(root, "beats", "storyboard"), ".beat", beats, (el, b, i) => {
        setText(el.querySelector(".beat-time"), `${i + 1}. ${num(b.start, 0)} s to ${num(b.end, 0)} s`);
        setText(el.querySelector(".beat-head b"), b.title ?? "");
        const lines = [...el.querySelectorAll(".beat-line")];
        lines.forEach((line, j) => (b.lines && j < b.lines.length ? (line.textContent = b.lines[j] ) : b.lines && line.remove()));
      });
    }
    if (typeof o.count === "number") [...root.querySelectorAll(".beat")].forEach((el, i) => i >= (o.count) && el.remove());
  },
  review(root, o) {
    if (typeof o.status === "string") setText(find(root, "status", "review"), o.status);
    if (typeof o.title === "string") setText(find(root, "head", "review")?.querySelector(".grow") ?? null, o.title);

    const scores = o.scores ;
    const fill = Math.max(0, Math.min(1, num(o.progress, 1)));
    if (scores && typeof scores === "object")
      for (const row of findAll(root, "score", "review")) {
        const value = scores[row.getAttribute("data-score") || ""];
        if (typeof value !== "number" || !Number.isFinite(value)) continue;
        const v = Math.max(0, Math.min(10, value));
        const bar = row.querySelector(".score-bar > span") ;
        if (bar) bar.style.width = `${fill * v * 10}%`;
        setText(row.querySelector(".score-value"), String(Math.round(v * fill)));
      }
  },
  timeline(root, o) {
    timelineProps(root, o, part("timeline").pxPerSecond || 60);
  },
  preview(root, o) {
    if (typeof o.time === "number") setLead(find(root, "timecode", "preview"), timecode(o.time));
    if (typeof o.duration === "number") setText(root.querySelector(".timecode .tc-end"), ` / ${timecode(o.duration)}`);
    if (typeof o.canvas === "string") setText(root.querySelector('[data-testid="canvas-info"]'), o.canvas);
  },
  export(root, o) {
    if (typeof o.quality === "string") {
      for (const q of ["draft", "standard", "high"]) {
        const card = find(root, q, "export");
        if (!card) continue;
        card.classList.toggle("active", q === o.quality);
        card.setAttribute("data-active", String(q === o.quality));
      }
    }
    if (typeof o.file === "string") find(root, "file", "export")?.setAttribute("value", o.file);
    if (typeof o.duration === "number")
      setText(root.querySelector('[data-testid="export-range-text"]'), `${timecode(0)} to ${timecode(o.duration)}, ${o.duration.toFixed(1)} s`);
    if (typeof o.motionBlur === "boolean") {
      const box = find(root, "motionBlur", "export");
      if (box) o.motionBlur ? box.setAttribute("checked", "") : box.removeAttribute("checked");
    }
  },
  exportProgress(root, o) {
    if (typeof o.progress === "number") {
      const p = Math.max(0, Math.min(1, o.progress));
      const fill = find(root, "fill", "exportProgress");
      if (fill) fill.style.width = `${p * 100}%`;
      const label = find(root, "bar", "exportProgress")?.previousElementSibling ?? null;
      if (label) setLead(label, `${p >= 1 ? "Done" : "Rendering…"} ${Math.round(p * 100)}%`);
    }
    if (typeof o.eta === "number") {
      const label = find(root, "bar", "exportProgress")?.previousElementSibling?.querySelector(".muted") ?? null;
      setText(label, `About ${Math.max(1, Math.round(o.eta))} s left`);
    }
  },
  topbar(root, o) {
    if (typeof o.exportLabel === "string") setLead(find(root, "export", "topbar"), o.exportLabel);
    if (typeof o.title === "string") setText(find(root, "title", "topbar"), o.title);
  },
  agent(root, o) {
    nested(root, o, ["composer", "turn", "message", "review"]);
  },
  editor(root, o) {
    if (Array.isArray(o.media)) {
      const grid = root.querySelector('[data-testid="media-grid"]');
      const tpl = DATA.parts.editor ? mediaTile(root.ownerDocument) : null;
      if (grid && tpl)
        for (const m of o.media) {
          const el = tpl.cloneNode(true) ;
          setText(el.querySelector(".tile-name"), m.name ?? "");
          setText(el.querySelector(".tile-sub"), m.meta ?? "");

          const badge = el.querySelector(".dur");
          if (typeof m.duration === "number")
            setText(badge, `${String(Math.floor(m.duration / 60)).padStart(2, "0")}:${String(Math.floor(m.duration % 60)).padStart(2, "0")}`);
          else badge?.remove();
          const thumb = el.querySelector(".thumb") ;
          if (thumb && m.image) thumb.style.cssText += `;background:url("${picture(m.image)}") center/cover`;
          grid.appendChild(el);
        }
    }
  },
};

function chipify(el , chips) {
  const labels = [...new Set(list(chips).filter(Boolean))].sort((a, b) => b.length - a.length);
  if (!labels.length) return;
  const text = el.textContent || "";
  const doc = el.ownerDocument;
  const out = [];
  let at = 0;
  let last = 0;
  while (at < text.length) {
    const hit = text[at] === "@" ? labels.find((l) => text.startsWith(l, at + 1)) : undefined;
    if (!hit) {
      at++;
      continue;
    }
    if (at > last) out.push(doc.createTextNode(text.slice(last, at)));
    const mark = doc.createElement("mark");
    mark.className = "chip";
    mark.setAttribute("data-testid", "agent-chip");
    mark.textContent = `@${hit}`;
    out.push(mark);
    at += hit.length + 1;
    last = at;
  }
  if (!out.length) return;
  if (last < text.length) out.push(doc.createTextNode(text.slice(last)));
  el.replaceChildren(...out);
}

function nested(root , o , names) {
  const sel = {
    composer: ".composer",
    turn: ".turn",
    message: ".msg-user",
    review: '.card-item[data-type="review"]',
    timeline: ".bottom",
    preview: ".stage",
    topbar: ".topbar",
  };
  for (const n of names) {
    const sub = o[n] ;
    const el = root.querySelector(sel[n] ) ;
    if (sub && typeof sub === "object" && el) applyProps(n, el, sub);
  }
}

function picture(src) {
  if (src.startsWith("uncut:media/"))
    throw new Error(`uncutUI: "${src}" can't load from a prop; pass await uncut.url(id, seconds) (a blob: URL, asked once before the first frame) instead`);
  return src;
}

function mediaTile(doc) {
  const tpl = doc.createElement("template");
  tpl.innerHTML = expand(part("editor").html);
  const tile = tpl.content.querySelector('[data-testid="media-tile"]');
  tile?.querySelector(".tile-used")?.remove();
  return tile;
}

function addCaptured(root , name , sel , fill , after) {
  let el = root.querySelector(sel) ;
  if (!el) {
    const tpl = root.ownerDocument.createElement("template");
    tpl.innerHTML = expand(part(name).html);
    const src = tpl.content.querySelector(sel) ;
    if (!src) return;
    el = src.cloneNode(true) ;
    const parent = (src.parentElement && root.querySelector(`.${[...src.parentElement.classList].join(".")}`)) || root;
    const anchor = after ? (parent.querySelector(after)) : null;
    anchor && anchor.parentElement === parent ? anchor.after(el) : parent.appendChild(el);
  }
  fill(el);
}

function expand(html) {
  return html.replace(/\u0001(\d+)\u0002/g, (_m, i) => DATA.pool[Number(i)] ?? "");
}

function fillList   (container , selector , entries , fill) {
  if (!container) return;
  const existing = [...container.querySelectorAll(selector)];

  let tpl = existing[0];
  let parent = tpl?.parentElement ?? null;
  if (!tpl) {
    const owner = partName(container);
    const t = container.ownerDocument.createElement("template");
    t.innerHTML = owner ? expand(part(owner).html) : "";
    tpl = t.content.querySelector(`${[...container.classList].map((c) => `.${c}`).join("")} ${selector}`) ?? undefined;
    parent = container;
  }
  if (!tpl || !parent) return;
  existing.forEach((e) => e.remove());
  entries.forEach((entry, i) => {
    const el = tpl.cloneNode(true) ;
    fill(el, entry, i);
    parent.appendChild(el);
  });
}

function timelineProps(root , o , pps) {
  const lanes = [...root.querySelectorAll(".tl-lane")] ;
  const heads = [...root.querySelectorAll(".tl-head")];
  const laneOf = (track) => {
    if (typeof track === "number") return lanes[track];
    if (typeof track === "string") {
      const i = heads.findIndex((h) => (h.querySelector(".name")?.textContent || "").trim().toLowerCase() === track.toLowerCase());
      return i >= 0 ? lanes[i] : lanes.find((l) => l.getAttribute("data-track") === track);
    }
    return lanes.find((l) => l.classList.contains("main"));
  };
  if (Array.isArray(o.clips)) {
    const clips = o.clips ;

    const templates = new Map                      ();
    const any = new Map                 ();
    const tpl0 = root.ownerDocument.createElement("template");
    tpl0.innerHTML = expand(part("timeline").html);
    const captured = [...tpl0.content.querySelectorAll(".tl-lane")];
    lanes.forEach((lane, i) => {
      const c = captured[i]?.querySelector(".clip");
      if (c) templates.set(lane, c);
      for (const k of ["video", "audio", "text"]) if (c?.classList.contains(k) && !any.has(k)) any.set(k, c);
    });

    for (const lane of lanes) for (const c of lane.querySelectorAll(".clip")) c.remove();
    for (const c of clips) {
      const lane = laneOf(c.track);
      if (!lane) continue;
      const tpl = templates.get(lane) || any.get(lane.classList.contains("main") ? "video" : "audio") || any.values().next().value;
      if (!tpl) continue;
      const el = tpl.cloneNode(true) ;
      const start = num(c.start, 0);
      const dur = Math.max(0.05, num(c.duration, 1));
      el.style.left = `${start * pps}px`;
      el.style.width = `${Math.max(2, dur * pps - 2)}px`;
      el.classList.toggle("selected", !!c.selected);
      if (c.name !== undefined) setText(el.querySelector(".nm"), c.name);
      setText(el.querySelector(".meta"), `${dur.toFixed(1)}s`);
      for (const img of el.querySelectorAll("img")) (img).style.width = "100%";
      const strip = el.querySelector(".strip") ;
      if (strip && c.image) {
        strip.style.backgroundImage = `url("${picture(c.image)}")`;
        strip.style.backgroundSize = "auto 100%";
        strip.style.backgroundRepeat = "repeat-x";
      }
      if (c.color) el.style.background = c.color;
      lane.appendChild(el);
    }
  }
  for (const i of list(o.selected)) root.querySelectorAll(".clip")[Number(i)]?.classList.add("selected");
  if (typeof o.playhead === "number") {
    const ph = root.querySelector(".playhead") ;
    if (ph) ph.style.left = `${o.playhead * pps}px`;
  }
}

const LINE_GROW = 0.22;

function typedCount(k , t) {
  const len = String(k.props?.text ?? "").length;
  const from = Math.max(0, Math.min(len, Math.round(num(k.typing?.from, 0))));
  const dur = num(k.typing?.dur, 0);
  const at = num(k.typing?.at, 0);
  const p = dur > 0 ? Math.max(0, Math.min(1, (t - at) / dur)) : t >= at ? 1 : 0;
  return Math.round(from + (len - from) * p);
}

function typedTime(k , n) {
  const len = String(k.props?.text ?? "").length;
  const from = Math.max(0, Math.min(len, Math.round(num(k.typing?.from, 0))));
  const dur = num(k.typing?.dur, 0);
  return num(k.typing?.at, 0) + (len > from && dur > 0 ? dur * Math.max(0, (n - 0.5 - from) / (len - from)) : 0);
}

function typedHeight(host , k , n) {
  let m = host.querySelector(":scope > .uncut-ui-measure") ;
  if (!m) {
    m = host.ownerDocument.createElement("div") ;
    m.className = "uncut-ui-measure";
    m.style.cssText = "position:absolute;left:0;top:0;width:0;height:0;overflow:visible;visibility:hidden;pointer-events:none";
    host.appendChild(m);
  }
  const key = { ...k, at: 0, typing: undefined, props: { ...k.props, text: String(k.props?.text ?? "").slice(0, n) } };
  const id = keyOf(key);
  m.__heights ??= new Map();
  const known = m.__heights.get(id);
  if (known !== undefined) return known;
  const b = buildPiece(m, key);
  const h = b.h - 2 * b.pad;
  m.__heights.set(id, h);
  return h;
}

function typedKey(k , t , host) {
  if (!k.typing || typeof k.props?.text !== "string") return k;
  const n = typedCount(k, t);
  if (typeof k.size?.height === "number") return { ...k, props: { ...k.props, text: k.props.text.slice(0, n) } };
  const n0 = typedCount(k, t - LINE_GROW);
  const h = (c) => typedHeight(host, k, c);
  let height = h(n0);
  const wraps = [];
  const split = (lo , hi , hl , hh) => {
    if (Math.abs(hl - hh) < 0.01) return;
    if (hi - lo <= 1) return void wraps.push(hi);
    const mid = (lo + hi) >> 1;
    const hm = h(mid);
    split(lo, mid, hl, hm);
    split(mid, hi, hm, hh);
  };
  if (n > n0) split(n0, n, height, h(n));
  for (const c of wraps) height += (h(c) - h(c - 1)) * settle((t - typedTime(k, c)) / LINE_GROW);
  return { ...k, props: { ...k.props, text: k.props.text.slice(0, n) }, size: { ...k.size, height } };
}

const PIECE_SHELL = "display:contents;";

function rgba(c) {
  const hex = /^#([0-9a-f]{6})$/i.exec(c.trim());
  if (hex) {
    const n = parseInt(hex[1] , 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1];
  }
  const m = c.match(/[\d.]+/g);
  if (!m || m.length < 3 || !c.trim().startsWith("rgb")) return undefined;
  return [Number(m[0]), Number(m[1]), Number(m[2]), m.length >= 4 ? Number(m[3]) : 1];
}

function mixRgba(a , b , p) {
  const x = rgba(a) || [0, 0, 0, 0];
  const y = rgba(b) || [0, 0, 0, 0];
  const v = x.map((n, i) => n + (y[i]  - n) * p);
  return `rgba(${Math.round(v[0] )}, ${Math.round(v[1] )}, ${Math.round(v[2] )}, ${Math.round(v[3]  * 1000) / 1000})`;
}

function settle(p) {
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  return p * p * (6 - 8 * p + 3 * p * p);
}

const smooth = (p) => {
  const q = Math.max(0, Math.min(1, p));
  return q * q * (3 - 2 * q);
};

function resolveKey(k , host) {

  const view = host.ownerDocument.defaultView;
  const W = host.offsetWidth || host.ownerDocument.documentElement.clientWidth || view?.innerWidth || 1080;
  const H = host.offsetHeight || host.ownerDocument.documentElement.clientHeight || view?.innerHeight || 1350;
  const own = typeof k.size?.width === "number";
  const width = typeof k.width === "number" ? k.width : typeof k.scale === "number" || own ? undefined : W * 0.86;
  const type = own || covers(k) || width === undefined ? 0 : num(k.type, H * 0.048);
  return { ...k, x: num(k.x, W / 2), y: num(k.y, H / 2), width, type };
}

function buildPiece(holder , k) {
  const [name, slot] = [k.piece.split(".")[0] , k.piece.split(".").slice(1).join(".")];
  const props = k.props || {};
  const typed = num(k.type, 0) > 0 && typeof k.width === "number";
  const key = `${k.piece}\n${k.index ?? 0}\n${k.pad ?? ""}\n${k.radius ?? ""}\n${k.background ?? ""}\n${k.theme ?? ""}\n${k.color ?? ""}\n${typed ? `${k.width}/${k.type}` : ""}\n${keyOf(k.size ?? {})}\n${keyOf(props)}`;
  if (holder.__pieceKey === key && holder.__built) return holder.__built;
  const scratch = holder.ownerDocument.createElement("div");
  scratch.style.cssText = "position:absolute;left:0;top:0;visibility:hidden;pointer-events:none";
  holder.replaceChildren(scratch);
  const root = mount(scratch, name, { ...props, background: "none", scale: 1 });
  const wrap = scratch.firstElementChild ;
  const theme = k.theme === "light";
  wrap.classList.toggle("uncut-ui-light", theme);
  const el = slot ? findAll(root, slot, name)[k.index ?? 0] : root;
  if (!el) throw new Error(`uncutUI: no piece "${k.piece}"${k.index ? ` #${k.index}` : ""} (slots of ${name}: ${slots(name).join(", ")})`);
  const view = holder.ownerDocument.defaultView ;
  const cs = view.getComputedStyle(el);

  const ownBg = cs.backgroundColor;
  const ownRadius = parseFloat(cs.borderTopLeftRadius) || 0;

  let lead = el;
  for (let n = el; n; n = nextEl(n, el))
    if ([...n.childNodes].some((c) => c.nodeType === 3 && /\S/.test(c.textContent || ""))) {
      lead = n;
      break;
    }
  const font = parseFloat(view.getComputedStyle(lead).fontSize) || 13;
  const own = rgba(ownBg);

  const opaque = !!own && own[3] >= 0.99 && ownRadius > 0;
  let behind = own && own[3] >= 0.99 ? ownBg : theme ? "rgb(255, 255, 255)" : part(name).backdrop || "rgb(10, 10, 10)";
  if (!(own && own[3] >= 0.99))
    for (let p = el.parentElement; p && p !== scratch; p = p.parentElement) {
      const c = rgba(view.getComputedStyle(p).backgroundColor);
      if (c && c[3] >= 0.99) {
        behind = view.getComputedStyle(p).backgroundColor;
        break;
      }
    }

  const line = parseFloat(view.getComputedStyle(lead).lineHeight) || font * 1.4;
  const radius = num(k.radius, opaque ? ownRadius : Math.min(18, Math.max(10, line * 0.6)));
  const pad = num(k.pad, opaque ? 0 : Math.round(Math.min(18, Math.max(10, line * 0.6))));

  const w = typed ? Math.max(48, Math.round((k.width  * font) / k.type  - pad * 2)) : num(k.size?.width, el.offsetWidth);
  let h = num(k.size?.height, el.offsetHeight);

  for (let at = el; at !== wrap;) {
    const parent = at.parentElement ;
    for (const sib of [...parent.children]) if (sib !== at) sib.remove();
    if (parent.getAttribute("style")?.startsWith(SHELL)) parent.setAttribute("style", PIECE_SHELL + (parent.getAttribute("style") || "").slice(SHELL.length));
    else parent.style.display = "contents";
    at = parent;
  }
  wrap.style.cssText = "display:contents";
  const st = el.style;
  st.boxSizing = "border-box";
  st.width = `${w}px`;
  st.height = (typed || typeof k.size?.width === "number") && typeof k.size?.height !== "number" ? "auto" : `${h}px`;
  st.margin = "0";
  st.position = "relative";
  st.left = st.top = st.right = st.bottom = "auto";
  st.flex = "none";
  st.maxWidth = st.maxHeight = "none";
  if (opaque) st.boxShadow = "none";
  if (k.color) st.color = k.color;
  if (st.height === "auto") {

    const r = el.getBoundingClientRect();
    h = el.offsetHeight > 2 ? (r.width > 0 && el.offsetWidth > 0 ? (r.height * el.offsetWidth) / r.width : el.offsetHeight) : h;
    st.height = `${h}px`;
  }

  const typedText = k.typing && typeof props.text === "string" ? props.text : "";
  if (typedText && typeof k.size?.height === "number") {
    st.height = "auto";
    const natural = el.offsetHeight;
    const box = [...el.children].find((c) => (c.textContent || "").includes(typedText)) ;
    const short = natural - h;
    if (box && short > 0.01) {
      const bs = box.style;
      bs.height = `${Math.max(0, box.offsetHeight - short)}px`;
      bs.minHeight = "0";
      bs.overflow = "hidden";
      bs.flex = "none";
    }
    st.height = `${h}px`;
  }
  const node = holder.ownerDocument.createElement("div");
  node.className = "uncut-ui-piece";
  node.style.cssText = `position:absolute;left:0;top:0;width:${w + pad * 2}px;height:${h + pad * 2}px;padding:${pad}px;box-sizing:border-box;transform-origin:0 0`;
  node.appendChild(wrap);
  holder.replaceChildren(node);
  const built = { node, el, w: w + pad * 2, h: h + pad * 2, bg: k.background ?? (opaque ? ownBg : behind), radius, font, name, pad };
  holder.__pieceKey = key;
  holder.__built = built;
  return built;
}

function nextEl(n , root) {
  if (n.firstElementChild) return n.firstElementChild;
  for (let at = n; at && at !== root; at = at.parentElement) if (at.nextElementSibling) return at.nextElementSibling;
  return null;
}

function keyBox(k , b) {
  const s = typeof k.width === "number" ? k.width / b.w : num(k.scale, 1);
  const w = typeof k.width === "number" ? k.width : b.w * s;
  const h = typeof k.height === "number" ? k.height : b.h * s;
  return { x: typeof k.x === "number" ? k.x : w / 2, y: typeof k.y === "number" ? k.y : h / 2, w, h, r: b.radius * s };
}

const fitScale = (b , w , h , cover) => (cover ? Math.max(w / b.w, h / b.h) : Math.min(w / b.w, h / b.h));

function fitInto(b , w , h , alpha , blur , dx , dy , cover , z) {
  const s = fitScale(b, w, h, cover) * num(z, 1);
  const st = b.node.style;
  st.transform = `translate(${(w - b.w * s) / 2 + dx}px, ${(h - b.h * s) / 2 + dy}px) scale(${s})`;
  st.opacity = String(Math.round(alpha * 1000) / 1000);
  st.filter = blur > 0.05 ? `blur(${(blur / Math.max(s, 0.01)).toFixed(2)}px)` : "none";
  st.visibility = alpha > 0.001 ? "visible" : "hidden";
  st.maskImage = "";
}

const covers = (k) => (k.fit ? k.fit === "cover" : k.piece.endsWith(".frame"));

const DIRS = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0], none: [0, 0] };

function localRect(el , node) {
  const a = el.getBoundingClientRect();
  const b = node.getBoundingClientRect();
  const s = node.offsetWidth ? b.width / node.offsetWidth : 1;
  return { x: (a.left - b.left) / s, y: (a.top - b.top) / s, w: a.width / s, h: a.height / s, r: 0 };
}

function restAt(b , box , cover) {
  const s = fitScale(b, box.w, box.h, cover);
  return { s, x: box.x - box.w / 2 + (box.w - b.w * s) / 2, y: box.y - box.h / 2 + (box.h - b.h * s) / 2 };
}

function carry(host , kf , kj , bf , bj , boxF , boxJ , p , raw , hidden) {
  const doc = host.ownerDocument;
  let layer = host.querySelector(":scope > .uncut-ui-carry") ;
  if (!layer) {
    layer = doc.createElement("div") ;
    layer.className = "uncut-ui-carry";
    host.appendChild(layer);
  }
  const pairs = (kj.carry || []).map((c) => (typeof c === "string" ? [c, c] : c));
  const found = pairs
    .map(([a, b]) => [find(bf.el, a, bf.name), find(bj.el, b, bj.name)])
    .filter((x) => !!x[0] && !!x[1]);
  if (!found.length || raw >= 1) {
    layer.style.display = "none";
    return;
  }
  layer.style.cssText = "position:absolute;left:0;top:0;width:0;height:0;overflow:visible;pointer-events:none;z-index:2";
  const spec = JSON.stringify(pairs);
  if (layer.__from !== bf || layer.__to !== bj || layer.__spec !== spec) {
    layer.replaceChildren();
    found.forEach(([fe, te], i) => {
      for (const [b, e] of [
        [bf, fe],
        [bj, te],
      ]) {
        e.setAttribute("data-uncut-carry", String(i));
        const c = b.node.cloneNode(true) ;
        e.removeAttribute("data-uncut-carry");
        c.querySelector(`[data-uncut-carry="${i}"]`)?.setAttribute(
          "style",
          `${c.querySelector(`[data-uncut-carry="${i}"]`)?.getAttribute("style") || ""};visibility:visible`,
        );
        layer .appendChild(c);
      }
    });
    layer.__from = bf;
    layer.__to = bj;
    layer.__spec = spec;
  }
  const rf = restAt(bf, boxF, covers(kf));
  const rj = restAt(bj, boxJ, covers(kj));
  const hand = smooth((raw - 0.4) / 0.12);
  found.forEach(([fe, te], i) => {
    const lf = localRect(fe, bf.node);
    const lj = localRect(te, bj.node);
    const A = { x: rf.x + lf.x * rf.s, y: rf.y + lf.y * rf.s, w: lf.w * rf.s };
    const B = { x: rj.x + lj.x * rj.s, y: rj.y + lj.y * rj.s, w: lj.w * rj.s };
    const cur = { x: A.x + (B.x - A.x) * p, y: A.y + (B.y - A.y) * p, w: A.w + (B.w - A.w) * p };
    const sides = [
      [lf, (rf.s * cur.w) / Math.max(A.w, 0.01), 1 - hand],
      [lj, (rj.s * cur.w) / Math.max(B.w, 0.01), hand],
    ];
    sides.forEach(([l, s, alpha], side) => {
      const c = layer .children[i * 2 + side] ;
      c.style.transform = `translate(${cur.x - l.x * s}px, ${cur.y - l.y * s}px) scale(${s})`;
      c.style.opacity = String(Math.round(alpha * 1000) / 1000);
      c.style.filter = "none";
      c.style.visibility = "hidden";
    });
    for (const e of [fe, te]) {
      e.style.visibility = "hidden";
      hidden.push(e);
    }
  });
  layer.style.display = "block";
}

function startOf(
  i ,
  keys ,
  holders ,
  dur ,
  depth = 0,
) {
  if (i < 1 || depth > 8) return null;
  const at = num(keys[i] .at, 0);
  const raw = (num(keys[i + 1] .at, 0) - at) / dur(keys[i] );
  if (raw >= 1) return null;
  const q = settle(raw);
  const built = (n) => {
    const hd = holders[n] ;
    const shown = hd.style.display;
    hd.style.display = "block";
    const b = buildPiece(hd, keys[n] );
    hd.style.display = shown;
    return b;
  };
  const bi = built(i);
  const rest = keyBox(keys[i] , bi);
  const prev = startOf(i - 1, keys, holders, dur, depth + 1);
  const bp = built(i - 1);
  const a = prev ? prev.box : keyBox(keys[i - 1] , bp);
  const abg = prev ? prev.bg : bp.bg;
  const pa = prev ? prev.at : placeOf(bp, a, covers(keys[i - 1] ));
  const pr = placeOf(bi, rest, covers(keys[i] ));
  return {
    box: { x: a.x + (rest.x - a.x) * q, y: a.y + (rest.y - a.y) * q, w: a.w + (rest.w - a.w) * q, h: a.h + (rest.h - a.h) * q, r: a.r + (rest.r - a.r) * q },
    bg: mixRgba(abg, bi.bg, q),
    at: { s: pa.s + (pr.s - pa.s) * q, y: pa.y + (pr.y - pa.y) * q },
  };
}

function placeOf(b , box , cover) {
  const s = fitScale(b, box.w, box.h, cover);
  return { s, y: (box.h - b.h * s) / 2 };
}

function sequence(
  host ,
  t ,
  keyList ,
  o ,
) {
  if (!keyList.length) throw new Error("uncutUI.sequence: no keys");
  const doc = host.ownerDocument;
  ensureCss(doc);
  const keys = keyList.map((k) => typedKey(resolveKey(k, host), t, host));
  let shell = host.querySelector(":scope > .uncut-ui-shell") ;
  if (!shell) {
    shell = doc.createElement("div") ;
    shell.className = "uncut-ui-shell";
    host.insertBefore(shell, host.querySelector(":scope > .uncut-ui-carry"));
  }
  for (const e of shell.__hidden || []) e.style.visibility = "";
  const hidden = (shell.__hidden = []);
  const holders = [];
  for (let i = 0; i < keys.length; i++) {
    let hd = shell.children[i] ;
    if (!hd) {
      hd = doc.createElement("div") ;
      hd.style.cssText = "position:absolute;left:0;top:0";
      shell.appendChild(hd);
    }
    holders.push(hd);
  }
  while (shell.children.length > keys.length) shell.lastElementChild .remove();
  let j = 0;
  for (let i = 0; i < keys.length; i++) if (num(keys[i] .at, 0) <= t) j = i;
  const dur = (k) => Math.max(0.05, num(k.dur, num(o?.dur, 0.9)));
  const from = j > 0 && t < num(keys[j] .at, 0) + dur(keys[j] ) ? j - 1 : -1;
  const raw = from >= 0 ? (t - num(keys[j] .at, 0)) / dur(keys[j] ) : 1;
  const p = settle(raw);

  holders.forEach((hd, i) => {
    hd.style.display = i === j || i === from ? "block" : "none";
    hd.style.zIndex = "";
  });

  holders.forEach((hd, i) => {
    hd.setAttribute("data-uncut-piece", keys[i] .piece);
    hd.setAttribute("data-uncut-at", String(num(keys[i] .at, 0)));
    hd.setAttribute("data-uncut-dur", String(dur(keys[i] )));
    hd.setAttribute("data-uncut-swap", from < 0 ? "" : i === j ? "in" : i === from ? "out" : "");
  });
  const bj = buildPiece(holders[j] , keys[j] );
  const boxJ = keyBox(keys[j] , bj);
  let box = boxJ;
  let bg = bj.bg;
  let press = num(keys[j] .press, 1);
  let carried = false;
  if (from >= 0) {
    const kf = keys[from] ;
    const kj = keys[j] ;
    const bf = buildPiece(holders[from] , kf);
    const boxF = keyBox(kf, bf);

    const start = startOf(from, keys, holders, dur);
    const b0 = start ? start.box : boxF;
    box = {
      x: b0.x + (boxJ.x - b0.x) * p,
      y: b0.y + (boxJ.y - b0.y) * p,
      w: b0.w + (boxJ.w - b0.w) * p,
      h: b0.h + (boxJ.h - b0.h) * p,
      r: b0.r + (boxJ.r - b0.r) * p,
    };
    bg = mixRgba(start ? start.bg : bf.bg, bj.bg, p);
    press = num(kf.press, 1) + (press - num(kf.press, 1)) * p;
    const same = kf.piece === kj.piece && (kf.index ?? 0) === (kj.index ?? 0) && kf.theme === kj.theme;
    holders[from] .style.display = same ? "none" : "block";
    if (!same) {

      const [dx, dy] = DIRS[kj.from || "down"] || DIRS.down ;
      const out = smooth((raw - 0.04) / 0.3);
      const go = out * out;
      const blurOut = 14 * smooth(raw / 0.3);
      if (covers(kf)) {
        const rf = restAt(bf, boxF, true);
        const st = bf.node.style;
        const fade = smooth((raw - 0.3) / 0.35);
        st.transform = `translate(${rf.x - (box.x - box.w / 2)}px, ${rf.y - (box.y - box.h / 2)}px) scale(${rf.s})`;
        st.opacity = String(Math.round((1 - fade) * 1000) / 1000);
        st.filter = "none";
        st.visibility = fade < 0.999 ? "visible" : "hidden";
        st.maskImage = "";
      } else fitInto(bf, box.w, box.h, 1 - out, blurOut, -dx * 0.35 * box.w * go, -dy * 0.35 * box.h * go, false, 1 - 0.06 * out);
      const pic = covers(kj);
      const inn = pic ? smooth((raw - 0.08) / 0.27) : smooth((raw - 0.18) / 0.3);
      const arrive = 1 - settle(Math.max(0, (raw - 0.08) / 0.92));
      fitInto(
        bj,
        box.w,
        box.h,
        inn,
        (pic ? 8 : 14) * (1 - smooth((raw - (pic ? 0.1 : 0.16)) / 0.45)),
        dx * 0.35 * box.w * arrive,
        dy * 0.35 * box.h * arrive,
        covers(kj),
        1 + 0.05 * arrive,
      );
      if (kj.carry?.length) {
        carry(host, kf, kj, bf, bj, boxF, boxJ, p, raw, hidden);
        carried = true;
      }
    } else {

      const pf = start ? start.at : placeOf(bf, boxF, covers(kf));
      const pj = placeOf(bj, boxJ, covers(kj));
      const s = pf.s + (pj.s - pf.s) * p;
      const oy = pf.y + (pj.y - pf.y) * p;
      const place = (b , sc) => {
        const st = b.node.style;
        st.transform = `translate(${(box.w - b.w * sc) / 2}px, ${oy}px) scale(${sc})`;
        st.filter = "none";
        st.visibility = "visible";
      };
      place(bj, s);
      const st = bj.node.style;
      st.opacity = "1";
      const end = (box.h - oy) / s - bj.pad;
      const old = Math.max(0, bf.h - bf.pad);
      const grew = bj.h > bf.h + 0.5 && Math.abs(bj.w - bf.w) < 0.5;
      const a = grew ? smooth((raw - 0.1) / 0.45) : 1;
      const cut = bj.pad > 0 && end < bj.h - bj.pad - 0.5;
      const stops = [];
      if (a < 0.999) stops.push(`#000 ${old.toFixed(2)}px`, `rgb(0 0 0 / ${a.toFixed(3)}) ${(old + 1).toFixed(2)}px`);
      if (cut)
        stops.push(`rgb(0 0 0 / ${a.toFixed(3)}) ${Math.max(end, old + 1).toFixed(2)}px`, `transparent ${(Math.max(end, old + 1) + bj.pad / 2).toFixed(2)}px`);
      st.maskImage = stops.length ? `linear-gradient(to bottom, ${a < 0.999 ? "" : "#000 0px, "}${stops.join(", ")})` : "";

      const fade = Math.abs(bj.w - bf.w) < 0.5 ? smooth(raw / 0.45) : 1;
      const hf = holders[from] ;
      if (fade < 0.999) {
        hf.style.display = "block";
        hf.style.zIndex = "1";
        place(bf, s * (bj.w / bf.w));
        bf.node.style.opacity = String(Math.round((1 - fade) * 1000) / 1000);
        bf.node.style.maskImage = bf.pad > 0 ? `linear-gradient(to bottom, #000 ${old.toFixed(2)}px, transparent ${(old + bf.pad / 2).toFixed(2)}px)` : "";
      }
    }
  } else fitInto(bj, box.w, box.h, 1, 0, 0, 0, covers(keys[j] ));
  if (!carried) {
    const layer = host.querySelector(":scope > .uncut-ui-carry") ;
    if (layer) layer.style.display = "none";
  }
  shell.style.cssText = `position:absolute;left:${box.x - box.w / 2}px;top:${box.y - box.h / 2}px;width:${box.w}px;height:${box.h}px;border-radius:${Math.min(box.r, box.w / 2, box.h / 2)}px;background:${bg};overflow:hidden;transform:scale(${press});transform-origin:50% 50%${keys[j] .shadow === false || (from >= 0 && keys[from] .shadow === false && raw < 0.6) ? "" : ";box-shadow:0 1px 2px rgb(0 0 0 / 8%), 0 14px 40px rgb(0 0 0 / 14%)"}`;
  return { x: box.x, y: box.y, w: box.w, h: box.h, r: box.r, p: from >= 0 ? p : 1, key: j, el: bj.el, type: (bj.font * boxJ.w) / bj.w };
}

function snapshot(el) {
  const view = el.ownerDocument.defaultView ;
  const copy = el.cloneNode(true) ;
  const src = [el, ...el.querySelectorAll("*")];
  const dst = [copy, ...copy.querySelectorAll("*")];
  src.forEach((s, i) => {
    const cs = view.getComputedStyle(s);
    let css = "";
    for (let j = 0; j < cs.length; j++) {
      const k = cs[j] ;
      if (k === "visibility" || k.startsWith("transition") || k.startsWith("animation")) continue;
      css += `${k}:${cs.getPropertyValue(k)};`;
    }
    dst[i] .setAttribute("style", css);
  });
  copy.style.position = "absolute";
  copy.style.left = copy.style.top = "0px";
  copy.style.margin = "0";
  copy.style.transform = "none";
  copy.style.transformOrigin = "0 0";
  copy.style.opacity = "1";
  copy.style.boxShadow = "none";
  copy.style.width = `${el.offsetWidth}px`;
  copy.style.height = `${el.offsetHeight}px`;

  copy.style.maxWidth = copy.style.maxHeight = "none";
  copy.style.minWidth = copy.style.minHeight = "0";
  copy.style.boxSizing = "border-box";
  copy.style.visibility = "visible";
  return copy;
}

const isPieceKey = (v) => !!v && typeof v === "object" && typeof (v).piece === "string";
const isElement = (v) => !!v && typeof v === "object" && "nodeType" in (v);

function fly(host , t , f) {
  const doc = host.ownerDocument;
  ensureCss(doc);
  const id = f.id ?? "0";
  let layer = [...host.children].find((c) => c.classList.contains("uncut-ui-fly") && c.getAttribute("data-fly") === id) ;
  if (!layer) {
    layer = doc.createElement("div") ;
    layer.className = "uncut-ui-fly";
    layer.setAttribute("data-fly", id);
    layer.innerHTML = '<div class="uncut-ui-fly-box"><div class="uncut-ui-fly-a"></div><div class="uncut-ui-fly-b"></div></div>';
    host.appendChild(layer);
  }
  layer.__snaps ??= new Map();
  layer.style.cssText = "position:absolute;left:0;top:0;width:0;height:0;overflow:visible;pointer-events:none;z-index:50";
  const box = layer.firstElementChild ;
  const slotA = box.children[0] ;
  const slotB = box.children[1] ;
  const dur = Math.max(0.05, num(f.dur, 0.9));
  const raw = (t - f.at) / dur;
  const to = isElement(f.to) ? f.to : null;
  const from = isElement(f.from) ? f.from : null;

  if (to) {
    if (raw < 1 && (raw >= 0 || isPieceKey(f.from))) to.setAttribute("data-uncut-fly-hidden", "");
    else to.removeAttribute("data-uncut-fly-hidden");
  }
  if (from && f.leave) from.style.visibility = raw >= 0 ? "hidden" : "";

  if (raw >= 1 || !f.to || !f.from || (raw < 0 && !isPieceKey(f.from))) {
    layer.style.display = "none";
    return { x: 0, y: 0, w: 0, h: 0, p: raw >= 1 ? 1 : 0, el: null };
  }

  let A ;
  let built = null;
  let press = 1;
  if (isPieceKey(f.from)) {
    const k = typedKey(resolveKey(f.from, host), t, host);
    built = buildPiece(slotA, k);
    const b = keyBox(k, built);
    A = { x: b.x - b.w / 2, y: b.y - b.h / 2, w: b.w, h: b.h };
    press = num(k.press, 1);
  } else if (from) A = rectIn(from, host);
  else A = f.from ;
  const B = to ? rectIn(to, host) : (f.to);

  if ((to && !(B.w > 0 && B.h > 0)) || (from && !(A.w > 0 && A.h > 0))) {
    layer.style.display = "none";
    return { x: 0, y: 0, w: 0, h: 0, p: 0, el: null };
  }

  if (raw < 0 && !built) {
    layer.style.display = "none";
    return { x: A.x + A.w / 2, y: A.y + A.h / 2, w: A.w, h: A.h, p: 0, el: null };
  }
  layer.style.display = "block";
  const q = Math.max(0, raw);
  const p = settle(q);
  const arc = num(f.arc, 0) * 4 * p * (1 - p);
  const cur = { x: A.x + (B.x - A.x) * p, y: A.y + (B.y - A.y) * p + arc, w: A.w + (B.w - A.w) * p, h: A.h + (B.h - A.h) * p };

  const snap = (slot , el) => {
    const key = `${el.outerHTML.length}:${el.offsetWidth}x${el.offsetHeight}:${el.outerHTML.slice(0, 400)}:${el.textContent}`;
    let s = layer .__snaps .get(slot);
    if (!s || s.key !== key) {
      const view = doc.defaultView ;
      const cs = view.getComputedStyle(el);
      const node = snapshot(el);
      node.removeAttribute("data-uncut-fly-hidden");
      node.style.backgroundColor = "transparent";
      node.style.borderRadius = "0";
      node.style.border = "0";
      s = { key, node, w: el.offsetWidth || 1, h: el.offsetHeight || 1, bg: cs.backgroundColor, r: parseFloat(cs.borderTopLeftRadius) || 0 };
      layer .__snaps .set(slot, s);
    }
    return s;
  };
  const sb = to ? snap("b", to) : null;
  if (sb && slotB.firstElementChild !== sb.node) slotB.replaceChildren(sb.node);
  if (!sb) slotB.replaceChildren();
  let rA = 0;
  let bgA = "rgba(0, 0, 0, 0)";
  if (built) {
    rA = (built.radius * A.w) / built.w;
    bgA = built.bg;
  } else if (from) {
    const sa = snap("a", from);
    if (slotA.firstElementChild !== sa.node) slotA.replaceChildren(sa.node);
    rA = (sa.r * A.w) / sa.w;
    bgA = sa.bg;
  } else slotA.replaceChildren();
  const rB = sb ? (sb.r * B.w) / sb.w : rA;
  const bgB = sb ? sb.bg : bgA;

  const words = f.fit === "contain";
  const inB = words ? smooth((q - 0.34) / 0.16) : smooth((q - 0.2) / 0.25);
  const outA = words ? smooth((q - 0.18) / 0.16) : smooth((q - 0.32) / 0.18);
  const place = (node , w , h , alpha , cover) => {
    const s = cover ? Math.max(cur.w / w, cur.h / h) : Math.min(cur.w / w, cur.h / h);
    node.style.transformOrigin = "0 0";
    node.style.transform = `translate(${(cur.w - w * s) / 2}px, ${(cur.h - h * s) / 2}px) scale(${s})`;
    node.style.opacity = String(Math.round(alpha * 1000) / 1000);
    node.style.visibility = alpha > 0.001 ? "visible" : "hidden";
  };
  slotA.style.cssText = slotB.style.cssText = "position:absolute;left:0;top:0;width:0;height:0;overflow:visible";
  if (built) {
    built.node.style.position = "absolute";
    place(built.node, built.w, built.h, raw < 0 ? 1 : 1 - outA, false);
  } else if (slotA.firstElementChild) {
    const sa = layer.__snaps.get("a") ;
    place(sa.node, sa.w, sa.h, 1 - outA, f.fit !== "contain");
  }
  if (sb) place(sb.node, sb.w, sb.h, raw < 0 ? 0 : inB, f.fit !== "contain");
  const bg = mixRgba(bgA, bgB, raw < 0 ? 0 : inB);
  const r = rA + (rB - rA) * p;
  const lift =
    raw < 0 ? (built && f.from && (f.from).shadow !== false ? 1 : 0) : Math.sin(Math.PI * Math.min(1, q * 1.4)) * (1 - p) + (built ? 1 - p : 0);
  const shadow =
    lift > 0.01
      ? `;box-shadow:0 ${(2 + 22 * lift).toFixed(1)}px ${(6 + 50 * lift).toFixed(1)}px rgb(0 0 0 / ${(0.1 + 0.22 * Math.min(1, lift)).toFixed(3)})`
      : "";
  const pz = raw < 0 ? press : 1;
  box.style.cssText = `position:absolute;left:${cur.x}px;top:${cur.y}px;width:${cur.w}px;height:${cur.h}px;border-radius:${Math.min(r, cur.w / 2, cur.h / 2)}px;background:${bg};overflow:hidden;transform:scale(${pz});transform-origin:50% 50%${shadow}`;
  return { x: cur.x + cur.w / 2, y: cur.y + cur.h / 2, w: cur.w, h: cur.h, p: raw < 0 ? 0 : p, el: built?.el ?? null };
}

function piece(host , id , props) {
  return sequence(host, 0, [{ ...props, piece: id, at: 0 }]).el;
}

function frameText(
  target ,
  host ,
  o ,
) {
  const W = num(o?.width, 1080);
  const H = num(o?.height, 1350);
  const want = num(o?.text, 0.048);
  const safe = Math.max(0, Math.min(num(o?.safe, 72), W / 2 - 1, H / 2 - 1));
  const pad = num(o?.pad, 8);

  const els = (isElement(target) ? [target] : [...(target)]).filter(Boolean);
  const doc = host.ownerDocument;
  const view = doc.defaultView;
  const hb = host.getBoundingClientRect();
  const hs = host.offsetWidth ? hb.width / host.offsetWidth : 1;
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  const grow = (r) => {
    if (!r.width || !r.height) return;
    x0 = Math.min(x0, (r.left - hb.left) / hs);
    y0 = Math.min(y0, (r.top - hb.top) / hs);
    x1 = Math.max(x1, (r.right - hb.left) / hs);
    y1 = Math.max(y1, (r.bottom - hb.top) / hs);
  };

  const sizes = [];
  for (const el of els) {
    const walk = doc.createTreeWalker(el, 4 /* NodeFilter.SHOW_TEXT */);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      const text = (n.nodeValue || "").trim();
      const p = n.parentElement;
      if (!text || !p) continue;
      const cs = view ? view.getComputedStyle(p) : null;
      if (cs && (cs.visibility === "hidden" || cs.display === "none" || cs.opacity === "0")) continue;
      const range = doc.createRange();
      range.selectNodeContents(n);
      const rects = range.getClientRects();
      if (!rects.length) continue;
      for (let i = 0; i < rects.length; i++) grow(rects[i] );
      const pr = p.getBoundingClientRect();
      const k = p.offsetWidth ? pr.width / p.offsetWidth : 1;
      sizes.push([(parseFloat(cs ? cs.fontSize : "12") || 12) * (k / hs), text.length]);
    }
    el.querySelectorAll("svg").forEach((s) => grow(s.getBoundingClientRect()));
  }
  if (!sizes.length) {
    for (const el of els) grow(el.getBoundingClientRect());
    sizes.push([12, 1]);
  }
  if (!Number.isFinite(x0)) return { x: 0, y: 0, zoom: 1, text: 0, fits: false };
  sizes.sort((a, b) => a[0] - b[0]);
  const total = sizes.reduce((s, x) => s + x[1], 0);
  let acc = 0;
  let font = sizes[sizes.length - 1] [0];
  for (const [px, n] of sizes)
    if ((acc += n) >= total / 2) {
      font = px;
      break;
    }
  const bw = x1 - x0 + 2 * pad,
    bh = y1 - y0 + 2 * pad;
  const zText = (want * H) / Math.max(1, font);
  const zFit = Math.min((W - 2 * safe) / Math.max(1, bw), (H - 2 * safe) / Math.max(1, bh));
  const zoom = Math.min(zText, zFit);
  return { x: (x0 + x1) / 2, y: (y0 + y1) / 2, zoom, text: Math.round(((font * zoom) / H) * 10000) / 10000, fits: zText <= zFit + 1e-9 };
}

function rectIn(el , host) {
  const a = el.getBoundingClientRect();
  const b = host.getBoundingClientRect();
  const s = host.offsetWidth ? b.width / host.offsetWidth : 1;
  return { x: (a.left - b.left) / s, y: (a.top - b.top) / s, w: a.width / s, h: a.height / s };
}

function cursor(host , o) {
  const doc = host.ownerDocument;
  let el = host.querySelector(":scope > .uncut-ui-cursor") ;
  if (!el) {
    el = doc.createElement("div");
    el.className = "uncut-ui-cursor";
    el.innerHTML = CURSOR_SVG;
    host.appendChild(el);
  }
  const size = num(o.size, 28);
  el.style.cssText = `position:absolute;left:0;top:0;width:${size}px;height:${size * 1.5}px;pointer-events:none;z-index:1000;transform-origin:${size * 0.18}px ${size * 0.1}px;transform:translate(${o.x - size * 0.18}px,${o.y - size * 0.1}px) scale(${num(o.scale, 1)})`;
  return el;
}

const SPINNER_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-loader-circle spin"><path d="M21 12a9 9 0 1 1-6.219-8.56"></path></svg>';
const CURSOR_SVG =
  '<svg viewBox="0 0 20 30" width="100%" height="100%" style="display:block;overflow:visible;filter:drop-shadow(0 1px 1.5px rgb(0 0 0 / 35%))"><path d="M3.6 3 L3.6 24.2 L8.6 19.4 L11.9 27 L15.1 25.6 L11.9 18.2 L18.6 18.2 Z" fill="#000" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';

window.uncutUI = {
  parts: parts,
  size: size,
  slots: slots,
  mount: mount,
  find: find,
  findAll: findAll,
  piece: piece,
  sequence: sequence,
  fly: fly,
  rectIn: rectIn,
  frameText: frameText,
  cursor: cursor,
  timecode: timecode,
  css: css,
};
})();
