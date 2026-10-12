// Turns the user's manual edits since the agent's last turn into the short note
// the agent gets before its next turn (D6). The same entries feed the
// "You made N edits by hand" line in the Agent tab.
import type { Id, Op, Project, Session } from "./types.ts";

const secs = (frames: number, fps: number) => `${(Math.abs(frames) / fps).toFixed(1)}s`;

function label(project: Project, id: Id) {
  for (const t of project.tracks) {
    const item = t.items.find((i) => i.id === id);
    if (item) {
      const media = item.media && project.media.find((m) => m.id === item.media);
      const name = item.name ?? (item.text ? `text "${item.text.replace(/\n/g, " ")}"` : (media || undefined)?.name ?? item.component ?? id);
      return `${name} (${id})`;
    }
  }
  return id;
}

export function describeOp(op: Op, project: Project): string {
  const fps = project.canvas.fps;
  const it = (id: Id) => label(project, id);
  switch (op.op) {
    case "trim_item":
      return `${op.frames > 0 ? "Trimmed" : "Extended"} ${it(op.item)} by ${secs(op.frames, fps)} at the ${op.edge}`;
    case "update_item":
      return `Changed ${Object.keys(op.set).join(", ")} on ${it(op.item)}`;
    case "split_item":
      return `Split ${it(op.item)} at ${secs(op.at, fps)}`;
    case "move_item":
      return `Moved ${it(op.item)}${op.track ? ` to track ${op.track}` : ""}${op.start !== undefined ? ` to ${secs(op.start, fps)}` : ""}`;
    case "delete_item":
      return `Deleted ${op.item}`;
    case "insert_item":
      return `Added ${op.item.type} ${op.item.id} on track ${op.track}`;
    case "set_transition":
      return op.transition ? `Set ${op.transition.module} into ${it(op.item)}` : `Removed the transition into ${it(op.item)}`;
    case "update_track":
      return `Changed ${Object.keys(op.set).join(", ")} on track ${op.track}`;
    case "add_track":
      return `Added ${op.track.kind ?? ""} track ${op.track.name ? `"${op.track.name}" (${op.track.id})` : op.track.id}`.replace("  ", " ");
    case "delete_track":
      return `Deleted track ${op.track}`;
    case "add_media":
      return `Added media ${op.media.name} (${op.media.id})`;
    case "update_project":
      return `Changed project ${Object.keys(op.set).join(", ")}`;
    default:
      // Every op is handled above; this is for ops from a newer format.
      return String((op as { op: unknown }).op).replace(/_/g, " ");
  }
}

/** The note the agent receives. Empty string when the user changed nothing. */
export function manualEditsNote(session: Session, sinceRevision: number): string {
  const entries = session.log.filter((e) => e.revision > sinceRevision && e.actor === "user");
  const lines = entries.flatMap((e) => e.ops.map((op) => `- ${describeOp(op, session.project)}`));
  if (!lines.length) return "";
  return [
    `The user made ${lines.length} edit${lines.length === 1 ? "" : "s"} by hand since your last turn (now at revision ${session.revision}).`,
    "They are intentional. Keep them, build on them, and don't undo or question them unless the user asks.",
    ...lines,
  ].join("\n");
}
