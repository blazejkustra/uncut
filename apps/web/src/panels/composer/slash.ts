// The composer's / menu (D232, issue #111): the installed skills (a picked one goes in as /name),
// then a "Templates" group (a picked one is filled from the project and lands in the composer as a
// brief). One list, so the arrows and Enter walk across both groups. Pure, for the tests.

export interface SlashSkill {
  readonly kind: "skill";
  readonly id: string;
  readonly name: string;
  readonly description: string;
}
export interface SlashTemplate {
  readonly kind: "template";
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly builtin: boolean;
}
export type SlashItem = SlashSkill | SlashTemplate;

/** Skills at most, then templates at most, in the menu. */
export const SLASH_SKILLS_MAX = 12;
export const SLASH_TEMPLATES_MAX = 8;

const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-");

/**
 * The menu for what's typed after /: skills whose id starts with it first, then the ones whose id
 * or name has it; the same for templates by id or name (a dashed query matches spaced words:
 * "beat-cut" finds "Beat-cut reel", "one-shape" finds "One shape, never cut").
 */
export function slashItems(q: string, skills: ReadonlyArray<{ readonly id: string; readonly name: string; readonly description: string }>, templates: ReadonlyArray<{ readonly id: string; readonly name: string; readonly description: string; readonly builtin?: boolean | undefined }>): Array<SlashItem> {
  const rank = <T extends { readonly id: string; readonly name: string }>(all: ReadonlyArray<T>) => [
    ...all.filter((x) => x.id.startsWith(q) || words(x.name).startsWith(q)),
    ...all.filter((x) => !(x.id.startsWith(q) || words(x.name).startsWith(q)) && (x.id.includes(q) || words(x.name).includes(q))),
  ];
  return [
    ...rank(skills).slice(0, SLASH_SKILLS_MAX).map((x): SlashSkill => ({ kind: "skill", id: x.id, name: x.name, description: x.description })),
    ...rank(templates).slice(0, SLASH_TEMPLATES_MAX).map((x): SlashTemplate => ({ kind: "template", id: x.id, name: x.name, description: x.description, builtin: !!x.builtin })),
  ];
}
