// Transcripts in the editing model (D68, D69), browser-safe: the fillers and pauses derived from a
// transcript's words (the server's transcript_read and the Transcript panel derive the same ones),
// and planTextCut, which turns "remove these words / pauses / fillers" into one timeline edit. The
// transcript is in seconds of the media file; the timeline in project frames (D38).
export { PAUSE_MIN_S, FILLERS, fillersOf, pausesOf, HEAD_S, TAIL_S, handleFrames, tailFrames, DEFAULT_PAUSE_MIN_S } from "./transcript/fillers.ts";
export type { Filler, Pause } from "./transcript/fillers.ts";
export { ENVELOPE_RATE, encodeEnvelope, decodeEnvelope, speechThreshold, envelopeInformative, speechEdges, speechWords } from "./transcript/speech.ts";
export type { SpeechSegment, StoredEnvelope, SpeechEnvelope, HeardWords } from "./transcript/speech.ts";
export type { CutWord } from "./transcript/cutSpans.ts";
export { planTextCut } from "./transcript/textCut.ts";
export type { CutTranscript, TextCutRequest, TextCut, TextCutPlan } from "./transcript/textCut.ts";
export { soundParts, speechItem, transcriptScope, editWords } from "./transcript/editWords.ts";
export type { EditWord, TranscriptScope } from "./transcript/editWords.ts";
