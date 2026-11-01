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

On first launch Uncut checks what it needs and shows how to install anything missing:

- **[Claude Code](https://claude.com/claude-code) or [Codex](https://github.com/openai/codex)**, installed and signed in. Uncut uses whatever sign-in each has: for Claude Code a Claude subscription, an API key, or Bedrock, Vertex AI or Foundry; for Codex your ChatGPT plan or an OpenAI API key. Usage is billed the way your agent's usage normally is. The independent critic runs through Claude Code, so reviews need it installed even when you edit with Codex.
- **ffmpeg**: `brew install ffmpeg`.
- **whisper.cpp** (optional, for transcripts): `brew install whisper-cpp`.
- **[Argent](https://www.npmjs.com/package/@swmansion/argent)** (optional, to record simulators, emulators and apps): `npx @swmansion/argent@latest init -y`.

## What it does

- **An agent that plans before it cuts.** It runs your installed Claude Code or Codex, with its own sign-in. It writes a brief, plans the shots in a storyboard, builds the edit, then an independent critic reviews it from rendered frames. Every turn is one undoable step, and a meter shows how full the agent's context is.
- **A real timeline.** Tracks, trims, splits, snapping, keyframes, speed, and keyboard-first editing with Uncut, Premiere Pro, DaVinci Resolve or Final Cut Pro shortcuts.
- **Transcript editing.** Local transcription with whisper.cpp; cut by the words, or remove fillers and long pauses in one go.
- **Captions and subtitles.** Burned-in or word-by-word captions, SRT and WebVTT in and out.
- **Text, graphics and elements.** Text looks and animations, animated components (terminals, device frames, end cards), elements like follow handles with platform marks, and brand kits with your logos, colours and fonts.
- **Sound.** The Uncut sounds pack, your own sound folders, your Music library, and online search on Openverse or Freesound (with your own key). A mixer with ducking under speech and loudness targets for export.
- **Effects, looks and transitions.** Filters, colour looks and GPU shader effects, with the preview drawn on the GPU by default.
- **Capture.** Record your screen, camera and mic, or iOS simulators, Android emulators and apps through Argent, straight into the project.
- **Generators with your own keys.** Images with GPT Image, video with Veo, sound effects, voiceover and music with ElevenLabs, with a cost estimate before you send.
- **Plugins and skills.** Looks, components, checks, shader effects, skills and agent tools in a folder, with a marketplace in Settings › Plugins (from [`plugins/catalog`](plugins/catalog)). Skills are recipes the agent loads; type `/` in the composer to use one.
- **Export.** H.264 or HEVC at the quality you pick, a range or the whole edit, with optional subtitles.
- **Labs.** Environments: pair a remote Uncut server and edit on another machine.

Coming soon: [issues labelled coming-soon](https://github.com/blazejkustra/uncut/issues?q=is%3Aissue+label%3Acoming-soon).

## Development

You need an Apple silicon Mac, Node 24, pnpm (through corepack), Rust and ffmpeg.

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
pnpm dist:signed    # a Developer ID signed, notarized dmg in release/
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
- **Generators.** Image, video, sound effect, voiceover and music generators send your prompts (and any image you give them) to OpenAI, Google or ElevenLabs with your own API keys, under their terms.
- **Sound search.** Searching for sounds online sends the search words to Openverse, or to Freesound with your key.
- **Downloads.** The speech model comes from Hugging Face; updates are checked for and downloaded from GitHub, which sees your IP address and the app version.

**The website.** [uncut.video](https://uncut.video) uses Google Analytics 4. Visitors from the EEA, the UK and Switzerland see a cookie banner, and Google Analytics loads only if they accept. Details are in the [website's privacy notice](https://uncut.video/privacy/).

## Contributing

Bug reports, fixes and plugins are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Licence

MIT, see [LICENSE](LICENSE). Bundled fonts, sound effects, icons and packages, with their licences, are listed in [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES). Not affiliated with Anthropic or OpenAI.
