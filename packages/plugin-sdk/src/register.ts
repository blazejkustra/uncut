// Makes `import ... from "@uncut/plugin-sdk"` work in any plugin Uncut starts with "node" (D102):
// the host passes `--import <this file>`, and the specifier resolves to the SDK shipped with this
// Uncut (Resources/plugin-sdk in the app, packages/plugin-sdk/src in the repo). A plugin needs no
// node_modules for it, wherever its folder is.
import { registerHooks } from "node:module";

const SDK = new URL("./index.ts", import.meta.url).href;

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "@uncut/plugin-sdk") return { url: SDK, shortCircuit: true };
    return next(specifier, context);
  },
});
