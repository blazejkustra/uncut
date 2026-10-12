// @uncut/core: the reference format code shared by the server, the renderer and the tests.
export type * from "./types.ts";
export { loadModules, validateModule, validateOps, validateProject } from "./validate.ts";
export { resolveStarts, projectDuration, timelineProblems } from "./rules.ts";
export { EditError, EditConflict, TurnDependency, createSession, applyEdit, undoTurn } from "./apply-ops.ts";
export { describeOp, manualEditsNote } from "./edit-log.ts";
export { animationAt, DRAWN_MOVES, layout, visualsAt } from "./timeline.ts";
export { audibleAt, audioSpan, dbToGain, fadeAt, gainToDb, itemGain, keyDbAt, MAX_DB, SILENCE_DB, soundMedia, sourceAt, trackAudible } from "./audio.ts";
export type { Audible } from "./audio.ts";
export type { Visual } from "./timeline.ts";
export { canvasBackground, DEFAULT_THEME, esc, RENDER_CSS, resolveColor, resolveFont, safeMargin, SOLID, solidBackground, solidHtml, TEXT_STYLES, textHtml, textLook, themeColors } from "./render.ts";
export type { Motion, RenderTarget, TextLook } from "./render.ts";
