// ui_show, the approval cards (askUser), media_download and the built-in tools' permission prompts (can_use_tool).
import { randomUUID } from "node:crypto";
import { AGENT_UI_PANELS, type AgentApproval, type Storyboard, type AgentQuestion, type AgentUiPanel } from "@uncut/contracts";
import { layout } from "@uncut/core";
import * as Effect from "effect/Effect";
import { QUESTION_MS } from "../agentPlan.ts";
import { join } from "node:path";
import { decide, inside, realPath, shownPath } from "../agentPermissions.ts";
import { BRAND_ID, globalBrandDir, readActive } from "../../brand/store.ts";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { basename, extname } from "node:path";
import { FONT_FORMATS } from "@uncut/core";
import { BRAND_DOWNLOAD_TYPES, DOWNLOAD_TYPES, downloadToFolder, safeName } from "../agentDownload.ts";
import { fontFileFamilies, MAX_KIT_FONT_BYTES, projectFontsDir } from "../../export/fonts.ts";
import type { ProjectView } from "../../project/projects.ts";
import type { Running, ClaudeSession } from "../session/types.ts";
import { isString } from "../turns/history.ts";
import { DOWNLOADS_PER_TURN, DOWNLOAD_BYTES_PER_TURN } from "./common.ts";
import type { McpResult, CardAnswer } from "../agent.ts";
import type { TranscriptCtx } from "./transcript.ts";

/**
 * D296: the folders read without a card (agentPermissions sanctioned): the active kit's in the
 * user's kits and the bundled graphic libraries; real paths. A project's own kit is in the project
 * zone already. A kit folder that is a symlink out of the kits folder sanctions nothing, so a link
 * can't open up any folder it points at.
 */
export const sanctionedDirs = (config: { readonly dataDir: string; readonly graphicLibsDir: string }, projectDir: string, kit: string | null): Array<string> => {
  const dirs = [realPath(config.graphicLibsDir, projectDir)];
  if (kit && BRAND_ID.test(kit)) {
    const kits = join(globalBrandDir(config.dataDir), "kits");
    const parent = realPath(kits, projectDir);
    const dir = realPath(join(kits, kit), projectDir);
    if (dir !== parent && inside(dir, parent)) dirs.push(dir);
  }
  return dirs;
};

const FONT_DOWNLOAD_TYPES = Object.fromEntries(Object.entries(BRAND_DOWNLOAD_TYPES).filter(([type]) => /font|opentype/.test(type)));

/**
 * A downloaded font file moved into <project>/fonts, named after its family (`name`) when given.
 * Refused (and removed) when projectFontSources wouldn't register it: over its size limit, or a
 * family name it doesn't take. A taken name gets a numbered weightless style (Geist-2.woff2), so the
 * family stays the one reported.
 */
export async function intoFonts(path: string, projectDir: string, name: string | undefined): Promise<{ readonly path: string; readonly family: string } | { readonly problem: string }> {
  const refuse = async (problem: string) => (await rm(path, { force: true }), { problem });
  const size = await stat(path).then((x) => x.size, () => 0);
  if (size > MAX_KIT_FONT_BYTES) return refuse(`the font file is ${(size / 1024 / 1024).toFixed(1)} MB; fonts over ${MAX_KIT_FONT_BYTES / 1024 / 1024} MB aren't used.`);
  const ext = extname(path).toLowerCase();
  const stem = (name ? safeName(name) : basename(path, extname(path))).replace(/ \d+$/, "");
  // The family as projectFontSources reads it: the file's own name table (TTF, OTF), else its name before the first dash.
  const own = ext === ".ttf" || ext === ".otf" ? (await fontFileFamilies(path))[0] : undefined;
  const family = (own ?? stem.split("-")[0]!.replace(/_+/g, " ")).trim();
  if (!/^[A-Za-z0-9 _.-]{1,80}$/.test(family)) return refuse(`"${family.slice(0, 100)}" isn't a family name fonts are used by (letters, digits, spaces, _ . -; up to 80). Name the download after the family, e.g. "Geist".`);
  const dir = projectFontsDir(projectDir);
  await mkdir(dir, { recursive: true });
  let target = join(dir, `${stem}${ext}`);
  for (let n = 2; await stat(target).then(() => true, () => false); n++) target = join(dir, `${stem}-${n}${ext}`);
  await rename(path, target);
  return { path: target, family };
}

export const makeAskTools = (ctx: TranscriptCtx) => {
  const { textResult, publish, testRun, approvalMs, st, mediaImport, config } = ctx;

  let uiCount = 0;
  const uiShow = (r: Running, v: ProjectView, args: Record<string, unknown>): McpResult => {
    const project = v.session.project;
    const said: Array<string> = [];
    let frame: number | undefined;
    if (args.frame !== undefined) {
      if (!Number.isInteger(args.frame) || (args.frame as number) < 0) return textResult("frame must be a whole frame number from 0.", true);
      const { duration } = layout(project);
      const end = project.tracks.some((t) => t.items.length) ? duration : 0;
      frame = Math.min(args.frame as number, end);
      said.push(frame === args.frame ? `frame ${frame}` : `frame ${end}, where the project ends`);
    }
    let select: string | undefined;
    if (args.select !== undefined) {
      const ids = Array.isArray(args.select) ? args.select : typeof args.select === "string" ? [args.select] : [];
      if (ids.length !== 1 || typeof ids[0] !== "string") return textResult("select takes one item id, e.g. [\"clip-1\"] (the editor selects one item at a time).", true);
      const id = ids[0];
      if (!project.tracks.some((t) => t.items.some((i) => i.id === id))) return textResult(`There's no timeline item "${id}". project_read lists the items.`, true);
      select = id;
      said.push(id);
    }
    let panel: AgentUiPanel | undefined;
    if (args.panel !== undefined) {
      if (!(AGENT_UI_PANELS as ReadonlyArray<unknown>).includes(args.panel)) return textResult(`panel must be one of ${AGENT_UI_PANELS.join(", ")}.`, true);
      panel = args.panel as AgentUiPanel;
    }
    if (!said.length && !panel) return textResult("Pass frame, select or panel.", true);
    r.owner.ui = { id: `${r.turn.id}-${++uiCount}`, revision: v.session.revision, ...(frame !== undefined ? { frame } : {}), ...(select ? { select } : {}), ...(panel ? { panel } : {}) };
    publish();
    // D235 (issue #64): the editor never moves the user's playhead or selection for the agent.
    const shown = [...(said.length ? [`a pill over the preview points the user at ${said.join(" and ")} (a click jumps there; their playhead and selection stay put)`] : []), ...(panel ? [`the ${panel} panel is open`] : [])];
    return textResult(`Shown: ${shown.join(", ")}.`);
  };

  /** Waits for the user's Allow / Don't on a card in the Agent tab; no answer in time or a stopped turn is no. */
  const askUser = (r: Running, text: string, estimate: number, screen?: AgentApproval["screen"], onAnswer?: (card: AgentApproval, a: "allow" | "deny" | "timeout" | "stopped", source?: string, extra?: CardAnswer) => void, edit?: AgentApproval["edit"], more?: { readonly question?: AgentQuestion; readonly storyboard?: Storyboard; readonly permission?: AgentApproval["permission"]; readonly brand?: AgentApproval["brand"]; readonly boot?: AgentApproval["boot"] }) =>
    Effect.promise(
      () =>
        new Promise<"allow" | "deny" | "timeout" | "stopped">((resolve) => {
          // A question or a storyboard may take thinking over (QUESTION_MS); UNCUT_APPROVAL_MS shortens both in tests.
          const long = !!(more?.question || more?.storyboard);
          const ms = long && testRun && Number(process.env.UNCUT_APPROVAL_MS) > 0 ? approvalMs() : long ? QUESTION_MS : approvalMs();
          const card: AgentApproval = { id: randomUUID(), turnId: r.turn.id, text, estimate, until: new Date(Date.now() + ms).toISOString(), ...(screen ? { screen } : {}), ...(edit ? { edit } : {}), ...(more?.question ? { question: more.question } : {}), ...(more?.storyboard ? { storyboard: more.storyboard } : {}), ...(more?.permission ? { permission: more.permission } : {}), ...(more?.brand ? { brand: more.brand } : {}), ...(more?.boot ? { boot: more.boot } : {}) };
          let settled = false;
          const answer = (a: "allow" | "deny" | "timeout" | "stopped", source?: string, extra?: CardAnswer) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            r.abort.signal.removeEventListener("abort", onStop);
            if (st.approval?.card.id === card.id) st.approval = undefined;
            // Registered before the card goes away, so a take that comes back at once is heard.
            onAnswer?.(card, a, source, extra);
            publish();
            resolve(a);
          };
          const timer = setTimeout(() => answer("timeout"), ms);
          const onStop = () => answer("stopped");
          if (r.abort.signal.aborted) return answer("stopped");
          r.abort.signal.addEventListener("abort", onStop, { once: true });
          st.approval?.answer("deny");
          st.approval = { card, answer };
          publish();
        }),
    );

  /**
   * D194: media_download, a picture, video or sound from the web into media/downloads/, then
   * imported like media_import (an edit of this turn). The fetch is the library's guarded GET.
   */
  const mediaDownload = (r: Running, v: ProjectView, args: Record<string, unknown>) =>
    Effect.gen(function* () {
      const url = typeof args.url === "string" ? args.url.trim() : "";
      if (!url) return textResult("Pass url: the file's https address.", true);
      const name = typeof args.name === "string" && args.name.trim() ? args.name.trim().slice(0, 80) : undefined;
      if (r.downloads.count >= DOWNLOADS_PER_TURN) return textResult(`Not downloaded: ${DOWNLOADS_PER_TURN} downloads is the most for one turn.`, true);
      const left = DOWNLOAD_BYTES_PER_TURN - r.downloads.bytes;
      if (left <= 0) return textResult("Not downloaded: this turn already downloaded 1 GB.", true);
      r.downloads.count++;
      // A font file (WOFF2, WOFF, TTF, OTF) goes to the project's fonts folder, where every drawer
      // finds it by family (export/fonts.ts projectFontSources), not into Media.
      const got = yield* Effect.promise(() => downloadToFolder(url, join(v.dir, "media", "downloads"), name, r.abort.signal, left, { ...DOWNLOAD_TYPES, ...FONT_DOWNLOAD_TYPES }));
      if (!("problem" in got)) r.downloads.bytes += got.bytes;
      if ("problem" in got) return textResult(`Not downloaded: ${got.problem}`, true);
      if (FONT_FORMATS[extname(got.path).toLowerCase()]) {
        const placed = yield* Effect.promise(() => intoFonts(got.path, v.dir, name));
        if ("problem" in placed) return textResult(`Not downloaded: ${placed.problem}`, true);
        return textResult({
          font: { family: placed.family, file: shownPath(placed.path, v.dir), url: got.url, bytes: got.bytes },
          note: `Saved in the project's fonts folder: "${placed.family}" now works by name in graphics (CSS font-family, ctx.font) and text styles, in the preview and the export, and project_check counts it as there. Use only a font whose licence allows it (an OFL font such as Geist, Archivo or Inter is fine; say which in your reply). The family is the file's name before its first dash (name the download after the family, e.g. "Geist", or "Geist-Bold" for one weight).`,
        });
      }
      const out = yield* mediaImport(r, v, { path: got.path, ...(name ? { name } : {}) });
      const source = { url: got.url, bytes: got.bytes, type: got.type, file: shownPath(got.path, v.dir) };
      const first = out.content[0];
      if (out.isError || first?.type !== "text") return { ...out, content: [...out.content, { type: "text" as const, text: JSON.stringify({ downloaded: source }) }] };
      try {
        return { ...out, content: [{ type: "text" as const, text: JSON.stringify({ ...JSON.parse(first.text), source }) }, ...out.content.slice(1)] };
      } catch {
        return { ...out, content: [...out.content, { type: "text" as const, text: JSON.stringify({ source }) }] };
      }
    });

  /**
   * D194: claude asks whether a built-in tool may run (a can_use_tool control request; claude
   * waits for the control_response). Decided by the turn's access (agentPermissions.ts decide):
   * allow, deny with why, or a card in the Agent tab (Allow once, Always for this session, Deny),
   * one card at a time. Always answered, except when claude cancels the request.
   */
  const canUseTool = (s: ClaudeSession, msg: Record<string, any>) => {
    const requestId = String(msg.request_id ?? "");
    const req = (msg.request ?? {}) as Record<string, any>;
    const tool = isString(req.tool_name) ? req.tool_name : "";
    const input = (req.input && typeof req.input === "object" ? req.input : {}) as Record<string, unknown>;
    const toolUseId = isString(req.tool_use_id) ? req.tool_use_id : undefined;
    let answered = false;
    const reply = (response: Record<string, unknown>) => {
      if (answered) return;
      answered = true;
      s.prompts.delete(requestId);
      if (s.closed || !s.child?.stdin) return;
      try {
        s.child.stdin.write(`${JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: requestId, response: { ...response, ...(toolUseId ? { toolUseID: toolUseId } : {}) } } })}\n`);
      } catch {}
    };
    const allow = () => reply({ behavior: "allow", updatedInput: input });
    const deny = (message: string) => reply({ behavior: "deny", message });
    const r = s.turn;
    if (!r || r.turn.status !== "running" || r.cancelled) return deny("Not done: no turn is running in Uncut.");
    // D194: approvals can't be trusted without the handshake: fail closed.
    if (s.initFailed) return deny("Not done: Uncut couldn't set up approvals with Claude Code (it didn't answer initialize), so nothing that needs the user's OK runs in this session. Say what you would do.");
    const project = realPath(r.owner.dir, r.owner.dir);
    // D296: the active kit's folder (the user's, or the project's own) and the bundled graphic
    // libraries are read without a card: Uncut points the agent at them.
    let sanctioned: ReadonlyArray<string> = [];
    const ctx = () => ({ access: r.access, project, roots: r.owner.dirs, sanctioned, candidates: r.owner.mentioned, grants: r.owner.grants, webUsed: r.owner.webUsed, tainted: r.owner.tainted });
    // claude may give up on it while the kit is looked up: then it's not answered at all.
    s.prompts.set(requestId, () => {
      answered = true;
      s.prompts.delete(requestId);
    });
    void readActive(r.owner.dir)
      .then((active) => (sanctioned = sanctionedDirs(config, r.owner.dir, active.kit)), () => {})
      .then(() => decideFirst())
      .catch((error) => {
        // Always answered: a decision that failed is a no.
        console.error(`[uncut] permission check for ${tool} failed: ${(error as Error).message}`);
        deny("Not done: Uncut couldn't check whether this may run.");
      });
    const decideFirst = () => {
      if (answered) return;
      const first = decide(tool, input, ctx());
      if (first.kind === "allow") return allow();
      if (first.kind === "deny") return deny(first.message);
      // Its card is the one open (cards are shown one at a time).
      let showing = false;
      const close = () => {
        if (showing && st.approval?.card.permission && st.approval.card.turnId === r.turn.id) st.approval.answer("stopped");
      };
      // claude gave up on it (an interrupt): no answer, and its card goes.
      s.prompts.set(requestId, () => {
        answered = true;
        s.prompts.delete(requestId);
        close();
      });
      const ask = async () => {
        if (answered) return;
        // Another card may be open (a question, a spend): this one waits for it.
        while (st.approval && !r.abort.signal.aborted && !answered) await new Promise((done) => setTimeout(done, 150));
        if (answered) return;
        if (r.abort.signal.aborted) return deny("Not done: the turn was stopped.");
        // An "Always" given on the card before may cover it now.
        const d = decide(tool, input, ctx());
        if (d.kind === "allow") return allow();
        if (d.kind === "deny") return deny(d.message);
        let always = false;
        showing = true;
        const answer = await Effect.runPromise(
          askUser(r, d.title, 0, undefined, (_card, _a, _source, extra) => {
            always = extra?.always === true && !!d.grant;
          }, undefined, { permission: { tool, target: d.target, ...(d.why ? { why: d.why } : {}), always: !!d.grant } }),
        ).finally(() => (showing = false));
        if (answered) return;
        if (answer === "allow") {
          // A confirmed folder becomes a root of this chat (and --add-dir from the next message); other grants are remembered as they are.
          if (always && d.grant?.startsWith("Root:")) {
            const dir = d.grant.slice(5);
            if (!r.owner.dirs.includes(dir) && r.owner.dirs.length < 16) r.owner.dirs.push(dir);
          } else if (always && d.grant) r.owner.grants.add(d.grant);
          return allow();
        }
        if (answer === "stopped") return deny("Not done: the turn was stopped.");
        return deny(`Not done: the user ${answer === "timeout" ? "didn't answer" : "said no"} to "${d.title}: ${d.target.slice(0, 200)}". Don't try it again in this turn; say what you wanted to do and why.`);
      };
      r.permissionQueue = r.permissionQueue.then(ask, ask).catch((error) => {
        console.error(`[uncut] permission prompt for ${tool} failed: ${(error as Error).message}`);
        deny("Not done: Uncut couldn't ask the user.");
      });
    };
  };

  return { askUser, mediaDownload, uiShow, canUseTool };
};

export type AskCtx = TranscriptCtx & ReturnType<typeof makeAskTools>;
