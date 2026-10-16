# Uncut

An AI-first video editor for macOS: it runs your installed Claude Code, which edits with you on a real timeline.

![Uncut editing a launch film: the title "Ship it." over a mountain sunset in the preview, landscape clips in the media panel, a timeline with text, graphics, five clips with transitions and music, and the agent's brief, approved storyboard and passed review](docs/hero.png)

## What it does

- **An agent that plans before it cuts.** It writes a brief and a storyboard for you to approve, builds the edit, then an independent critic reviews it. Every turn is one undoable step.
- **A real timeline.** Tracks, trims, splits, snapping, keyframes, a mixer with ducking, keyboard-first editing.
- **Effects, looks and transitions.** Filters, colour looks, text animations and animated components like terminals, device frames and end cards.
- **Captions and subtitles.** Local transcription with whisper.cpp, burned-in or word-by-word captions, SRT and WebVTT in and out.
- **Capture.** Record iOS simulators, Android emulators, web and desktop apps through [Argent](https://www.npmjs.com/package/@swmansion/argent), or your screen, camera and mic.
- **Plugins.** Looks, components, checks and agent tools in a folder, with a catalog in [`plugins/catalog`](plugins/catalog).

Everything runs on your Mac. The agent runs your installed Claude Code with whatever sign-in it uses (a Claude account, an API key or a cloud provider), billed to you as Claude Code usage normally is. Uncut is not made by or affiliated with Anthropic.

## Install

No signed builds yet, so build from source. You need an Apple Silicon Mac, Node 24, pnpm (through corepack), Rust and ffmpeg (`brew install ffmpeg`). For the agent, install and sign in to [Claude Code](https://claude.com/claude-code) (any sign-in it supports); for transcription, `brew install whisper-cpp`.

```sh
git clone https://github.com/blazejkustra/uncut
cd uncut
corepack enable
pnpm install
```

## Run

```sh
pnpm dev     # builds the media core, server and shell, opens the app
pnpm dist    # an ad-hoc signed .app and dmg in dist/
```

## Tests

```sh
pnpm test:fast   # typecheck and everything but the packaged-app tests
pnpm test:app    # the packaged-app tests (run pnpm dist first)
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

- **The agent.** Uncut runs your own Claude Code, which sends Anthropic what the agent works with: your prompts, frames from your video, transcripts, file and project names, under your Claude Code account and Anthropic's terms.
- **Generators.** Image, video and voice generators send your prompts (and any image you give them) to OpenAI, Google or ElevenLabs with your own API keys, under their terms.
- **Sound search.** Searching for sounds online sends the search words to Openverse, or to Freesound with your key.
- **Downloads.** The speech model comes from Hugging Face; updates are checked for and downloaded from GitHub, which sees your IP address and the app version.

## Contributing

Bug reports, fixes and plugins are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Licence

MIT, see [LICENSE](LICENSE). Bundled fonts, sound effects, icons and packages, with their licences, are listed in [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES).
