// @uncut/core: the reference format code shared by the server, the renderer and the tests.
export type * from "./types.ts";
export { loadModules, validateModule, validateOps, validateProject } from "./validate.ts";
export { resolveStarts, projectDuration, timelineProblems } from "./rules.ts";
export { EditError, EditConflict, TurnDependency, createSession, applyEdit, undoTurn } from "./apply-ops.ts";
export { describeOp, manualEditsNote } from "./edit-log.ts";
export { animationAt, dipId, dipOpacity, dipsOf, DRAWN_MOVES, layout, spanOf, visualsAt } from "./timeline.ts";
export { CROSSFADE, cutsOf, defaultFrames, DIP_TO_BLACK, DRAWN_TRANSITIONS, handleAfter, handleBefore, overlaps, transitionInfo, transitionLimits, transitionName, TRANSITION_LIMITS, TRANSITIONS, WIPE } from "./transitions.ts";
export type { Cut, TransitionInfo, TransitionLimits } from "./transitions.ts";
export { audibleAt, audioSpan, dbToGain, fadeAt, gainToDb, itemGain, keyDbAt, MAX_DB, SILENCE_DB, soundMedia, sourceAt, trackAudible } from "./audio.ts";
export type { Audible } from "./audio.ts";
export type { Dip, Span, Visual } from "./timeline.ts";
export { canvasBackground, DEFAULT_THEME, esc, RENDER_CSS, resolveColor, resolveFont, safeMargin, SOLID, solidBackground, solidHtml, TEXT_STYLES, textHtml, textLook, themeColors } from "./render.ts";
export type { Motion, RenderTarget, TextLook } from "./render.ts";
export { outputSize } from "./export.ts";
export type { ExportQuality } from "./export.ts";
export { decodeEnvelope, DEFAULT_PAUSE_MIN_S, editWords, encodeEnvelope, ENVELOPE_RATE, FILLERS, fillersOf, handleFrames, HEAD_S, PAUSE_MIN_S, pausesOf, planTextCut, speechEdges, speechWords, TAIL_S, tailFrames } from "./transcript.ts";
export type { CutTranscript, CutWord, EditWord, Filler, Pause, SpeechEnvelope, SpeechSegment, StoredEnvelope, TextCut, TextCutPlan, TextCutRequest } from "./transcript.ts";
