// D218: what the Agent tab says when Claude Code stops or pauses for the user's subscription limits,
// an API error or a sign-in problem. Modelled on t3code's ClaudeAdapterV2 (describeClaudeUsageLimit,
// providerFailureFromResult, terminalResultError, claudeSignedOutMessage). It only reads what claude
// itself streams (rate_limit_event, an assistant message's `error`, the result's api_error_status
// and terminal_reason): Uncut never asks Anthropic's servers about usage and never reads the login.
// Nothing here retries: a limit ends or pauses the turn and the user decides when to send again.

/** The windows claude names in rate_limit_info.rateLimitType (t3code's CLAUDE_USAGE_LIMIT_WINDOWS). */
const WINDOWS: Readonly<Record<string, string>> = {
  five_hour: "5-hour",
  seven_day: "7-day",
  seven_day_opus: "7-day Opus",
  seven_day_sonnet: "7-day Sonnet",
  seven_day_overage_included: "7-day model",
  overage: "overage",
};

/** Beyond this a reset time isn't credible, so the message goes without a wait (t3code: 30 days). */
const MAX_WAIT_MS = 30 * 24 * 60 * 60 * 1000;

export interface RateLimitInfo {
  readonly status?: unknown;
  readonly rateLimitType?: unknown;
  readonly resetsAt?: unknown;
  readonly overageStatus?: unknown;
  readonly isUsingOverage?: unknown;
  readonly overageInUse?: unknown;
}

/** A turn's limit state: rejected windows (type → reset, epoch seconds) and what claude said. */
export interface TurnLimits {
  readonly rejected: Map<string, number | undefined>;
  readonly announced: Set<string>;
  rateLimited: boolean;
  authFailed: boolean;
  // An assistant message's billing_error (no credit, a spend limit) and its words.
  billingFailed?: boolean;
  billingText?: string;
}
export const turnLimits = (): TurnLimits => ({ rejected: new Map(), announced: new Set(), rateLimited: false, authFailed: false });

/**
 * Which sign-in claude used: keySource is its init message's apiKeySource ("ANTHROPIC_API_KEY",
 * "apiKeyHelper", "/login managed key", "none", "oauth", or a settings scope: "user", "project",
 * "org", "temporary"); keyWhere is where Uncut sees an ANTHROPIC_API_KEY come from (shellEnv's
 * apiKeySource). Names and places only, never a key's value. Nothing here changes the sign-in (D277).
 */
export interface AuthInfo {
  readonly keySource?: string | undefined;
  readonly keyWhere?: "environment" | "settings" | undefined;
}

const SUBSCRIPTION = new Set(["none", "oauth"]);
/** True when claude used an API key (any source), not a Claude account sign-in. */
export const usedKey = (auth: AuthInfo | undefined) => !!auth?.keySource && !SUBSCRIPTION.has(auth.keySource);

/** The key claude used, in words: "ANTHROPIC_API_KEY from the environment", "the key from its apiKeyHelper setting". */
const keyWords = (auth: AuthInfo): string => {
  switch (auth.keySource) {
    case "ANTHROPIC_API_KEY":
      return auth.keyWhere === "settings"
        ? "ANTHROPIC_API_KEY from Claude Code's settings (the env block of settings.json)"
        : "ANTHROPIC_API_KEY from the environment";
    case "apiKeyHelper":
      return "the key from its apiKeyHelper setting";
    case "/login managed key":
      return "the API key from its Anthropic Console login";
    default:
      return `an API key from its ${auth.keySource} settings`;
  }
};

/** How to get back to a working sign-in from the key claude used. */
const keyWayOut = (auth: AuthInfo, fix: string): string => {
  switch (auth.keySource) {
    case "ANTHROPIC_API_KEY":
      return auth.keyWhere === "settings"
        ? `Remove it from settings.json to use your Claude subscription, or ${fix} that key.`
        : `Unset it to use your Claude subscription, or ${fix} that key.`;
    case "apiKeyHelper":
      return `Remove apiKeyHelper from Claude Code's settings to use your Claude subscription, or ${fix} that key.`;
    case "/login managed key":
      return `Run \`claude auth login\` in Terminal and sign in with your Claude subscription, or ${fix} that Console account's key.`;
    default:
      return `Remove it to use your Claude subscription, or ${fix} that key.`;
  }
};

/** Which sign-in an auth or billing error came from, as a sentence (empty when claude didn't say). */
export const authNote = (kind: "credit" | "rejected", auth: AuthInfo | undefined): string => {
  if (!auth?.keySource) return "";
  if (!usedKey(auth)) {
    return kind === "credit"
      ? "Claude Code used your Claude account sign-in (no API key), so your plan's usage or extra-usage credit ran out: check Settings, Usage on claude.ai, or wait for the limit to reset."
      : "";
  }
  return kind === "credit"
    ? `Claude Code used ${keyWords(auth)}, which has no credit. ${keyWayOut(auth, "top up")}`
    : `Claude Code used ${keyWords(auth)}, which was rejected. ${keyWayOut(auth, "replace")}`;
};

const BILLING = /credit balance is too low|insufficient credit|billing|spend limit reached|out of credits?/i;

/** "2h 5m", "45m", "3h" (t3code's formatClaudeUsageLimitWait). */
export const formatWait = (waitMs: number): string => {
  const total = Math.ceil(waitMs / 60_000);
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  if (hours === 0) return `${total}m`;
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
};

const waitFor = (resetsAt: number | undefined, nowMs: number) => {
  if (resetsAt === undefined || !Number.isFinite(nowMs)) return undefined;
  const ms = resetsAt * 1000 - nowMs;
  return ms > 0 && ms <= MAX_WAIT_MS ? formatWait(ms) : undefined;
};

const seconds = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined);

/**
 * A rate_limit_event's info against the turn: a rejected window that overage doesn't cover pauses
 * claude (it holds the turn until the window reopens), so this returns the notice to show, once per
 * window and reset; an allowed one clears that window. Warnings and overage keep running (no notice).
 */
export const onRateLimit = (limits: TurnLimits, info: RateLimitInfo, nowMs: number): { readonly notice?: string; readonly cleared?: boolean } => {
  const type = typeof info.rateLimitType === "string" && info.rateLimitType ? info.rateLimitType : "unknown";
  const overage = info.overageStatus === "allowed" || info.overageStatus === "allowed_warning" || info.isUsingOverage === true || info.overageInUse === true;
  const resetsAt = seconds(info.resetsAt);
  if (info.status === "rejected" && !overage) {
    limits.rejected.set(type, resetsAt);
    const key = `${type}:${resetsAt ?? "unknown"}`;
    if (limits.announced.has(key)) return {};
    limits.announced.add(key);
    const label = Object.hasOwn(WINDOWS, type) ? WINDOWS[type] : undefined;
    const wait = waitFor(resetsAt, nowMs);
    return {
      notice: `Claude usage limit reached. This turn is paused until the ${label ? `${label} ` : ""}limit resets${wait ? ` in ${wait}` : ""}. Wait, or press Stop and send it again later.`,
    };
  }
  if (info.status === "allowed" || info.status === "allowed_warning" || overage) {
    const had = limits.rejected.delete(type);
    return had ? { cleared: limits.rejected.size === 0 } : {};
  }
  return {};
};

/** Claude Code isn't signed in (t3code's claudeSignedOutMessage, in Uncut's words). */
export const signedOutMessage = (configDir: string | undefined) =>
  `Claude Code isn't signed in${configDir ? ` (CLAUDE_CONFIG_DIR is ${JSON.stringify(configDir)})` : ""}. Run \`claude auth login\` in Terminal to sign in (or set up the API key or cloud provider you use with Claude Code), then send the message again.`;

/** A result's terminal_reason in words (t3code's terminalResultError). */
const TERMINAL: Record<string, string> = {
  api_error: "Claude gave up after repeated API errors.",
  malformed_tool_use_exhausted: "Claude gave up after repeated malformed tool calls.",
  budget_exhausted: "Claude stopped: the turn's token budget was exhausted.",
  structured_output_retry_exhausted: "Claude could not produce the requested structured output.",
  tool_deferred_unavailable: "Claude could not resume a deferred tool call: the tool is no longer available.",
  turn_setup_failed: "Claude could not start the turn.",
  blocking_limit: "Claude stopped: a usage limit blocked the request.",
  rapid_refill_breaker: "Claude stopped: the context refilled too quickly after compaction.",
  prompt_too_long: "Claude stopped: the prompt exceeds the model's context window.",
  image_error: "Claude stopped: an image in the conversation could not be processed.",
  model_error: "Claude stopped: the model returned an error.",
};

const SIGNED_OUT = /not logged in|please run \/login|run \/login|invalid api key|oauth token (has )?expired|authentication_failed/i;

/**
 * Why a turn failed, from claude's result line and what the turn saw before it, or undefined when
 * there's nothing better than the result's own words. Order as t3code: sign-in, then the usage
 * limit (a rejected window or a rate_limit assistant error, with a 429 or no API status), 529,
 * 429, then the terminal reason.
 */
export const resultError = (msg: Record<string, any>, limits: TurnLimits, nowMs: number, configDir?: string, auth?: AuthInfo): string | undefined => {
  const said = [
    typeof msg.result === "string" ? msg.result : "",
    ...(Array.isArray(msg.errors) ? msg.errors.filter((e: unknown) => typeof e === "string") : []),
  ].join(" ");
  if (limits.authFailed || SIGNED_OUT.test(said)) {
    // An API key that was rejected isn't a sign-out: say which key it was.
    if (usedKey(auth)) return `Claude Code's API key was rejected${said.trim() ? ` ("${said.trim().slice(0, 200)}")` : ""}. ${authNote("rejected", auth)}`;
    return signedOutMessage(configDir);
  }
  // A billing error (no credit on the key, a spend limit): claude's own words and which sign-in it was.
  const billingWords = [limits.billingText ?? "", said].find((x) => BILLING.test(x));
  if (limits.billingFailed || billingWords) {
    const words = (billingWords ?? limits.billingText ?? said).trim().slice(0, 200) || "Billing error";
    const note = authNote("credit", auth);
    return `Claude's API refused the request: "${words}".${note ? ` ${note}` : " Check the credit of the account Claude Code signs in with."}`;
  }
  const status = typeof msg.api_error_status === "number" ? msg.api_error_status : undefined;
  const reason = typeof msg.terminal_reason === "string" ? msg.terminal_reason : undefined;
  const limited =
    ((limits.rejected.size > 0 || limits.rateLimited) &&
      (status === undefined || status === 429) &&
      (reason === undefined || reason === "api_error" || reason === "blocking_limit")) ||
    reason === "blocking_limit";
  if (limited) {
    const resets = [...limits.rejected.values()];
    const latest = resets.length > 0 && resets.every((r) => r !== undefined) ? Math.max(...(resets as Array<number>)) : undefined;
    const wait = waitFor(latest, nowMs);
    return `Claude usage limit reached. Send the message again once the limit resets${wait ? ` (in ${wait})` : ""}.`;
  }
  if (status === 529) return "Claude API is overloaded (529). Try again shortly.";
  if (status === 429) return "Claude API rate limit reached. Try again later.";
  return reason && Object.hasOwn(TERMINAL, reason) ? TERMINAL[reason] : undefined;
};

/**
 * A result claude labels a success (is_error false) that still failed (t3code's
 * terminalStatusFromResult): an API status of 429 or 529, or a terminal reason that is a give-up.
 */
export const resultFailed = (msg: Record<string, any>): boolean =>
  msg.api_error_status === 429 || msg.api_error_status === 529 || (typeof msg.terminal_reason === "string" && Object.hasOwn(TERMINAL, msg.terminal_reason));

// ---- Codex (issue #106) ----

/** Codex's codexErrorInfo values that need the user, in words. */
const CODEX_ERRORS: Record<string, string> = {
  contextWindowExceeded: "Codex stopped: the conversation is longer than the model's context window. Start a new chat.",
  sessionBudgetExceeded: "Codex stopped: this session's budget is spent.",
  serverOverloaded: "OpenAI's servers are overloaded. Try again shortly.",
  internalServerError: "OpenAI's servers had an error. Try again shortly.",
  sandboxError: "Codex's sandbox refused to run a command.",
  tooManyDenials: "Codex stopped after too many refused steps.",
};

/**
 * Why a Codex turn failed, from its TurnError (message, codexErrorInfo) and the limits it reported
 * on the way (account/rateLimits/updated, codexLimitNotice), or undefined for Codex's own words.
 */
export const codexTurnError = (
  error: { readonly message?: unknown; readonly codexErrorInfo?: unknown } | null | undefined,
  resetsAt: number | undefined,
  nowMs: number,
): string | undefined => {
  const info = error?.codexErrorInfo;
  const kind = typeof info === "string" ? info : info && typeof info === "object" ? Object.keys(info)[0] : undefined;
  const said = typeof error?.message === "string" ? error.message : "";
  if (kind === "unauthorized" || SIGNED_OUT.test(said) || /401|unauthori[sz]ed|refresh token|sign in again|log ?in/i.test(said)) {
    return "Codex isn't signed in, or its sign-in expired. Run `codex login` in Terminal (your ChatGPT plan, or `codex login --with-api-key` for an OpenAI API key), then send the message again.";
  }
  if (kind === "usageLimitExceeded") {
    const wait = waitFor(resetsAt, nowMs);
    return `Codex usage limit reached. Send the message again once the limit resets${wait ? ` (in ${wait})` : ""}, or switch to an API key with \`codex login --with-api-key\`.`;
  }
  if (kind === "rateLimitExceeded") return "OpenAI's rate limit reached. Try again later.";
  if (kind && Object.hasOwn(CODEX_ERRORS, kind)) return CODEX_ERRORS[kind];
  return undefined;
};

/**
 * Codex's account/rateLimits/updated snapshot: a window it reports as reached pauses the turn, so
 * this is the notice to show (and when it resets, epoch seconds), or nothing.
 */
export const codexLimitNotice = (snapshot: Record<string, any> | null | undefined, nowMs: number): { readonly notice?: string; readonly resetsAt?: number } => {
  if (!snapshot || typeof snapshot !== "object") return {};
  const windows = [snapshot.primary, snapshot.secondary].filter((w): w is Record<string, any> => !!w && typeof w === "object");
  const full = windows.filter((w) => typeof w.usedPercent === "number" && w.usedPercent >= 100);
  if (!snapshot.rateLimitReachedType && !full.length) return {};
  const resetsAt = (full.length ? full : windows)
    .map((w) => seconds(w.resetsAt))
    .filter((x): x is number => x !== undefined)
    .sort((a, b) => b - a)[0];
  const wait = waitFor(resetsAt, nowMs);
  return {
    notice: `Codex usage limit reached${wait ? `; it resets in ${wait}` : ""}. Wait, or press Stop and send it again later.`,
    ...(resetsAt ? { resetsAt } : {}),
  };
};
