import { type LibraryState, type SoundFolderInfo, type LibrarySearchResult } from "@uncut/contracts";
import { bridge } from "../../bridge.ts";
import { isTransportError } from "../../connection.ts";
import { getPlayback } from "../../../preview/playback.ts";
import { type LibraryQuery, libraryMediaOf, MUSIC_LIBRARY_PATH } from "@uncut/core/library";
import { planAddAtPlayhead, planAddMedia, planAddLibrarySound } from "../../project.ts";
import { set, state, online, projectOf, isRemote } from "../core.ts";
import { pickRemote } from "./remote.ts";
import { addPlanned, adding } from "../edits.ts";
import { call, plainError } from "../server.ts";

// A library sound being downloaded or copied and added (D134).
let soundAdding = false;

export const mediaActions = {
  /** A generated result → the timeline at the playhead (see planAddAtPlayhead, D99). */
  addAtPlayhead: (mediaId: string) => addPlanned((project) => planAddAtPlayhead(project, mediaId, getPlayback().frame)),
  /** Media tile → timeline (see planAddMedia); the playhead moves to the new item. */
  addMedia: (mediaId: string) => addPlanned((project) => planAddMedia(project, mediaId, getPlayback().frame)),
  /** The sound library's sources and limit (D134). */
  async libraryState(): Promise<LibraryState | undefined> {
    const result = await call((c) => c["library.state"]({}));
    return result.ok ? result.value : undefined;
  },
  /** The user's sound folders (D208), indexed again with rescan; the error in words. */
  async soundFolders(rescan = false): Promise<ReadonlyArray<SoundFolderInfo> | { readonly error: string }> {
    const result = await call((c) => c["library.folders"](rescan ? { rescan: true } : {}));
    return result.ok ? result.value : { error: plainError(result.error) };
  },
  /** Add a folder of sounds (the native dialog; the server's disk on a remote); undefined when cancelled. */
  async addSoundFolder(): Promise<ReadonlyArray<SoundFolderInfo> | { readonly error: string } | undefined> {
    let path: string | null;
    if (isRemote()) {
      const picked = await pickRemote("parent");
      path = typeof picked === "string" ? picked : null;
    } else path = await bridge.chooseFolder("sounds");
    if (!path) return undefined;
    const result = await call((c) => c["library.folderAdd"]({ path }));
    return result.ok ? result.value : { error: plainError(result.error) };
  },
  /** D249: list the Music app's library (its DRM-free songs) as one of the user's folders. */
  async addMusicLibrary(): Promise<ReadonlyArray<SoundFolderInfo> | { readonly error: string }> {
    const result = await call((c) => c["library.folderAdd"]({ path: MUSIC_LIBRARY_PATH }));
    return result.ok ? result.value : { error: plainError(result.error) };
  },
  async removeSoundFolder(id: string): Promise<ReadonlyArray<SoundFolderInfo> | { readonly error: string }> {
    const result = await call((c) => c["library.folderRemove"]({ id }));
    return result.ok ? result.value : { error: plainError(result.error) };
  },
  /** An online search (D134): the result, or the error in words. */
  async searchLibrary(query: LibraryQuery): Promise<LibrarySearchResult | { readonly error: string }> {
    const result = await call((c) =>
      c["library.search"]({
        kind: query.kind,
        query: query.query,
        ...(query.source ? { source: query.source } : {}),
        ...(query.license ? { license: query.license } : {}),
        ...(query.length ? { length: query.length } : {}),
        ...(query.songs ? { songs: true } : {}),
        ...(query.page ? { page: query.page } : {}),
      }),
    );
    return result.ok ? result.value : { error: plainError(result.error) };
  },
  /**
   * Library sound → the timeline (D134): the server downloads it into the project's media/ (or
   * copies a bundled sound effect, id sfx:<id>) unless it's there already, then the media (with its
   * credits) and the item go in as one edit, at the playhead on a free audio track.
   */
  async addLibrarySound(id: string, music: boolean, name: string) {
    if (!state.snapshot || !online() || adding || soundAdding) return;
    soundAdding = true;
    set({ libraryAdding: id });
    try {
      const existing = libraryMediaOf(projectOf(state.snapshot), id);
      let sound = {
        libraryId: id,
        name: existing?.name ?? name,
        seconds: (existing?.probe?.frames ?? 0) / projectOf(state.snapshot).canvas.fps,
        music,
      } as Parameters<typeof planAddLibrarySound>[1];
      if (!existing) {
        const result = await call((c) => c["library.add"]({ id }));
        if (!result.ok) return set({ notice: { text: plainError(result.error), transport: isTransportError(result.error) } });
        sound = { ...sound, name: result.value.name, path: result.value.path, seconds: result.value.seconds, source: result.value.source };
      }
      await addPlanned((project) => planAddLibrarySound(project, sound, getPlayback().frame));
    } finally {
      soundAdding = false;
      set({ libraryAdding: undefined });
    }
  },
};
