// send: a message from the composer becomes a turn in the open project's claude session.
import { randomBytes } from "node:crypto";
import { statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AGENT_IMAGE_MAX, AGENT_IMAGES_MAX, AgentError, type AgentFolder } from "@uncut/contracts";
import type { Project } from "@uncut/core";
import { contextBlock, mentionLabel } from "@uncut/core/mentions";
import * as Effect from "effect/Effect";
import { listFolder, listingWords } from "../agentFootage.ts";
import { calledSkills, gateOf, planContext, skillBlocks, skillCallsAsWords } from "../agentPlan.ts";
import { readBrand, readPlan, useSkills } from "../../brand/store.ts";
import { namedFolders, shownPath } from "../agentPermissions.ts";
import { accessLine, TOOLS_LINE, playheadLine } from "../agentTools.ts";
import { turnLimits } from "../agentLimits.ts";
import type { Running, StoredTurn } from "./types.ts";
import { joinNotes, noteFor } from "../turns/notes.ts";
import { findClaude, modelFor, IMAGE_EXT } from "./config.ts";
import type { AgentShape } from "../agent.ts";
import type { SpawnCtx } from "./spawn.ts";

export const makeSend = (ctx: SpawnCtx) => {
  const { plugins, ensureLoaded, st, config, view, closeSession, spawnSession, persist, publishNow, writeTurn } = ctx;

  /** The plugins' tool names now (D97): a session started with other ones is started again. */
  // D232: and the installed skills' names (the system prompt lists them), so installing one starts a new session.
  const toolsKeyNow = Effect.andThen(plugins.refresh, Effect.map(plugins.tools, (extra) => `${extra.map((t) => t.name).sort().join(",")}|skills:${plugins.skillsNow().map((x) => x.name).sort().join(",")}`));

  const send: AgentShape["send"] = ({ prompt, frame, selected, mentions, model: askedModel, effort, access = "auto", images = [], skipStoryboard = false }) =>
    Effect.gen(function* () {
      const owner = yield* ensureLoaded;
      if (!owner) return yield* new AgentError({ reason: "no-project", message: "Open a project first." });
      if (st.running) return yield* new AgentError({ reason: "busy", message: "The agent is still working on the last message." });
      if (owner.readError) {
        return yield* new AgentError({
          reason: "failed",
          message: `Can't read this project's agent history (agent/turns.json): ${owner.readError}. Fix the file's permissions, then open the project again.`,
        });
      }
      const text = prompt.trim();
      if (!text) return yield* new AgentError({ reason: "failed", message: "Write what you'd like the agent to do." });
      if (images.length > AGENT_IMAGES_MAX) return yield* new AgentError({ reason: "failed", message: `Attach at most ${AGENT_IMAGES_MAX} images to a message.` });
      const decoded = images.map((img) => ({ ...img, bytes: Buffer.from(img.data, "base64") }));
      const tooBig = decoded.find((img) => img.bytes.length > AGENT_IMAGE_MAX || img.bytes.length === 0);
      if (tooBig) return yield* new AgentError({ reason: "failed", message: `${tooBig.name.slice(0, 80)} is ${tooBig.bytes.length ? "over 5 MB" : "empty"}; attach a smaller image.` });
      // Wait for the login shell's PATH, or a Finder launch would miss ~/.local/bin.
      yield* Effect.promise(() => config.shellReady);
      const bin = yield* Effect.promise(() => findClaude());
      if (!bin) {
        return yield* new AgentError({ reason: "not-installed", message: "Claude Code isn't installed. Install it, sign in once with `claude`, then try again." });
      }
      const toolsKey = yield* toolsKeyNow;
      if (st.running) return yield* new AgentError({ reason: "busy", message: "The agent is still working on the last message." });
      const v = view();
      if (!v || v.openId !== owner.openId) return yield* new AgentError({ reason: "no-project", message: "The project was closed." });

      const note = joinNotes(owner.carried, noteFor(v, owner.agentSeen));
      const project = v.session.project as Project;
      // What the prompt's @labels point at (D140), only those still in the prompt.
      const pointed = (mentions ?? [])
        .filter((m) => text.includes(`@${m.label}`))
        .slice(0, 50)
        .map((m) => ({ ...m, label: mentionLabel(m.label), id: m.id.slice(0, 200) }));
      const context = [frame !== undefined ? playheadLine(project, frame) : "", selected ? `Selected item: ${selected}.` : "", accessLine(access), TOOLS_LINE, note].filter(Boolean);
      // D194: folders the message names (a pasted path) are offered on a card the first time a tool needs them.
      // D198: and each one is listed in the message (names only), so the agent can't miss one.
      const named = namedFolders(text, v.dir, (p) => {
        try {
          const st = statSync(p);
          return st.isDirectory() ? "dir" : st.isFile() ? "file" : undefined;
        } catch {
          return undefined;
        }
      });
      for (const f of named) {
        if (!f.problem && !owner.dirs.includes(f.dir) && !owner.mentioned.includes(f.dir) && owner.mentioned.length < 16) owner.mentioned.push(f.dir);
      }
      const folderList: Array<AgentFolder> = [];
      const folderLines: Array<string> = [];
      for (const f of named) {
        const shown = shownPath(f.dir);
        if (f.problem) {
          folderList.push({ path: shown, files: 0, folders: 0, problem: f.problem });
          folderLines.push(`${shown}: not listed, ${f.problem}. Ask the user for the folder inside it they mean, or use the files they named by their full paths.`);
          continue;
        }
        const listing = yield* Effect.promise(() => listFolder(f.dir));
        if (!listing) {
          folderList.push({ path: shown, files: 0, folders: 0, problem: "Uncut can't read it" });
          folderLines.push(`${shown}: Uncut can't read it (macOS may need Files and Folders access for Uncut).`);
          continue;
        }
        folderList.push({ path: shown, files: listing.files, folders: listing.folders });
        const more = listing.files + listing.folders - listing.names.length;
        folderLines.push(`${shown} (${f.dir}): ${listingWords(listing)}${listing.names.length ? `: ${listing.names.join(", ")}${more > 0 ? ` and ${more} more` : ""}` : ", empty"}.`);
      }
      const foldersBlock = folderLines.length ? `<folders>\nThe folders the user named in this message, each listed by Uncut (top level, hidden files left out). Use every one of them; media_import takes these paths.\n${folderLines.join("\n")}\n</folders>` : "";
      const dirsKey = [...owner.dirs].sort().join("\n");
      // D186/D188: the kit, skills and plan as they are now (the user may have changed them in the Brand panel or by hand).
      const skip = access === "auto" && skipStoryboard;
      // D232 (issue #60): a /name in the message calls that skill: its instructions come with the
      // message and the project uses it from now on (the critic follows it).
      const { planBlock, skillsBlock, called } = yield* Effect.promise(async () => {
        try {
          owner.plan = await readPlan(v.dir);
          const dirs = { dataDir: config.dataDir, projectDir: v.dir, skills: plugins.skillsNow() };
          let all = await readBrand(dirs);
          const called = calledSkills(text, all.skills.map((x) => x.id));
          if (called.length) {
            await useSkills(v.dir, called);
            all = await readBrand(dirs);
          }
          const kit = all.kits.find((k) => k.id === all.active.kit);
          return {
            planBlock: planContext({ kit, files: kit ? (all.files[kit.id] ?? {}) : {}, skills: all.skills.filter((x) => all.active.skills.includes(x.id)), others: all.kits.map((k) => ({ id: k.id, name: k.name })) }, owner.plan, gateOf(owner.plan, skip)),
            skillsBlock: skillBlocks(called.flatMap((id) => all.skills.filter((x) => x.id === id))),
            called,
          };
        } catch (error) {
          console.error(`[uncut] couldn't read the brand kit or plan of ${v.dir}: ${(error as Error).message}`);
          return { planBlock: "", skillsBlock: "", called: [] as Array<string> };
        }
      });
      let message = [skillCallsAsWords(text, called), skillsBlock, contextBlock(project, pointed), foldersBlock, planBlock, context.length ? `<editor-context>\n${context.join("\n")}\n</editor-context>` : ""].filter(Boolean).join("\n\n");

      // The session to use: the live one when it's still this opening's with the same tools, model
      // and effort (D184: another choice starts another claude that resumes the conversation).
      const model = modelFor(askedModel);
      let s = st.session;
      if (s && (s.closed || s.owner !== owner || s.openId !== owner.openId || s.toolsKey !== toolsKey || s.model !== model || s.effort !== effort || s.dirsKey !== dirsKey || s.access !== access || !s.child || s.child.exitCode !== null)) {
        closeSession(s, "graceful");
        s = undefined;
      }
      if (!s) {
        const started = spawnSession(owner, bin, toolsKey, true, { model, effort, access });
        if (typeof started === "string") return yield* new AgentError({ reason: "failed", message: started });
        s = st.session = started;
      }

      const turnId = `turn-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
      // D184: attached images are kept in .cache/agent-images/ for the card (the cache can be
      // wiped: the card then shows no thumbnail; claude already has them in its conversation).
      const imageNames: Array<string> = [];
      if (decoded.length) {
        const folder = join(v.dir, ".cache", "agent-images");
        yield* Effect.promise(async () => {
          try {
            await mkdir(folder, { recursive: true });
            for (const [i, img] of decoded.entries()) {
              const name = `${turnId}-${i}.${IMAGE_EXT[img.mimeType]}`;
              await writeFile(join(folder, name), img.bytes);
              imageNames.push(name);
            }
          } catch (error) {
            console.error(`[uncut] couldn't keep the attached images in ${folder}: ${(error as Error).message}`);
          }
        });
        // D232: their paths too, so a skill can bring a dropped logo into a kit (brand_write logos) or the project.
        if (imageNames.length) message += `\n\n<attachments>\nThe attached images are also saved as files (brand_write logos and media_import take these paths):\n${imageNames.map((n, i) => `${decoded[i]?.name.slice(0, 80) ?? n}: ${join(folder, n)}`).join("\n")}\n</attachments>`;
      }
      const turn: StoredTurn = {
        id: turnId,
        prompt: text,
        ...(pointed.length ? { mentions: pointed.map((m) => ({ kind: m.kind, label: m.label })) } : {}),
        ...(imageNames.length ? { images: imageNames } : {}),
        ...(model ? { model } : {}),
        ...(note ? { note } : {}),
        ...(folderList.length ? { folders: folderList } : {}),
        startedAt: new Date().toISOString(),
        status: "running",
        items: [],
        edits: [],
      };
      owner.turns.push(turn);
      owner.bounds.set(turn.id, { start: v.session.revision });
      const r: Running = {
        turn,
        owner,
        openId: owner.openId,
        session: s,
        message,
        delivered: false,
        abort: new AbortController(),
        cancelled: false,
        interruptTimer: undefined,
        steps: new Map(),
        blocks: new Map(),
        messageId: "",
        streamed: new Map(),
        announced: [],
        gen: ++s.gens,
        noteRevision: v.session.revision,
        stopReason: undefined,
        access,
        images: decoded.map((img) => ({ mimeType: img.mimeType, data: img.data })),
        inputs: new Map(),
        skipStoryboard: skip,
        looked: { sheet: false, phone: false },
        limits: turnLimits(),
        reviewRounds: 0,
        rendered: [],
        graphicWrites: 0,
        addedTracks: new Set(),
        reviewedStamp: undefined,
        picked: [],
        permissionQueue: Promise.resolve(),
        toolNames: new Map(),
        downloads: { bytes: 0, count: 0 },
      };
      st.running = r;
      persist(owner);
      publishNow();
      writeTurn(s, r);
      return { turnId: turn.id };
    });

  return { send };
};
