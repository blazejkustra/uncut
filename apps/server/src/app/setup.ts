// What Uncut needs on this Mac, checked for real: the agent CLIs (and how Claude Code is
// signed in), Argent for capture, ffmpeg for thumbnails and export, whisper.cpp for transcripts
// (D68).
// Every probe is local, read-only, time-boxed and output-capped, and each one is isolated:
// whatever a tool does, it costs its own row an "error", never the whole check.
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { join } from "node:path";

import type { SetupCheck } from "@uncut/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ServerConfig } from "./config.ts";
import { runProbe, type ProbeResult } from "../media/probe.ts";
import { apiKeySource, claudeEnv, codexEnv, withoutApiKey } from "./shellEnv.ts";

// Generous: a cold CLI start (first run after an update, a busy machine, macOS scanning a new
// binary) can take seconds; a hung one still gives up quickly enough to show an error.
const PROBE_TIMEOUT_MS = 6000;
const AUTH_TIMEOUT_MS = 5000;

export interface SetupShape {
  readonly check: Effect.Effect<ReadonlyArray<SetupCheck>>;
}

export class Setup extends Context.Service<Setup, SetupShape>()("uncut/Setup") {}

/** The first executable called `name` on PATH, like `which`. */
export const which = async (name: string, path: string) => {
  for (const dir of path.split(":")) {
    if (!dir) continue;
    const candidate = join(dir, name);
    try {
      await access(candidate, constants.X_OK);
      if ((await stat(candidate)).isFile()) return candidate;
    } catch {}
  }
  return undefined;
};

/** A version number out of whatever `--version` printed ("2.1.296 (Claude Code)" → "2.1.296"). Never raw output. */
export const versionToken = (output: string): string | undefined => /\d+(?:\.\d+)+[\w.-]*/.exec(output)?.[0]?.slice(0, 32);

// The other tools' probes get no sign-in variable or other secret (toolEnv, D277 review).
const run = (command: string, args: ReadonlyArray<string>, timeoutMs = PROBE_TIMEOUT_MS) =>
  runProbe(command, args, { timeoutMs, env: withoutApiKey(process.env) });
// D218, D277: Claude Code's probes get the environment the agent's claude gets (as sessionEnv:
// claudeEnv, whatever Claude Code signs in with, plus the sign-in variables of its user settings),
// so the sign-in row is the agent's.
const runClaude = (command: string, args: ReadonlyArray<string>, timeoutMs = PROBE_TIMEOUT_MS) =>
  runProbe(command, args, { timeoutMs, env: claudeEnv(process.env) });

/** Why a found tool couldn't answer, in words. */
const problem = (path: string, result: ProbeResult): string =>
  result.kind === "timeout"
    ? `Found, but it didn't answer within ${PROBE_TIMEOUT_MS / 1000} s.`
    : result.kind === "overflow"
      ? `Found, but it printed far more than a version number; is ${path} the right program?`
      : result.kind === "failed"
        ? `Couldn't run ${path}: ${result.message}.`
        : `Found, but it failed (exit code ${result.code}).`;

type Base = Pick<SetupCheck, "id" | "name" | "optional">;
const errorRow = (base: Base, detail: string, path?: string): SetupCheck => ({ ...base, status: "error", ...(path ? { path } : {}), detail });

/**
 * Issue #106: Codex's sign-in, from its app-server (initialize, then account/read): signed in with
 * ChatGPT (and the plan) or an API key, needing no OpenAI sign-in (a local or custom provider in
 * its config.toml), or signed out. Time-boxed; the app-server is killed either way.
 */
export const codexAccount = (bin: string, timeoutMs = AUTH_TIMEOUT_MS * 2) =>
  new Promise<{ kind: "chatgpt"; plan?: string } | { kind: "apiKey" | "other" | "signed-out" } | { kind: "failed"; message: string }>((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bin, ["app-server"], { env: codexEnv(process.env), stdio: ["pipe", "pipe", "ignore"] });
    } catch (error) {
      return resolve({ kind: "failed", message: (error as Error).message });
    }
    let done = false;
    const end = (answer: Parameters<typeof resolve>[0]) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      resolve(answer);
    };
    const timer = setTimeout(() => end({ kind: "failed", message: `no answer within ${timeoutMs / 1000} s` }), timeoutMs);
    child.once("error", (error) => end({ kind: "failed", message: error.message }));
    child.once("close", () => end({ kind: "failed", message: "it exited" }));
    let buffer = "";
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      buffer = (buffer + chunk).slice(-200_000);
      let i: number;
      while ((i = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 1);
        let msg: Record<string, any>;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id === 1 && msg.error) return end({ kind: "failed", message: String(msg.error.message ?? "initialize failed").slice(0, 200) });
        if (msg.id !== 2) continue;
        const result = msg.result as { account?: { type?: string; planType?: unknown } | null; requiresOpenaiAuth?: boolean } | undefined;
        if (!result) return end({ kind: "failed", message: String(msg.error?.message ?? "account/read failed").slice(0, 200) });
        const type = result.account?.type;
        if (type === "chatgpt") return end({ kind: "chatgpt", ...(typeof result.account?.planType === "string" ? { plan: result.account.planType } : {}) });
        if (type === "apiKey") return end({ kind: "apiKey" });
        if (type || result.requiresOpenaiAuth === false) return end({ kind: "other" });
        return end({ kind: "signed-out" });
      }
    });
    child.stdin!.on("error", () => {});
    child.stdin!.write(`${JSON.stringify({ id: 1, method: "initialize", params: { clientInfo: { name: "uncut", version: "0" } } })}\n`);
    child.stdin!.write(`${JSON.stringify({ method: "initialized" })}\n`);
    child.stdin!.write(`${JSON.stringify({ id: 2, method: "account/read", params: {} })}\n`);
  });

/** Runs one probe so that nothing it does (a typed failure or a defect) reaches the others. */
const isolated = (base: Base, probe: () => Promise<SetupCheck>) =>
  Effect.tryPromise(probe).pipe(Effect.catchCause(() => Effect.succeed(errorRow(base, `Something went wrong while checking ${base.name}.`))));

const capitalize = (s: string) => `${s[0]!.toUpperCase()}${s.slice(1)}`;

// D277: Uncut runs Claude Code with whatever sign-in it uses (a Claude account, an API key, a
// cloud provider); every one is ready. Only the plan or provider is shown, never the account.
// D277 review: an ANTHROPIC_API_KEY in the environment wins over a Claude login in claude -p, so a
// stale one exported in a shell profile would silently bill an API account; say so (presence only).
const ENV_KEY_NOTE = "Using ANTHROPIC_API_KEY from your shell environment; agent usage is billed to that API account. Unset it to use your Claude login.";
const claudeSignIn = (status: { authMethod?: unknown; apiProvider?: unknown; subscriptionType?: unknown }, keySource: ReturnType<typeof apiKeySource>) => {
  switch (status.authMethod) {
    case "claude.ai": {
      const plan = typeof status.subscriptionType === "string" && status.subscriptionType ? `, ${capitalize(status.subscriptionType)} plan` : "";
      return { status: "ready" as const, detail: `Signed in with a Claude account${plan}` };
    }
    case "api_key":
      return {
        status: "ready" as const,
        detail:
          keySource === "environment" ? `Signed in with an API key. ${ENV_KEY_NOTE}` : "Signed in with an API key. Agent usage is billed to that API account.",
      };
    // D219: CLAUDE_CODE_OAUTH_TOKEN, the long-lived token `claude setup-token` makes from a Claude account.
    case "oauth_token":
      return { status: "ready" as const, detail: "Signed in with a Claude account (a long-lived token from claude setup-token)" };
    case "third_party": {
      const provider = typeof status.apiProvider === "string" && status.apiProvider ? status.apiProvider : "a cloud provider";
      return { status: "ready" as const, detail: `Using ${provider}. Agent usage is billed by that provider.` };
    }
    default:
      return { status: "ready" as const, detail: `Signed in${typeof status.authMethod === "string" ? ` (${status.authMethod})` : ""}.` };
  }
};

export const layer = Layer.effect(
  Setup,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const path = () => process.env.PATH ?? "";

    const claude = isolated({ id: "claude", name: "Claude Code", optional: false }, async () => {
      const base = { id: "claude", name: "Claude Code", optional: false } as const;
      // The same binary the agent runs (UNCUT_CLAUDE points at another install, or a test stand-in).
      const bin = process.env.UNCUT_CLAUDE || (await which("claude", path()));
      if (!bin) {
        return {
          ...base,
          status: "missing",
          detail: "Not installed. Uncut's agent runs your installed Claude Code, with whatever sign-in it uses.",
          fix: { text: "Install it, then run claude once to sign in.", command: "curl -fsSL https://claude.ai/install.sh | bash" },
        };
      }
      const versionRun = await runClaude(bin, ["--version"]);
      if (versionRun.kind !== "done" || versionRun.code !== 0) return errorRow(base, problem(bin, versionRun), bin);
      const version = versionToken(versionRun.stdout);
      // `claude auth status --json` reads the local sign-in (exit 1 when signed out). It can
      // briefly report signed-out while Claude Code refreshes its token, so ask twice.
      const ask = async () => {
        const r = await runClaude(bin, ["auth", "status", "--json"], AUTH_TIMEOUT_MS);
        if (r.kind !== "done") return undefined;
        try {
          const parsed = JSON.parse(r.stdout) as Record<string, unknown>;
          return typeof parsed === "object" && parsed !== null ? parsed : undefined;
        } catch {
          return undefined;
        }
      };
      let status = await ask();
      if (status?.loggedIn === false) {
        await new Promise((r) => setTimeout(r, 400));
        status = (await ask()) ?? status;
      }
      const found = { ...base, path: bin, ...(version ? { version } : {}) };
      if (!status || typeof status.loggedIn !== "boolean") {
        return { ...found, status: "warning", detail: "Found. This version can't report whether it's signed in; run claude once to make sure." };
      }
      if (!status.loggedIn) {
        return {
          ...found,
          status: "needs-login",
          detail: "Installed, but not signed in.",
          fix: { text: "Sign in (or set up the API key or cloud provider you use with Claude Code):", command: "claude auth login" },
        };
      }
      // Only the plan is shown; the account's email and organisation stay out of the app.
      return { ...found, ...claudeSignIn(status, apiKeySource(process.env)) };
    });

    const codex = isolated({ id: "codex", name: "Codex", optional: true }, async () => {
      const base = { id: "codex", name: "Codex", optional: true } as const;
      const bin = await which("codex", path());
      if (!bin) {
        return {
          ...base,
          status: "missing",
          detail: "Not installed. Optional: a second agent, with your ChatGPT plan or an OpenAI API key.",
          fix: { text: "Install with npm (or: brew install --cask codex):", command: "npm install -g @openai/codex" },
        };
      }
      const versionRun = await run(bin, ["--version"]);
      if (versionRun.kind !== "done" || versionRun.code !== 0) return errorRow(base, problem(bin, versionRun), bin);
      const version = versionToken(versionRun.stdout);
      const found = { ...base, path: bin, ...(version ? { version } : {}) };
      // Issue #106: its app-server says whether it's signed in (a ChatGPT plan, an API key) or needs no sign-in (a local or custom provider).
      const account = await codexAccount(bin);
      if (account.kind === "failed")
        return { ...found, status: "warning", detail: `Found, but it couldn't report its sign-in (${account.message}). Run codex once to make sure.` };
      if (account.kind === "signed-out") {
        return {
          ...found,
          status: "needs-login",
          detail: "Installed, but not signed in.",
          fix: { text: "Sign in with your ChatGPT plan (or `codex login --with-api-key` for an OpenAI API key):", command: "codex login" },
        };
      }
      return {
        ...found,
        status: "ready",
        detail:
          account.kind === "chatgpt"
            ? `Signed in with ChatGPT${account.plan ? ` (${capitalize(account.plan)})` : ""}.`
            : account.kind === "apiKey"
              ? "Signed in with an OpenAI API key; usage is billed to that API account."
              : "Ready: its config.toml uses a provider that needs no OpenAI sign-in.",
      };
    });

    const argent = isolated({ id: "argent", name: "Argent", optional: true }, async () => {
      const base = { id: "argent", name: "Argent", optional: true } as const;
      const bin = await which("argent", path());
      if (!bin) {
        return {
          ...base,
          status: "missing",
          detail: "Not installed. Optional: records simulators, emulators and apps for you.",
          fix: { text: "Set it up with:", command: "npx @swmansion/argent@latest init -y" },
        };
      }
      const versionRun = await run(bin, ["--version"]);
      if (versionRun.kind !== "done" || versionRun.code !== 0) return errorRow(base, problem(bin, versionRun), bin);
      const version = versionToken(versionRun.stdout);
      return { ...base, status: "ready", path: bin, ...(version ? { version } : {}), detail: "Ready to record apps." };
    });

    const ffmpeg = isolated({ id: "ffmpeg", name: "ffmpeg", optional: false }, async () => {
      const base = { id: "ffmpeg", name: "ffmpeg", optional: false } as const;
      const [ffmpegPath, ffprobePath] = await Promise.all([which("ffmpeg", path()), which("ffprobe", path())]);
      const fix = { text: "Install with Homebrew:", command: "brew install ffmpeg" };
      if (!ffmpegPath || !ffprobePath) {
        const missing = [!ffmpegPath && "ffmpeg", !ffprobePath && "ffprobe"].filter(Boolean).join(" and ");
        const somewhere = ffmpegPath ?? ffprobePath;
        return {
          ...base,
          status: "missing",
          ...(somewhere ? { path: somewhere } : {}),
          detail: `${missing} not found. Thumbnails, waveforms and export need both.`,
          fix,
        };
      }
      const versionRun = await run(ffmpegPath, ["-version"]);
      if (versionRun.kind !== "done" || versionRun.code !== 0) return errorRow(base, problem(ffmpegPath, versionRun), ffmpegPath);
      const version = versionToken(/ffmpeg version \S+/.exec(versionRun.stdout)?.[0] ?? "");
      return { ...base, status: "ready", path: ffmpegPath, ...(version ? { version } : {}), detail: "ffmpeg and ffprobe found." };
    });

    // whisper.cpp (Homebrew's whisper-cpp) transcribes speech on this Mac (D68). Its model is
    // shown and downloaded beside this row (transcription.state), not checked here.
    const whisper = isolated({ id: "whisper", name: "whisper.cpp", optional: true }, async () => {
      const base = { id: "whisper", name: "whisper.cpp", optional: true } as const;
      const bin = await which("whisper-cli", path());
      if (!bin) {
        return {
          ...base,
          status: "missing",
          detail: "Not installed. Optional: transcribes speech on this Mac, so the agent can cut by what's said.",
          fix: { text: "Install with Homebrew:", command: "brew install whisper-cpp" },
        };
      }
      const versionRun = await run(bin, ["--version"]);
      if (versionRun.kind !== "done" || versionRun.code !== 0) return errorRow(base, problem(bin, versionRun), bin);
      const version = versionToken(versionRun.stdout);
      return { ...base, status: "ready", path: bin, ...(version ? { version } : {}), detail: "Transcribes speech on this Mac." };
    });

    return Setup.of({
      // Wait for the login shell's PATH first, or a check right after launch would miss tools.
      check: Effect.andThen(
        Effect.promise(() => config.shellReady),
        Effect.all([claude, codex, argent, ffmpeg, whisper], { concurrency: "unbounded" }).pipe(Effect.map((rows) => rows as ReadonlyArray<SetupCheck>)),
      ),
    });
  }),
);
