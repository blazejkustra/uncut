// Issue #63 (D234): the Generate tab's models per type. The ones that work come from the server
// (generate.list: the SVG/HTML generator, GPT Image, Veo, Sound effects); this file only dresses them
// (brand, display name) and adds the models that aren't wired up yet, shown as Coming soon with
// their real options visible but disabled so the design has room for them. A coming-soon model
// never reaches startGenerate (its id starts with "soon.", and the tab can't run it).
import type { GeneratorInfo } from "@uncut/contracts";

export type GenType = "image" | "video" | "audio";
export type Brand = "claude" | "openai" | "google" | "elevenlabs" | "other";

/** One option a model takes, shown as chips, image slots, a switch or a text field. */
export type ModelOption =
  | { readonly kind: "chips"; readonly label: string; readonly values: ReadonlyArray<string> }
  | { readonly kind: "frames"; readonly label: string; readonly slots: ReadonlyArray<string> }
  | { readonly kind: "toggle"; readonly label: string }
  | { readonly kind: "text"; readonly label: string; readonly placeholder: string };

export interface Model {
  /** The server's generator id, or "soon.*". */
  readonly id: string;
  /** What runs it on the server; undefined when coming soon. */
  readonly generator?: string;
  readonly name: string;
  /** Who makes it, as a word ("OpenAI", "Google"); for the key-free generator, what it runs on ("Claude Code"). */
  readonly lab: string;
  /** What a generated tile credits (Media › Generated); default "<name>, <lab>". */
  readonly credit?: string;
  readonly brand: Brand;
  /** The server's row when it's wired up. */
  readonly info?: GeneratorInfo;
  /** Its options when it's coming soon (a wired model's come from info: sizes, seconds). */
  readonly options?: ReadonlyArray<ModelOption>;
  readonly soon: boolean;
}

/** How each wired generator is shown, per type (the SVG generator makes stills and animations). */
// D277 (#103): no "Claude" or "Anthropic" in a feature's name; the SVG generator says in plain
// words that it runs on the user's Claude Code.
const WIRED: Record<string, { name: Partial<Record<GenType, string>>; lab: string; credit?: string; brand: Brand }> = {
  "generate.svg": { name: { image: "SVG drawing", video: "Vector animation" }, lab: "Claude Code", credit: "Made with Claude Code", brand: "claude" },
  "generate.gpt-image": { name: { image: "GPT Image" }, lab: "OpenAI", brand: "openai" },
  "generate.veo": { name: { video: "Veo" }, lab: "Google", brand: "google" },
  "generate.sound": { name: { audio: "Sound effects" }, lab: "ElevenLabs", brand: "elevenlabs" },
};

/**
 * Models that aren't wired up yet, with the options their APIs take. D277 (#103): only generic ones
 * from a provider Uncut already works with; no other brand-named model is listed as coming soon.
 */
const SOON: Record<GenType, ReadonlyArray<Omit<Model, "soon">>> = {
  image: [],
  video: [],
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
  ],
};

/** The models for a type: the ones that work (the key-free one first, then the keyed ones), then Coming soon. */
export function modelsFor(generators: ReadonlyArray<GeneratorInfo>, type: GenType): Array<Model> {
  const wired = generators
    .filter((g) => g.kinds.includes(type))
    .sort((a, b) => Number(!!a.provider) - Number(!!b.provider))
    .map((g): Model => {
      // D268 (#97): no separate title card row; titles are text items the agent makes.
      const look = WIRED[g.id];
      return { id: g.id, generator: g.id, name: look?.name[type] ?? g.name, lab: look?.lab ?? g.provider ?? "Plugin", ...(look?.credit ? { credit: look.credit } : {}), brand: look?.brand ?? "other", info: g, soon: false };
    });
  return [...wired, ...SOON[type].map((m) => ({ ...m, soon: true }))];
}

/** The model to show first for a type: a ready one, else a wired one that needs its key, never a coming-soon one. */
export const firstModel = (models: ReadonlyArray<Model>) => models.find((m) => m.info?.ready) ?? models.find((m) => !m.soon) ?? models[0];
