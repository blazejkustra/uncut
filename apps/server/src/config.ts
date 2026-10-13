import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import * as Context from "effect/Context";
import * as Layer from "effect/Layer";

import type { ShellEnvironment } from "./shellEnv.ts";

declare const __UNCUT_SERVER_VERSION__: string | undefined;

export interface ServerConfigShape {
  readonly version: string;
  readonly host: string;
  readonly port: number;
  readonly token: string;
  // True when nobody handed us a token, so the ready line has to tell the caller.
  readonly tokenGenerated: boolean;
  readonly mediaBin: string;
  // Built-in module manifests (spec/modules/builtin). The packaged app ships a copy in Resources.
  readonly modulesDir: string;
  // The bundled music library (assets/music, D91). The packaged app ships it in Resources/music.
  readonly musicDir: string;
  // Where app state lives (recents.json). The desktop passes Electron's userData path.
  readonly dataDir: string;
  // Plugin folders, searched in this order (D97): UNCUT_PLUGINS_DIR (tests, development), the
  // user's <dataDir>/plugins, then the plugins shipped with the app (Resources/plugins; dev: plugins/).
  readonly pluginDirs: ReadonlyArray<{ readonly source: "user" | "bundled"; readonly dir: string }>;
  // ANTHROPIC_API_KEY was in our environment at startup (D41: it is removed and never passed on).
  readonly apiKeyInEnv: boolean;
  // The login shell's environment, once resolved (undefined when UNCUT_SHELL_ENV=off).
  readonly shellReady: Promise<ShellEnvironment | undefined>;
  // Test-only fault injection (UNCUT_TEST_FAULT), e.g. "create-after-mkdir".
  readonly testFault: string | undefined;
  // Where speech models come from (UNCUT_WHISPER_MODEL_URL, tests or a mirror; D68). Unset: Hugging Face, checked against the catalog.
  readonly whisperModelUrl: string | undefined;
}

export class ServerConfig extends Context.Service<ServerConfig, ServerConfigShape>()(
  "uncut/ServerConfig",
) {}

export interface LaunchOptions {
  readonly bootstrapToken: string | undefined;
  readonly exitWithStdin: boolean;
}

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
  return { bootstrapToken, exitWithStdin: argv.includes("--exit-with-stdin") };
};

// The desktop shell passes UNCUT_PORT / UNCUT_MEDIA_BIN / UNCUT_MODULES_DIR / UNCUT_MUSIC_DIR / UNCUT_DATA_DIR / UNCUT_BUNDLED_PLUGINS_DIR
// and the token over the bootstrap fd. Dev fallbacks assume the bundle in apps/server/dist.
// Run by hand, the server picks a free port and a fresh token (or takes UNCUT_TOKEN) and
// prints the port, plus any token it generated, on its ready line.
export const readConfig = (
  env: NodeJS.ProcessEnv = process.env,
  bootstrapToken?: string,
  shell: { readonly apiKeyInEnv: boolean; readonly shellReady: Promise<ShellEnvironment | undefined> } = { apiKeyInEnv: false, shellReady: Promise.resolve(undefined) },
): ServerConfigShape => {
  const token = bootstrapToken ?? (env.UNCUT_TOKEN || undefined);
  return {
    version: typeof __UNCUT_SERVER_VERSION__ === "string" ? __UNCUT_SERVER_VERSION__ : "0.0.0-dev",
    host: "127.0.0.1",
    port: Number(env.UNCUT_PORT ?? 0),
    token: token ?? randomBytes(24).toString("base64url"),
    tokenGenerated: token === undefined,
    // Dev fallback: the bundle lives in apps/server/dist, the helper in native/media/target.
    mediaBin:
      env.UNCUT_MEDIA_BIN ||
      fileURLToPath(new URL("../../../native/media/target/release/uncut-media", import.meta.url)),
    modulesDir: env.UNCUT_MODULES_DIR || fileURLToPath(new URL("../../../spec/modules/builtin", import.meta.url)),
    musicDir: env.UNCUT_MUSIC_DIR || fileURLToPath(new URL("../../../assets/music", import.meta.url)),
    dataDir: env.UNCUT_DATA_DIR || join(homedir(), "Library", "Application Support", "Uncut"),
    pluginDirs: [
      ...(env.UNCUT_PLUGINS_DIR ? [{ source: "user" as const, dir: env.UNCUT_PLUGINS_DIR }] : []),
      { source: "user" as const, dir: join(env.UNCUT_DATA_DIR || join(homedir(), "Library", "Application Support", "Uncut"), "plugins") },
      { source: "bundled" as const, dir: env.UNCUT_BUNDLED_PLUGINS_DIR || fileURLToPath(new URL("../../../plugins", import.meta.url)) },
    ],
    testFault: env.UNCUT_TEST_FAULT || undefined,
    whisperModelUrl: env.UNCUT_WHISPER_MODEL_URL || undefined,
    apiKeyInEnv: shell.apiKeyInEnv,
    shellReady: shell.shellReady,
  };
};

export const layer = (config: ServerConfigShape) => Layer.succeed(ServerConfig, config);
