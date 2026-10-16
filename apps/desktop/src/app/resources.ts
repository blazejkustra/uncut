// Where the server, media binary, modules, music, fonts and plugins are: in the app bundle or the repo.
import * as path from "node:path";
import { app } from "electron";

// __dirname is apps/desktop/dist in dev and app.asar/dist when packaged.
const repoRoot = path.resolve(__dirname, "../../..");
export const resources = app.isPackaged
  ? {
      serverEntry: path.join(process.resourcesPath, "server", "server.mjs"),
      mediaBin: path.join(process.resourcesPath, "bin", "uncut-media"),
      modulesDir: path.join(process.resourcesPath, "modules", "builtin"),
      sfxDir: path.join(process.resourcesPath, "sfx"),
      graphicLibsDir: path.join(process.resourcesPath, "graphic-libs"),
      fontsDir: path.join(process.resourcesPath, "fonts"),
      // Plugins shipped with the app (D97).
      bundledPluginsDir: path.join(process.resourcesPath, "plugins"),
      pluginSdkDir: path.join(process.resourcesPath, "plugin-sdk"),
      renderEntry: undefined,
    }
  : {
      serverEntry: path.join(repoRoot, "apps/server/dist/server.mjs"),
      mediaBin: path.join(repoRoot, "native/media/target/release/uncut-media"),
      modulesDir: path.join(repoRoot, "spec/modules/builtin"),
      sfxDir: path.join(repoRoot, "assets/sfx"),
      graphicLibsDir: path.join(repoRoot, "assets/graphic-libs"),
      fontsDir: path.join(repoRoot, "assets/fonts"),
      bundledPluginsDir: path.join(repoRoot, "plugins"),
      pluginSdkDir: path.join(repoRoot, "packages/plugin-sdk/src"),
      // Under `pnpm dev` the binary is a bare Electron: it needs this bundle to be the rasteriser.
      renderEntry: path.join(__dirname, "main.cjs"),
    };
