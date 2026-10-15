// Issue #63 (D234): the Generate tab's models per type. The ones that work come from the server
// (generate.list: Claude's SVG/HTML, GPT Image, Veo, Sound effects); this file only dresses them
// (brand, display name) and adds the models that aren't wired up yet, shown as Coming soon with
// their real options visible but disabled so the design has room for them. A coming-soon model
// never reaches startGenerate (its id starts with "soon.", and the tab can't run it).
import type { GeneratorInfo } from "@uncut/contracts";

export type GenType = "image" | "video" | "audio";
export type Brand = "claude" | "openai" | "google" | "xai" | "bytedance" | "elevenlabs" | "higgsfield" | "other";

/** One option a model takes, shown as chips, image slots, a switch or a text field. */
export type ModelOption =
  | { readonly kind: "chips"; readonly label: string; readonly values: ReadonlyArray<string> }
  | { readonly kind: "frames"; readonly label: string; readonly slots: ReadonlyArray<string> }
  | { readonly kind: "toggle"; readonly label: string }
  | { readonly kind: "text"; readonly label: string; readonly placeholder: string };

export interface Model {
  /** The server's generator id, "title-card" (generate.svg with the title prefix) or "soon.*". */
  readonly id: string;
  /** What runs it on the server (generate.svg for the title card); undefined when coming soon. */
  readonly generator?: string;
  readonly name: string;
  /** The lab, as a word under the name: "Anthropic", "xAI". */
  readonly lab: string;
  readonly brand: Brand;
  /** The server's row when it's wired up. */
  readonly info?: GeneratorInfo;
  /** Its options when it's coming soon (a wired model's come from info: sizes, seconds). */
  readonly options?: ReadonlyArray<ModelOption>;
  readonly soon: boolean;
}

export const TITLE_PREFIX = "Title card: ";
export const TITLE_CARD = "title-card";

/** How each wired generator is shown, per type (Claude's generator makes stills and animations). */
const WIRED: Record<string, { name: Partial<Record<GenType, string>>; lab: string; brand: Brand }> = {
  "generate.svg": { name: { image: "Drawn by Claude", video: "Animation by Claude" }, lab: "Anthropic", brand: "claude" },
  "generate.gpt-image": { name: { image: "GPT Image" }, lab: "OpenAI", brand: "openai" },
  "generate.veo": { name: { video: "Veo" }, lab: "Google", brand: "google" },
  "generate.sound": { name: { audio: "Sound effects" }, lab: "ElevenLabs", brand: "elevenlabs" },
};

const ASPECTS = ["16:9", "9:16", "1:1", "4:3", "3:4"];

/** Models that aren't wired up yet, with the options their APIs take. */
const SOON: Record<GenType, ReadonlyArray<Omit<Model, "soon">>> = {
  image: [
    {
      id: "soon.nano-banana",
      name: "Nano Banana",
      lab: "Google",
      brand: "google",
      options: [
        { kind: "frames", label: "References", slots: ["Image 1", "Image 2", "Image 3"] },
        { kind: "chips", label: "Aspect", values: [...ASPECTS, "21:9"] },
      ],
    },
    {
      id: "soon.imagen",
      name: "Imagen 4",
      lab: "Google",
      brand: "google",
      options: [
        { kind: "chips", label: "Quality", values: ["Fast", "Standard", "Ultra"] },
        { kind: "chips", label: "Aspect", values: ASPECTS },
        { kind: "chips", label: "Count", values: ["1", "2", "3", "4"] },
      ],
    },
    {
      id: "soon.grok-image",
      name: "Grok Imagine",
      lab: "xAI",
      brand: "xai",
      options: [
        { kind: "chips", label: "Aspect", values: ASPECTS },
        { kind: "chips", label: "Count", values: ["1", "2", "4"] },
      ],
    },
    {
      id: "soon.seedream",
      name: "Seedream",
      lab: "ByteDance",
      brand: "bytedance",
      options: [
        { kind: "frames", label: "References", slots: ["Image 1", "Image 2", "Image 3"] },
        { kind: "chips", label: "Resolution", values: ["1K", "2K", "4K"] },
        { kind: "chips", label: "Aspect", values: [...ASPECTS, "21:9"] },
      ],
    },
  ],
  video: [
    {
      id: "soon.grok-video",
      name: "Grok Imagine",
      lab: "xAI",
      brand: "xai",
      options: [
        { kind: "frames", label: "Frames", slots: ["First frame", "Last frame"] },
        { kind: "chips", label: "Length", values: ["6 s", "10 s", "15 s"] },
        { kind: "chips", label: "Aspect", values: ASPECTS },
        { kind: "chips", label: "Resolution", values: ["480p", "720p"] },
      ],
    },
    {
      id: "soon.seedance",
      name: "Seedance",
      lab: "ByteDance",
      brand: "bytedance",
      options: [
        { kind: "frames", label: "Frames", slots: ["First frame", "Last frame"] },
        { kind: "chips", label: "Length", values: ["5 s", "10 s"] },
        { kind: "chips", label: "Aspect", values: [...ASPECTS, "21:9"] },
        { kind: "chips", label: "Resolution", values: ["480p", "720p", "1080p"] },
        { kind: "toggle", label: "Keep the camera still" },
      ],
    },
    {
      id: "soon.higgsfield",
      name: "Higgsfield",
      lab: "Higgsfield",
      brand: "higgsfield",
      options: [
        { kind: "frames", label: "Frames", slots: ["First frame"] },
        { kind: "chips", label: "Motion", values: ["Dolly in", "Crash zoom", "Orbit", "Crane up", "FPV drone"] },
        { kind: "chips", label: "Model", values: ["Lite", "Standard", "Turbo"] },
        { kind: "chips", label: "Length", values: ["5 s"] },
      ],
    },
    {
      id: "soon.sora",
      name: "Sora 2",
      lab: "OpenAI",
      brand: "openai",
      options: [
        { kind: "frames", label: "Frames", slots: ["First frame"] },
        { kind: "chips", label: "Length", values: ["4 s", "8 s", "12 s"] },
        { kind: "chips", label: "Size", values: ["1280×720", "720×1280"] },
        { kind: "chips", label: "Model", values: ["Sora 2", "Sora 2 Pro"] },
      ],
    },
  ],
  audio: [
    {
      id: "soon.music",
      name: "Music",
      lab: "ElevenLabs",
      brand: "elevenlabs",
      options: [
        { kind: "chips", label: "Length", values: ["30 s", "1 min", "2 min", "3 min"] },
        { kind: "toggle", label: "Instrumental only" },
      ],
    },
    {
      id: "soon.voice",
      name: "Voiceover",
      lab: "ElevenLabs",
      brand: "elevenlabs",
      options: [
        { kind: "chips", label: "Model", values: ["Eleven v3", "Multilingual v2", "Flash v2.5"] },
        { kind: "chips", label: "Voice", values: ["Choose a voice"] },
        { kind: "chips", label: "Speed", values: ["0.8×", "1×", "1.2×"] },
      ],
    },
    {
      id: "soon.lyria",
      name: "Lyria 2",
      lab: "Google",
      brand: "google",
      options: [
        { kind: "chips", label: "Length", values: ["30 s"] },
        { kind: "text", label: "Leave out", placeholder: "Drums, vocals" },
      ],
    },
  ],
};

/** The models for a type: the ones that work (Claude's first, then the keyed ones), then Coming soon. */
export function modelsFor(generators: ReadonlyArray<GeneratorInfo>, type: GenType): Array<Model> {
  const wired = generators
    .filter((g) => g.kinds.includes(type))
    .sort((a, b) => Number(!!a.provider) - Number(!!b.provider))
    .flatMap((g): Array<Model> => {
      const look = WIRED[g.id];
      const row: Model = { id: g.id, generator: g.id, name: look?.name[type] ?? g.name, lab: look?.lab ?? g.provider ?? "Plugin", brand: look?.brand ?? "other", info: g, soon: false };
      // Claude's generator also makes title cards (a still with the title prefix).
      if (g.id === "generate.svg" && type === "image") return [row, { ...row, id: TITLE_CARD, name: "Title card by Claude" }];
      return [row];
    });
  return [...wired, ...SOON[type].map((m) => ({ ...m, soon: true }))];
}

/** The model to show first for a type: a ready one, else a wired one that needs its key, never a coming-soon one. */
export const firstModel = (models: ReadonlyArray<Model>) => models.find((m) => m.info?.ready) ?? models.find((m) => !m.soon) ?? models[0];
