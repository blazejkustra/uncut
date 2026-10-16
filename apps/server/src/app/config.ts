import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import * as Context from "effect/Context";
import * as Layer from "effect/Layer";

import type { ShellEnvironment } from "./shellEnv.ts";
import { besideServer } from "../paths.ts";
import { pluginLayout, type PluginLayout } from "../plugins/discovery/bundled.ts";

declare const __UNCUT_SERVER_VERSION__: string | undefined;

export interface ServerConfigShape {
  readonly version: string;
  readonly host: string;
  readonly port: number;
  readonly token: string;
  /** Run as `uncut-server` on its own (--host / --port / --data-dir, D106): prints how to pair on stderr once it listens. */
  readonly headless?: boolean;
  /** Where a headless server keeps its token (D106). */
  readonly tokenFile?: string | undefined;
  /** Origins allowed besides the defaults (D110): UNCUT_ALLOWED_ORIGINS, comma-separated (the dev page). */
  readonly allowedOrigins?: ReadonlyArray<string>;
  // True when nobody handed us a token, so the ready line has to tell the caller.
  readonly tokenGenerated: boolean;
  readonly mediaBin: string;
  // Built-in module manifests (spec/modules/builtin). The packaged app ships a copy in Resources.
  readonly modulesDir: string;
  // The bundled sound-effects pack (assets/sfx, D134), shipped in Resources/sfx.
  readonly sfxDir: string;
  // The libraries graphics load with uncut:lib/ markers (assets/graphic-libs, D193), shipped in Resources/graphic-libs.
  readonly graphicLibsDir: string;
  /** D198: the bundled fonts (DM Sans, DM Mono; assets/fonts, Resources/fonts) that graphics load. */
  readonly fontsDir: string;
  // Where app state lives (recents.json). The desktop passes Electron's userData path.
  readonly dataDir: string;
  // Plugin folders, searched in this order (D97): UNCUT_PLUGINS_DIR (tests, development), the
  // user's <dataDir>/plugins, then the plugins shipped with the app (Resources/plugins; dev: plugins/).
  // D258: `folders`, when set, are the root's plugin folders (bundled.json's split) instead of its subfolders.
  readonly pluginDirs: ReadonlyArray<{ readonly source: "user" | "bundled"; readonly dir: string; readonly folders?: ReadonlyArray<string> }>;
  /** The plugin SDK plugins on Uncut's Node import (D102): its index.ts and register.ts. */
  readonly pluginSdkDir: string;
  /** The plugin catalog (D103): plugins shipped with Uncut, off until the user enables one (Resources/plugins/catalog; repo plugins/catalog). */
  readonly pluginCatalogDir: string;
  /** D258: the catalog's plugin folders when the bundled folder has a bundled.json (development: every repo plugin it doesn't list); else pluginCatalogDir's subfolders. */
  readonly pluginCatalogFolders?: ReadonlyArray<string>;
  // The login shell's environment, once resolved (undefined when UNCUT_SHELL_ENV=off).
  readonly shellReady: Promise<ShellEnvironment | undefined>;
  // Test-only fault injection (UNCUT_TEST_FAULT), e.g. "create-after-mkdir".
  readonly testFault: string | undefined;
  // Where speech models come from (UNCUT_WHISPER_MODEL_URL, tests or a mirror; D68). Unset: Hugging Face, checked against the catalog.
  readonly whisperModelUrl: string | undefined;
  // The desktop's keys pipe (--keys-fd, D99): safeStorage encrypt/decrypt for generator keys. Undefined: keys in memory only.
  readonly keysFd?: number | undefined;
}

export class ServerConfig extends Context.Service<ServerConfig, ServerConfigShape>()(
  "uncut/ServerConfig",
) {}

export interface LaunchOptions {
  readonly bootstrapToken: string | undefined;
  readonly exitWithStdin: boolean;
  readonly keysFd: number | undefined;
  /** `uncut-server --host <addr> --port <n> --data-dir <dir>` (D106): any of them makes it headless. */
  readonly host?: string | undefined;
  readonly port?: number | undefined;
  readonly dataDir?: string | undefined;
}

const flagValue = (argv: ReadonlyArray<string>, name: string): string | undefined => {
  const i = argv.indexOf(name);
  if (i !== -1) {
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${name} needs a value`);
    return value;
  }
  const inline = argv.find((a) => a.startsWith(`${name}=`));
  return inline?.slice(name.length + 1);
};

// `--bootstrap-fd N`: read one JSON object ({ "token": "..." }) from that fd until EOF. The
// desktop passes the token this way (as t3code does) so it never shows in `ps eww`.
// `--exit-with-stdin`: shut down when stdin reaches EOF, i.e. when the parent goes away.
export const readLaunchOptions = (argv: ReadonlyArray<string>): LaunchOptions => {
  const fdIndex = argv.indexOf("--bootstrap-fd");
  let bootstrapToken: string | undefined;
  if (fdIndex !== -1) {
    const fd = Number(argv[fdIndex + 1]);
    const bootstrap = JSON.parse(readFileSync(fd, "utf8")) as { token?: unknown };
    if (typeof bootstrap.token !== "string" || bootstrap.token === "") {
      throw new Error(`bootstrap fd ${fd} carried no token`);
    }
    bootstrapToken = bootstrap.token;
  }
  // `--keys-fd N` (D99): a duplex pipe to the desktop, which encrypts and decrypts generator keys.
  const keysIndex = argv.indexOf("--keys-fd");
  const keysFd = keysIndex !== -1 && Number.isInteger(Number(argv[keysIndex + 1])) ? Number(argv[keysIndex + 1]) : undefined;
  const host = flagValue(argv, "--host");
  const portText = flagValue(argv, "--port");
  const port = portText === undefined ? undefined : Number(portText);
  if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65535)) throw new Error(`--port must be a port number (0 picks a free one), got "${portText}"`);
  const dataDir = flagValue(argv, "--data-dir");
  return { bootstrapToken, exitWithStdin: argv.includes("--exit-with-stdin"), keysFd, host, port, dataDir };
};

/**
 * Inside Uncut.app the bundle is Resources/server/server.mjs, next to Resources/bin, modules,
 * plugins and plugin-sdk: a headless server started from an installed app (the SSH helper's command,
 * D111) finds them there without the desktop passing their paths.
 */
const packagedResources = (): string | undefined => (existsSync(besideServer("../bin/uncut-media")) ? besideServer("..") : undefined);
const fromResources = (rel: string, dev: string) => {
  const root = packagedResources();
  return root ? join(root, rel) : besideServer(dev);
};

/** Where app state lives: UNCUT_DATA_DIR, else ~/Library/Application Support/Uncut. */
export const dataDirOf = (env: NodeJS.ProcessEnv = process.env) => env.UNCUT_DATA_DIR || join(homedir(), "Library", "Application Support", "Uncut");

// The desktop shell passes UNCUT_PORT / UNCUT_MEDIA_BIN / UNCUT_MODULES_DIR / UNCUT_DATA_DIR / UNCUT_BUNDLED_PLUGINS_DIR
// and the token over the bootstrap fd. Dev fallbacks assume the bundle in apps/server/dist.
// Run by hand, the server picks a free port and a fresh token (or takes UNCUT_TOKEN) and
// prints the port, plus any token it generated, on its ready line.
export const readConfig = (
  env: NodeJS.ProcessEnv = process.env,
  bootstrapToken?: string,
  shell: { readonly shellReady: Promise<ShellEnvironment | undefined> } = { shellReady: Promise.resolve(undefined) },
  keysFd?: number,
  headless?: { readonly host?: string | undefined; readonly tokenFile?: string | undefined },
): ServerConfigShape => {
  const token = bootstrapToken ?? (env.UNCUT_TOKEN || undefined);
  const bundledPlugins = env.UNCUT_BUNDLED_PLUGINS_DIR || fromResources("plugins", "../../../plugins");
  // D258: the repo's bundled.json (development); the packaged app's folder is already laid out and has none.
  let layout: PluginLayout | undefined;
  try {
    layout = pluginLayout(bundledPlugins);
    for (const problem of layout?.problems ?? []) console.error(`[uncut] ${problem}`);
  } catch (error) {
    console.error(`[uncut] ${(error as Error).message} Every plugin folder there ships as before.`);
  }
  return {
    version: typeof __UNCUT_SERVER_VERSION__ === "string" ? __UNCUT_SERVER_VERSION__ : "0.0.0-dev",
    host: headless?.host || "127.0.0.1",
    ...(headless ? { headless: true, tokenFile: headless.tokenFile } : {}),
    allowedOrigins: (env.UNCUT_ALLOWED_ORIGINS ?? "").split(",").map((o) => o.trim()).filter(Boolean),
    port: Number(env.UNCUT_PORT ?? 0),
    token: token ?? randomBytes(24).toString("base64url"),
    tokenGenerated: token === undefined,
    // Dev fallback: the bundle lives in apps/server/dist, the helper in native/media/target.
    mediaBin:
      env.UNCUT_MEDIA_BIN ||
      fromResources("bin/uncut-media", "../../../native/media/target/release/uncut-media"),
    modulesDir: env.UNCUT_MODULES_DIR || fromResources("modules/builtin", "../../../spec/modules/builtin"),
    sfxDir: env.UNCUT_SFX_DIR || fromResources("sfx", "../../../assets/sfx"),
    graphicLibsDir: env.UNCUT_GRAPHIC_LIBS_DIR || fromResources("graphic-libs", "../../../assets/graphic-libs"),
    fontsDir: env.UNCUT_FONTS_DIR || fromResources("fonts", "../../../assets/fonts"),
    dataDir: dataDirOf(env),
    pluginDirs: [
      ...(env.UNCUT_PLUGINS_DIR ? [{ source: "user" as const, dir: env.UNCUT_PLUGINS_DIR }] : []),
      { source: "user" as const, dir: join(dataDirOf(env), "plugins") },
      { source: "bundled" as const, dir: bundledPlugins, ...(layout ? { folders: layout.bundled } : {}) },
    ],
    pluginSdkDir: env.UNCUT_PLUGIN_SDK_DIR || fromResources("plugin-sdk", "../../../packages/plugin-sdk/src"),
    pluginCatalogDir: env.UNCUT_PLUGIN_CATALOG_DIR || join(bundledPlugins, "catalog"),
    ...(layout && !env.UNCUT_PLUGIN_CATALOG_DIR ? { pluginCatalogFolders: layout.catalog } : {}),
    testFault: env.UNCUT_TEST_FAULT || undefined,
    whisperModelUrl: env.UNCUT_WHISPER_MODEL_URL || undefined,
    shellReady: shell.shellReady,
    keysFd,
  };
};

export const layer = (config: ServerConfigShape) => Layer.succeed(ServerConfig, config);
