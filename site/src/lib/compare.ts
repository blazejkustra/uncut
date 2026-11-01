// The comparison pages under /vs/ and the Claude Code guide. Bodies are Markdown. Every claim about
// a rival needs a link under Sources, and `checked` moves only when the page was checked again.
export type Article = {
  title: string;
  description: string;
  /** The day the facts were last checked against their sources (YYYY-MM-DD). */
  checked: string;
  body: string;
};

export type Comparison = Article & {
  slug: string;
  rival: string;
};

const UNCUT_BASICS = `Uncut is free under the [MIT licence](https://github.com/blazejkustra/uncut/blob/main/LICENSE) and runs on Apple silicon Macs with macOS 13 or later. It needs Claude Code or Codex installed and signed in, plus ffmpeg, and it has no Uncut account or quota. Its limits are real too: it is a young project on a 0.x version, with a small community.`;

const UNCUT_SOURCES = `- [Uncut README, including what leaves your Mac](https://github.com/blazejkustra/uncut#privacy)`;

export const COMPARISONS: ReadonlyArray<Comparison> = [
  {
    slug: "palmier",
    rival: "Palmier Pro",
    title: "Uncut vs Palmier Pro",
    description: "Two Mac video editors built for agents, compared on licence, price, agent setup and what each one does better.",
    checked: "2026-11-01",
    body: `Palmier Pro and Uncut are both Mac timeline editors that an agent can drive. Palmier is the more established product. Uncut is smaller, with its current source open and with no paid tier.

${UNCUT_BASICS}

| | Uncut | Palmier Pro |
| --- | --- | --- |
| Licence | MIT, current source public | GPLv3 through v0.7.6; later binaries are proprietary and their source is unpublished |
| Requires | Apple silicon, macOS 13 or later | Apple silicon, macOS 26 |
| App | Electron | Native Swift |
| Price | Free, you pay your agent's provider | Free; Pro $29 a month, Max $69 a month (discounted from $49 and $99) |
| Credits | None from Uncut; generators use your own keys | 5,000 a month on Pro, 12,000 on Max, for generation |
| Agent | Your Claude Code or Codex inside the app | Claude, Codex or Cursor over MCP, plus an in-app agent |
| External agents | No external MCP entry | Yes, local MCP server while the app is open |
| Review | A separate critic scores rendered frames | No equivalent described in its README |
| Interchange | SRT and WebVTT | Render or NLE XML export |

## Where Palmier Pro is better

- **Native Mac app.** It is written from scratch in Swift, while Uncut is an Electron app.
- **Generation inside the timeline.** Seedance, Kling and Nano Banana Pro are available from the editor on paid plans, with no keys to manage.
- **Any MCP agent.** Claude Code, Codex, Cursor and Claude Desktop can all connect. Uncut's agent runs only inside the app.
- **Handing off to other editors.** Its free plan lists NLE XML export. Uncut has no project interchange.
- **Footage search.** Its free plan lists local footage search. Uncut's media search covers metadata only.
- **Reach.** Its repo has about 14,700 stars, so far more people have tried it.

## Where Uncut is better

- **Current open source.** You can read, fork and build what you run. Palmier's newest releases ship without published source.
- **Older Macs.** Uncut runs from macOS 13, and Palmier needs macOS 26.
- **A built-in reviewer.** A separate agent process scores rendered frames, and any blocker sends the edit back, for up to three rounds in a turn.
- **Nothing to subscribe to.** Generation uses your own OpenAI, Google and ElevenLabs keys at their prices. This also means you set those keys up yourself.

## Which to pick

Pick Palmier Pro if you want a native app, generation with no key setup, or NLE export. Pick Uncut if you want an MIT codebase, run an older macOS, or want a critic in the loop.

## Sources

- [Palmier Pro repository and licence notice](https://github.com/palmier-io/palmier-pro)
- [Palmier pricing](https://www.palmier.io/pricing)
${UNCUT_SOURCES}`,
  },
  {
    slug: "video-use",
    rival: "video-use",
    title: "Uncut vs video-use",
    description: "An agent skill that returns a finished file, and a desktop editor with a timeline. What each one is good at.",
    checked: "2026-11-01",
    body: `video-use is a skill for coding agents: you point it at a folder of raw footage and get \`final.mp4\` back. Uncut is a desktop editor with the agent inside it. Both are MIT licensed and free, so the choice comes down to how you want to work.

${UNCUT_BASICS}

| | Uncut | video-use |
| --- | --- | --- |
| Form | Mac app with a timeline | Skill for an agent with shell access |
| Licence | MIT | MIT |
| Output | Editable project, then H.264 or HEVC export | \`edit/final.mp4\`, from an edit decision list |
| Agents | Claude Code or Codex | Claude Code, Codex, Hermes, Openclaw and others |
| Transcription | Local, whisper.cpp | ElevenLabs Scribe, with your key |
| Checking | Separate critic scores rendered frames | Self-evaluation at every cut, up to three fix passes |
| Hand edits | Yes, on the same timeline | No timeline in the project; you ask the agent |

## Where video-use is better

- **Nothing to install but a skill.** There is no app, so it fits a terminal, a server or a Telegram bot through Browser Use Box.
- **Any agent with a shell.** Uncut supports two.
- **Richer transcripts.** Scribe gives speaker labels and audio events such as laughter. Uncut has no speaker separation.
- **Animation overlays.** It can spawn HyperFrames, Remotion, Manim or PIL overlays in parallel sub-agents.
- **Session memory.** A \`project.md\` carries decisions into next week's session.
- **Reach.** Its repo has about 30,300 stars.

## Where Uncut is better

- **You can see and touch the edit.** The agent works on a live timeline, and you can trim, retime and mix by hand afterwards.
- **Undo by turn.** Each agent turn is one undoable step.
- **Local transcription.** No transcription key, and no audio sent for it.
- **Reviewing with a fresh pair of eyes.** The critic is a separate process with none of the builder's conversation.
- **Everything else an editor has.** Captions, a mixer with ducking, text looks, shader effects, screen and simulator capture.

## Which to pick

Pick video-use if a finished file from a chat or a server is all you want. Pick Uncut if you expect to look at the cut and change it yourself.

## Sources

- [video-use README](https://github.com/browser-use/video-use)
${UNCUT_SOURCES}`,
  },
  {
    slug: "descript",
    rival: "Descript",
    title: "Uncut vs Descript",
    description: "Descript's text-based editing and team features compared with Uncut, a free open-source Mac editor that runs your own agent.",
    checked: "2026-11-01",
    body: `Descript made editing video by editing text popular, and it is a mature product for teams. Uncut borrows the transcript idea, adds an agent you already pay for, and stays on your Mac.

${UNCUT_BASICS}

| | Uncut | Descript |
| --- | --- | --- |
| Licence | MIT | Proprietary |
| Price per person | Free, you pay your agent's provider | Free, then $24, $35 or $65 a month, or $16, $24 or $50 on annual billing |
| Included media | No Uncut limit | 1 hour on Free; 10, 30 or 40 hours a month on paid plans |
| AI credits | None from Uncut | 100 once on Free; 400, 800 or 1,500 a month on paid plans |
| Transcript editing | Yes, transcribed locally | Yes |
| AI agent | Your Claude Code or Codex | Underlord |
| Voice | ElevenLabs with your own key | Voice cloning and Regenerate Speech built in |
| Sharing | None | Links with comments on the video |

The media hours and credits above come from Descript's pricing page, which lists two unlabelled prices per plan. We read the lower one as annual billing because the page says annual saves up to 35%.

## Where Descript is better

- **Working with other people.** Send a link and get comments on the video. Uncut has no sharing.
- **Audio repair.** Studio Sound removes noise and enhances voices in one click.
- **Voice tools.** Cloning and regenerating speech are built in, with no separate account.
- **No setup.** No agent, ffmpeg or Homebrew to install first.
- **Maturity.** A long-established product with a large user base.

## Where Uncut is better

- **No metered hours.** Uncut counts nothing. Your agent's plan has its own limits.
- **Local files and transcription.** Footage files stay on your Mac. Frames, transcripts and prompts go to your agent's provider.
- **A real multi-track timeline with a critic.** The agent builds on it, and a separate process scores the frames it renders.
- **Open source.** MIT, with a plugin SDK for looks, checks, skills and agent tools.

## Which to pick

Pick Descript for team review, audio repair and a setup that needs no terminal. Pick Uncut if you work alone on a Mac and already use Claude Code or Codex.

## Sources

- [Descript pricing](https://www.descript.com/pricing)
- [Descript product page](https://www.descript.com/)
${UNCUT_SOURCES}`,
  },
  {
    slug: "capcut",
    rival: "CapCut",
    title: "Uncut vs CapCut",
    description: "CapCut's templates and free tools compared with Uncut, an open-source Mac editor where an agent cuts on a timeline.",
    checked: "2026-11-01",
    body: `CapCut is the default free editor for short social video, and these two serve different people. CapCut gives you templates and tools to drive by hand. Uncut gives you an agent that does the first pass on a timeline.

${UNCUT_BASICS}

| | Uncut | CapCut |
| --- | --- | --- |
| Licence | MIT | Proprietary |
| Platforms | Apple silicon Macs | Windows 7 or later, macOS 10.14 or later |
| Price | Free, you pay your agent's provider | Free tier and Pro; prices vary by region and device |
| Editing style | Prompt an agent, then edit by hand | By hand, with templates and AI tools |
| Captions | Local transcripts, burned-in or word by word, SRT and WebVTT | Automatic captions |
| Content terms | No licence to your content | Outside the EU and UK, a licence to content you submit, for operating, developing and providing the Services, subject to your Platform settings |

We could not find an official CapCut Pro price: it is set in the app.

CapCut's global terms, last updated April 15, 2026, give Bytedance Pte. Ltd. and its affiliates "a non-exclusive, royalty-free, transferable, sub-licensable, perpetual and worldwide license" to content you submit, "for the purposes of operating, developing and providing the Services, subject to your Platform settings" (section 10). The EU and UK supplement says the User-Generated Content paragraphs of section 10 "shall not apply". US users have separate terms with TikTok USDS Joint Venture LLC, of the same date. Their User-Generated Content section is wider: "an unconditional, non-exclusive, royalty-free, fully transferable, sub-licensable, perpetual and worldwide license" for that company, its affiliates, agents, service providers, partners and "other connected third parties", with the same purposes and settings wording. Read the terms for your region if you handle client work.

## Where CapCut is better

- **Templates and trends.** Its desktop app is sold on "rich tools and viral templates". Uncut has no template library of that kind.
- **Works everywhere you do.** It runs on Windows and much older Macs. Uncut needs Apple silicon.
- **No agent required.** There is nothing to sign in to and no agent plan to pay for.
- **Generation and search built in.** Its page lists AI video creation, script to video and search by objects, dialogue and people.
- **Scale.** A very large user base and plenty of tutorials.

## Where Uncut is better

- **An agent that edits.** Describe the film, then watch it build on a real timeline, with a critic reviewing the result.
- **Open source.** MIT licensed, so you can read and change the code.
- **Plain ownership.** Uncut takes no licence to your content, and your project is a folder on your Mac.
- **Keyboard-first editing.** Shortcut sets for Premiere Pro, DaVinci Resolve and Final Cut Pro.

## Which to pick

Pick CapCut for quick social edits by hand, for free. Pick Uncut if you want an agent doing the cutting on a Mac and you already have Claude Code or Codex.

## Sources

- [CapCut desktop editor](https://www.capcut.com/tools/desktop-video-editor)
- [CapCut terms of service](https://www.capcut.com/clause/terms-of-service)
- [CapCut US terms of service](https://sf19.tiktokcdn-us.com/obj/draft-ttp-tx/terms-policy/capcut_terms_of_service_en-US.html)
${UNCUT_SOURCES}`,
  },
  {
    slug: "kino",
    rival: "Kino",
    title: "Uncut vs Kino",
    description: "Kino is a team video platform with agents attached, and Uncut is a local open-source editor. What we tested, what comes from Kino's docs.",
    checked: "2026-10-31",
    body: `Kino is a much larger product than Uncut: a team media platform with search, review links and multiplayer. Uncut is a local editor for one person on a Mac.

**How far this comparison goes.** We installed Kino 1.5.69 on October 31, 2026 and did not create an account. Kino's app stops at sign-in, so we tested the download, the sign-in wall, the MCP server while signed out and two free browser tools. Everything else about Kino below is **from its docs and pricing page, and we have not run it**. We also wrote Uncut, so read this with that in mind.

${UNCUT_BASICS}

| | Uncut | Kino (from its docs unless marked) |
| --- | --- | --- |
| Licence | MIT | Proprietary |
| Platforms | Apple silicon Macs | macOS, Windows, Linux |
| Account | None (tested) | Required: the app opens on sign-in (tested) |
| Price | Free, you pay your agent's provider | Free; Pro $25 per editor per month ($20 billed yearly), plus usage; Enterprise custom |
| Metering | None from Uncut | Indexing 5 h a month on Free, 75 h on Pro; 100 MCP calls a week on Free |
| Storage | Your disk | 720p proxy of every clip in the cloud by default; originals stay on your drive unless uploaded |
| Agents | Claude Code or Codex in the app | Claude Code, Codex, Kino Agent, ChatGPT, Claude Desktop, Cursor, VS Code and cloud agents |
| Search | Project metadata only | Across a library by what is said or shown, and by person |
| Review | None | Links, frame comments, multiplayer timeline (review links on Pro) |
| Export | H.264, HEVC | H.264, HEVC, VP9, AV1, ProRes, including transparent ProRes 4444 |
| Project interchange | None | Imports from Resolve, Premiere, Final Cut, CapCut and After Effects (Beta) |

## Where Kino is better

All of this is from Kino's docs, apart from the skills, which ship in its app.

- **Finding a moment.** Search across hours of footage by speech, visuals or person. Uncut has no equivalent.
- **Client review.** Viewers comment on a frame in the browser with no account, and the agent can pick those comments up.
- **Teams.** A multiplayer timeline with cursors, seats and delivery links.
- **Reach.** Windows and Linux, plus agents that work in the cloud.
- **Pro formats.** BRAW, REDCODE, ProRes and DNx in, ProRes and alpha out.
- **Migration.** Import from other editors, though Kino labels this Beta.
- **Skills.** It ships 20 agent skills, which we read: the audio and reframing recipes are detailed and clearly drawn from real productions.

## Where Uncut is better

- **Start with no account.** Install it and work. Kino stops at sign-in (tested).
- **The work stays local by default.** Footage files stay on your Mac and nothing is uploaded to Uncut. Frames, transcripts and prompts go to your agent's provider. Kino's docs say proxies go to its cloud by default.
- **No meter.** Uncut has no indexing hours and no call limit. Your agent's plan has its own limits.
- **Open source.** MIT, with a plugin SDK. Kino's app is proprietary and its interface loads from kino.ai (tested, signed out).
- **A separate critic.** We found no equivalent stage in Kino's docs, though its skills do check their work with screenshots.
- **A typed project format.** Agent edits are typed operations on \`project.json\`. Kino projects are Remotion code, which gives its agent more freedom for motion graphics and more room for fragile patches, as its own skills note.

## Which to pick

Pick Kino if a team shares a large footage library or clients review your work. Pick Uncut if you edit alone on a Mac and want your project, your agent and your bill under your control.

## Sources

- [Kino pricing](https://kino.ai/pricing) (figures read from the rendered page on October 31, 2026)
- [Kino docs: teams and billing](https://kino.ai/docs/teams-and-billing)
- [Kino docs: storage](https://kino.ai/docs/storage)
- [Kino docs: working with agents](https://kino.ai/docs/working-with-agents)
- [Kino docs: pro media formats](https://kino.ai/docs/pro-media-formats)
- [Kino docs: import from other editors](https://kino.ai/docs/import-from-other-editors)
- [Kino docs: Kino for editors](https://kino.ai/docs/kino-for-editors)
- [Kino changelog](https://kino.ai/changelog)
${UNCUT_SOURCES}`,
  },
];

export const pathOf = (c: Comparison) => `/vs/${c.slug}/`;

export const GUIDE_PATH = "/guides/edit-video-with-claude-code/";

export const GUIDE: Article = {
  title: "Edit video with Claude Code",
  description: "The main ways to edit video with Claude Code today, how to do it in Uncut step by step, and where each approach falls short.",
  checked: "2026-11-01",
  body: `Claude Code can edit video if you give it a way to see the footage and change the cut. There are four common setups. They trade control against effort, so start from what you want at the end.

| Setup | You get | Good for |
| --- | --- | --- |
| A skill, such as [video-use](/vs/video-use/) | A rendered file | Talking heads and tutorials from a chat or a server |
| An MCP editor, such as [Palmier Pro](/vs/palmier/) or [Kino](/vs/kino/) | A timeline your agent reaches from outside | Keeping your agent in its own terminal |
| An editor with the agent inside, such as Uncut | A timeline and the agent in one window | Watching the cut and fixing it by hand |
| Code, with [Remotion](https://www.remotion.dev/) | A video written as React | Motion graphics with no camera footage |

## Edit with Claude Code in Uncut

1. **Install what it needs.** [Download Uncut](https://github.com/blazejkustra/uncut#download) for an Apple silicon Mac, install [Claude Code](https://claude.com/claude-code) and sign in, then run \`brew install ffmpeg\`. For transcripts, add \`brew install whisper-cpp\`. Uncut checks all of this on first launch.
2. **Start a project and add footage.** Drop your clips into the media panel. They stay where they are on your Mac.
3. **Say what you want.** Describe the film as you would to an editor: "Cut these takes into a 45 second launch film, keep the best delivery, add captions". Type \`/\` to pick a skill such as \`/talking-head\` or \`/launch-promo\`.
4. **Watch it plan and build.** The agent writes a brief and a storyboard, then edits the timeline while you watch. It can read transcripts, look at frames and rank takes.
5. **Let the critic look.** A separate process with none of the conversation scores rendered frames. Blockers send the edit back, for up to three rounds in a turn.
6. **Take over.** Undo the whole turn, ask for a change with \`@\` pointing at a clip, or trim by hand on the same timeline.
7. **Export.** H.264 or HEVC, the whole edit or a range, with optional subtitles.

## What it costs and what leaves your Mac

Uncut is free and has no account. The agent's work counts against your Claude plan or API usage, and a review round uses more of it. Your footage files stay on your Mac, while your prompts, transcripts and frames go to Anthropic, or to the cloud provider you use with Claude Code. If you use generators, your prompts go to those services with your own keys.

## Where this falls short

- The agent sees sampled frames. It can miss what happens between them, so watch the result yourself.
- A passed review means a separate model found no blockers. Taste is still yours.
- Long projects fill the agent's context. Uncut shows a meter, and it helps to work in short turns.
- Uncut is Mac only, and it exports H.264 and HEVC, with no ProRes or project interchange yet.

Codex works in Uncut as well. The critic still runs through Claude Code, so keep that installed if you want reviews.

## Sources

- [Claude Code docs](https://code.claude.com/docs)
- [video-use](https://github.com/browser-use/video-use)
- [Remotion](https://www.remotion.dev/)
- [Uncut README](https://github.com/blazejkustra/uncut)`,
};
