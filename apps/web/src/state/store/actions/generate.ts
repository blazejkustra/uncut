import { type GeneratorChoice, type KeyProvider } from "@uncut/contracts";
import { bridge } from "../../bridge.ts";
import { set } from "../core.ts";
import { call, plainError } from "../server.ts";
import type { GenerateDraft } from "../types.ts";
import { actions } from "../actions.ts";

let draftSeq = 0;

export const generateActions = {
  // ---- generators and keys (D99) ----
  async listGenerators() {
    const result = await call((c) => c["generate.list"]({}));
    if (result.ok) set({ generators: result.value });
  },
  async startGenerate(draft: GenerateDraft) {
    set({ generateError: undefined });
    const result = await call((c) =>
      c["generate.start"]({
        generator: draft.generator,
        prompt: draft.prompt,
        ...(draft.kind ? { kind: draft.kind } : {}),
        ...(draft.size ? { size: draft.size } : {}),
        ...(draft.seconds !== undefined ? { seconds: draft.seconds } : {}),
        ...(draft.options && Object.keys(draft.options).length ? { options: draft.options } : {}),
      }),
    );
    if (!result.ok) {
      set({ generateError: plainError(result.error) });
      void actions.listGenerators();
    }
  },
  cancelGenerate: (jobId: string) => call((c) => c["generate.cancel"]({ jobId })),
  /** A plugin generator's choices for an option, from the plugin (#108: the account's voices); an error in words. */
  async generatorChoices(generator: string, option: string): Promise<{ readonly choices: ReadonlyArray<GeneratorChoice> } | { readonly error: string }> {
    const result = await call((c) => c["generate.choices"]({ generator, option }));
    return result.ok ? { choices: result.value } : { error: plainError(result.error) };
  },
  /** "Edit prompt" on a generated result: the Generate tab with its generator, prompt and settings. */
  editPrompt(draft: GenerateDraft) {
    set({ generateDraft: { ...draft, seq: ++draftSeq }, generateError: undefined });
  },
  async listKeys() {
    const result = await call((c) => c["keys.list"]({}));
    if (result.ok) set({ keys: result.value });
  },
  /** Stores a key (it goes to the server once and never comes back). Returns whether it was saved. */
  async setKey(provider: KeyProvider, key: string) {
    set({ keysError: undefined });
    const result = await call((c) => c["keys.set"]({ provider, key }));
    if (!result.ok) {
      set({ keysError: plainError(result.error) });
      return false;
    }
    set({ keys: result.value });
    void actions.listGenerators();
    return true;
  },
  async removeKey(provider: KeyProvider) {
    set({ keysError: undefined });
    const result = await call((c) => c["keys.remove"]({ provider }));
    if (result.ok) set({ keys: result.value });
    else set({ keysError: plainError(result.error) });
    void actions.listGenerators();
  },
  /** Settings › Keys. */
  openKeys() {
    set({ setupOpen: true, setupFocus: "keys" });
    void actions.checkSetup();
    void actions.listKeys();
  },
  copy: (text: string) => bridge.copyText(text),
  /** Finish (or skip) onboarding; it won't open on launch again. */
  async finishSetup(next: "new-project" | "stay") {
    set({ setupOpen: false, setupFocus: undefined });
    void actions.listGenerators();
    await call((c) => c["setup.complete"]({}));
    if (next === "new-project") actions.showNewProject();
  },
};
