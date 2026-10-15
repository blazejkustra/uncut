// What Uncut needs on this Mac, checked for real: the agent CLIs (and how Claude Code is
// signed in), Argent for capture, ffmpeg for thumbnails and export, whisper.cpp for transcripts
// (D68), and a stray API key.
// Every probe is local, read-only, time-boxed and output-capped, and each one is isolated:
// whatever a tool does, it costs its own row an "error", never the whole check.
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { join } from "node:path";

import type { SetupCheck } from "@uncut/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ServerConfig } from "./config.ts";
import { runProbe, type ProbeResult } from "../media/probe.ts";
import { claudeEnv, withoutApiKey } from "./shellEnv.ts";

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

// The agent CLIs run without ANTHROPIC_API_KEY (D41); the probes use the same environment,
// so onboarding reports what the agent will actually do.
const run = (command: string, args: ReadonlyArray<string>, timeoutMs = PROBE_TIMEOUT_MS) =>
  runProbe(command, args, { timeoutMs, env: withoutApiKey(process.env) });
// D218: Claude Code's probes get exactly the environment the agent's claude gets (claudeEnv: no
// API keys, no CLAUDE_CODE_* but the setup-token login CLAUDE_CODE_OAUTH_TOKEN, D219), so the
// sign-in row is the agent's.
const runClaude = (command: string, args: ReadonlyArray<string>, timeoutMs = PROBE_TIMEOUT_MS) => runProbe(command, args, { timeoutMs, env: claudeEnv(process.env) });

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

/** Runs one probe so that nothing it does (a typed failure or a defect) reaches the others. */
const isolated = (base: Base, probe: () => Promise<SetupCheck>) =>
  Effect.tryPromise(probe).pipe(
    Effect.catchCause(() => Effect.succeed(errorRow(base, `Something went wrong while checking ${base.name}.`))),
  );

const capitalize = (s: string) => `${s[0]!.toUpperCase()}${s.slice(1)}`;

// How Claude Code is signed in decides who pays (D9): only a claude.ai login uses the subscription.
const claudeSignIn = (status: { authMethod?: unknown; apiProvider?: unknown; subscriptionType?: unknown }) => {
  const billed = "Agent usage is billed to that account, not your Claude subscription.";
  const fix = { text: "To use your Claude subscription instead:", command: "claude auth login" };
  switch (status.authMethod) {
    case "claude.ai": {
      const plan = typeof status.subscriptionType === "string" && status.subscriptionType ? `, ${capitalize(status.subscriptionType)} plan` : "";
      return { status: "ready" as const, detail: `Signed in with Claude${plan}` };
    }
    case "api_key":
      return { status: "warning" as const, detail: `Signed in with an API key. ${billed}`, fix };
    // D219: CLAUDE_CODE_OAUTH_TOKEN is the long-lived token `claude setup-token` makes from the user's
    // Claude subscription: the same subscription, not an API account.
    case "oauth_token":
      return { status: "ready" as const, detail: "Signed in with your Claude subscription (a long-lived token from claude setup-token)" };
    case "third_party": {
      const provider = typeof status.apiProvider === "string" && status.apiProvider ? status.apiProvider : "a cloud provider";
      return { status: "warning" as const, detail: `Using ${provider} (Bedrock, Vertex or similar). Agent usage is billed by that provider, not your Claude subscription.`, fix };
    }
    default:
      return { status: "warning" as const, detail: `Signed in, but not with a Claude login${typeof status.authMethod === "string" ? ` (${status.authMethod})` : ""}. Usage may not come from your subscription.`, fix };
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
          detail: "Not installed. Uncut's agent runs on Claude Code with your Claude subscription.",
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
        return { ...found, status: "needs-login", detail: "Installed, but not signed in.", fix: { text: "Sign in with your Claude subscription:", command: "claude auth login" } };
      }
      // Only the plan is shown; the account's email and organisation stay out of the app.
      return { ...found, ...claudeSignIn(status) };
    });

    const codex = isolated({ id: "codex", name: "Codex", optional: true }, async () => {
      const base = { id: "codex", name: "Codex", optional: true } as const;
      const bin = await which("codex", path());
      if (!bin) {
        return {
          ...base,
          status: "missing",
          detail: "Not installed. Optional: a second agent, on your ChatGPT plan.",
          fix: { text: "Install with npm (or: brew install --cask codex):", command: "npm install -g @openai/codex" },
        };
      }
      const versionRun = await run(bin, ["--version"]);
      if (versionRun.kind !== "done" || versionRun.code !== 0) return errorRow(base, problem(bin, versionRun), bin);
      const version = versionToken(versionRun.stdout);
      // No way to check Codex's sign-in was verified on this machine, so say so instead of guessing.
      return { ...base, status: "warning", path: bin, ...(version ? { version } : {}), detail: "Found. Sign-in not checked; run codex once to make sure." };
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
        return { ...base, status: "missing", ...(somewhere ? { path: somewhere } : {}), detail: `${missing} not found. Thumbnails, waveforms and export need both.`, fix };
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

    // Presence only. The key's value is never read into a check, a log line or a reply.
    const apiKey = Effect.map(Effect.promise(() => config.shellReady), (shell): Array<SetupCheck> => {
      const where = config.apiKeyInEnv ? "in your environment" : shell?.apiKeySetInShell ? "in your shell" : undefined;
      return where
        ? [{ id: "api-key", name: "ANTHROPIC_API_KEY", status: "warning", optional: true, detail: `Found ANTHROPIC_API_KEY ${where}. Uncut uses your Claude subscription and ignores the key.` }]
        : [];
    });

    return Setup.of({
      // Wait for the login shell's PATH first, or a check right after launch would miss tools.
      check: Effect.andThen(
        Effect.promise(() => config.shellReady),
        Effect.all([claude, codex, argent, ffmpeg, whisper, apiKey], { concurrency: "unbounded" }).pipe(
          Effect.map(([a, b, c, d, w, keys]) => [a, b, c, d, w, ...keys] as ReadonlyArray<SetupCheck>),
        ),
      ),
    });
  }),
);
