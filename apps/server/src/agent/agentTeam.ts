// C12: several agents in one project: each one's focus preset (a paragraph of its message; it
// steers, never forbids) and what it is told about the others.
import type { AgentFocus } from "@uncut/contracts";

export const FOCUS_NAMES: Record<AgentFocus, string> = {
  general: "Editor",
  cuts: "Cuts",
  graphics: "Graphics",
  look: "Look",
  sound: "Sound",
  captions: "Captions",
};

const FOCUS_WORDS: Record<AgentFocus, string> = {
  general: "anything in the edit",
  cuts: "the main track: cuts, the transcript, pacing and order",
  graphics: "text, titles, graphics and components on overlay tracks, and the graphics/*.html files",
  look: "effects, colour, transforms, keys and transitions",
  sound: "audio tracks, music, the mixer, volume and fades",
  captions: "captions and subtitles",
};

export interface Teammate {
  readonly agentId: string;
  readonly name: string;
  readonly focus: AgentFocus;
  readonly working: boolean;
}

/**
 * The <agents> block of a message: who this agent is, what it focuses on, the other agents and
 * theirs. Empty for a project's only agent on the general focus (nothing changes for it).
 */
export function teamBlock(me: Teammate, others: ReadonlyArray<Teammate>): string {
  if (!others.length && me.focus === "general") return "";
  const lines = [`You are ${me.name}, one of the agents editing this project. Your focus: ${FOCUS_WORDS[me.focus]}.`];
  if (me.focus !== "general")
    lines.push("Stay in your focus; outside it make small fixes only, and leave the rest to the agent whose focus it is (or tell the user).");
  if (others.length) {
    lines.push("The other agents edit the same project at the same time, each in its own chat:");
    for (const o of others) lines.push(`- ${o.name}: ${FOCUS_WORDS[o.focus]}${o.working ? " (working now)" : ""}`);
    lines.push(
      'Their edits reach you in your notes and edit results, named ("by Graphics: ..."): build on them, don\'t redo or revert them; if you disagree, tell the user. An edit of an item another agent changed after your baseRevision is refused: read the project again and keep their change.',
      "Two agents inserting clips by position on Main shift each other's clips without a conflict: read the project right before an insert on Main and check where it landed.",
    );
  }
  return `<agents>\n${lines.join("\n")}\n</agents>`;
}
