// The fixture the UI parts are rendered from (scripts/ui-parts.ts, uncut:lib/ui.js): a launch-film
// project (4:5, 60 fps, drone clips on Main, a title, an end-card graphic, the music and a few sound effects), an agent
// turn with its storyboard waiting for approval, a finished turn with the critic's review card, and
// an export. Plain data in the shapes the server sends, so the real components draw it as they
// would the real thing. No run facts in it (a timing, a count, a BPM, a defect, a fix): a film's
// parts state none unless the graphic passes real ones, and the runtime blanks the review's result,
// round and scores, the turn's status line and the export's time left until it does. Changing it changes the generated parts (ui-parts.test.ts sees them stale).
import type { AgentState, AgentTurn, ExportJob, ProjectSnapshot, Review, SetupCheck, Storyboard } from "@uncut/contracts";

export const FIXTURE_DIR = "/Users/you/Movies/Launch film.uncut";
const FPS = 60;
const s = (seconds: number) => Math.round(seconds * FPS);

const clip = (id: string, name: string, frames: number) => ({
  id,
  kind: "video" as const,
  name,
  path: `/Users/you/Footage/${name.replace(" ", "_")}.MP4`,
  probe: { frames, fps: 50, width: 3840, height: 2160, hasAudio: false },
});
const sound = (id: string, name: string, seconds: number) => ({
  id,
  kind: "audio" as const,
  name,
  path: `/Users/you/Sounds/${name}.wav`,
  probe: { frames: Math.round(seconds * 50), hasAudio: true },
});

export const FIXTURE_PROJECT = {
  format: "uncut/1",
  name: "Launch film",
  canvas: { width: 1080, height: 1350, fps: FPS },
  textLooks: 1,
  media: [
    {
      id: "m-music",
      kind: "audio" as const,
      name: "electro-dreams.mp3",
      path: "/Users/you/Music/electro-dreams.mp3",
      probe: { frames: s(28), hasAudio: true },
    },
    clip("m-dji-0050", "DJI 0050", 1896),
    clip("m-dji-0055", "DJI 0055", 2300),
    clip("m-dji-0063", "DJI 0063", 2900),
    clip("m-dji-0068", "DJI 0068", 1350),
    sound("m-click", "Mouse click", 0.3),
    sound("m-whoosh", "Airy whoosh", 0.8),
    sound("m-typing", "Keyboard typing", 2.9),
  ],
  tracks: [
    {
      id: "t-text",
      kind: "text" as const,
      name: "Text",
      items: [
        {
          id: "title",
          type: "text" as const,
          name: "Edit videos by talking",
          text: "Edit videos by talking",
          start: s(0.5),
          duration: s(5.5),
          style: { size: 120 },
        },
      ],
    },
    {
      id: "t-gfx",
      kind: "video" as const,
      name: "Graphics",
      items: [{ id: "end", type: "graphic" as const, name: "End card", src: "graphics/end-card.html", start: s(22), duration: s(6) }],
    },
    {
      id: "t-main",
      kind: "video" as const,
      role: "main" as const,
      name: "Main",
      items: [
        { id: "c1", type: "clip" as const, media: "m-dji-0055", in: s(15), duration: s(7) },
        { id: "c2", type: "clip" as const, media: "m-dji-0063", in: s(9.7), duration: s(7) },
        { id: "c3", type: "clip" as const, media: "m-dji-0068", in: s(9), duration: s(6) },
        { id: "c4", type: "clip" as const, media: "m-dji-0050", in: s(15.8), duration: s(8) },
      ],
    },
    {
      id: "t-music",
      kind: "audio" as const,
      name: "Audio",
      items: [{ id: "music", type: "audio" as const, media: "m-music", start: 0, in: 0, duration: s(28) }],
    },
    {
      id: "t-sfx",
      kind: "audio" as const,
      name: "Sound effects",
      items: [
        { id: "sx1", type: "audio" as const, media: "m-typing", start: s(2.5), in: 0, duration: s(2.9) },
        { id: "sx2", type: "audio" as const, media: "m-click", start: s(6), in: 0, duration: s(0.3) },
        { id: "sx3", type: "audio" as const, media: "m-whoosh", start: s(11.6), in: 0, duration: s(0.8) },
        { id: "sx4", type: "audio" as const, media: "m-click", start: s(20.5), in: 0, duration: s(0.3) },
      ],
    },
  ],
};

export const FIXTURE_SNAPSHOT: ProjectSnapshot = { dir: FIXTURE_DIR, project: FIXTURE_PROJECT, revision: 15, canUndo: true, canRedo: false };

/** The effects scene: the second clip selected with a look and an effect on it (the Inspector's effect rows, the Effects tab's tiles). */
export const FIXTURE_FX_CLIP = "c2";
export const FIXTURE_SNAPSHOT_FX: ProjectSnapshot = {
  ...FIXTURE_SNAPSHOT,
  project: {
    ...FIXTURE_PROJECT,
    tracks: FIXTURE_PROJECT.tracks.map((t) => ({
      ...t,
      items: t.items.map((i) =>
        i.id === FIXTURE_FX_CLIP
          ? {
              ...i,
              effects: [
                { module: "effect.look", params: { look: "warm" } },
                { module: "effect.vignette", params: { amount: 0.5, size: 0.5 } },
              ],
            }
          : i,
      ),
    })),
  },
};

/** The menu scene: the clip right-clicked (DJI 0063 on Main), and its chip as Add to chat makes it (actions.addItemToChat). */
export const FIXTURE_MENU_CLIP = "c2";
export const FIXTURE_CHIP = { kind: "item" as const, id: FIXTURE_MENU_CLIP, label: "DJI 0063", range: { start: s(7), end: s(14) } };

export const FIXTURE_PROMPT = "Make a 28 s launch film for Uncut on the Electro Dreams beat, the drone clips as the film being edited.";

export const FIXTURE_STORYBOARD: Storyboard = {
  summary:
    "One take on Electro Dreams: the composer, the agent's plan, the timeline building, the preview flooding full-frame on the drop, the critic's card, the export.",
  status: "proposed",
  beats: [
    {
      start: 0,
      end: 2,
      title: "Hook",
      entry: '"Edit videos by talking to an agent" huge on the canvas',
      exit: "The empty composer under it",
      purpose: "Stop the scroll with the claim",
      assets: ["Kit fonts", "composer UI"],
      sound: "Downbeat 0",
    },
    {
      start: 2,
      end: 6,
      title: "Typing the prompt",
      entry: "The cursor clicks into the composer",
      exit: "Prompt typed; Send pressed at 6.0",
      purpose: "Show you typing this prompt",
      assets: ["Composer UI"],
      sound: "Click on 2.5, send on 6.0",
    },
    {
      start: 6,
      end: 12,
      title: "It edits the timeline",
      entry: "The panel morphs into the editor",
      exit: "Camera pushes onto the preview",
      purpose: "The agent putting clips on real tracks",
      assets: ["DJI 0055", "DJI 0063", "DJI 0068"],
      sound: "A clip lands on every beat",
    },
    {
      start: 12,
      end: 18,
      title: "Drop: the film plays",
      entry: "The preview floods full-frame",
      exit: "Shots grow out of each other",
      purpose: "The reveal: the edited film itself",
      assets: ["DJI 0063", "DJI 0050"],
      sound: "Drop 12.0",
    },
  ],
};

export const FIXTURE_REVIEW: Review = {
  round: 2,
  scores: { hook: 9, readability: 8, motion: 9, variety: 8, sound: 9, brand: 9 },
  rubric: { hook: "required", readability: "required", motion: "required", variety: "optional", sound: "required", brand: "optional" },
  defects: [],
  by: "critic",
  passed: true,
  at: "2026-10-16T10:12:00.000Z",
  fixes: [],
};

const turn = (id: string, patch: Partial<AgentTurn>): AgentTurn => ({
  id,
  prompt: FIXTURE_PROMPT,
  startedAt: "2026-10-16T10:00:00.000Z",
  status: "done",
  items: [],
  edits: [],
  undo: { state: "none" },
  ...patch,
});

/** The plan scene: the turn is waiting on the storyboard card (Approve). */
export const FIXTURE_AGENT_PLAN: AgentState = {
  dir: FIXTURE_DIR,
  provider: "Claude Code",
  running: "turn-1",
  turns: [
    turn("turn-1", {
      status: "running",
      items: [
        { kind: "thinking", text: "Beat grid first, then a storyboard with one state per beat" },
        { kind: "step", text: "Read the brand kit Uncut", tool: "brand_read", status: "done" },
        { kind: "step", text: "Found the beats", tool: "beat_grid", status: "done" },
        { kind: "text", text: "Here's the plan: one take on the beat, the drop floods the preview full-frame." },
      ],
    }),
  ],
  approval: { id: "ap-1", turnId: "turn-1", text: "Approve the storyboard", estimate: 0, until: "2099-01-01T00:00:00.000Z", storyboard: FIXTURE_STORYBOARD },
  plan: { storyboard: FIXTURE_STORYBOARD, reviews: [] },
};

/** The review scene: the turn is done; the critic's card, the reply and the edits under it. */
export const FIXTURE_AGENT_DONE: AgentState = {
  dir: FIXTURE_DIR,
  provider: "Claude Code",
  running: null,
  turns: [
    turn("turn-1", {
      finishedAt: "2026-10-16T10:21:00.000Z",
      items: [
        { kind: "step", text: "Wrote graphic film.html", tool: "graphic_write", status: "done" },
        { kind: "step", text: "Placed the clips on Main", tool: "edit", status: "done" },
        { kind: "card", text: "", card: { type: "review", review: FIXTURE_REVIEW } },
        {
          kind: "text",
          text: "The film is built on the Electro Dreams beat: it opens on the claim, types your prompt, builds the timeline, floods the preview on the drop and ends on the export.",
        },
      ],
      edits: [
        { revision: 14, summary: "Placed the clips on Main", lines: ["Added DJI 0055", "Added DJI 0063", "Added DJI 0068", "Added DJI 0050"], at: 1 },
        { revision: 15, summary: "Added sound effects", lines: ["Added Keyboard typing", "Added Mouse click"] },
      ],
      undo: { state: "available" },
    }),
  ],
  plan: { storyboard: { ...FIXTURE_STORYBOARD, status: "approved", approvedBy: "user" }, reviews: [FIXTURE_REVIEW] },
};

/** The menu scene's thread: one sent prompt with a clip chip (its CSS; the runtime blanks the words). */
export const FIXTURE_AGENT_CHIP: AgentState = {
  dir: FIXTURE_DIR,
  provider: "Claude Code",
  running: null,
  turns: [
    turn("turn-1", {
      prompt: `@${FIXTURE_CHIP.label} make this one slow motion`,
      mentions: [{ kind: FIXTURE_CHIP.kind, label: FIXTURE_CHIP.label }],
      finishedAt: "2026-10-16T10:01:00.000Z",
    }),
  ],
};

export const FIXTURE_SETUP: ReadonlyArray<SetupCheck> = [
  { id: "claude", name: "Claude Code", status: "ready", optional: false, detail: "Signed in", version: "2.1.300" },
  { id: "ffmpeg", name: "ffmpeg", status: "ready", optional: false, detail: "Installed", version: "7.1" },
];

/** An export a little under half done. */
export const FIXTURE_EXPORT_JOB: ExportJob = {
  id: "ex-1",
  projectDir: FIXTURE_DIR,
  name: "Launch film.mp4",
  output: "/Users/you/Movies/Launch film.mp4",
  quality: "high",
  codec: "h264",
  loudness: "normal",
  targetLufs: -14,
  phase: "rendering",
  progress: 0.42,
  etaSeconds: 38,
  width: 1080,
  height: 1350,
  fps: 60,
  seconds: 28,
  startedAt: "2026-10-16T10:22:00.000Z",
  motionBlur: true,
};
