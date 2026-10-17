// Legibility from the text census (packages/core census.ts): render_frames' note and review_submit's
// finding and facts. The keynote films' step lines stood 2 to 2.5 % tall (a piece typed under its
// default, a thread's step rows smaller than its message), the critic called them readable by eye,
// and nothing measured them; whole-editor moments were blocked one per round. The census lists every
// word under the floor in each frame, so the agent sees them all before the critic.
import { censusList, LETTER_SHARE, SMALL_TEXT, type CensusRun } from "@uncut/core";

import type { CriticFinding } from "./agentCritic.ts";

/** A frame's census as render_frames and review_submit get it. */
export interface CensusFrame {
  readonly frame: number;
  readonly small?: ReadonlyArray<CensusRun>;
  readonly measured?: number;
}

/** The smallest uncutUI type (px) whose letters reach SMALL_TEXT on a canvas this tall. */
export const minType = (height: number) => Math.ceil((SMALL_TEXT / LETTER_SHARE) * height);

/** The one-call fixes for small words in an uncutUI film, with this canvas's numbers. */
export const legibleFix = (height: number) =>
  `Set the line the moment is about as an uncutUI piece at its default size (an uncutUI.sequence key without type: words 4.8 % of the height, letters about 3.5 %; type under ${minType(height)} px on this ${height} px canvas leaves letters under ${SMALL_TEXT * 100} %, and a piece's type sizes its first line, so a thread's 12 px step rows come out at 12/13 of its message: give the steps their own "turn.steps" key), or push the camera in until its words read: key = uncutUI.frameText(el, world, { width, height }) (fits false: too wide, set it as a piece). Labels and chrome around the moment may stay small.`;

const frames = (list: ReadonlyArray<CensusFrame>) => list.filter((f) => f.small?.length);

/** render_frames' note: each frame's words under the floor, then the fix; undefined when none (or no census). */
export function legibilityNote(list: ReadonlyArray<CensusFrame>, height: number): string | undefined {
  const small = frames(list);
  if (!small.length) return undefined;
  const lines = small.slice(0, 6).map((f) => `frame ${f.frame}: ${censusList(f.small!, 4)}`);
  return `Small text, measured on the graphics' words (letters' height as % of the frame's height; words a viewer must read need ${SMALL_TEXT * 100} %): ${lines.join("; ")}${small.length > 6 ? `; ${small.length - 6} more frames` : ""}. ${legibleFix(height)}`;
}

/** The census near a moment (seconds): the closest measured frame within half a second, as "measured there: …". */
export function censusNear(list: ReadonlyArray<CensusFrame>, at: number, fps: number): string | undefined {
  const f = at * fps;
  const near = list.filter((x) => x.measured !== undefined && Math.abs(x.frame - f) <= fps / 2).sort((a, b) => Math.abs(a.frame - f) - Math.abs(b.frame - f))[0];
  if (!near) return undefined;
  return near.small?.length ? `measured at f ${near.frame}: ${censusList(near.small, 3)}` : `measured at f ${near.frame}: no word under ${SMALL_TEXT * 100} %`;
}

/** The critic's fact line (in <motion>): the sheet's frames with words under the floor, or that none has. */
export function legibilityFacts(list: ReadonlyArray<CensusFrame>, fps: number): Array<string> {
  const measured = list.filter((f) => (f.measured ?? 0) > 0);
  if (!measured.length) return [];
  const small = frames(measured);
  const head = `Words measured on the graphics (DOM text on screen, not faded or blurred; letters' height as % of the frame's height; ${SMALL_TEXT * 100} % is the floor for words a viewer must read; canvas-drawn text isn't measured)`;
  if (!small.length) return [`${head}: none under ${SMALL_TEXT * 100} % in the ${measured.length} contact-sheet frames.`];
  return [`${head}: ${small.map((f) => `f ${f.frame} (${(f.frame / fps).toFixed(1)} s): ${censusList(f.small!, 3)}`).join("; ")}. Small labels and chrome around the moment's subject are texture; the line the moment is about isn't.`];
}

/** review_submit's finding for the agent (never a blocker): every sheet frame with small words at once, and the fix. */
export function legibilityFindings(list: ReadonlyArray<CensusFrame>, fps: number, height: number): Array<CriticFinding> {
  const small = frames(list);
  if (!small.length) return [];
  const first = small[0]!.frame;
  return [{ rule: "legibility", key: `legibility:${first}`, frame: first, hard: false, message: `Small text in ${small.length} of the contact sheet's frames (letters under ${SMALL_TEXT * 100} % of the height, measured on the graphics' words): ${small.slice(0, 8).map((f) => `f ${f.frame} (${(f.frame / fps).toFixed(1)} s): ${censusList(f.small!, 3)}`).join("; ")}. Where one of them is the line the moment is about, fix them all in this round, not one per round: ${legibleFix(height)}` }];
}
