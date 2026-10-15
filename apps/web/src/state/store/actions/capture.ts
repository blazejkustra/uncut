import { type TakeKind, takeUploadName, type CaptureOptions, type MultiLayout } from "@uncut/contracts";
import { playback } from "../../../preview/playback.ts";
import { set, state } from "../core.ts";
import { call, plainError, uploadOne } from "../server.ts";
import { actions } from "../actions.ts";

export const captureActions = {
  /** The Capture tab: Argent's devices (and whether Argent is there at all). */
  async checkCapture() {
    set({ captureChecking: true });
    const result = await call((c) => c["capture.devices"]({}));
    if (result.ok) set({ captureChecking: false, capture: result.value, captureError: undefined });
    else set({ captureChecking: false, captureError: plainError(result.error) });
  },
  async startCapture(device: string, options: CaptureOptions = {}) {
    set({ captureError: undefined, captureSaved: undefined, captureBusy: [...(state.captureBusy ?? []), device] });
    const result = await call((c) => c["capture.start"]({ device, ...options }));
    set({ captureBusy: (state.captureBusy ?? []).filter((d) => d !== device) });
    if (!result.ok) set({ captureError: plainError(result.error) });
    await actions.checkCapture();
  },
  /**
   * D143: a take that replays a saved flow; it ends with the flow and lands in Media as one edit.
   * The row shows its timer while the flow runs (the server lists it as recording).
   */
  async recordFlow(device: string, flow: string, options: CaptureOptions = {}) {
    set({ captureError: undefined, captureSaved: undefined, captureBusy: [...(state.captureBusy ?? []), device] });
    const pending = call((c) => c["capture.record"]({ device, flow, ...(options.showTouches !== undefined ? { showTouches: options.showTouches } : {}), ...(options.orientation ? { orientation: options.orientation } : {}), ...(options.bundleId ? { bundleId: options.bundleId } : {}) }), 12 * 60 * 1000);
    await new Promise((r) => setTimeout(r, 400));
    await actions.checkCapture();
    const result = await pending;
    set({ captureBusy: (state.captureBusy ?? []).filter((d) => d !== device) });
    if (result.ok) set({ captureSaved: result.value });
    else set({ captureError: plainError(result.error) });
    await actions.checkCapture();
  },
  /** D143: "Boot and record": Argent boots the simulator or AVD (only on this click), then the take starts. */
  async bootAndRecord(device: string, options: CaptureOptions = {}, flow?: string) {
    set({ captureError: undefined, captureSaved: undefined, captureBooting: [...(state.captureBooting ?? []), device] });
    const booted = await call((c) => c["capture.boot"]({ device }), 10 * 60 * 1000);
    set({ captureBooting: (state.captureBooting ?? []).filter((d) => d !== device) });
    if (!booted.ok) {
      set({ captureError: plainError(booted.error) });
      return void (await actions.checkCapture());
    }
    await actions.checkCapture();
    if (flow) await actions.recordFlow(booted.value.device, flow, options);
    else await actions.startCapture(booted.value.device, options);
  },
  /** Stops a recording; the server adds the take to the project as one edit (⌘Z removes it). */
  async stopCapture(device: string) {
    set({ captureError: undefined, captureBusy: [...(state.captureBusy ?? []), device] });
    const result = await call((c) => c["capture.stop"]({ device }));
    set({ captureBusy: (state.captureBusy ?? []).filter((d) => d !== device) });
    if (result.ok) set({ captureSaved: result.value });
    else set({ captureError: plainError(result.error) });
    await actions.checkCapture();
  },
  /**
   * D114: a take recorded on this Mac goes up to the active server's media/uploads/ (Local or a
   * remote alike, D108), then capture.save converts it into media/captures/ and imports it as one
   * edit, placed at `placeAt` when given. The project must still be the one it was recorded for.
   */
  async saveTake(blob: Blob, take: { readonly kind: TakeKind; readonly name?: string; readonly device?: string; readonly placeAt?: number; readonly dir: string }): Promise<{ readonly saved: { readonly mediaId: string; readonly name: string; readonly seconds: number; readonly itemId?: string | undefined; readonly trackId?: string | undefined } } | { readonly problem: string }> {
    if (state.snapshot?.dir !== take.dir) return { problem: "The project changed while recording, so the take wasn't added." };
    const ext = blob.type.startsWith("audio/") ? "webm" : blob.type.includes("mp4") ? "mp4" : "webm";
    const uploaded = await uploadOne(new File([blob], takeUploadName(take.kind, ext), { type: blob.type }));
    if ("message" in uploaded) return { problem: `The take couldn't be sent to the server: ${uploaded.message}` };
    if (state.snapshot?.dir !== take.dir) return { problem: "The project changed while recording, so the take wasn't added." };
    // Converting a long camera or screen take can take a while: wait up to 10 minutes.
    const result = await call((c) => c["capture.save"]({ path: uploaded.path, kind: take.kind, ...(take.name ? { name: take.name } : {}), ...(take.device ? { device: take.device } : {}), ...(take.placeAt !== undefined ? { placeAt: take.placeAt } : {}) }), 10 * 60 * 1000);
    if (!result.ok) return { problem: plainError(result.error) };
    if (result.value.itemId) playback.select(result.value.itemId);
    return { saved: result.value };
  },
  /**
   * D211: a multi-source take: each part uploaded on its own, then capture.saveMulti converts them
   * into the take's folder and imports them as one edit (placed at `placeAt`, start-aligned, grouped).
   */
  async saveMultiTake(take: { readonly parts: ReadonlyArray<{ readonly blob: Blob; readonly kind: TakeKind; readonly device?: string | undefined; readonly offsetMs: number; readonly recordedMs: number }>; readonly name?: string | undefined; readonly placeAt?: number; readonly layout?: MultiLayout | undefined; readonly dir: string }): Promise<{ readonly saved: { readonly name: string; readonly seconds: number; readonly items: ReadonlyArray<{ readonly itemId: string }> } } | { readonly problem: string }> {
    const changed = { problem: "The project changed while recording, so the take wasn't added." };
    if (state.snapshot?.dir !== take.dir) return changed;
    const parts: Array<{ path: string; kind: TakeKind; device?: string; offsetMs: number; recordedMs: number }> = [];
    for (const part of take.parts) {
      const ext = part.blob.type.startsWith("audio/") ? "webm" : part.blob.type.includes("mp4") ? "mp4" : "webm";
      const uploaded = await uploadOne(new File([part.blob], takeUploadName(part.kind, ext), { type: part.blob.type }));
      if ("message" in uploaded) return { problem: `The take couldn't be sent to the server: ${uploaded.message}` };
      parts.push({ path: uploaded.path, kind: part.kind, ...(part.device ? { device: part.device } : {}), offsetMs: Math.max(0, Math.round(part.offsetMs)), recordedMs: Math.round(part.recordedMs) });
    }
    if (state.snapshot?.dir !== take.dir) return changed;
    const result = await call((c) => c["capture.saveMulti"]({ parts, ...(take.name ? { name: take.name } : {}), ...(take.placeAt !== undefined ? { placeAt: take.placeAt } : {}), ...(take.layout ? { layout: take.layout } : {}) }), 10 * 60 * 1000);
    if (!result.ok) return { problem: plainError(result.error) };
    const first = result.value.items[0];
    if (first) playback.select(first.itemId);
    return { saved: result.value };
  },
};
