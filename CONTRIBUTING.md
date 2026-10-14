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

A catalog plugin is the quickest way to add a look, a component, a check or an agent tool:

```sh
pnpm plugin:new acme.promo --name "Acme promo"
# edit plugins/catalog/acme-promo/
pnpm plugin:check plugins/catalog/acme-promo
```

The template's comments explain the manifest and the code. Plugin code may import only `node:` built-ins, `@uncut/plugin-sdk` and its own files. Open a PR that touches only your plugin's folder; CI runs `plugin:check` and a maintainer reads the code.

## Code style

- TypeScript only, for code, scripts and tests.
- Match the code around you: naming, comments, error messages. There's no formatter, so read the neighbouring file first.
- Comments say why, not what. Messages users see are plain sentences that say what to do next.
- On-screen text never separates words with `·`, `•` or a lone `*`; use commas, line breaks or separate elements (`test/repo/ui-separators.test.ts` checks it).
- Add dependencies only for a good reason, then run `node scripts/notices.ts`.
- Nothing personal in the repo: no home paths, emails, keys or footage (`test/repo/launch-hygiene.test.ts` checks it).

## Pull requests

- One change per PR, with tests, and `pnpm test:fast` passing.
- Say what was broken, how you fixed it and what you checked, including what you didn't.
- Screenshots or a short recording for anything visible.

By contributing you agree that your work is released under the MIT licence (see LICENSE).
