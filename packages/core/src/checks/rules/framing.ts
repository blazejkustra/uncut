import { clipBox, hasKeys, type Rect } from "../../visual/box.ts";
import type { Id, Item, Media, Op } from "../../timeline/types.ts";
import { type Check, type CheckContext, type CheckRule, mediaOf, secs, startOf } from "../context.ts";

/** Within this many canvas px, two clips show the picture the same way. */
const FRAMING_PX = 2;

const isCamera = (media: Media) => media.kind === "video" && (media.source?.module === "capture.camera" || /\b(camera|webcam|facecam)\b/i.test(media.name));

const sameFraming = (a: Rect, b: Rect) =>
  Math.abs(a.x - b.x) <= FRAMING_PX && Math.abs(a.y - b.y) <= FRAMING_PX && Math.abs(a.w - b.w) <= FRAMING_PX && Math.abs(a.h - b.h) <= FRAMING_PX;

interface Framing {
  readonly picture: Rect;
  readonly items: Array<Item>;
}

/** Where the whole picture lands at the clip's last frame (fit, scale, keys). */
const pictureOf = (ctx: CheckContext, item: Item, media: Media) =>
  clipBox(item, { ...ctx.project.canvas, fps: ctx.fps }, media.probe, item.duration - 1).content;

function framingsOf(ctx: CheckContext, clips: ReadonlyArray<Item>, media: Media): Array<Framing> {
  const out: Array<Framing> = [];
  for (const item of clips) {
    const picture = pictureOf(ctx, item, media);
    const same = out.find((f) => sameFraming(f.picture, picture));
    if (same) same.items.push(item);
    else out.push({ picture, items: [item] });
  }
  return out;
}

function difference(base: Rect, picture: Rect): string {
  const zoom = picture.w / base.w;
  if (Math.abs(zoom - 1) > 0.005) return `${zoom > 1 ? "zoomed in" : "zoomed out"} ${Math.round(Math.abs(zoom - 1) * 100)}%`;
  return `moved ${Math.round(Math.hypot(picture.x - base.x, picture.y - base.y))} px`;
}

/** The fix: each odd clip without box keys gets the transform of a clip framed the common way. */
function framingFix(base: Framing, odd: ReadonlyArray<Item>, locked: (item: Item) => boolean) {
  const model = base.items.find((i) => !hasKeys(i));
  if (!model) return undefined;
  const ops: Array<Op> = odd
    .filter((i) => !hasKeys(i) && !locked(i))
    .map((i) => ({ op: "update_item", item: i.id, set: { transform: model.transform ? { ...model.transform } : null } }));
  return ops.length ? { summary: `Frame every clip of the camera like ${model.id}`, ops } : undefined;
}

/** Picture rules: how footage is framed. */
export const FRAMING_RULES: ReadonlyArray<CheckRule> = [
  {
    id: "camera-framing",
    title: "One framing per camera",
    description: "Clips of one camera take on a track show the person the same size and in the same place.",
    severity: "warn",
    check: (ctx) => {
      const out: Array<Omit<Check, "id" | "severity">> = [];
      for (const track of ctx.project.tracks) {
        if (track.hidden || track.kind !== "video") continue;
        const byMedia = new Map<Id, Array<Item>>();
        for (const item of track.items) {
          const media = item.type === "clip" ? mediaOf(ctx, item) : undefined;
          if (media && isCamera(media)) byMedia.set(media.id, [...(byMedia.get(media.id) ?? []), item]);
        }
        for (const [id, clips] of byMedia) {
          const media = ctx.media.get(id)!;
          const framings = framingsOf(ctx, clips, media);
          if (framings.length < 2) continue;
          // The common framing wins; on a tie, the least zoomed one.
          const base = [...framings].sort((a, b) => b.items.length - a.items.length || a.picture.w - b.picture.w)[0]!;
          const odd = framings.filter((f) => f !== base).flatMap((f) => f.items.map((item) => ({ item, picture: f.picture })));
          const fix = framingFix(
            base,
            odd.map((o) => o.item),
            (i) => track.locked === true || i.locked === true,
          );
          out.push({
            key: `camera-framing:${track.id}:${id}`,
            message: `${odd.length} of ${clips.length} clips of ${media.name} are framed differently from the rest: ${odd.map((o) => `${o.item.id} at ${secs(startOf(ctx, o.item), ctx.fps)} (${difference(base.picture, o.picture)})`).join(", ")}.`,
            itemIds: odd.map((o) => o.item.id),
            frame: Math.min(...odd.map((o) => startOf(ctx, o.item))),
            ...(fix ? { fix } : {}),
            hint: "Give every clip of one camera the same framing (change all of them, not only the one asked about), or say why a punch-in is on purpose.",
          });
        }
      }
      return out;
    },
  },
];
