// Captions from a transcript (D82), browser-safe. A captions item keeps a snapshot of its source
// media's transcript words (media seconds, where each word is heard: speechWords, D74) and is
// resolved at every frame through the main-track clips that play that media (the editWords rule: a
// word belongs to the clip whose played stretch holds its middle), so cuts, trims, splits and
// transcript_edit removals move the captions with the speech and removed words simply aren't there.
// Cards are grouped per clip from the words it plays; the card at a frame becomes an ordinary text
// item (the captions item's look, style and position) that core textHtml draws, so the preview, the
// export and render_frames draw the same thing. Corrections (`edits`, keyed by word index into the
// snapshot = transcript_read's w12) and forced card starts (`breaks`) survive any re-cut.
export { CAPTION_MODES, CAPTION_MODE_NAMES, CAPTION_DEFAULTS, CAPTION_LINE_BOUNDS, CAPTION_MIN_S, CAPTION_HOLD_S, CAPTION_BRIDGE_S, autoMaxChars, captionSettings, captionMode, captionWordText } from "./captions/settings.ts";
export type { CaptionMode, CaptionWord, CaptionLines, CaptionCard } from "./captions/settings.ts";
export { captionCards, captionExtent, captionCardAt, activeWord, captionAt, captionBox, captionSegments, checkCaptionLines } from "./captions/cards.ts";
export { planMakeCaptions, planCaptionEdit, captionsCoverMain, captionCardList } from "./captions/plans.ts";
export type { MakeCaptionsRequest, MakeCaptionsPlan, CaptionEdit } from "./captions/plans.ts";
export { CAPTION_STYLES, captionStyleDef, captionStyleFields, planCaptionStyle, planCaptionHighlight, captionStyleSample } from "./captions/styles.ts";
export type { CaptionStyleDef } from "./captions/styles.ts";
