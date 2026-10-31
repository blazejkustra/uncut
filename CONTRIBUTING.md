# Contributing to Uncut

Thanks for helping. Bug reports, fixes and plugins are all welcome. For anything bigger than a fix, open an issue first so we can agree on the shape.

## Dev loop

You need an Apple Silicon Mac, Node 24, pnpm (through corepack), Rust and ffmpeg. For the agent, Claude Code signed in; for transcription, `brew install whisper-cpp`.

```sh
corepack enable
pnpm install
pnpm dev
```

Editor changes hot-reload. Server and desktop changes need a restart: close the window and run `pnpm dev` again.

## Tests

Tests use Node's built-in runner, live in `test/<area>/*.test.ts` and run as TypeScript on Node 24, so only erasable syntax (no enums, namespaces or parameter properties).

- `pnpm test:fast`: typecheck plus every test outside `test/app`. Run it while you work and before a PR (it needs `pnpm build` once).
- `pnpm test:file test/core/captions.test.ts`: one file.
- `pnpm test:app`: the packaged-app tests. They need `pnpm dist`, launch the real app and are slow, so run only the files your change touches; CI runs all of them.

New behaviour comes with a test. A visible change comes with a look at it in the app.

## Plugins

This is the plugin creation guide. Uncut shows the same text in Settings › Plugins › Make a plugin (it comes from `apps/web/src/settings/plugins/guide.ts`; `node apps/web/src/settings/plugins/guide.ts` prints this section).

### What a plugin is

A plugin is one folder with an `uncut.module.json` manifest. It adds things to Uncut (text looks, components, checks, filters, shader effects, skills) and can give the agent tools of its own.

- A data plugin (`"runtime": {"type": "data"}`) runs nothing: Uncut reads its manifest. Its folder is the manifest plus the `.ts` sources of its shader effects.
- A process plugin (`"runtime": {"type": "process"}`) is a program Uncut starts on the first call to one of its tools: a small MCP server over stdio, written in TypeScript with `@uncut/plugin-sdk`. It runs on Uncut's own Node, so there's no package.json, node_modules or build step.
- Nothing a plugin adds shows, and none of its tools run, until the user allows it. The approval dialog says where it came from, what it adds and what it asks for.

Community plugins live in this repo, in `plugins/catalog/<id with dots as dashes>/`. Uncut's Settings › Plugins lists them as a marketplace. `plugins/bundled.json` names the few that ship installed and allowed; every other plugin is install-only.

### Start from the example

The quickest start is a copy of the Example kit (`plugins/catalog/uncut-example-kit`), a data plugin with a text look, a component, a skill and a shader effect. Its `effect.ts` header walks through the manifest field by field.

```sh
pnpm plugin:new acme.promo-kit --from uncut.example-kit
# or a process plugin with one agent tool:      pnpm plugin:new acme.promo-kit
# or a shader effect plugin:                    pnpm plugin:new acme.promo-kit --shader
pnpm plugin:check plugins/catalog/acme-promo-kit
```

Pick an id that says who you are and what it is: lowercase letters, digits and dashes in two or more parts (`acme.promo-kit`). The folder is the id with dots as dashes, every contribution id starts with it (`acme.promo-kit.headline`) and tool names start with it too (`acme_promo_kit_word_count`). `plugin:new` puts yours in everywhere and renames the example's skills so they don't clash.

### The manifest

`uncut.module.json` follows `spec/schema/module.schema.json`. The fields a plugin uses:

| | |
| --- | --- |
| manifest, apiVersion | Always `"uncut.module/0"` and `"uncut.module/1"`, the frozen plugin API. |
| id | `<you>.<what>`, unique in the repo. The folder is named after it. |
| kind | `pack` for a plugin that adds data; a process plugin uses what it is: `capture-source`, `analyzer`, `generator`, `effect`... |
| name, version, description | What the marketplace card shows. version is semver (`1.0.0`). |
| author, license | Who made it, and its licence (MIT, like Uncut, unless you have a reason). |
| runtime | `{"type": "data"}`, or `{"type": "process", "command": "node", "args": ["server.ts"], "timeoutSeconds": 120}`. One tool call may take timeoutSeconds (at most 1800). |
| capabilities | What it may touch, shown before the user allows it: `project:read`, `project:write`, `media:read`, `media:write`, `network`, `process:spawn`, `gpu`, `microphone`, `screen`, `api-key`. Ask only for what you use; a data plugin asks for none. |
| requires | A program it needs on PATH, with the command that installs it (`{"binary": "whisper-cli", "install": "brew install whisper-cpp"}`). |
| agentTools | A process plugin's tools for the agent: name, description (what the agent reads to decide) and inputSchema (a JSON Schema object). |
| contributes | What it adds: looks, components, rules, filters, shaders, skills (next section). At most 50 of each. |

### What a plugin can add

Every entry of `contributes` has an id `<plugin id>.<name>` (skills have a name instead). A project never depends on a plugin: what a user adds is copied into the project, so it keeps drawing after the plugin is removed.

| | |
| --- | --- |
| looks | Text looks in the Text tab and for the agent's insert_text: the built-in look block (size, weight, font, colour, align, x, y, w as fractions of the frame, background, stroke, shadow, animation). Example: Lower third in the Example kit. |
| components | Elements tiles: an HTML template with {{param}} placeholders and plain CSS, params as a JSON Schema with defaults. No script, event handlers or script URLs; CSS animates with `--t` (seconds) and `--progress`. Drawn in the graphics sandbox, the same in the preview and the export. Example: Callout badge. |
| rules | Checks in the Checks tab and the agent's project_check: `max-words`, `banned-phrases`, `min-text-size`, `end-card`, or `process` (Uncut calls the plugin's own `check` tool with the project). Each has a title, a severity (warn or info) and a hint. Example: plugins/catalog/taste-extra. |
| filters | Colour looks for the Effects tab: the numbers Uncut's colour maths draws (mixer, mono, adjust, curve, split toning, fade). |
| shaders | GPU effects for the Effects tab: a TypeGPU function in a `.ts` file, its params (number, color, bool) and the WGSL that `pnpm plugin:check --write` resolves from it. Example: Spotlight; more in plugins/catalog/typegpu-effects. |
| skills | Instructions the agent follows when they fit, in the shape of a SKILL.md: name (what the user types after /), title, description (what the agent reads to know when it fits) and instructions. Names are shared by every plugin, and Uncut's own can't be taken. Example: /example-kit-lower-thirds. |
| agent tools | A process plugin's agentTools: the agent sees them once the plugin is allowed and calls them like Uncut's own. Example: the template from `pnpm plugin:new`. |
| process plugins | Plugins that run a program for Uncut itself: plugins/argent-capture (kind capture-source, the Capture tab's devices and recordings) and plugins/whisper-transcribe (kind analyzer: Uncut calls its transcribe tool, the agent has no tool of its own). |

### The SDK (process plugins)

`@uncut/plugin-sdk` (packages/plugin-sdk/src/index.ts) is the whole contract: its types are the documentation. A server is a manifest and one handler per tool:

```ts
import { serve, text, ToolError, type ToolContext } from "@uncut/plugin-sdk";

serve({
  manifest: new URL("./uncut.module.json", import.meta.url),
  tools: {
    acme_promo_kit_word_count: async (args, { projectDir, signal, progress }: ToolContext) => {
      if (!projectDir) throw new ToolError("No project is open.");
      // read projectDir/project.json, do the work, report progress(1, 3) on long jobs
      return text("12 words", { words: 12 });
    },
  },
});
```

- `serve` answers initialize, ping and tools/list, dispatches tools/call, passes progress on, cancels a call when Uncut asks (its `signal` aborts) and exits when Uncut closes stdin.
- `ToolContext` gives `projectDir`, `captureDir` and `flowsDir` (by capability), `signal`, `progress(done, total, message)` and the raw `meta`.
- `text(body, structured?)`, `failure(body)` and `image(data, mimeType)` build answers; throw a `ToolError` to answer with an error the agent reads as is.
- A plugin returns data and never edits project.json. One declared exception: with `media:write`, a file written into captureDir and named in `structuredContent.uncut` (an UncutDeclaration) is imported, or replaces a clip's media.
- stdout carries only protocol messages; log to stderr. Code may import only `node:` built-ins, `@uncut/plugin-sdk` and its own `./files.ts`.

### Installing and allowing

- Install copies the folder into Uncut's plugins folder; it runs nothing. The approval dialog follows: source, id, version, tools, what it adds and what it asks for.
- A data plugin says it runs no program. A process plugin says it runs with the user's rights. A plugin with skills says the agent follows them without asking.
- The approval is for that folder, command, capabilities and skills' text: a change to any of them asks again.
- Disable stops allowing it (nothing of it shows or runs); Remove deletes the copy. Plugins that ship with Uncut are always allowed.

### Testing it

```sh
pnpm plugin:check --write plugins/catalog/acme-promo-kit   # fills in shader effects' wgsl
pnpm plugin:check plugins/catalog/acme-promo-kit           # the checks a pull request must pass
pnpm plugin:check                                          # every plugin in the repo
```

plugin:check validates the manifest against the schema and Uncut's own rules, checks that ids, contribution ids, skill names and tool names aren't taken, that looks, components and rules load without a warning, that the folder holds only top-level .json and .ts files (at most 40 files, 512 KB), what code imports, and resolves each shader with TypeGPU. `pnpm test:fast` runs the same gate (test/repo/plugins-folder.test.ts) on every plugin.

Then try it in Uncut: Settings › Plugins › Add from a folder or git, choose your folder, Allow, and use what it adds (the Text, Elements, Effects and Checks tabs, / in the composer for skills, or ask the agent to use a tool).

### Publishing to the catalog

- Open a pull request that adds only your folder under plugins/catalog/. CI runs plugin:check and a maintainer reads the code.
- Once merged, it's in the next Uncut's marketplace (Settings › Plugins), install-only.
- Whether a plugin ships installed is the maintainers' call: `plugins/bundled.json` lists those by id.
- To share a plugin outside the catalog, put the folder in a git repo: anyone can add it with Settings › Plugins › Add from a folder or git.


## Code style

- TypeScript only, for code, scripts and tests.
- Match the code around you: naming, comments, error messages.
- `pnpm format` formats the code (oxfmt) and `pnpm lint` lints it (oxlint); CI checks both. No source file goes over 1000 lines (`test/repo/file-size.test.ts`): split it into modules instead.
- Comments say why, not what. Messages users see are plain sentences that say what to do next.
- On-screen text never separates words with `·`, `•` or a lone `*`; use commas, line breaks or separate elements (`test/repo/ui-separators.test.ts` checks it).
- Add dependencies only for a good reason, then run `node scripts/notices.ts`.
- Nothing personal in the repo: no home paths, emails, keys or footage (`test/repo/launch-hygiene.test.ts` checks it).

## Pull requests

- One change per PR, with tests, and `pnpm test:fast` passing.
- Say what was broken, how you fixed it and what you checked, including what you didn't.
- Screenshots or a short recording for anything visible.

By contributing you agree that your work is released under the MIT licence (see LICENSE).
