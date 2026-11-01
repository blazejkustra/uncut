import type { Item, TimedModule } from "../types.ts";

const CROSSFADE = "transition.crossfade";

export const sameTransition = (transition: TimedModule) => transition.module === CROSSFADE;

/** What an interchange file can't carry of an item, as sentences. */
export function itemLosses(item: Item): ReadonlyArray<string> {
  const name = item.name ?? item.id;
  const lost: Array<string> = [];
  if (item.effects?.some((e) => !e.bypass)) lost.push(`${name}'s effects and colour are left out.`);
  if (item.keys?.length) lost.push(`${name}'s keyframes are left out.`);
  if (item.transform && Object.keys(item.transform).length) lost.push(`${name}'s position, size and opacity are left out.`);
  if (item.speed !== undefined && item.speed !== 1) lost.push(`${name} plays at normal speed: its speed change is left out.`);
  if (item.animation) lost.push(`${name}'s animation is left out.`);
  if (item.loop) lost.push(`${name}'s loop is left out.`);
  return lost;
}
