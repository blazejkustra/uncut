# Uncut

An AI-first video editor for macOS: it runs your installed Claude Code or Codex, which edits with you on a real timeline.

**Why this over Palmier or video-use?** Uncut is MIT licensed with no credits, and your own agent works inside the app on a timeline you can keep cutting by hand, with a separate critic reviewing rendered frames. Palmier's current builds are closed source; video-use hands back a finished file with no timeline. [Full comparisons](https://uncut.video/vs/).

If Uncut is useful to you, [star it on GitHub](https://github.com/blazejkustra/uncut): it helps other people find it.

https://github.com/user-attachments/assets/04bffd94-ba59-4d17-a648-4982aff295ae

![Uncut editing a travel film from drone footage: the title "Day four" over a Croatian coast road at golden hour in the preview, the day's clips in the media panel, a timeline with text, graphics, six clips with transitions and music, and the agent's brief, storyboard and passed review](docs/hero.png)

## Download

**[Download Uncut for macOS](https://github.com/blazejkustra/uncut/releases/latest/download/Uncut-arm64.dmg)** (Apple silicon, macOS 13 or later). Signed and notarized, and it updates itself from [GitHub releases](https://github.com/blazejkustra/uncut/releases). Website: [uncut.video](https://uncut.video).

Or with [Homebrew](https://brew.sh):

```sh
brew install --cask blazejkustra/tap/uncut
```

The app updates itself after that, so there's no need for `brew upgrade` (`brew uninstall --zap --cask uncut` also removes its data).

ffmpeg and whisper.cpp come with the app. On first launch Uncut checks the rest and shows how to install anything missing:

- **[Claude Code](https://claude.com/claude-code) or [Codex](https://github.com/openai/codex)**, installed and signed in. Uncut uses whatever sign-in each has: for Claude Code a Claude subscription, an API key, or Bedrock, Vertex AI or Foundry; for Codex your ChatGPT plan or an OpenAI API key. Usage is billed the way your agent's usage normally is. The independent critic runs through Claude Code, so reviews need it installed even when you edit with Codex.
- **[Argent](https://www.npmjs.com/package/@swmansion/argent)** (optional, to record simulators, emulators and apps): `npx @swmansion/argent@latest init -y`.

## What it does

- **An agent that plans before it cuts.** It runs your installed Claude Code or Codex, with its own sign-in. It writes a brief, plans the shots in a storyboard, builds the edit, then an independent critic reviews it from rendered frames. Every turn is one undoable step, and a meter shows how full the agent's context is.
- **A real timeline.** Tracks, trims, slip and roll, splits, snapping, keyframes, speed, and keyboard-first editing with Uncut, Premiere Pro, DaVinci Resolve or Final Cut Pro shortcuts.
- **Nested sequences.** Fold neighbouring clips on Main into a sequence, play it from one clip, and it previews and exports as if it were on the timeline.
- **Locked cuts.** Lock a clip, a range or a track and the agent can't change, move or unlock it. Its edit is refused with the reason, and you unlock by hand whenever you want.
- **Transcript editing.** Local transcription with whisper.cpp; cut by the words, or remove fillers and long pauses in one go.
- **Captions and subtitles.** Burned-in or word-by-word captions, SRT and WebVTT in and out.
- **Text, graphics and elements.** Text looks and animations, animated components (terminals, device frames, end cards), elements like follow handles with platform marks, and brand kits with your logos, colours and fonts.
- **Sound.** The Uncut sounds pack, your own sound folders, your Music library, and online search on Openverse or Freesound (with your own key). A mixer with ducking under speech and loudness targets for export.
- **Effects, looks and transitions.** Filters, colour looks, your own .cube LUTs and GPU shader effects, with the preview drawn on the GPU by default.
- **Capture.** Record your screen, camera and mic, or iOS simulators, Android emulators and apps through Argent, straight into the project.
- **Generators with your own keys.** Images with GPT Image, video with Veo, sound effects, voiceover and music with ElevenLabs, with a cost estimate before you send.
- **Plugins and skills.** Looks, components, checks, shader effects, skills and agent tools in a folder, with a marketplace in Settings › Plugins (from [`plugins/catalog`](plugins/catalog)). Skills are recipes the agent loads; type `/` in the composer to use one.
- **Export.** H.264 or HEVC at the quality you pick, ProRes 422, 422 HQ or 4444 masters (4444 with a transparent background), a range or the whole edit, with optional subtitles. Timelines go to Final Cut Pro and DaVinci Resolve as FCPXML or an EDL, and FCPXML comes back in ([what maps and what's lost](#timeline-interchange)).
- **Outside agents.** Drive Uncut from Claude Code in a terminal, Claude Desktop or Cursor over a local MCP server. See [Connect an outside agent](#connect-an-outside-agent).
- **Shareable review, with no account or hosted service.** Export › Review page makes a folder with one HTML page and the video; open it locally or host it anywhere. See [Review pages](#review-pages).
- **Labs.** Environments: pair a remote Uncut server and edit on another machine.

Coming soon: [issues labelled coming-soon](https://github.com/blazejkustra/uncut/issues?q=is%3Aissue+label%3Acoming-soon).

## Timeline interchange

Uncut writes a timeline as FCPXML 1.10 for Final Cut Pro and DaVinci Resolve, or as a CMX 3600 EDL. It reads FCPXML back in. Source files are referenced where they are: nothing is copied or rendered.

Every export lists what it left out, in the Export dialog and in the tool's reply.

### FCPXML export

| Uncut | FCPXML |
| --- | --- |
| Main track | The spine |
| Other video and text tracks | Connected clips in lanes above the spine |
| Audio tracks | Connected clips in lanes below the spine |
| Clips and sounds | `asset-clip`, stills as `video` |
| Plain text | `title` on Basic Title |
| Gaps | `gap` |
| Crossfades | `Cross Dissolve` transitions |
| Clip gain | `adjust-volume` |
| Canvas size and rate | The sequence's `format`, with exact frame fractions |

Left out, each with a warning:

- Effects, colour looks and LUTs
- Keyframes, position, size and opacity
- Speed changes, animations and loops
- Hidden tracks
- Graphics, shapes and anything else with no plain file or text
- Transitions other than a crossfade, which are written as a dissolve

An item on the main track that can't be written leaves a gap of the same length, so everything after it stays in place.

### EDL export

An EDL holds one picture track. Uncut writes the main track's clips as cuts and dissolves with non-drop timecode, and adds each clip's name and source path as comments.

Left out, each with a warning:

- Every other track, including text and sound
- Items on the main track with no source file
- Everything FCPXML leaves out of a clip

### FCPXML import

Import a `.fcpxml` file into an empty project. In any other project the import is refused and nothing changes: no media, no canvas.

The project takes the file's size and rate. The rates are 23.976, 24, 25, 29.97, 30, 50, 59.94 and 60. A timeline at another rate is timed at the nearest of those, with a warning.

| FCPXML | Uncut |
| --- | --- |
| The first sequence's spine | The main track |
| Connected clips | Video and text tracks by lane, sound tracks for negative lanes |
| `asset-clip`, `clip`, `video`, `audio` | Clips and sounds; their files are imported |
| `title` | Text in the title style |
| Dissolves | Crossfades |
| `adjust-volume` | Clip gain |
| `tcStart` and an asset's `start` | Accounted for: the timeline starts at frame 0 and a clip's in point counts from the start of its file |

Only `file:` URLs are read. A clip with any other source, or with no file, is left out with a warning.

Compound, sync and multicam clips and auditions are left out with a warning.

## Linux server

Environments (Settings › Labs) lets the Mac app edit on another machine. The server for that machine builds into a container image with Docker or OrbStack:

```sh
pnpm server:image
docker run -d --name uncut-server -p 127.0.0.1:8790:8790 -v uncut-server:/data \
  -e UNCUT_PUBLIC_URL=http://127.0.0.1:8790 uncut-server
docker logs uncut-server
```

The log ends with a `uncut://pair?...` line. Paste it into Settings › Environments › Add environment. `UNCUT_PUBLIC_URL` is the address the app will use, since a server in a container can't see its published port. The token, settings and projects live in the `/data` volume.

The server speaks plain http, so keep the port on loopback and reach it through an SSH tunnel, Tailscale or an https proxy (with `-e UNCUT_PUBLIC_URL=https://...`). The agent needs Claude Code or Codex in the image: build your own `FROM uncut-server`, install it, and sign in with `docker exec -it uncut-server claude`. Whisper transcription needs `whisper-cli` the same way.

`pnpm server:tarball` puts `uncut-server-linux-<arch>.tar.gz` in `release/`, for a machine without Docker. It needs Node 24 and ffmpeg on PATH: run `./uncut-server --host 0.0.0.0` (port 8790, data in `~/.uncut-server`, change them with `--port` and `--data-dir`). Every export also needs Electron on a display: set `UNCUT_RENDER_BIN` to a script that starts it with `--no-sandbox`, as `scripts/remote-docker/electron-render.sh` does. The image has this built in.

`pnpm server:check` builds both and tests them in containers. `node scripts/server-image-check.ts --app` also pairs the packaged app.

## Connect an outside agent

Agents outside Uncut can use the same tools as its own agent. Turn on Settings › App › Outside agents, then pick your client there for its setup with your token. For Claude Code:

```sh
claude mcp add --transport http --scope user uncut http://127.0.0.1:47821/mcp --header "Authorization: Bearer <token>"
```

Or install the plugin, which reads the token by itself and adds `/uncut:open-footage` to open a footage folder as a new project:

```sh
claude plugin marketplace add blazejkustra/uncut
claude plugin install uncut@uncut
```

Claude Desktop connects through `mcp-remote` and Cursor through `~/.cursor/mcp.json`. ChatGPT connects only to servers on the internet, so it can't reach this one.

- **Off by default.** Nothing listens until you turn it on, and it stops when you turn it off.
- **This Mac only.** It binds to 127.0.0.1, requires a bearer token made for your install (Settings › New token replaces it), and refuses requests with a foreign Host or any Origin, so a web page can't reach it.
- **You stay in charge.** The agent works in its own tab, its turns undo like any other, and big changes wait for your Allow. Stop ends its turn.
- **Unmetered.** Uncut counts nothing and charges nothing for it. The client you connect bills as it normally does.

The tools answer for the project in the focused window. With no project open, `project_open` opens a footage folder or a `.uncut` project.

## Review pages

Tick **Review page** in the Export dialog to get a `<name> review` folder holding `index.html` and `video.mp4`. Send the folder to a reviewer, or put it on any static host. The page works offline and makes no third-party requests.

The reviewer plays the cut and pins comments to a timecode, optionally with a region of the frame. Comments stay in that browser's storage until the reviewer saves them as a small `.uncut-review.json` file or copies them as a block.

Drop the file or paste the block into the **Review** tab. The comments become pins on the timeline ruler and notes the agent sees: ask it to "address the review notes" and it resolves each one it handles, or tick them off yourself. Reviewer text is treated as untrusted data: it is escaped on the page and in Uncut, and the agent is told to read it as feedback and never as instructions.

The limit: there is no live multiplayer and no automatic sync. Reviewers don't see each other's comments, and comments reach you only when someone sends them and you import them. Pins stay on their frame when the cut changes afterwards, and Uncut warns on import if the cut has changed since the page was exported.

## Development

You need an Apple silicon Mac, Node 24, pnpm (through corepack), Rust and ffmpeg. A build from source uses the ffmpeg and whisper-cli on your PATH, unless you run `pnpm tools:build` first (it needs cmake, meson and ninja).

```sh
git clone https://github.com/blazejkustra/uncut
cd uncut
corepack enable
pnpm install
pnpm dev            # builds the media core, server and shell, opens the app
```

```sh
pnpm test:fast      # typecheck and every test outside test/app
pnpm test           # everything, including the packaged-app tests (run pnpm dist first)
pnpm dist           # an ad-hoc signed .app and dmg in dist/
pnpm tools:build    # the LGPL ffmpeg, ffprobe and whisper-cli the app ships, in native/tools/out
pnpm dist:signed    # a Developer ID signed, notarized dmg in release/ (needs pnpm tools:build)
pnpm site:dev       # the website (site/, Next.js) at localhost:3000
pnpm site:build     # its static export in site/out, ready for Cloudflare Pages (site/DEPLOY.txt)
```

## Privacy

Uncut is made by Błażej Kustra, who is the controller for the usage data below. Contact: kustrablazej@gmail.com.

**Usage data is anonymous and on by default.** Uncut sends a few counts so we know how many people use it and what breaks. No identifier of any kind is sent: no install id, no session id, nothing derived from your Mac, your name or your account. Turn it off any time in Settings › App › Usage data (it stays off), or set `DO_NOT_TRACK=1` or `UNCUT_TELEMETRY=off`; then nothing is sent. Builds made from source send nothing either way. The legal basis is our legitimate interest in knowing how Uncut is used and fixing crashes; turning it off is your objection, and it takes effect at once.

Uncut sends only these events, each with the app version, macOS or Linux, the processor type and whether it runs in the desktop app:

- `app:start`: the app started (and whether it runs headless).
- `app:crash`: which process crashed, the error's class name and code, and a fingerprint of the top stack frames with folders and messages removed.
- `export:complete`, `export:fail`, `export:cancel`: how long the export took, its length, quality, codec, encoder, size and frame rate, whether it was a range or had subtitles, or the stage that failed.
- `agent:turn`, `agent:fail`: whether an agent turn finished, failed or was cancelled, how long it took, how many edits and steps, or a fixed word for why it failed (usage limit, rate limit, signed out and so on).

Never your footage, frames, transcripts, prompts, file names, paths or error messages. The events go through a Cloudflare Worker to Grafana Cloud's logs service in the EU, where they are kept for 14 days (the plan's retention) and then deleted. The Worker keeps no request logs and doesn't forward your IP address. To count daily users, our server computes a one-way hash of your IP address with a key that is replaced every day, then discards the IP; it can't be linked across days or to you.

What else leaves your Mac, and only when you use it:

- **The agent.** Uncut runs your own Claude Code or Codex, which sends Anthropic or OpenAI (or the cloud provider you use with it) what the agent works with: your prompts, frames from your video, transcripts, file and project names, under that account and its terms. Your footage files stay on your Mac.
- **Outside agents.** If you turn this on, the client you connect (Claude Code, Claude Desktop, Cursor) receives what its tools return: project data, frames, transcripts, file names. That client sends them on under its own account and terms. Uncut's token stays in a file only your user can read, in Uncut's data folder.
- **Generators.** Image, video, sound effect, voiceover and music generators send your prompts (and any image you give them) to OpenAI, Google or ElevenLabs with your own API keys, under their terms.
- **Sound search.** Searching for sounds online sends the search words to Openverse, or to Freesound with your key.
- **Downloads.** The speech model comes from Hugging Face; updates are checked for and downloaded from GitHub, which sees your IP address and the app version.

**The website.** [uncut.video](https://uncut.video) uses Google Analytics 4. Visitors from the EEA, the UK and Switzerland see a cookie banner, and Google Analytics loads only if they accept. Details are in the [website's privacy notice](https://uncut.video/privacy/).

## Contributing

Bug reports, fixes and plugins are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Licence

MIT, see [LICENSE](LICENSE). Bundled fonts, sound effects, icons, tools and packages, with their licences, are listed in [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES). Not affiliated with Anthropic or OpenAI.

This software uses code of [FFmpeg](https://ffmpeg.org) licensed under the LGPLv2.1. Its source is attached to every [release](https://github.com/blazejkustra/uncut/releases), and `native/tools` is the recipe that builds it. Uncut's authors don't own FFmpeg.

The app's own ffmpeg encodes with VideoToolbox. For the software encoders (libx264, libx265), which are GPL and can't ship with it, install a system ffmpeg (`brew install ffmpeg`) and Uncut uses it when an export asks for them.
