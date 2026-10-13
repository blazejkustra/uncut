// Types for the Uncut project format (spec/schema/project.schema.json), edit ops
// (spec/schema/edit-ops.schema.json) and module manifests (spec/schema/module.schema.json).
// Written by hand and kept pragmatic: one Item shape with every per-type field optional rather
// than a union per item type. The schemas stay the source of truth; the validator enforces them.
// Format types are readonly (they describe data); the edit engine works on a Mutable copy.

export type Id = string;
export type ModuleId = string;
/** Frames from a start, at the canvas fps. */
export type Frame = number;

export type Mutable<T> = T extends ReadonlyArray<infer U> ? Array<Mutable<U>> : T extends object ? { -readonly [K in keyof T]: Mutable<T[K]> } : T;

export interface Canvas {
  readonly width: number;
  readonly height: number;
  readonly fps: 24 | 25 | 30 | 50 | 60;
  readonly background?: string;
}

export interface ModuleUse {
  readonly module: ModuleId;
  readonly params?: { readonly [key: string]: unknown };
  readonly bypass?: boolean;
}

export interface TimedModule {
  readonly module: ModuleId;
  readonly duration: Frame;
  readonly params?: { readonly [key: string]: unknown };
}

export interface MediaProbe {
  readonly frames?: number;
  readonly fps?: number;
  readonly width?: number;
  readonly height?: number;
  readonly hasAudio?: boolean;
}

export interface Media {
  readonly id: Id;
  readonly kind: "video" | "image" | "audio";
  readonly name: string;
  readonly path: string;
  readonly source?: { readonly module: ModuleId; readonly [key: string]: unknown };
  readonly probe?: MediaProbe;
}

export interface Transform {
  readonly x?: number;
  readonly y?: number;
  readonly w?: number;
  readonly h?: number;
  readonly scale?: number;
  readonly rotate?: number;
  readonly opacity?: number;
  readonly fit?: "contain" | "cover" | "fill";
  /** Clips: corner radius of the box in canvas pixels (D75). */
  readonly radius?: number;
}

export interface TextStyle {
  readonly preset?: ModuleId;
  readonly font?: string;
  readonly size?: number;
  readonly weight?: number;
  readonly tracking?: number;
  readonly lineHeight?: number;
  readonly color?: string;
  readonly align?: "left" | "center" | "right";
  readonly uppercase?: boolean;
  /** D80: false = none (even when the preset's look has one); absent = the look's. */
  readonly stroke?: TextStroke | false;
  readonly shadow?: TextShadow | false;
  readonly background?: TextBackground | false;
}

/** A text's outline (D80): width in canvas px, colour a theme token or CSS colour. */
export interface TextStroke {
  readonly width: number;
  readonly color?: string;
}
/** A text's drop shadow (D80): offsets and blur in canvas px, opacity 0–1. */
export interface TextShadow {
  readonly x?: number;
  readonly y?: number;
  readonly blur?: number;
  readonly color?: string;
  readonly opacity?: number;
}
/** A box behind a text (D80): one box around its text box, or one behind each line; padding (the sides; top and bottom get half) and radius in canvas px. */
export interface TextBackground {
  readonly color?: string;
  readonly opacity?: number;
  readonly padding?: number;
  readonly radius?: number;
  readonly wrap?: "box" | "lines";
}

export type ItemType = "clip" | "component" | "graphic" | "text" | "captions" | "audio";

export interface Item {
  readonly id: Id;
  readonly type: ItemType;
  readonly name?: string;
  /** Free tracks only; main-track items play back to back. */
  readonly start?: Frame;
  readonly duration: Frame;
  readonly locked?: boolean;
  readonly transform?: Transform;
  /** Clips: keyframes of x, y, scale and opacity (D75, box.ts). */
  readonly keys?: ReadonlyArray<{ readonly frame: Frame; readonly ease?: "linear" | "in" | "out" | "inOut"; readonly x?: number; readonly y?: number; readonly scale?: number; readonly opacity?: number; readonly [key: string]: unknown }>;
  readonly transitionIn?: TimedModule;
  readonly animation?: { readonly in?: TimedModule; readonly out?: TimedModule; readonly loop?: TimedModule };
  readonly effects?: ReadonlyArray<ModuleUse>;
  // clip, component, audio
  readonly media?: Id;
  readonly in?: Frame;
  // clip
  readonly speed?: number;
  // clip, audio
  readonly gainDb?: number;
  // component
  readonly component?: ModuleId;
  // component, graphic
  readonly props?: { readonly [key: string]: unknown };
  // graphic
  readonly src?: string;
  // text
  readonly text?: string;
  // text: TextStyle (the schema lists its fields); captions: a free-form object in the schema,
  // so other keys are allowed.
  readonly style?: TextStyle & { readonly [key: string]: unknown };
  // captions (D82): the source media, a snapshot of its transcript words (seconds of the media,
  // where each is heard), corrections by word index, forced card starts and how cards are grouped.
  readonly source?: Id;
  readonly mode?: "line" | "word" | "single";
  readonly words?: ReadonlyArray<{ readonly text: string; readonly start: number; readonly end: number; readonly filler?: boolean }>;
  readonly edits?: ReadonlyArray<{ readonly word: number; readonly text: string }>;
  readonly breaks?: ReadonlyArray<number>;
  readonly lines?: { readonly maxChars?: number; readonly maxLines?: number; readonly maxSeconds?: number; readonly maxWords?: number; readonly pause?: number };
  readonly hideFillers?: boolean;
  /** Captions (D82): draw wherever the source plays on main, whatever start/duration say (set by Make captions). */
  readonly coversMain?: boolean;
  /** Drawn text only (captions' cards, never saved): transform.y is the box's bottom edge, so wrapping grows upward. */
  readonly anchor?: "bottom";
  // clip, audio
  readonly fadeIn?: Frame;
  readonly fadeOut?: Frame;
  /** The media starts over when the item is longer than it (clip: D75). */
  readonly loop?: boolean;
  /** Clips (D94): the media's last frame stays on screen when the clip is longer than it (a freeze); loop wins. */
  readonly hold?: boolean;
  readonly gainKeys?: ReadonlyArray<{ readonly frame: Frame; readonly db: number }>;
}

export interface Mixer {
  readonly gainDb?: number;
  readonly pan?: number;
  readonly mute?: boolean;
  readonly solo?: boolean;
  readonly effects?: ReadonlyArray<ModuleUse>;
}

export interface Track {
  readonly id: Id;
  readonly kind: "video" | "text" | "audio";
  readonly role?: "main";
  readonly name: string;
  readonly locked?: boolean;
  readonly hidden?: boolean;
  readonly mixer?: Mixer;
  readonly items: ReadonlyArray<Item>;
}

export interface Scene {
  readonly id: Id;
  readonly name: string;
  readonly start: Frame;
  readonly end: Frame;
}

export interface Marker {
  readonly frame: Frame;
  readonly label?: string;
}

export interface Project {
  readonly format: string;
  readonly name: string;
  readonly canvas: Canvas;
  readonly theme?: { readonly colors?: Readonly<Record<string, string>>; readonly fonts?: Readonly<Record<string, string>>; readonly margin?: number };
  /** D80: 1 on projects created from D80 on (the older looks' soft shadow isn't drawn there); absent on older ones. */
  readonly textLooks?: number;
  readonly media: ReadonlyArray<Media>;
  readonly tracks: ReadonlyArray<Track>;
  readonly scenes?: ReadonlyArray<Scene>;
  readonly markers?: ReadonlyArray<Marker>;
  /** D83: gainDb is the master volume (−60…+12 dB, after the tracks are summed). */
  readonly master?: { readonly gainDb?: number; readonly loudness?: { readonly targetLufs: number }; readonly effects?: ReadonlyArray<ModuleUse> };
  /** D90: taste checks the project turned off (rule ids from core checks.ts). */
  readonly checks?: { readonly disabled?: ReadonlyArray<string>; readonly [key: string]: unknown };
}

/** Fields an op sets; a null value removes the field. */
export type FieldSet = { readonly [key: string]: unknown };

export type Op =
  | { readonly op: "insert_item"; readonly track: Id; readonly index?: number; readonly item: Item }
  | { readonly op: "update_item"; readonly item: Id; readonly set: FieldSet }
  | { readonly op: "trim_item"; readonly item: Id; readonly edge: "start" | "end"; readonly frames: number }
  | { readonly op: "split_item"; readonly item: Id; readonly at: Frame; readonly newId: Id }
  | { readonly op: "move_item"; readonly item: Id; readonly track?: Id; readonly index?: number; readonly start?: Frame }
  | { readonly op: "delete_item"; readonly item: Id }
  | { readonly op: "set_transition"; readonly item: Id; readonly transition: TimedModule | null }
  // The schema only says "an object" for the new track (the project validator checks the result),
  // so every field is optional here. insert_item's item and add_media's media are also plain
  // objects in the schema but are typed as Item and Media: the engine reads their id and type.
  | { readonly op: "add_track"; readonly track: Partial<Track> & { readonly [key: string]: unknown }; readonly index?: number }
  | { readonly op: "update_track"; readonly track: Id; readonly set: FieldSet }
  | { readonly op: "delete_track"; readonly track: Id }
  | { readonly op: "add_media"; readonly media: Media }
  | { readonly op: "update_project"; readonly set: FieldSet };

export type OpName = Op["op"];
export type Actor = "user" | "agent";

export interface LogEntry {
  readonly revision: number;
  /** ISO time. */
  readonly at: string;
  readonly actor: Actor;
  readonly ops: ReadonlyArray<Op>;
  readonly turnId?: string;
  readonly summary?: string;
}

/** The open project, its revision and the edits that led there. */
export interface Session {
  readonly project: Project;
  readonly revision: number;
  readonly log: ReadonlyArray<LogEntry>;
}

/** One edit: a list of ops applied atomically by one actor. */
export interface Edit {
  readonly actor: Actor;
  readonly ops: ReadonlyArray<Op>;
  /** The revision the actor last saw; defaults to the session's. */
  readonly baseRevision?: number;
  readonly turnId?: string;
  readonly summary?: string;
  readonly at?: string;
}

/** A validation problem. */
export interface Problem {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

export type ModuleKind = "transition" | "move" | "text-style" | "component" | "effect" | "audio-processor" | "analyzer" | "generator" | "capture-source";

/** A module manifest (*.json in a modules directory). Kind-specific blocks are left open. */
export interface ModuleManifest {
  readonly manifest: "uncut.module/0";
  readonly id: ModuleId;
  readonly kind: ModuleKind;
  readonly name: string;
  readonly version: string;
  readonly runtime: unknown;
  /** JSON Schema for the module's params or props. */
  readonly params?: object;
  readonly transition?: { readonly minFrames?: number; readonly maxFrames?: number; readonly [key: string]: unknown };
  readonly [key: string]: unknown;
}

export type Modules = ReadonlyMap<ModuleId, ModuleManifest>;
