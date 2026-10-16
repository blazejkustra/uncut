// Phase 6 exit check, the real-claude half (D93): "the next Argent promo is made in Uncut". The same
// files as test/app/phase6-exit.test.ts (the reference's recordings and sky by path, a dark copy of the
// Argent logo in the run folder), driven by the REAL agent instead of the scripted one.
// Not part of `pnpm test`: it uses your Claude subscription (claude CLI, signed in). ANTHROPIC_API_KEY
// is removed from this process and from the server's environment (D41).
//
// Run from the repo root:
//   node scripts/phase6-manual-check.ts          print the prompt to give claude in the Agent tab and what to check
//   node scripts/phase6-manual-check.ts --run    do it headlessly (after pnpm build): start the bundled server,
//                                                create a 1920×1080 30 fps project, send the prompt to the real
//                                                claude, wait for the turn, export (Standard, −16 LUFS) and print
//                                                a pass/check list against the reference video
//   ... --out <dir>                              where to put it all (default: a new temp folder)
//   ... --prompt "<text>"                        a different prompt
//   ... --fake                                   (testing this script) the scripted claude from the exit test
//                                                instead of the real one: no subscription used
// Needs: the reference promo's folder (UNCUT_ARGENT_REF; never written to), its white logo SVG
// (UNCUT_ARGENT_LOGO), its music (UNCUT_ARGENT_MUSIC), ffmpeg.
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import { projectChecks, type Project } from "../packages/core/src/index.ts";
import { buildTurn, END_URL, fixTurn, loudness, makeBrandFolder, MUSIC, probe, REF, REF_DIR, referenceMissing, sceneOf, signature, stampReference, TOTAL } from "../test/helpers/phase6-fixture.ts";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const option = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
delete process.env.ANTHROPIC_API_KEY;

const missing = referenceMissing();
if (missing) {
  console.error(`Can't run: ${missing}.`);
  process.exit(2);
}
const out = resolve(option("--out") ?? realpathSync(mkdtempSync(join(tmpdir(), "uncut-phase6-manual-"))));
/** The real path of p, through its nearest existing ancestor when p doesn't exist yet. */
const realish = (p: string): string => (existsSync(p) ? realpathSync(p) : join(realish(dirname(p)), basename(p)));
if (`${realish(out)}/`.startsWith(`${realpathSync(REF_DIR)}/`)) {
  console.error(`--out ${out} is inside the reference folder ${REF_DIR}: pick another folder (the reference is read-only).`);
  process.exit(2);
}
mkdirSync(out, { recursive: true });
const brand = makeBrandFolder(join(out, "Brand"));

const prompt =
  option("--prompt") ??
  [
    `Make a product demo promo comparing two runs of the same task from these files, in the style of the reference video ${REF.out} (import it and look at it with contact_sheet first, then keep it off the timeline: same scenes, timings, copy and numbers).`,
    `Files: the sky background ${REF.sky}, the two sped-up screen recordings ${REF.h45} (the first run) and ${REF.h55} (the second run), and a dark product logo ${brand.logo}.`,
    `The reference's copy, the agent logs (model, clock, tokens and lines per run) and the comparison table's numbers are in ${REF.project}: read them from there, don't make any up.`,
    `Structure: a white title card over the sky (about 3 s); the race: both recordings side by side in phone frames, each next to its agent log, the product wordmark and the task line on top and the footnote at the bottom, recordings that end early hold their last frame (about 22 s); the dark comparison table over the sky (about 10 s); the white end card with the product's logo, the install command and ${END_URL} as the URL (about 4 s). 1920×1080, 39.5 s in all.`,
    `Music: the lo-fi track ${MUSIC} under all of it with short fades, export target −16 LUFS. Run project_check before you're done and fix every warning.`,
  ].join(" ");

if (!flag("--run")) {
  console.log(`
Manual check in the app (pnpm dev, or dist/mac-arm64/Uncut.app):
  1. New project (1920×1080, 30 fps), open the Agent tab. Claude Code must show as signed in.
  2. Send this prompt:

${prompt}

  3. Expect: media_import (by path, the music too), a few timeline_edits
     (device frames with hold, agent logs, compare table, end card), project_check with no warnings left.
  4. Check in the preview: the title card, both phones playing beside their logs (the clocks stop at 2:50
     and 2:41, "Stuck in the table, $0.48" and "All 10 steps pass, $0.34"), the phones hold their last
     frame, the table's bars grow row by row, the end card wipes in with ${END_URL}.
  5. Checks tab: 0 to look at. Export (Standard, Quieter −16 LUFS) and play it next to
     ${REF.out}
  6. One Undo turn on the card restores the empty project; quit, reopen from Recents, ⌘Z / ⇧⌘Z still work.

Or run it headlessly: node scripts/phase6-manual-check.ts --run
`);
  process.exit(0);
}

// --run: the bundled server (plain node), a data folder of its own; the real claude from PATH (or the scripted one with --fake).
const { BUNDLE, MEDIA, connect, startServer } = await import("../test/helpers/server.ts");
for (const built of [BUNDLE, resolve("apps/server/dist/mcp.mjs"), resolve("apps/desktop/dist/main.cjs"), MEDIA]) if (!existsSync(built)) throw new Error(`${built} isn't built: run pnpm build (from the repo root)`);
const before = stampReference();
const data = join(out, "data");
mkdirSync(data, { recursive: true });
writeFileSync(join(data, "settings.json"), JSON.stringify({ onboarded: true }));
const fakePlan = join(out, "plan.json");
const results = join(out, "results.jsonl");
const fake = flag("--fake");
const env: NodeJS.ProcessEnv = { UNCUT_DATA_DIR: data, ANTHROPIC_API_KEY: "" };
if (fake) {
  writeFileSync(fakePlan, JSON.stringify([buildTurn(brand)]));
  writeFileSync(results, "");
  Object.assign(env, { UNCUT_CLAUDE: resolve("test/helpers/fake-claude.ts"), FAKE_PLAN: fakePlan, FAKE_PROMPT_LOG: join(out, "prompts.jsonl"), FAKE_RESULT_LOG: results });
} else delete process.env.UNCUT_CLAUDE;
const server = await startServer({ env });
const client = await connect(server.ready.port, server.ready.token);
const checks: Array<[string, boolean]> = [];
try {
  const agent = client.subscribe("agent.subscribe");
  const jobs = client.subscribe("export.jobs");
  mkdirSync(join(out, "projects"), { recursive: true });
  const snap = await client.ok("project.create", { parentDir: join(out, "projects"), name: "Argent promo", canvas: { width: 1920, height: 1080, fps: 30 } });
  await agent.until((s) => s?.dir === snap.dir, 20000);
  const turnOf = async (text: string, minutes: number) => {
    console.log(`\nPrompt: ${text}\nWaiting for the turn (up to ${minutes} min) …`);
    const t0 = Date.now();
    const { turnId } = await client.ok("agent.send", { prompt: text });
    let shown = 0;
    const timer = setInterval(() => {
      const turn = agent.values.at(-1)?.turns?.find((t: any) => t.id === turnId);
      const steps = (turn?.items ?? []).filter((i: any) => i.kind === "step");
      for (const s of steps.slice(shown)) console.log(`  - ${s.text} (${s.status})`);
      shown = steps.length;
    }, 1000);
    await agent.until((s) => s?.turns?.some((t: any) => t.id === turnId && t.status !== "running"), minutes * 60 * 1000);
    clearInterval(timer);
    const turn = agent.values.at(-1).turns.find((t: any) => t.id === turnId);
    console.log(`Turn ${turn.status} in ${((Date.now() - t0) / 1000).toFixed(0)} s${turn.error ? `: ${turn.error}` : ""}`);
    for (const i of turn.items) if (i.kind === "text") console.log(`  claude: ${i.text}`);
    for (const e of turn.edits ?? []) console.log(`  edit: ${e.summary}`);
    return turn;
  };
  const turn = await turnOf(prompt, 30);
  checks.push(["the turn finished", turn.status === "done"]);
  const current = async () => (await client.ok("project.get", {})).project as Project;
  if (fake) {
    // The scripted claude's second turn fixes what project_check found (the real one does it in its first).
    const found = projectChecks(await current()).filter((c) => c.severity === "warn").map((c) => ({ rule: c.id, items: c.itemIds as Array<string>, fix: c.fix }));
    writeFileSync(fakePlan, JSON.stringify([buildTurn(brand), fixTurn(found)]));
    await turnOf("Fix the remaining checks", 5);
  }
  const project = await current();
  const warnings = projectChecks(project).filter((c) => c.severity === "warn");
  for (const w of warnings) console.log(`  check: ${w.message}`);
  checks.push([`project_check: no warnings (${warnings.length})`, warnings.length === 0]);
  const fps = project.canvas.fps;
  const length = Math.max(...project.tracks.flatMap((t) => t.items.map((i) => (t.role === "main" ? 0 : (i.start ?? 0)) + i.duration)), ...project.tracks.filter((t) => t.role === "main").map((t) => t.items.reduce((s, i) => s + i.duration, 0)));
  checks.push([`${project.canvas.width}×${project.canvas.height} at ${fps} fps`, project.canvas.width === 1920 && project.canvas.height === 1080 && fps === 30]);
  const items = project.tracks.flatMap((t) => t.items);
  const used = new Set(items.map((i) => i.media).filter(Boolean));
  const mediaBy = (path: string) => project.media.find((m) => m.path === path || realpathSafe(m.path) === realpathSafe(path));
  checks.push(["both recordings and the sky are used, by path", [REF.h45, REF.h55, REF.sky].every((p) => !!mediaBy(p) && used.has(mediaBy(p)!.id))]);
  checks.push(["the recordings sit in device frames", items.filter((i) => i.component === "component.device-frame").length >= 2]);
  checks.push(["each recording has an agent log", items.filter((i) => i.component === "component.agent-log").length >= 2]);
  const recordings = items.filter((i) => i.type === "clip" && (i.media === mediaBy(REF.h45)?.id || i.media === mediaBy(REF.h55)?.id));
  checks.push([`the recordings hold their last frame (${recordings.length} clips, hold and no loop)`, recordings.length >= 2 && recordings.every((i) => i.hold === true && !i.loop)]);
  checks.push(["a comparison table or chart", items.some((i) => i.component === "component.compare-table" || i.component === "component.chart")]);
  const texts = items.filter((i) => i.type === "text").map((i) => i.text ?? "");
  const shown = [...texts, ...items.filter((i) => i.type === "component").map((i) => JSON.stringify(i.props ?? {}))];
  checks.push([`a text says ${END_URL}, and nothing on screen says argent.example.com`, texts.some((t) => t.includes(END_URL)) && !shown.some((t) => /argent\.example\.com/.test(t))]);
  checks.push(["library music with fades", items.some((i) => i.type === "audio" && (i.fadeIn ?? 0) > 0 && (i.fadeOut ?? 0) > 0)]);

  // Export: Standard, the project's −16 LUFS target.
  const output = join(out, "Argent promo.mp4");
  const { jobId } = await client.ok("export.start", { output, quality: "standard", loudness: "quiet" });
  console.log(`\nExporting ${output} …`);
  await jobs.until((list) => list.some((j: any) => j.id === jobId && ["done", "failed", "cancelled"].includes(j.phase)), 15 * 60 * 1000);
  const job = jobs.values.at(-1).find((j: any) => j.id === jobId);
  checks.push([`export ${job.phase}${job.error ? `: ${job.error}` : ""}`, job.phase === "done"]);
  if (job.phase === "done") {
    const p = probe(output);
    checks.push([`1920×1080 h264 at 30 fps (${p.width}×${p.height} ${p.codec} ${p.fps}), with ${p.audio ?? "no"} audio`, p.width === 1920 && p.height === 1080 && p.fps === "30/1" && p.audio === "aac"]);
    checks.push([`duration ${p.duration.toFixed(2)} s, the reference's ${(TOTAL / 30).toFixed(2)} s within 1.5 s (claude picks its own timings)`, Math.abs(p.duration - TOTAL / 30) <= 1.5 && length > 0]);
    const at = (s: number) => Math.min(p.duration - 0.1, s * (p.duration / (TOTAL / 30)));
    const scenes = [1.5, 12, 30, 38.5].map((s) => sceneOf(signature(output, at(s))));
    checks.push([`scenes at 4%, 30%, 76%, 98% of the length: ${scenes.join(", ")} (title, race, table, end)`, scenes.join() === "title,race,table,end"]);
    const l = loudness(output);
    checks.push([`loudness ${l.lufs} LUFS (−16 ± 1), true peak ${l.truePeak} dBTP (≤ −1)`, Math.abs(l.lufs + 16) <= 1 && l.truePeak <= -1]);
  }
  checks.push(["the reference folder is unchanged", JSON.stringify(stampReference()) === JSON.stringify(before)]);
  console.log("");
  for (const [what, ok] of checks) console.log(`  ${ok ? "PASS " : "CHECK"} ${what}`);
  console.log(`\nOpen ${snap.dir} in Uncut to look at it (Checks tab, History, Export).`);
  if (fake) writeFileSync(join(out, "checks.json"), JSON.stringify(checks));
} finally {
  client.close();
  await server.stop();
}

function realpathSafe(p: string) {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

