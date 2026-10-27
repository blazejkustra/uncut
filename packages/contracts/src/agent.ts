import * as Schema from "effect/Schema";

/**
 * The production brief (U15, `<project>/brief.json`): co-written with the agent before a new video
 * is built, editable by the user. Every field is plain text the agent reads each turn.
 */
export const Brief = Schema.Struct({
  film: Schema.String, // the film in one sentence
  audience: Schema.String,
  duration: Schema.String, // "20 s"
  formats: Schema.Array(Schema.String), // "9:16 1080x1920", "16:9"
  assets: Schema.Array(Schema.String), // the real assets it uses (logo, recordings, screenshots)
  visual: Schema.String, // visual direction
  hardLines: Schema.Array(Schema.String), // never invent product UI, metrics or logos...
  deliverables: Schema.Array(Schema.String),
  notes: Schema.optional(Schema.String),
  updatedAt: Schema.optional(Schema.String),
  by: Schema.optional(Schema.Literals(["agent", "user"])),
  // D217: the kind of video (core VIDEO_TYPES: "launch-promo", "tutorial", "meme", …); the critic's
  // rubric and the sound limits follow it. Absent on briefs written before D217 (judged as before).
  type: Schema.optional(Schema.String),
  // D217: the skills brief_write suggested for it (ids); only the ones the user picked are on.
  skills: Schema.optional(Schema.Array(Schema.String)),
});
export type Brief = typeof Brief.Type;
/** One beat of the storyboard / shot list (U9, U15): times in seconds. */
export const StoryboardBeat = Schema.Struct({
  start: Schema.Number,
  end: Schema.Number,
  title: Schema.String,
  entry: Schema.String, // what's on screen as it starts
  exit: Schema.String, // what's on screen as it ends
  purpose: Schema.String,
  assets: Schema.Array(Schema.String),
  sound: Schema.optional(Schema.String), // the beat or hit it lands on
  // D295: the beat's still, rendered by storyboard_propose (an image name in .cache/agent-images/).
  still: Schema.optional(Schema.String),
});
export type StoryboardBeat = typeof StoryboardBeat.Type;
/** The storyboard (`<project>/storyboard.json`): proposed by the agent, approved (maybe edited) by the user before the build. */
export const Storyboard = Schema.Struct({
  summary: Schema.String,
  beats: Schema.Array(StoryboardBeat),
  status: Schema.Literals(["proposed", "approved", "declined"]),
  // "user": approved on the card; "setting": Auto with the gate skipped.
  approvedBy: Schema.optional(Schema.Literals(["user", "setting", "agent"])),
  note: Schema.optional(Schema.String),
  updatedAt: Schema.optional(Schema.String),
});
export type Storyboard = typeof Storyboard.Type;
/** The critic's scores (U16), 0–10 each. */
export const REVIEW_SCORES = ["hook", "readability", "motion", "variety", "sound", "brand"] as const;
// D217: only the categories that apply to the video are scored (a tutorial has no hook score).
export const ReviewScores = Schema.Struct({
  hook: Schema.optional(Schema.Number),
  readability: Schema.optional(Schema.Number),
  motion: Schema.optional(Schema.Number),
  variety: Schema.optional(Schema.Number),
  sound: Schema.optional(Schema.Number),
  brand: Schema.optional(Schema.Number),
});
export type ReviewScores = typeof ReviewScores.Type;
/** One review round (`<project>/reviews/review-<n>.json`). */
export const Review = Schema.Struct({
  round: Schema.Number,
  scores: ReviewScores,
  // id: the critic's defect id (d1, d2, …: what a fix claim names in the next round, D195).
  // D217: kind (a category or a blocker kind the rubric made a finding), source "check" (Uncut's own),
  // rule (a check's finding family, "sound:density"), to (where a check's range ends, seconds).
  defects: Schema.Array(
    Schema.Struct({
      at: Schema.Number,
      what: Schema.String,
      fix: Schema.optional(Schema.String),
      id: Schema.optional(Schema.String),
      kind: Schema.optional(Schema.String),
      source: Schema.optional(Schema.String),
      rule: Schema.optional(Schema.String),
      to: Schema.optional(Schema.Number),
    }),
  ),
  notes: Schema.optional(Schema.String),
  // D195: who scored it: "critic" (a separate claude process Uncut ran) or "agent" (rounds before D195).
  by: Schema.optional(Schema.Literals(["critic", "agent"])),
  // D195: hard blockers (any one fails the round whatever the scores); source "critic" or "check" (Uncut's layout checks).
  // Round 3: fix, the critic's concrete change at that moment.
  blockers: Schema.optional(
    Schema.Array(
      Schema.Struct({
        id: Schema.optional(Schema.String),
        kind: Schema.String,
        what: Schema.String,
        at: Schema.optional(Schema.Number),
        source: Schema.String,
        rule: Schema.optional(Schema.String),
        to: Schema.optional(Schema.Number),
        fix: Schema.optional(Schema.String),
      }),
    ),
  ),
  // D217: the rubric the round was judged by: per category required, optional or na (not scored); the
  // video type and sound profile it came from; how many findings the user marked Intended were left out.
  rubric: Schema.optional(Schema.Record(Schema.String, Schema.Literals(["required", "optional", "na"]))),
  videoType: Schema.optional(Schema.String),
  soundProfile: Schema.optional(Schema.String),
  intended: Schema.optional(Schema.Number),
  // D195: per score, the frames the critic cites ("f 0, f 45: …").
  evidence: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  // D196: the builder's fix claims and whether the critic saw each fixed on fresh frames.
  fixes: Schema.optional(
    Schema.Array(
      Schema.Struct({
        defect: Schema.String,
        what: Schema.String,
        at: Schema.optional(Schema.Number),
        verified: Schema.Boolean,
        note: Schema.optional(Schema.String),
      }),
    ),
  ),
  // D195: why the round has no scores (the critic couldn't run or answered something unreadable).
  error: Schema.optional(Schema.String),
  // The determinism check (U16): graphics drawn twice at the same frame, by name; those that differed.
  determinism: Schema.optional(Schema.Struct({ checked: Schema.Array(Schema.String), differed: Schema.Array(Schema.String) })),
  // Whether this round's looks were taken (a contact sheet and phone-size frames in this turn).
  looked: Schema.optional(Schema.Struct({ sheet: Schema.Boolean, phone: Schema.Boolean })),
  passed: Schema.Boolean,
  revision: Schema.optional(Schema.Number),
  at: Schema.String,
  turnId: Schema.optional(Schema.String),
});
export type Review = typeof Review.Type;
/**
 * D217: a review finding the user marked "Intended" on the review card (`<project>/intended.json`):
 * the critic stops raising it. kind: the finding's rule or kind ("sound:density", "hook"); from/to:
 * the time range it covers (seconds; absent for a finding with no time).
 */
export const IntendedFinding = Schema.Struct({
  kind: Schema.String,
  what: Schema.String,
  from: Schema.optional(Schema.Number),
  to: Schema.optional(Schema.Number),
  at: Schema.String,
});
export type IntendedFinding = typeof IntendedFinding.Type;
/** The open project's plan as the Agent tab shows it. */
export const AgentPlan = Schema.Struct({
  brief: Schema.optional(Brief),
  storyboard: Schema.optional(Storyboard),
  reviews: Schema.Array(Review),
  intended: Schema.optional(Schema.Array(IntendedFinding)),
});
export type AgentPlan = typeof AgentPlan.Type;

/** A question the agent asks (ask_user, U8): pick one or several options and/or write an answer. */
export const AgentQuestion = Schema.Struct({
  question: Schema.String,
  options: Schema.Array(Schema.Struct({ label: Schema.String, detail: Schema.optional(Schema.String) })),
  multi: Schema.Boolean,
  freeText: Schema.Boolean,
});
export type AgentQuestion = typeof AgentQuestion.Type;
/** The user's answer to a question card. */
export const AgentAnswer = Schema.Struct({ choices: Schema.Array(Schema.String), text: Schema.optional(Schema.String) });
export type AgentAnswer = typeof AgentAnswer.Type;
/** A card in a turn's history (kept with the turn): a question and its answer, the brief, the storyboard, a review. */
export const AgentCard = Schema.Struct({
  type: Schema.Literals(["question", "brief", "storyboard", "review", "brand"]),
  question: Schema.optional(AgentQuestion),
  answer: Schema.optional(AgentAnswer),
  // "answered", "skipped" (no answer in time, or stopped), "approved", "declined", "auto" (approved by the setting)
  outcome: Schema.optional(Schema.String),
  brief: Schema.optional(Brief),
  storyboard: Schema.optional(Storyboard),
  review: Schema.optional(Review),
  // brand: what was written into which kit ("Style guide written into Argent")
  text: Schema.optional(Schema.String),
});
export type AgentCard = typeof AgentCard.Type;

// ---- agent (D40, D48) ----

// The MCP server the agent CLI runs forwards tool calls to these routes (same port as the
// WebSocket), authenticated by a token that lives only as long as one turn: GET <path>/tools,
// POST <path>/call with { name, args }.
export const AGENT_BRIDGE_PATH = "/agent";
export const AGENT_TOKEN_HEADER = "x-uncut-agent-token";

/** One thing in a turn, in order: a piece of the agent's reply, its thinking (a summary), or a tool it used. */
export const AgentItem = Schema.Struct({
  kind: Schema.Literals(["text", "step", "thinking", "card"]),
  // The reply text, the thinking summary, or the step in words ("Read the timeline", the edit's summary).
  text: Schema.String,
  tool: Schema.optional(Schema.String),
  status: Schema.optional(Schema.Literals(["running", "done", "error"])),
  // Still streaming in (D139): text and thinking grow as Claude writes them.
  live: Schema.optional(Schema.Boolean),
  // A step that failed (D182): what the tool answered, for the work log's ✕ row.
  error: Schema.optional(Schema.String),
  // A step while it runs (D182), in the present tense with its target ("Writing graphic s3-enter.html").
  doing: Schema.optional(Schema.String),
  // D194: what a built-in tool (WebSearch, WebFetch, Bash, Read, …) answered, at most 4,000 characters: the work log's row opens to it.
  result: Schema.optional(Schema.String),
  // kind "card" (D186–D190): a question with its answer, the brief, the storyboard or a review.
  card: Schema.optional(AgentCard),
});
export type AgentItem = typeof AgentItem.Type;

// ---- the composer's choices (U4, D184) ----

/** Issue #106: the agent CLIs a turn can run in: Claude Code, or Codex (its app-server). */
export const AGENT_PROVIDERS = ["claude", "codex"] as const;
export const AgentProvider = Schema.Literals(AGENT_PROVIDERS);
export type AgentProvider = typeof AgentProvider.Type;

/** The models the composer offers (each CLI's own model ids); none chosen = that CLI's default (for Codex: its config.toml's model). */
export const AGENT_MODELS: ReadonlyArray<{
  readonly id: string;
  readonly name: string;
  readonly detail: string;
  readonly provider: AgentProvider;
  readonly isNew: boolean;
}> = [
  // D209: isNew marks the newest generation (a NEW badge in the model menu).
  { id: "claude-opus-5-5", name: "Opus 5.5", detail: "Most capable", provider: "claude", isNew: true },
  { id: "claude-sonnet-5-5", name: "Sonnet 5.5", detail: "Fast and capable", provider: "claude", isNew: true },
  { id: "claude-fable-5-1", name: "Fable 5.1", detail: "Creative", provider: "claude", isNew: false },
  { id: "claude-haiku-5-5", name: "Haiku 5.5", detail: "Fastest", provider: "claude", isNew: true },
  // Issue #106: Codex's model/list (codex-cli 0.164), its visible current generation.
  { id: "gpt-6.1-sol", name: "GPT-6.1 Sol", detail: "Workhorse for everyday work", provider: "codex", isNew: true },
  { id: "gpt-6-astra", name: "GPT-6 Astra", detail: "Most capable", provider: "codex", isNew: false },
  { id: "gpt-6-luna", name: "GPT-6 Luna", detail: "Fast and affordable", provider: "codex", isNew: false },
];
/** --effort levels (claude 2.1.299 also has xhigh; the composer offers these four). */
export const AGENT_EFFORTS = ["low", "medium", "high", "max"] as const;
export const AgentEffort = Schema.Literals(AGENT_EFFORTS);
export type AgentEffort = typeof AgentEffort.Type;
/**
 * What the agent may do (D184): look (reads and looks, never changes the project), ask (big
 * changes wait for Allow on a card: removing things, cutting by transcript, many items at once)
 * and edit (everything, as before; spending over $1 still asks, D99).
 */
// D214: "auto" (Claude Code's own auto mode) replaced "edit" (Edit freely); stored prefs migrate in the web app.
export const AGENT_ACCESS = ["look", "ask", "auto"] as const;
export const AgentAccess = Schema.Literals(AGENT_ACCESS);
export type AgentAccess = typeof AgentAccess.Type;
/** An image attached to a message: base64 data, at most AGENT_IMAGE_MAX bytes, AGENT_IMAGES_MAX per message. */
export const AGENT_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
export const AGENT_IMAGE_MAX = 5 * 1024 * 1024;
export const AGENT_IMAGES_MAX = 4;
export const AgentImage = Schema.Struct({ name: Schema.String, mimeType: Schema.Literals(AGENT_IMAGE_TYPES), data: Schema.String });
export type AgentImage = typeof AgentImage.Type;

/**
 * An edit the agent made in a turn: its summary and every op in words (core describeOp). D203: `at`
 * is the index in the turn's items of the step (tool call) that made it, so the thread shows the
 * edit where it happened; `media` the ids of the media it added (an import's thumbnails).
 */
export const AgentEdit = Schema.Struct({
  revision: Schema.Number,
  summary: Schema.String,
  lines: Schema.Array(Schema.String),
  at: Schema.optional(Schema.Number),
  media: Schema.optional(Schema.Array(Schema.String)),
});
export type AgentEdit = typeof AgentEdit.Type;

export const AgentTurnStatus = Schema.Literals(["running", "done", "error", "cancelled"]);

/**
 * Something the user pointed at in the composer (D140): an @mention or an "Add to chat" chip. The
 * prompt holds "@label"; the agent gets the label with the real id in a <context> block.
 */
export const AgentMentionKind = Schema.Literals(["media", "item", "track", "marker", "moment", "range", "effect", "transition", "region"]);
export const AgentMention = Schema.Struct({
  kind: AgentMentionKind,
  id: Schema.String,
  label: Schema.String,
  // Add to chat (D141): the stretch of the timeline it covers, in project frames, or the frame it was picked at.
  range: Schema.optional(Schema.Struct({ start: Schema.Int, end: Schema.Int })),
  frame: Schema.optional(Schema.Int),
  // Issue #118: a region of the picture (dragged over the preview), in canvas pixels, at `frame` or over `range`.
  area: Schema.optional(Schema.Struct({ x: Schema.Int, y: Schema.Int, w: Schema.Int, h: Schema.Int })),
});
export type AgentMention = typeof AgentMention.Type;

/** Whether "Undo turn" can run now, and why not when it can't. */
export const AgentUndo = Schema.Struct({
  state: Schema.Literals(["none", "available", "blocked", "unavailable", "undone"]),
  reason: Schema.optional(Schema.String),
  // An undone turn: whether Redo can put its edits back now ("blocked": a later edit touches what it changed; redoReason says which).
  redo: Schema.optional(Schema.Literals(["available", "blocked"])),
  redoReason: Schema.optional(Schema.String),
});

/** D198: a folder the prompt named, as Uncut listed it for the agent ("Found 12 files in ~/x"), or why it didn't. */
export const AgentFolder = Schema.Struct({ path: Schema.String, files: Schema.Number, folders: Schema.Number, problem: Schema.optional(Schema.String) });
export type AgentFolder = typeof AgentFolder.Type;

export const AgentTurn = Schema.Struct({
  id: Schema.String,
  prompt: Schema.String,
  // What the prompt's @labels point at (D140), for the card's chips.
  mentions: Schema.optional(Schema.Array(Schema.Struct({ kind: AgentMentionKind, label: Schema.String }))),
  // The manual-edit note the agent got with this prompt (D6), shown on the card.
  note: Schema.optional(Schema.String),
  // Images attached to the prompt (D184): file names in the project's .cache/agent-images/.
  images: Schema.optional(Schema.Array(Schema.String)),
  // The model it was asked of (a composer choice, D184); absent = Claude Code's default.
  model: Schema.optional(Schema.String),
  // D198: the folders the prompt named, listed for the agent.
  folders: Schema.optional(Schema.Array(AgentFolder)),
  startedAt: Schema.String,
  finishedAt: Schema.optional(Schema.String),
  status: AgentTurnStatus,
  items: Schema.Array(AgentItem),
  edits: Schema.Array(AgentEdit),
  error: Schema.optional(Schema.String),
  seconds: Schema.optional(Schema.Number),
  undoneAt: Schema.optional(Schema.String),
  undo: AgentUndo,
  // Estimated spend on API keys in this turn, US dollars (D9, D99): generators billed to the user's keys.
  spend: Schema.optional(Schema.Number),
  // D206: graphics files the agent wrote in this turn (graphics/<name>), so only its own are ever cleaned up.
  graphics: Schema.optional(Schema.Array(Schema.String)),
  // D206: the turn-end clean-up: unused graphics moved to .cache/trash/<turn>/ and empty tracks the
  // agent made removed (an edit of the turn). restored: the user put the graphics back.
  cleanup: Schema.optional(
    Schema.Struct({ graphics: Schema.Array(Schema.String), tracks: Schema.Array(Schema.String), restored: Schema.optional(Schema.Boolean) }),
  ),
  // "compact": the user's /compact (the Compact action), Claude Code's own compaction of the conversation, not a message to the agent.
  kind: Schema.optional(Schema.Literals(["compact"])),
  // Claude Code compacted the conversation in this turn (its compact_boundary): manual (/compact) or auto, and the tokens before and after.
  compacted: Schema.optional(Schema.Struct({ trigger: Schema.String, before: Schema.optional(Schema.Number), after: Schema.optional(Schema.Number) })),
  // Redo turn: when the user put an undone turn's edits back.
  redoneAt: Schema.optional(Schema.String),
});
export type AgentTurn = typeof AgentTurn.Type;

/** The editor panels the agent's ui_show can open (D65): the library rail's tabs and the side tabs. */
export const AGENT_UI_PANELS = ["media", "text", "elements", "audio", "inspector", "agent", "checks"] as const;
export const AgentUiPanel = Schema.Literals(AGENT_UI_PANELS);
export type AgentUiPanel = typeof AgentUiPanel.Type;

/**
 * The agent's latest ui_show (D65): move the playhead, select an item, open a panel. Each request
 * has a new id; the renderer applies a request once, when its id is new to it.
 */
export const AgentUi = Schema.Struct({
  id: Schema.String,
  // The project revision it was made against: applied once the renderer has that snapshot, so a
  // frame isn't clamped to an older, shorter project.
  revision: Schema.Number,
  frame: Schema.optional(Schema.Number),
  select: Schema.optional(Schema.String),
  panel: Schema.optional(AgentUiPanel),
});
export type AgentUi = typeof AgentUi.Type;

/**
 * Something the running turn waits on the user for (D99): a generation billed to their key over
 * $1. Allow or Don't (agent.approve); unanswered in about 2 minutes, or the turn stopped, is no.
 * A permission card waits until the user answers or the turn stops.
 */
export const AgentApproval = Schema.Struct({
  id: Schema.String,
  turnId: Schema.String,
  // "Generate a 4 s Veo video, about $1.60 on your Google key"
  text: Schema.String,
  estimate: Schema.Number,
  // ISO time it stops waiting; absent: it waits for the user.
  until: Schema.optional(Schema.String),
  // D144: a screen recording the agent asks for (screen_record): the card picks the screen or
  // window (the agent's `source` preselected by name), Record or Don't. The renderer records and
  // answers with agent.screenTake. Absent: a spend card (D99).
  screen: Schema.optional(Schema.Struct({ source: Schema.optional(Schema.String), seconds: Schema.Number, withMic: Schema.Boolean })),
  // D184: a big change asked for in "Ask first": what it would do, in words.
  edit: Schema.optional(Schema.Struct({ lines: Schema.Array(Schema.String) })),
  // D187: a question (ask_user): answered with agent.approve's answer; Skip is allow false.
  question: Schema.optional(AgentQuestion),
  // D188: a storyboard to approve before the build: Approve (maybe with edited beats) or Change (a note).
  storyboard: Schema.optional(Storyboard),
  // D198: the agent wants to change a kit's colours or fonts (brand_write): each field before and
  // after. Apply (allow) or Keep the kit (deny); no answer in 2 minutes keeps it.
  brand: Schema.optional(
    Schema.Struct({
      kit: Schema.String,
      changes: Schema.Array(Schema.Struct({ field: Schema.String, before: Schema.Array(Schema.String), after: Schema.Array(Schema.String) })),
    }),
  ),
  // D194: a Claude Code tool asks (Bash, a file write, ...): the tool, what it would run or touch, why
  // it asks, and whether "Always for this session" is offered. Allow once, Always (agent.approve
  // always: true) or Deny.
  permission: Schema.optional(Schema.Struct({ tool: Schema.String, target: Schema.String, why: Schema.optional(Schema.String), always: Schema.Boolean })),
  // D204: the agent asks to boot a simulator or emulator (argent_boot): its name, platform and kind
  // ("iOS simulator", "Android emulator"), the app it would open next. Boot (allow) or Don't.
  boot: Schema.optional(
    Schema.Struct({ device: Schema.String, name: Schema.String, platform: Schema.String, kind: Schema.String, bundleId: Schema.optional(Schema.String) }),
  ),
});
export type AgentApproval = typeof AgentApproval.Type;

/**
 * D261 (issue #93): how full the agent's context window is after its last answer, in tokens.
 * used and window are what claude reported (its last API call's input, cache read, cache creation
 * and output; modelUsage's contextWindow, else the model id's); systemTools and message are
 * estimates (Uncut's prompt and tools at ~4 and ~2.4 characters a token, plus about 20k for Claude
 * Code's own), conversation the rest.
 */
export const AgentContext = Schema.Struct({
  used: Schema.Number,
  // D269 (#101): absent until known (the model's "[1m]", or the result's modelUsage): never guessed.
  window: Schema.optional(Schema.Number),
  systemTools: Schema.Number,
  conversation: Schema.Number,
  message: Schema.Number,
  model: Schema.optional(Schema.String),
  // The last call's split (cached tokens fill the window like fresh ones, at about a tenth of the
  // price to read) and where Claude Code compacts the conversation on its own (get_context_usage).
  fresh: Schema.optional(Schema.Number),
  cacheRead: Schema.optional(Schema.Number),
  cacheWrite: Schema.optional(Schema.Number),
  output: Schema.optional(Schema.Number),
  compactAt: Schema.optional(Schema.Number),
});
export type AgentContext = typeof AgentContext.Type;

/** The open project's agent: its turns (oldest first) and the one running, if any. */
export const AgentState = Schema.Struct({
  dir: Schema.String,
  provider: Schema.String,
  running: Schema.NullOr(Schema.String),
  turns: Schema.Array(AgentTurn),
  ui: Schema.optional(AgentUi),
  approval: Schema.optional(AgentApproval),
  // D144: the screen_record card id whose take the server waits for; gone (turn stopped, project
  // closed, timed out) means the renderer cancels that take.
  screenTake: Schema.optional(Schema.String),
  // D188: the project's brief, storyboard and reviews (U15, U16).
  plan: Schema.optional(AgentPlan),
  // D194: something wrong with the agent's setup the user should know (claude didn't answer initialize).
  warning: Schema.optional(Schema.String),
  // D261: the context window's use after the last answer (absent until claude reported one).
  context: Schema.optional(AgentContext),
  // D295: when the current chat started (New chat); turns before it belong to earlier chats.
  threadStart: Schema.optional(Schema.String),
});
export type AgentState = typeof AgentState.Type;

export class AgentError extends Schema.TaggedError<AgentError>()("AgentError", {
  reason: Schema.Literals(["no-project", "busy", "not-installed", "unknown-turn", "failed"]),
  message: Schema.String,
}) {}
