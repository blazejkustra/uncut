// Phase 7 exit check (D101), shared by test/app/phase7-exit.test.ts and scripts/phase7-manual-check.ts:
// the files a run needs (a short voiceover with sound, a flow for Argent, whisper's answer for the
// fake whisper-cli) and the scripted agent's turn, in two halves: what it records, generates and
// imports, then (once the media ids are known) how it places them, transcribes the voice and checks.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { SAY_TOKENS, whisperJson } from "./whisper-json.ts";

export const DEVICE = "SIM-IPHONE-16";
export const FLOW = "demo";
/** A flow the fake argent replays for 2 s (a real one would launch the app and tap through it). */
export const FLOW_YAML = "# fake-seconds: 2\nlaunch: com.example.app\n";
export const PICTURE_PROMPT = "A phone on a wooden desk, soft morning light";

/** A title card the agent writes as SVG (key-free, D99). */
export const TITLE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080"><rect width="1920" height="1080" fill="#0B1D3A"/><rect x="160" y="420" width="12" height="240" fill="#F5A524"/><text x="210" y="520" font-family="Helvetica, Arial, sans-serif" font-size="120" font-weight="700" fill="#FFFFFF">Recorded with Argent</text><text x="214" y="630" font-family="Helvetica, Arial, sans-serif" font-size="56" fill="#9FB3D1">Placed by the agent in Uncut</text></svg>`;

/** The run's own files: voice.m4a (6 s of tone standing in for speech) and whisper's answer. */
export function makeFiles(dir: string) {
  mkdirSync(dir, { recursive: true });
  const voice = join(dir, "voice.m4a");
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=220:sample_rate=48000", "-t", "6", "-c:a", "aac", "-b:a", "96k", voice]);
  const whisper = join(dir, "say.json");
  writeFileSync(whisper, whisperJson(SAY_TOKENS, "en"));
  return { voice, whisper };
}

type Step = { tool: string; args?: unknown } | { text: string } | { await: string };

/** The turn's first half: Argent records the flow, the SVG card and a GPT Image picture are generated, the voice is imported. */
export function recordSteps(voice: string, awaitPath: string, { keyed = true } = {}): Array<Step> {
  return [
    { tool: "argent_list_devices", args: {} },
    { tool: "argent_record", args: { device: DEVICE, flow: FLOW, name: "demo take" } },
    { tool: "generate_media", args: { generator: "generate.svg", prompt: "A title card: Recorded with Argent", kind: "image", content: TITLE_SVG, name: "title card" } },
    ...(keyed ? [{ tool: "generate_media", args: { generator: "generate.gpt-image", prompt: PICTURE_PROMPT, kind: "image", size: "1536x1024", name: "desk" } }] : []),
    { tool: "media_import", args: { path: voice } },
    { await: awaitPath },
  ];
}

export interface Placed {
  readonly capture: string;
  readonly captureFrames: number;
  readonly demo: string;
  readonly demoFrames: number;
  readonly card: string;
  readonly picture?: string | undefined;
  readonly voice: string;
}

/** The second half: everything on the timeline in one timeline_edit, the voice transcribed, project_check. */
export function placeSteps(m: Placed): Array<Step> {
  const take = (frames: number, max: number) => Math.max(15, Math.min(max, frames - 2));
  const ops = [
    { op: "insert_item", track: "main", item: { id: "card", type: "clip", media: m.card, in: 0, duration: 75, animation: { out: { module: "move.fade", duration: 10 } } } },
    { op: "insert_item", track: "main", item: { id: "take-tab", type: "clip", media: m.capture, in: 0, duration: take(m.captureFrames, 45) } },
    { op: "insert_item", track: "main", item: { id: "take-flow", type: "clip", media: m.demo, in: 0, duration: take(m.demoFrames, 60) } },
    ...(m.picture ? [{ op: "insert_item", track: "main", item: { id: "desk", type: "clip", media: m.picture, in: 0, duration: 45, transform: { fit: "cover" } } }] : []),
    { op: "add_track", track: { id: "t-voice", kind: "audio", name: "Voice" } },
    { op: "insert_item", track: "t-voice", item: { id: "voice", type: "audio", media: m.voice, in: 0, start: 0, duration: 150, fadeIn: 6, fadeOut: 15 } },
  ];
  return [
    { tool: "project_read", args: {} },
    { tool: "timeline_edit", args: { baseRevision: "$rev", summary: "Title card, both takes, the picture and the voice", ops } },
    { tool: "transcript_read", args: { media: m.voice } },
    { tool: "project_check", args: {} },
    { text: "Recorded the flow, made the title card and the picture, and placed everything; the voice is transcribed." },
  ];
}
