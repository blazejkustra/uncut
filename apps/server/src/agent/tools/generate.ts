// The agent's tools that make media: generate_media, screen_record, argent_boot, media_search, and the turn-end clean-up.
import type { ProjectSnapshot } from "@uncut/contracts";
import { type Project, describeOp, type Op } from "@uncut/core";
import * as Effect from "effect/Effect";
import { emptyAddedTracks, KEEP_REVISIONS, trashGraphics, unusedGraphics } from "../agentCleanup.ts";
import { withHistory } from "../../project/history.ts";
import { MAX_FOUND } from "../../media/mediaIndex.ts";
import { CONFIRM_OVER, needsKeyLine, TURN_CAP } from "../../generate/generate.ts";
import { providerName } from "../../generate/keys.ts";
import type { ProjectView } from "../../project/projects.ts";
import { type Running, pushEdit } from "../session/types.ts";
import type { AskCtx } from "./ask.ts";

export const makeGenerateTools = (ctx: AskCtx) => {
  const { generator, textResult, keys, askUser, persist, publish, entryInfo, screenWaits, capture, mediaIndex, view, projects } = ctx;

  /**
   * generate_media (D99): a generator's result imported as media, an edit of this turn (Undo
   * turn removes it), its source {module, prompt, model}. Keyed generators bill the user's own
   * key: anything estimated over CONFIRM_OVER waits for the user's Allow on a card in the Agent
   * tab (the agent can't approve it itself); a turn spends at most TURN_CAP. The estimate is
   * reserved on the turn before the request (kept once a request went out, whatever happens
   * next; refunded only when nothing was sent) and shown on the turn card (D9).
   */
  const generateMedia = (r: Running, v: ProjectView, args: Record<string, unknown>) =>
    Effect.gen(function* () {
      const planned = yield* generator.plan(args);
      if ("_tag" in planned) return textResult(planned.message, true);
      const { spec, estimate, provider } = planned;
      if (provider && !(yield* keys.has(provider)))
        return textResult(
          {
            needsKey: provider,
            message: `${needsKeyLine(provider)}. Nothing was generated.`,
            next: `Tell the user it ${needsKeyLine(provider).toLowerCase()}: they add it in Settings › Keys (Uncut never asks for it in chat; don't ask them to paste it here). For a picture or a simple animation you can draw it yourself with generate.svg.`,
          },
          true,
        );
      const dollars = (n: number) => `$${n.toFixed(2)}`;
      const overCap = () => estimate > 0 && (r.turn.spend ?? 0) + estimate > TURN_CAP;
      const capNote = () =>
        `That would take this turn past ${dollars(TURN_CAP)} of estimated spend (${dollars(r.turn.spend ?? 0)} so far). Nothing was generated; the user can generate more from the Generate tab.`;
      if (overCap()) return textResult(capNote(), true);
      if (estimate > CONFIRM_OVER) {
        const what =
          spec.kind === "video"
            ? `a ${spec.seconds ?? 4} s ${spec.generator === "generate.veo" ? "Veo " : ""}video`
            : spec.kind === "audio"
              ? "a sound"
              : "a picture";
        const answer = yield* askUser(r, `Generate ${what}, about ${dollars(estimate)} on your ${providerName(provider!)} key`, estimate);
        if (answer !== "allow")
          return textResult(
            {
              approved: false,
              message:
                answer === "deny"
                  ? `The user didn't allow it (about ${dollars(estimate)} on their ${providerName(provider!)} key). Nothing was generated.`
                  : answer === "timeout"
                    ? "Nobody answered the approval in the Agent tab within 2 minutes, so nothing was generated."
                    : "The turn was stopped, so nothing was generated.",
              next: "Don't try again in this turn unless the user asks; suggest something cheaper or generate.svg if it fits.",
            },
            true,
          );
      }
      // Check and reserve with nothing in between (no await): two calls can't both pass the cap.
      if (overCap()) return textResult(capNote(), true);
      const before = r.turn.spend ?? 0;
      if (estimate > 0) r.turn.spend = Number((before + estimate).toFixed(3));
      let sent = false;
      const outcome = yield* Effect.uninterruptible(
        generator.produce(spec, { openId: r.openId, dir: v.dir, turnId: r.turn.id, signal: r.abort.signal, sent: () => (sent = true) }).pipe(
          Effect.map((p) => ({ ok: true as const, p })),
          Effect.catch((e) => Effect.succeed({ ok: false as const, message: e.message })),
        ),
      );
      if (!outcome.ok) {
        // Nothing went to the provider: nothing billed. Once a request went out it may have been.
        if (!sent && estimate > 0) r.turn.spend = Number(Math.max(0, (r.turn.spend ?? 0) - estimate).toFixed(3)) || undefined;
        persist(r.owner);
        publish();
        return textResult(`Nothing was generated: ${outcome.message}`, true);
      }
      const { entry, result, cost, model } = outcome.p;
      // The reply's own price replaces the reservation.
      if (estimate > 0 || cost > 0) r.turn.spend = Number(Math.max(0, (r.turn.spend ?? 0) - estimate + cost).toFixed(3)) || undefined;
      const snapshot = result.snapshot;
      if (snapshot) {
        pushEdit(r, {
          revision: snapshot.revision,
          summary: `Generated ${entry.name}`,
          lines: [describeOp({ op: "add_media", media: entry } as Op, snapshot.project as Project)],
          media: [entry.id],
        });
        r.owner.seen.add(snapshot.revision);
      }
      persist(r.owner);
      publish();
      const fps = ((snapshot?.project ?? v.session.project) as Project).canvas.fps;
      return textResult({
        ...entryInfo(entry, fps),
        ...(snapshot ? { revision: snapshot.revision } : {}),
        model,
        ...(cost > 0 ? { estimatedCost: Number(cost.toFixed(3)), turnSpend: r.turn.spend } : { estimatedCost: 0 }),
        note: `In Media › Generated with its prompt (an edit of this turn: Undo turn removes it). Place it with timeline_edit${entry.kind === "audio" ? " on an audio track" : " (a clip on the main track, or with a start on a video track above it)"}.`,
      });
    });

  /**
   * screen_record (D144): the user is asked on a card (they pick the screen or window, the agent's
   * suggestion preselected); on Record the renderer records for `seconds` (no 3-2-1, D273), uploads the
   * take and answers with agent.screenTake; it's imported as an edit of this turn. Never silent.
   */
  const screenRecord = (r: Running, v: ProjectView, args: Record<string, unknown>) =>
    Effect.gen(function* () {
      const seconds = typeof args.seconds === "number" && Number.isFinite(args.seconds) ? args.seconds : NaN;
      if (!(seconds > 0 && seconds <= 300)) return textResult("seconds must be more than 0 and at most 300.", true);
      const source = typeof args.source === "string" && args.source.trim() ? args.source.trim().slice(0, 200) : undefined;
      const withMic = args.withMic === true;
      const secs = Math.round(seconds * 10) / 10;
      let waiting: Promise<{ path?: string | undefined; source?: string | undefined; problem?: string | undefined }> | undefined;
      const answer = yield* askUser(
        r,
        `Record ${source ? `"${source}"` : "your screen"} for ${secs} s${withMic ? " with the microphone" : ""}`,
        0,
        { ...(source ? { source } : {}), seconds: secs, withMic },
        (card, a) => {
          if (a !== "allow") return;
          waiting = new Promise((resolve) => {
            const timer = setTimeout(() => done({ problem: "The recording didn't come back in time." }), (secs + 3) * 1000 + 120_000);
            const onStop = () => done({ problem: "The turn was stopped." });
            const done = (x: { path?: string | undefined; source?: string | undefined; problem?: string | undefined }) => {
              clearTimeout(timer);
              r.abort.signal.removeEventListener("abort", onStop);
              screenWaits.delete(card.id);
              // The renderer sees the wait end and cancels a take still running (D144).
              publish();
              resolve(x);
            };
            r.abort.signal.addEventListener("abort", onStop, { once: true });
            screenWaits.set(card.id, { turnId: r.turn.id, done });
          });
        },
      );
      if (answer !== "allow" || !waiting)
        return textResult(
          {
            approved: false,
            message:
              answer === "deny"
                ? "The user didn't want the screen recorded. Nothing was recorded."
                : answer === "timeout"
                  ? "Nobody answered the card in the Agent tab within 2 minutes, so nothing was recorded."
                  : "The turn was stopped, so nothing was recorded.",
            next: "Don't ask again in this turn unless the user asks.",
          },
          true,
        );
      const take = yield* Effect.promise(() => waiting!);
      if (take.problem || !take.path) return textResult(`Nothing was recorded: ${take.problem ?? "no file came back"}`, true);
      const name = take.source?.trim().slice(0, 120) || undefined;
      const saved = yield* capture
        .saveForTurn({ path: take.path, kind: "screen", turnId: r.turn.id, dir: v.dir, ...(name ? { name, device: name } : {}) })
        .pipe(
          Effect.map((x) => ({ ok: true as const, x })),
          Effect.catch((e) => Effect.succeed({ ok: false as const, message: e.message })),
        );
      if (!saved.ok) return textResult(`The recording wasn't added: ${saved.message}`, true);
      const { snapshot } = saved.x;
      const entry = (snapshot?.project as Project | undefined)?.media.find((m) => m.id === saved.x.mediaId);
      if (snapshot && entry) {
        pushEdit(r, {
          revision: snapshot.revision,
          summary: `Recorded ${saved.x.name}`,
          lines: [describeOp({ op: "add_media", media: entry } as Op, snapshot.project as Project)],
          media: [entry.id],
        });
        r.owner.seen.add(snapshot.revision);
      }
      persist(r.owner);
      publish();
      return textResult({
        id: saved.x.mediaId,
        name: saved.x.name,
        path: saved.x.path,
        seconds: saved.x.seconds,
        ...(entry?.probe ? { frames: entry.probe.frames, width: entry.probe.width, height: entry.probe.height } : {}),
        ...(name ? { source: name } : {}),
        ...(snapshot ? { revision: snapshot.revision } : {}),
        note: "The recording is in Media (an edit of this turn: Undo turn removes it). Place it with timeline_edit.",
      });
    });

  /**
   * argent_boot (D204): boot a simulator or emulator for a recording, never without the user's
   * click. Without a device it lists the bootable ones by name. With one (its id or name) it asks
   * on a card (the device, its platform, what happens next); Boot boots it through the Capture
   * tab's boot (capture.boot, D143), Don't or no answer leaves it off. A device the user allowed
   * once in this chat boots again without a card (Auto and Ask first alike;
   * Look only never gets here: allowed() refuses it).
   */
  const argentBoot = (r: Running, args: Record<string, unknown>) =>
    Effect.gen(function* () {
      const state = yield* capture.state.pipe(
        Effect.map((x) => ({ ok: true as const, x })),
        Effect.catch((e) => Effect.succeed({ ok: false as const, message: e.message })),
      );
      if (!state.ok)
        return textResult(
          {
            booted: false,
            message: `Argent isn't available: ${state.message}`,
            next: "Ask the user to install Argent (Capture tab) or for a recording; don't draw a placeholder phone without asking.",
          },
          true,
        );
      if (!state.x.installed)
        return textResult(
          {
            booted: false,
            message: `Argent isn't installed (${state.x.install}).`,
            next: "Tell the user Argent is needed to record a simulator (the Capture tab installs it), or ask for a recording.",
          },
          true,
        );
      const kindOf = (d: { platform: string; id: string }) =>
        d.id.startsWith("avd:") || /android/i.test(d.platform) ? "Android emulator" : /ios/i.test(d.platform) ? "iOS simulator" : `${d.platform} device`;
      const bootable = state.x.devices.filter((d) => d.bootable);
      const live = state.x.devices.filter((d) => d.recordable);
      const list = () => ({
        bootable: bootable.map((d) => ({ device: d.id, name: d.name, kind: kindOf(d) })),
        running: live.map((d) => ({ device: d.id, name: d.name, kind: kindOf(d) })),
      });
      const want = typeof args.device === "string" ? args.device.trim() : "";
      if (!want)
        return textResult({
          ...list(),
          next: bootable.length
            ? "Pick one and call argent_boot with its device: the user is asked on a card before anything boots. A running one can be recorded now with argent_record."
            : live.length
              ? "Nothing to boot; record a running one with argent_record."
              : "No simulator or emulator can be booted here: ask the user.",
        });
      const found = live.find((d) => d.id === want || d.name.toLowerCase() === want.toLowerCase());
      if (found)
        return textResult({
          booted: true,
          device: found.id,
          name: found.name,
          already: true,
          next: `It's running already: argent_record {device: "${found.id}", bundleId, flow or seconds}.`,
        });
      const lower = want.toLowerCase();
      const device =
        bootable.find((d) => d.id === want) ??
        bootable.find((d) => d.name.toLowerCase() === lower) ??
        (bootable.filter((d) => d.name.toLowerCase().includes(lower)).length === 1 ? bootable.find((d) => d.name.toLowerCase().includes(lower)) : undefined);
      if (!device) return textResult({ booted: false, message: `No bootable device matches "${want.slice(0, 80)}".`, ...list() }, true);
      const bundleId = typeof args.bundleId === "string" && /^[A-Za-z0-9_][A-Za-z0-9._-]{0,200}$/.test(args.bundleId) ? args.bundleId : undefined;
      const kind = kindOf(device);
      const grant = `Boot:${device.id}`;
      if (!r.owner.grants.has(grant)) {
        const answer = yield* askUser(r, `Boot ${device.name}`, 0, undefined, undefined, undefined, {
          boot: { device: device.id, name: device.name, platform: device.platform, kind, ...(bundleId ? { bundleId } : {}) },
        });
        if (answer !== "allow")
          return textResult(
            {
              booted: false,
              approved: false,
              message:
                answer === "deny"
                  ? `The user didn't want ${device.name} booted.`
                  : answer === "timeout"
                    ? "Nobody answered the card in the Agent tab within 2 minutes, so nothing was booted."
                    : "The turn was stopped, so nothing was booted.",
              next: "Don't ask again in this turn. Ask the user for a recording or footage instead of drawing a placeholder.",
            },
            true,
          );
        // Once per device per chat (until the project closes).
        r.owner.grants.add(grant);
      }
      const booted = yield* capture.boot(device.id).pipe(
        Effect.map((x) => ({ ok: true as const, x })),
        Effect.catch((e) => Effect.succeed({ ok: false as const, message: e.message })),
      );
      if (!booted.ok) return textResult({ booted: false, message: `${device.name} didn't boot: ${booted.message}` }, true);
      return textResult({
        booted: true,
        device: booted.x.device,
        name: booted.x.name || device.name,
        kind,
        next: `Record it: argent_record {device: "${booted.x.device}"${bundleId ? `, bundleId: "${bundleId}"` : ", bundleId (the app to open)"}, flow (a saved flow) or seconds}.`,
      });
    });

  /**
   * media_search (D205): the user's media index, captures, imports and generations from the other
   * projects on this Mac, newest first. media_import with a result's path brings it in (copied
   * when it lives inside another project, D12).
   */
  const mediaSearch = (args: Record<string, unknown>) =>
    Effect.gen(function* () {
      const kind = typeof args.kind === "string" ? args.kind.toLowerCase() : undefined;
      if (kind && !["video", "image", "audio", "capture", "import", "generated"].includes(kind))
        return textResult("kind is video, image, audio, capture, import or generated.", true);
      const query = typeof args.query === "string" ? args.query.slice(0, 200) : "";
      const found = yield* mediaIndex.search({ query, ...(kind ? { kind } : {}), limit: MAX_FOUND });
      const out = found.map((e) => ({
        path: e.path,
        name: e.name,
        kind: e.kind,
        origin: e.origin,
        ...(e.seconds !== undefined ? { seconds: e.seconds } : {}),
        ...(e.width && e.height ? { size: `${e.width}x${e.height}` } : {}),
        project: e.project.name,
        ...(e.device ? { device: e.device } : {}),
        ...(e.app ? { app: e.app } : {}),
        created: e.created,
        import: e.copies ? "copied into this project's media/imports" : "referenced where it is",
      }));
      return textResult({
        found: out,
        note: out.length
          ? "Bring one in with media_import {path}; then place it with timeline_edit."
          : `Nothing ${query ? `matching "${query}" ` : ""}in other projects. Offer to record it (argent_boot, argent_record, screen_record) or ask the user for footage before drawing a placeholder.`,
      });
    });

  /**
   * D206: at the end of a turn that went well, empty tracks the agent added in it are removed (an
   * edit of the turn, so Undo turn brings them back) and the agent's graphics that nothing uses
   * (not the project, not the last KEEP_REVISIONS revisions of history, not another graphic) go
   * to .cache/trash/<turn>/graphics (Undo turn or the turn's Restore puts them back).
   */
  const turnCleanup = (r: Running) =>
    Effect.gen(function* () {
      const v = view();
      if (!v || v.openId !== r.openId || r.cancelled) return;
      const empty = emptyAddedTracks(v.session.project as Project, r.addedTracks);
      let tracks: Array<string> = [];
      if (empty.length) {
        const summary = empty.length === 1 ? "Removed an empty track" : `Removed ${empty.length} empty tracks`;
        const done = yield* projects
          .agentEdit(r.openId, { turnId: r.turn.id, ops: empty.map((track) => ({ op: "delete_track", track })), baseRevision: v.session.revision, summary })
          .pipe(
            Effect.map((x): ProjectSnapshot | undefined => x),
            Effect.catch(() => Effect.succeed(undefined)),
          );
        if (done) {
          pushEdit(r, { revision: done.revision, summary, lines: empty.map((id) => `Removed the empty track ${id}`) });
          r.owner.seen.add(done.revision);
          tracks = empty;
        }
      }
      // The agent's own graphics, less any the user put back from an earlier clean-up (they stay).
      const restored = new Set(r.owner.turns.flatMap((t) => (t.cleanup?.restored ? t.cleanup.graphics : [])));
      const candidates = new Set([...r.owner.turns.flatMap((t) => t.graphics ?? []), ...(r.turn.graphics ?? [])].filter((n) => !restored.has(n)));
      let graphics: Array<string> = [];
      const now = view();
      if (candidates.size && now && now.openId === r.openId) {
        const states: Array<unknown> = [now.session.project];
        try {
          withHistory(now.dir, (db) => {
            for (const row of db.listed(KEEP_REVISIONS).rows) {
              try {
                states.push(db.stateAt(row.revision));
              } catch {}
            }
          });
        } catch {}
        graphics = yield* Effect.promise(async () => trashGraphics(now.dir, r.turn.id, await unusedGraphics(now.dir, candidates, states)).catch(() => []));
      }
      if (tracks.length || graphics.length) {
        r.turn.cleanup = { graphics, tracks };
        persist(r.owner);
        publish();
      }
    });

  return { generateMedia, screenRecord, argentBoot, mediaSearch, turnCleanup };
};

export type GenerateCtx = AskCtx & ReturnType<typeof makeGenerateTools>;
