import type { Id, Item, Project } from "../timeline/types.ts";
import { audible, checkContext, isSpeechTrack, soundOf, startOf } from "./context.ts";
import { musicItems, sfxItems, type SfxKind } from "./soundSheet.ts";

/** What a sound on the timeline is to the mix: speech, the music bed, an effect, or anything else (ambience). */
export type SoundRole = "voice" | "music" | "effects" | "other";
export const SOUND_ROLES: ReadonlyArray<SoundRole> = ["voice", "music", "effects", "other"];

/** One heard item with its role, where it starts (project frames) and its name in messages. */
export interface RoledSound {
  readonly item: Item;
  readonly role: SoundRole;
  readonly start: number;
  readonly label: string;
  /** An effect's kind (whoosh, ui, hit…). */
  readonly kind?: SfxKind;
}

/**
 * Every item that sounds in the mix (unmuted, on an audible track, with sound) and its role: music and
 * effects as the sound sheet tells them, voice on a speech track; when no track is known to carry
 * speech, the main track's own sound counts as the voice (a talking-head or screen recording's).
 */
export function soundRoles(project: Project, options: { readonly speechMedia?: Iterable<Id> } = {}): Map<Id, RoledSound> {
  const ctx = checkContext(project, options);
  const music = new Set(musicItems(ctx).map((m) => m.item.id));
  const effects = new Map(sfxItems(ctx).map((s) => [s.item.id, s]));
  const out = new Map<Id, RoledSound>();
  for (const track of project.tracks) {
    if (!audible(ctx, track)) continue;
    const speech = isSpeechTrack(ctx, track);
    for (const item of track.items) {
      const media = soundOf(ctx, item);
      if (!media) continue;
      const sfx = effects.get(item.id);
      const role: SoundRole = music.has(item.id) ? "music" : sfx ? "effects" : speech ? "voice" : "other";
      out.set(item.id, { item, role, start: startOf(ctx, item), label: sfx?.label ?? media.name, ...(sfx ? { kind: sfx.kind } : {}) });
    }
  }
  if (![...out.values()].some((s) => s.role === "voice")) {
    const main = project.tracks.find((t) => t.role === "main");
    for (const item of main?.items ?? []) {
      const heard = out.get(item.id);
      if (heard?.role === "other") out.set(item.id, { ...heard, role: "voice" });
    }
  }
  return out;
}
