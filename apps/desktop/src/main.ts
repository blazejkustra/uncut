// The desktop entry (package.json "main"), in one of the modes of the same Electron binary:
// - the app (app.ts): the window, the menu and the server it starts;
// - the export rasteriser (render.ts), started by the server with --uncut-render (D55): an
//   offscreen Chromium that turns text and backgrounds into PNGs with the preview's HTML (D39);
// - the offline voice's runner (speech.ts), started by the Reverb plugin with --uncut-speech.
// A packaged Electron binary always runs this file whatever its arguments, so the rasteriser is a
// mode of it rather than a script of its own (the voice runner too). The choice is made before anything else runs: the
// app's single-instance lock would make a second process quit at once.
// esbuild bundles each module lazily, so only the chosen one's top-level code runs.
if (process.argv.includes("--uncut-render")) require("./render.ts");
else if (process.argv.includes("--uncut-speech")) require("./speech.ts");
else require("./app.ts");
