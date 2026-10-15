import { type BrandKit, type BrandScope, type BrandSkill, type BrandActive, type BrandImported } from "@uncut/contracts";
import { bridge } from "../../bridge.ts";
import { isTransportError } from "../../connection.ts";
import { set, state, isRemote } from "../core.ts";
import { pickRemote } from "./remote.ts";
import { call, plainError } from "../server.ts";
import { brandResult } from "../sync.ts";
import { nextPanelSeq } from "../agentUi.ts";
import { actions } from "../actions.ts";

export const brandActions = {
  // ---- brand kits and skills (D186) ----
  /** Reads the brand state again (the project's kits and skills, the user's, and its choice). */
  async brandGet() {
    const result = await call((c) => c["brand.get"]({}));
    if (result.ok) set({ brand: result.value });
    else if (!isTransportError(result.error)) set({ brandError: plainError(result.error) });
  },
  /** Each brand change answers with the whole state; true when it was taken. */
  async brandSaveKit(kit: BrandKit) {
    return brandResult(await call((c) => c["brand.saveKit"]({ kit })));
  },
  async brandDeleteKit(id: string, scope: BrandScope) {
    return brandResult(await call((c) => c["brand.deleteKit"]({ id, scope })));
  },
  async brandSaveSkill(skill: BrandSkill) {
    return brandResult(await call((c) => c["brand.saveSkill"]({ skill })));
  },
  async brandDeleteSkill(id: string, scope: BrandScope) {
    return brandResult(await call((c) => c["brand.deleteSkill"]({ id, scope })));
  },
  async brandSetActive(active: BrandActive) {
    // Shown at once, so a second change made before the answer builds on this one, not the old state.
    if (state.brand) set({ brand: { ...state.brand, active } });
    return brandResult(await call((c) => c["brand.setActive"]({ kit: active.kit, skills: [...active.skills] })));
  },
  /** Copies a file into a kit's folder; its name there, or undefined (the reason in brandError). */
  async brandAddFile(kit: string, scope: BrandScope, path: string): Promise<string | undefined> {
    const result = await call((c) => c["brand.addFile"]({ kit, scope, path }));
    if (!result.ok) return void set({ brandError: plainError(result.error) });
    set({ brand: result.value.state, brandError: undefined });
    return result.value.name;
  },
  /** D198: logos and fonts from a file, a folder or an https address into a kit's folder; what came in, or undefined (the reason in brandError). */
  async brandImport(kit: string, scope: BrandScope, source: string): Promise<ReadonlyArray<BrandImported> | undefined> {
    const result = await call((c) => c["brand.import"]({ kit, scope, source }));
    if (!result.ok) return void set({ brandError: plainError(result.error) });
    set({ brand: result.value.state, brandError: undefined });
    return result.value.files;
  },
  /** D198: a file or a folder to import into a kit (the native dialog; a remote's own disk isn't browsable for this). */
  async pickBrandSource(): Promise<string | undefined> {
    if (isRemote()) return undefined;
    return (await bridge.chooseFolder("brand")) ?? undefined;
  },
  /** Files for a kit (logos, examples, a reference): the native dialog here, the server's disk on a remote. */
  async pickBrandFiles(): Promise<ReadonlyArray<string>> {
    const picked = isRemote() ? await pickRemote("media") : await bridge.chooseMedia();
    return picked === null ? [] : typeof picked === "string" ? [picked] : picked;
  },
  dismissBrandError: () => set({ brandError: undefined }),
  /**
   * D232 (issue #60): calls a skill in the composer: /name at the start of the draft (once), the
   * Agent tab open and the caret at the end, like Add to chat (D141). Nothing is sent.
   */
  composeSkill(name: string) {
    const draft = state.agentDraft;
    const call = `/${name}`;
    const has = new RegExp(`(^|\\s)${call.replace(/[-/]/g, "\\$&")}(\\s|$)`).test(draft);
    set({ agentDraft: has ? draft : `${call} ${draft.trimStart()}`, agentFocus: state.agentFocus + 1, panelRequest: { panel: "agent", seq: nextPanelSeq() } });
  },
  /** D232: where skills come from: Settings, the plugins (Uncut's setup, its Capture step). */
  openPlugins() {
    actions.openSetup();
    set({ setupFocus: "plugins" });
  },
};
