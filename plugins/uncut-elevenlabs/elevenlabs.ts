// ElevenLabs' API as the plugin uses it, through Uncut's fetch (the key added by Uncut): the
// account's voices (GET /v2/voices, paged) and its error replies in a sentence.
import { ToolError, type FetchResult, type ToolContext } from "@uncut/plugin-sdk";

export const MUSIC_MODEL = "music_v1";
/** At most this many pages of voices (100 each) are listed. */
const MAX_PAGES = 3;
/** An ElevenLabs voice id. */
const VOICE_ID = /^[A-Za-z0-9]{20}$/;

interface Voice {
  readonly voice_id: string;
  readonly name: string;
  readonly category?: string;
}

/** An ElevenLabs reply that failed, in a sentence: its own message when it gives one. */
export function errorOf(r: FetchResult): string {
  let detail = "";
  try {
    const body = JSON.parse(r.text ?? "") as { detail?: unknown; message?: unknown };
    const d = body.detail as { message?: unknown; status?: unknown } | Array<{ msg?: unknown }> | string | undefined;
    detail = typeof d === "string" ? d : Array.isArray(d) ? d.map((x) => String(x?.msg ?? "")).join("; ") : typeof d?.message === "string" ? d.message : typeof body.message === "string" ? body.message : "";
  } catch {
    detail = (r.text ?? "").trim().split("\n")[0] ?? "";
  }
  // Its own sentence without the full stop: ours ends it.
  detail = detail.slice(0, 300).trim().replace(/[.\s]+$/, "");
  const tail = detail ? `: ${detail}` : "";
  if (r.status === 401) return `ElevenLabs didn't accept your key (401)${tail}. Check it in Settings › Keys.`;
  if (r.status === 402 || r.status === 403) return `ElevenLabs refused it for your plan (${r.status})${tail}.`;
  if (r.status === 429) return `ElevenLabs says too many requests or no credits left (429)${tail}.`;
  if (r.status >= 200 && r.status < 300) return "ElevenLabs answered with text instead of audio.";
  return `ElevenLabs refused the request (${r.status})${tail}.`;
}

/** The account's voices, up to MAX_PAGES pages. */
async function listVoices(ctx: ToolContext, search?: string): Promise<Array<Voice>> {
  const out: Array<Voice> = [];
  let token: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const q = new URLSearchParams({ page_size: "100", ...(search ? { search } : {}), ...(token ? { next_page_token: token } : {}) });
    const r = await ctx.fetch({ url: `/v2/voices?${q}` });
    if (r.status !== 200) throw new ToolError(errorOf(r));
    const body = JSON.parse(r.text ?? "{}") as { voices?: Array<Voice>; has_more?: boolean; next_page_token?: string | null };
    out.push(...(body.voices ?? []).filter((v) => typeof v?.voice_id === "string" && typeof v?.name === "string"));
    if (!body.has_more || !body.next_page_token) break;
    token = body.next_page_token;
  }
  return out;
}

/** "George - Warm, Captivating Storyteller" → "George". */
const shortName = (name: string) => name.split(" - ")[0]!.trim();

/** The voices as choices: the short name, the description after it, and where it comes from when it isn't one of ElevenLabs' own. */
export async function voiceChoices(ctx: ToolContext) {
  const voices = await listVoices(ctx);
  return voices.map((v) => {
    const rest = v.name.includes(" - ") ? v.name.slice(v.name.indexOf(" - ") + 3).trim() : "";
    const from = v.category && v.category !== "premade" ? ` (${v.category})` : "";
    return { value: v.voice_id, label: `${shortName(v.name)}${rest ? `, ${rest}` : ""}${from}`.slice(0, 80) };
  });
}

/** A voice by id (used as is) or by name (George, "george", "George - Warm…"), from the account's voices. */
export async function findVoice(ctx: ToolContext, wanted: string): Promise<{ readonly id: string; readonly name: string }> {
  const w = wanted.trim();
  if (!w) return { id: "JBFqnCBsd6RMkjVDRZzb", name: "George" };
  const voices = VOICE_ID.test(w) ? await listVoices(ctx) : await listVoices(ctx, shortName(w));
  const lower = w.toLowerCase();
  const found = voices.find((v) => v.voice_id === w) ?? voices.find((v) => v.name.toLowerCase() === lower) ?? voices.find((v) => shortName(v.name).toLowerCase() === shortName(lower));
  if (found) return { id: found.voice_id, name: shortName(found.name) };
  // An id that isn't listed (a shared voice): ElevenLabs says so if it can't use it.
  if (VOICE_ID.test(w)) return { id: w, name: "the voice" };
  const some = (await listVoices(ctx)).slice(0, 12).map((v) => shortName(v.name));
  throw new ToolError(`There's no voice "${w.slice(0, 60)}" in your ElevenLabs voices.${some.length ? ` Some of them: ${some.join(", ")}.` : ""}`);
}
