// Issues #34, #35, #37 (D198–D200) on the bundled server with fake-claude's session:
// - #37: every folder a message names (two of them, $HOME and ~ forms) is listed in the message
//   and reported on the turn; all of ~/Downloads is named with why; reference_frames takes ~/;
// - #35: brand_write makes a kit in the user's library (logos and a font file from ~/ paths and a
//   folder), another project picks it; brand_read shows the logos as pictures (an SVG drawn as a
//   PNG); changing the kit's colours waits for the before / after card (Keep the kit leaves them,
//   Apply changes them) and a style from a reference never touches them;
// - #34: a font a graphic asks for that isn't there is a project_check error (and graphic_write
//   says so); once the kit has the font's file it isn't.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BUNDLE, MEDIA, connect, killAll, startServer } from "../helpers/server.ts";

const MCP = resolve("apps/server/dist/mcp.mjs");
const FAKE = resolve("test/helpers/fake-claude.ts");
const DESKTOP = resolve("apps/desktop/dist/main.cjs");
const skip =
  existsSync(BUNDLE) && existsSync(MCP) && existsSync(MEDIA) && existsSync(DESKTOP) ? false : "server bundle, media core or desktop not built (run pnpm build)";
// A 1x1 PNG.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 60"><rect width="200" height="60" rx="12" fill="#0b1d3a"/><circle cx="30" cy="30" r="18" fill="#f5a623"/></svg>`;

let root = "";
after(() => {
  killAll();
  if (root) rmSync(root, { recursive: true, force: true });
});
before(() => {
  if (skip) return;
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-agent-brand-fonts-")));
});

type Result = { tool: string; result: { isError?: boolean; content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> } };

async function setup(name: string) {
  const base = join(root, name);
  const home = join(base, "home");
  mkdirSync(join(home, "Projects"), { recursive: true });
  const plan = join(base, "plan.json");
  const log = join(base, "prompts.jsonl");
  const results = join(base, "results.jsonl");
  writeFileSync(log, "");
  writeFileSync(results, "");
  // HOME is the test's: ~ and $HOME in paths and the folder rules mean this folder. No installed fonts.
  const server = await startServer({
    env: {
      HOME: home,
      UNCUT_FONT_DIRS: "",
      UNCUT_DATA_DIR: join(base, "data"),
      UNCUT_CLAUDE: FAKE,
      FAKE_PLAN: plan,
      FAKE_PROMPT_LOG: log,
      FAKE_RESULT_LOG: results,
      UNCUT_APPROVAL_MS: "15000",
    },
  });
  const client = await connect(server.ready.port, server.ready.token);
  const agent = client.subscribe("agent.subscribe");
  const snap = await client.ok("project.create", { parentDir: join(home, "Projects"), name: "P" });
  await agent.until((s) => s?.dir === snap.dir);
  const turns: Array<unknown> = [];
  const latest = () => agent.values.at(-1);
  const turn = (id: string) => latest()?.turns.find((t: { id: string }) => t.id === id);
  return {
    base,
    home,
    data: join(base, "data"),
    client,
    agent,
    dir: snap.dir as string,
    turn,
    prompts: (): Array<{ prompt: string }> =>
      readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l)),
    results: (): Array<Result> =>
      readFileSync(results, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
        .filter((x) => x.tool),
    start: async (prompt: string, steps: Array<unknown>) => {
      turns.push(steps);
      writeFileSync(plan, JSON.stringify(turns));
      const { turnId } = await client.ok("agent.send", { prompt, access: "auto" });
      return turnId as string;
    },
    done: async (id: string) => {
      await agent.until(() => turn(id) && turn(id).status !== "running", 60000);
      return turn(id);
    },
    stop: async () => {
      client.close();
      await server.stop();
    },
  };
}

const json = (r: Result) => JSON.parse(r.result.content[0]!.text!);

test(
  "#37: every folder a message names is listed for the agent and reported (two folders, ~ and $HOME), all of ~/Downloads says why; reference_frames takes ~/",
  { skip, timeout: 120000 },
  async () => {
    const s = await setup("folders");
    try {
      const clips = join(s.home, "Videos", "project");
      const assets = join(s.home, "Videos", "assets");
      mkdirSync(join(clips, "old"), { recursive: true });
      mkdirSync(assets, { recursive: true });
      mkdirSync(join(s.home, "Downloads"), { recursive: true });
      for (const n of ["a.mp4", "b.mp4", "c.png"]) writeFileSync(join(clips, n), "x");
      writeFileSync(join(assets, "logo.svg"), SVG);
      writeFileSync(join(s.home, "Downloads", "ref.png"), PNG);
      const id = await s.start(
        "Recreate ~/Downloads/ref.png with the clips in ~/Videos/project and the assets in $HOME/Videos/assets (also look in ~/Downloads).",
        [
          { tool: "reference_frames", args: { path: "~/Downloads/ref.png" } },
          { tool: "reference_frames", args: { path: "$HOME/Videos/assets/logo.svg" } },
          { text: "Looked." },
        ],
      );
      const t = await s.done(id);
      assert.equal(t.status, "done", t.error);
      assert.deepEqual(t.folders, [
        { path: "~/Videos/project", files: 3, folders: 1 },
        { path: "~/Videos/assets", files: 1, folders: 0 },
        { path: "~/Downloads", files: 0, folders: 0, problem: "it's all of ~/Downloads; paste a folder inside it" },
      ]);
      const prompt = s.prompts().at(-1)!.prompt;
      assert.match(prompt, /<folders>\nThe folders the user named in this message, each listed by Uncut/);
      assert.ok(prompt.includes(`~/Videos/project (${clips}): 3 files (2 videos, 1 image) and 1 folder: a.mp4, b.mp4, c.png, old/.`), prompt);
      assert.ok(prompt.includes(`~/Videos/assets (${assets}): 1 file (1 image): logo.svg.`), prompt);
      assert.match(prompt, /~\/Downloads: not listed, it's all of ~\/Downloads; paste a folder inside it/);
      const [ref, svg] = s.results().filter((r) => r.tool === "reference_frames");
      assert.ok(!ref!.result.isError, JSON.stringify(ref!.result));
      assert.equal(ref!.result.content[1]!.type, "image");
      // An SVG reference is drawn as a PNG the model can see.
      assert.ok(!svg!.result.isError, JSON.stringify(svg!.result));
      assert.equal(svg!.result.content[1]!.mimeType, "image/png");
    } finally {
      await s.stop();
    }
  },
);

test(
  "#35 + #34: a kit in the library from ~/ files and a folder, picked by another project; logos as pictures; colour changes wait for the card; a missing font is an error until the kit has its file",
  { skip, timeout: 240000 },
  async () => {
    const s = await setup("brand");
    try {
      const brand = join(s.home, "Downloads", "brand-kit");
      mkdirSync(brand, { recursive: true });
      writeFileSync(join(brand, "argent-logo.svg"), SVG);
      writeFileSync(join(brand, "argent-mark.png"), PNG);
      writeFileSync(join(s.home, "Downloads", "KitMono.woff2"), readFileSync(resolve("assets/fonts/DMMono-Regular.woff2")));
      const ghost = `<canvas id="c"></canvas><script>const c = document.getElementById("c"); window.render = (t, info) => { c.width = info.width; c.height = info.height; const x = c.getContext("2d"); x.font = "64px 'Ghost Grotesk', sans-serif"; x.fillText("Argent", 40, 120); };</script>`;
      const kitFont = ghost.replace("Ghost Grotesk", "Uncut Kit Mono");
      const id = await s.start("Make the Argent kit from ~/Downloads/brand-kit", [
        {
          tool: "brand_write",
          args: {
            name: "Argent",
            colors: [
              { hex: "#0b1d3a", role: "background" },
              { hex: "#f5a623", role: "accent" },
            ],
            logos: { light: "~/Downloads/brand-kit/argent-logo.svg" },
            import: "$HOME/Downloads/brand-kit",
          },
        },
        { tool: "brand_read" },
        { tool: "graphic_write", args: { name: "ghost.html", html: ghost } },
        { tool: "project_read" },
        {
          tool: "timeline_edit",
          args: {
            baseRevision: "$rev",
            summary: "A title",
            ops: [
              { op: "add_track", track: { id: "v2", kind: "video", name: "Graphics", items: [] }, index: 0 },
              { op: "insert_item", track: "v2", item: { id: "g-1", type: "graphic", src: "graphics/ghost.html", start: 0, duration: 30 } },
            ],
          },
        },
        { tool: "project_check" },
        // A style from a reference with the reference's colours: the colours wait for the card (Keep the kit), the style goes in.
        {
          tool: "brand_write",
          args: {
            kit: "argent",
            colors: [{ hex: "#e5484d", role: "error" }],
            style: {
              source: "ref.mp4",
              palette: [{ hex: "#e5484d", role: "alert" }],
              type: "Big grotesk",
              shotLengths: "1 s",
              transitions: "cuts",
              camera: "still",
              grain: "none",
            },
          },
        },
        {
          tool: "brand_write",
          args: {
            kit: "argent",
            colors: [
              { hex: "#0b1d3a", role: "background" },
              { hex: "#ffffff", role: "text" },
            ],
          },
        },
        { tool: "brand_write", args: { kit: "argent", fonts: [{ family: "Uncut Kit Mono", role: "headline", file: "~/Downloads/KitMono.woff2" }] } },
        { tool: "graphic_write", args: { name: "kit.html", html: kitFont } },
        // Edit mode: only the change travels; a new revision; an old that isn't there writes nothing.
        { tool: "graphic_write", args: { from: "kit.html", edits: [{ old: 'fillText("Argent"', new: 'fillText("Argent 2"' }] } },
        { tool: "graphic_write", args: { from: "graphics/kit.html", edits: [{ old: "not in the file", new: "x" }] } },
        { tool: "project_read" },
        {
          tool: "timeline_edit",
          args: { baseRevision: "$rev", summary: "Kit font title", ops: [{ op: "update_item", item: "g-1", set: { src: "graphics/kit.html" } }] },
        },
        { tool: "project_check" },
        { text: "Done." },
      ]);
      // The first card: the reference's red as a kit colour. Keep the kit.
      const card = async (...seen: Array<string>) => {
        const fits = (v: any) => v?.approval?.turnId === id && !!v.approval.brand && !seen.includes(v.approval.id);
        await s.agent.until(fits, 60000);
        return s.agent.values.findLast(fits).approval;
      };
      const first = await card();
      assert.equal(first.text, 'Change the colours of the kit "Argent"');
      assert.deepEqual(first.brand, {
        kit: "Argent",
        changes: [{ field: "Colours", before: ["#0b1d3a background", "#f5a623 accent"], after: ["#e5484d error"] }],
      });
      await s.client.ok("agent.approve", { id: first.id, allow: false });
      const second = await card(first.id);
      assert.deepEqual(second.brand.changes[0].after, ["#0b1d3a background", "#ffffff text"]);
      await s.client.ok("agent.approve", { id: second.id, allow: true });
      const t = await s.done(id);
      assert.equal(t.status, "done", t.error);

      const results = s.results();
      const by = (tool: string) => results.filter((r) => r.tool === tool);
      // The new kit is in the user's library, with its logos (light from the path, the mark from the folder) and active here.
      const made = json(by("brand_write")[0]!);
      assert.equal(made.saved, "argent");
      assert.match(made.scope, /the user's library/);
      const kitDir = join(s.data, "brand", "kits", "argent");
      const stored = JSON.parse(readFileSync(join(kitDir, "kit.json"), "utf8"));
      assert.deepEqual(stored.logos, { light: "argent-logo.svg", mark: "argent-mark.png" });
      assert.ok(existsSync(join(kitDir, "argent-logo.svg")) && existsSync(join(kitDir, "argent-mark.png")));
      assert.deepEqual(JSON.parse(readFileSync(join(s.dir, "brand", "active.json"), "utf8")).kit, "argent");
      // brand_read: the logos as PNG pictures (the SVG drawn), each named.
      const read = by("brand_read")[0]!.result;
      const images = read.content.filter((c) => c.type === "image");
      assert.equal(images.length, 2, JSON.stringify(read.content.map((c) => c.text ?? c.type)));
      assert.ok(images.every((i) => i.mimeType === "image/png" && Buffer.from(i.data!, "base64").subarray(1, 4).toString() === "PNG"));
      assert.ok(read.content.some((c) => c.text === "Logo: the logo for light backgrounds, argent-logo.svg:"));
      // The SVG drawn: its navy and orange are in the picture (not blank).
      writeFileSync(join(s.base, "logo-light.png"), Buffer.from(images[0]!.data!, "base64"));
      mkdirSync("test-output", { recursive: true });
      writeFileSync("test-output/issue35-brand-read-logo.png", Buffer.from(images[0]!.data!, "base64"));
      // #34: the missing font: graphic_write says so, project_check is an error.
      assert.match(json(by("graphic_write")[0]!).fonts, /Not available: "Ghost Grotesk"/);
      const check = json(by("project_check")[0]!);
      assert.equal(check.errors, 1, JSON.stringify(check));
      const err = check.checks.find((c: { rule: string }) => c.rule === "font-missing");
      assert.equal(err.severity, "error");
      assert.match(err.message, /graphics\/ghost\.html asks for "Ghost Grotesk"/);
      // The kit's colours: kept on the first card, the style written; changed on the second.
      const kept = json(by("brand_write")[1]!);
      assert.ok(
        kept.notes.some((n: string) => /kept the kit as it is: its colours and fonts weren't changed/.test(n)),
        JSON.stringify(kept),
      );
      const after = JSON.parse(readFileSync(join(kitDir, "kit.json"), "utf8"));
      assert.deepEqual(after.colors, [
        { hex: "#0b1d3a", role: "background" },
        { hex: "#ffffff", role: "text" },
      ]);
      assert.equal(after.style.palette[0].hex, "#e5484d", "the reference's red is in the style guide only");
      // The font file came in from ~/; the graphic in the kit's font passes the check.
      assert.deepEqual(after.fonts, [{ family: "Uncut Kit Mono", role: "headline", file: "KitMono.woff2" }]);
      assert.equal(json(by("graphic_write")[1]!).fonts, undefined);
      const edited = json(by("graphic_write")[2]!);
      assert.equal(edited.src, "graphics/kit-2.html", JSON.stringify(edited));
      assert.equal(edited.editedFrom, "graphics/kit.html");
      assert.equal(readFileSync(join(s.dir, "graphics", "kit-2.html"), "utf8"), kitFont.replace('fillText("Argent"', 'fillText("Argent 2"'));
      assert.equal(readFileSync(join(s.dir, "graphics", "kit.html"), "utf8"), kitFont, "the original is never overwritten");
      assert.equal(by("graphic_write")[3]!.result.isError, true);
      assert.match(by("graphic_write")[3]!.result.content[0]!.text!, /isn't in graphics\/kit\.html.*Nothing was written/);
      assert.ok(!existsSync(join(s.dir, "graphics", "kit-3.html")));
      const clean = json(by("project_check")[1]!);
      assert.equal(clean.errors, undefined, JSON.stringify(clean));

      // Another project in the same library: the kit is there to pick.
      const other = await s.client.ok("project.create", { parentDir: join(s.home, "Projects"), name: "Q" });
      await s.agent.until((v) => v?.dir === other.dir);
      const id2 = await s.start("Hi", [{ text: "Hello." }]);
      await s.done(id2);
      assert.match(s.prompts().at(-1)!.prompt, /No brand kit is chosen for this project\. The user's kits: "Argent" \(argent\)\./);
    } finally {
      await s.stop();
    }
  },
);
