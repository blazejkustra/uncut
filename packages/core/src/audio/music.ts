// The bundled music library (D91): five cozy CC0 tracks in assets/music, described by its
// library.json (title, moods, tempo, length, loudness, licence). Browser-safe: the Audio tab, the
// server's music.add and the agent's music_list / music_add all read this one list.
//
// A track added to a project is copied into the project's media/ folder and referenced there by a
// relative path (D12: the project stays portable), so it's plain audio media from then on.
import libraryJson from "../../../../assets/music/library.json" with { type: "json" };
import type { Media, Project } from "../timeline/types.ts";

export interface MusicTrack {
  readonly id: string;
  /** The file in assets/music (and the name it gets in a project's media/ folder). */
  readonly file: string;
  readonly title: string;
  readonly moods: ReadonlyArray<string>;
  /** Beats per minute (from the title or measured), null when there's no steady pulse. */
  readonly bpm: number | null;
  readonly seconds: number;
  /** Integrated loudness of the file (they're all normalised to about −16 LUFS). */
  readonly lufs: number;
  readonly bytes: number;
  /** Set when the file is a cut of a longer original. */
  readonly trimmed?: string;
  readonly author: string;
  readonly source: string;
  readonly license: string;
  readonly licenseChecked: string;
}

export const MUSIC_TRACKS: ReadonlyArray<MusicTrack> = (libraryJson as { tracks: ReadonlyArray<MusicTrack> }).tracks;

export type MusicTempo = "slow" | "medium" | "fast" | "free";
export const MUSIC_TEMPOS: ReadonlyArray<MusicTempo> = ["slow", "medium", "fast", "free"];
/** slow under 80 bpm, medium 80–109, fast from 110; free = no steady pulse. */
export const musicTempo = (bpm: number | null): MusicTempo => (bpm === null ? "free" : bpm < 80 ? "slow" : bpm < 110 ? "medium" : "fast");

/** Every mood tag in the library, in first-seen order. */
export const MUSIC_MOODS: ReadonlyArray<string> = [...new Set(MUSIC_TRACKS.flatMap((t) => t.moods))];

export const musicTrack = (id: string) => MUSIC_TRACKS.find((t) => t.id === id);

/** Tracks matching a search (title, author or mood words), a mood and a tempo; all when none is given. */
export function filterMusic({ query, mood, tempo }: { readonly query?: string | undefined; readonly mood?: string | undefined; readonly tempo?: MusicTempo | undefined } = {}): Array<MusicTrack> {
  const words = (query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  return MUSIC_TRACKS.filter((t) => {
    if (mood && !t.moods.includes(mood)) return false;
    if (tempo && musicTempo(t.bpm) !== tempo) return false;
    const hay = `${t.title} ${t.author} ${t.moods.join(" ")}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** Where a library track lives in a project: media/<file>, relative to the project folder. */
export const musicPath = (track: Pick<MusicTrack, "file">) => `media/${track.file}`;

/** A media entry that is a library track (copied into media/ under its own name, or a numbered copy). */
export function libraryTrackOf(media: Pick<Media, "path">): MusicTrack | undefined {
  const path = media.path.replace(/\\/g, "/");
  if (!path.startsWith("media/")) return undefined;
  const name = path.slice("media/".length);
  return MUSIC_TRACKS.find((t) => t.file === name) ?? MUSIC_TRACKS.find((t) => new RegExp(`^${t.file.replace(/\.m4a$/, "")}-\\d+\\.m4a$`).test(name));
}

/** The project's media entry for a library track already in it, if any. */
export const musicInProject = (project: Pick<Project, "media">, track: Pick<MusicTrack, "id">) => project.media.find((m) => libraryTrackOf(m)?.id === track.id);

/** A media id from a name, like the import's ("m-" + lowercase words), unique against `taken`. */
function mediaIdFor(name: string, taken: ReadonlySet<string>) {
  const stem = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "music";
  let id = `m-${stem}`;
  for (let n = 2; taken.has(id); n++) id = `m-${stem}-${n}`;
  return id;
}

/**
 * The add_media entry for a library track copied to `path` (relative, media/…): audio, its title as
 * the name, its length in project frames. `taken` holds every id in the project (media, tracks,
 * items, scenes).
 */
export function musicMedia(track: MusicTrack, path: string, fps: number, taken: ReadonlySet<string>): Media {
  return { id: mediaIdFor(track.title, taken), kind: "audio", name: track.title, path, probe: { frames: Math.max(1, Math.floor(track.seconds * fps)), hasAudio: true } };
}

/** Every id the validator requires to be unique. */
export const projectIds = (project: Pick<Project, "media" | "tracks" | "scenes">) =>
  new Set([...project.media.map((m) => m.id), ...project.tracks.flatMap((t) => [t.id, ...t.items.map((i) => i.id)]), ...(project.scenes ?? []).map((s) => s.id)]);
