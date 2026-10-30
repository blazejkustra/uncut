// The ElevenLabs plugin (#107, #108): voiceovers (text to speech) and music for the Generate tab and
// generate_media. Uncut calls `generate` ({generator, prompt, seconds?, options}) and `choices`
// ({generator, option}: the voices of the user's account) with a grant; every request to ElevenLabs
// goes through Uncut (context.fetch, uncut/fetch), which adds the user's key and saves the audio as
// the generation's file. This process never has the key.
import { serve, text, ToolError, type FetchResult, type Json, type ToolContext } from "@uncut/plugin-sdk";

import { errorOf, findVoice, MUSIC_MODEL, voiceChoices } from "./elevenlabs.ts";

const OUTPUT = "mp3_44100_128";

const options = (args: Json) => (args.options && typeof args.options === "object" ? args.options : {}) as Record<string, unknown>;

/** A voice setting asked for, or nothing: "voice" keeps what the voice has saved in the user's account. */
function voiceSetting(name: string, value: unknown) {
  const n = Number(value);
  return value === undefined || value === "voice" || !Number.isFinite(n) ? {} : { [name]: Math.min(1, Math.max(0, n)) };
}

/** The saved file, or the reply's error in a sentence. */
function savedOrError(r: FetchResult) {
  if (r.file) return;
  throw new ToolError(errorOf(r));
}

async function voiceover(args: Json, ctx: ToolContext) {
  const o = options(args);
  const script = String(args.prompt ?? "");
  const voice = await findVoice(ctx, typeof o.voice === "string" ? o.voice : "");
  const model = typeof o.model === "string" ? o.model : "eleven_multilingual_v2";
  const speed = Number(o.speed ?? 1);
  ctx.progress(0, undefined, `${voice.name} is reading the script…`);
  const r = await ctx.fetch({
    method: "POST",
    url: `/v1/text-to-speech/${encodeURIComponent(voice.id)}?output_format=${OUTPUT}`,
    headers: { "content-type": "application/json", accept: "audio/mpeg" },
    body: JSON.stringify({
      text: script,
      model_id: model,
      voice_settings: {
        speed: Number.isFinite(speed) ? Math.min(1.2, Math.max(0.7, speed)) : 1,
        ...voiceSetting("stability", o.stability),
        ...voiceSetting("similarity_boost", o.similarity),
      },
    }),
    save: "mp3",
  });
  savedOrError(r);
  return text(`Made the voiceover with ${voice.name}.`, { model, voice: voice.name });
}

async function music(args: Json, ctx: ToolContext) {
  const o = options(args);
  const seconds = Number(args.seconds ?? 30);
  ctx.progress(0, undefined, "ElevenLabs is composing…");
  const r = await ctx.fetch({
    method: "POST",
    url: `/v1/music?output_format=${OUTPUT}`,
    headers: { "content-type": "application/json", accept: "audio/mpeg" },
    body: JSON.stringify({
      prompt: String(args.prompt ?? ""),
      music_length_ms: Math.round(seconds * 1000),
      model_id: MUSIC_MODEL,
      force_instrumental: o.instrumental === true,
    }),
    save: "mp3",
  });
  savedOrError(r);
  return text(`Made ${seconds} s of music.`, { model: MUSIC_MODEL });
}

serve({
  manifest: new URL("./uncut.module.json", import.meta.url),
  tools: {
    generate: (args, ctx) => {
      if (args.generator === "elevenlabs.voiceover") return voiceover(args, ctx);
      if (args.generator === "elevenlabs.music") return music(args, ctx);
      throw new ToolError(`There's no generator ${String(args.generator)} here.`);
    },
    choices: async (args, ctx) => {
      if (args.generator !== "elevenlabs.voiceover" || args.option !== "voice") throw new ToolError("Only the voiceover's voice has choices.");
      return text("The voices of your ElevenLabs account.", { choices: await voiceChoices(ctx) });
    },
  },
});
