// The Inspector's clip box editor (D75): fit, position, size, keys.
import type { Item } from "@uncut/core/types";
import { ChevronLeft, ChevronRight, Diamond, RotateCcw, X } from "lucide-react";
import type { Fit, KeyProp } from "@uncut/core/box";
import { useRef } from "react";

import { getPlayback, playback, usePlayback, type PreviewDraft } from "../preview/playback.ts";
import { clipState, EASE_NAMES, keyEase, keyFrames, keyState, nearbyKey, planClipBox, planHold, planKeyEase, planLoop, planResetBox, planToggleKey, PROP_NAMES, type BoxPatch } from "../timeline/clip.ts";
import { type ProjectModel } from "../state/project.ts";
import { showDraft, send, NumberField, Slider, Group } from "./fields.tsx";
import { Tooltip } from "../ui/Tooltip.tsx";

const FITS: ReadonlyArray<readonly [Fit, string, string]> = [
  ["contain", "Contain", "All of the picture inside the box"],
  ["cover", "Cover", "Fill the box; what doesn't fit is cut off"],
  ["fill", "Fill", "Stretch the picture to the box"],
];

/** A keyframe diamond (D75): filled with a key at the playhead, outlined when the property has keys elsewhere. */
function KeyButton({ project, item, prop, local, inside, disabled }: { project: ProjectModel; item: Item; prop: KeyProp; local: number; inside: boolean; disabled: boolean }) {
  const state = keyState(item, prop, local);
  const title = !inside ? "Move the playhead over the clip to add a key" : state === "on" ? `Remove the ${PROP_NAMES[prop]} key at the playhead` : `Add a ${PROP_NAMES[prop]} key at the playhead`;
  return (
    <Tooltip label={title}>
      <button
        className={`icon-btn key-btn ${state}`}
        data-testid="insp-key"
        data-prop={prop}
        data-state={state}
        disabled={disabled || !inside}
        onClick={() => send((p) => planToggleKey(p, item.id, prop, getPlayback().frame))}
      >
        <Diamond />
      </button>
    </Tooltip>
  );
}

/**
 * A clip's box (D75): position and size in canvas pixels, fit, scale (zoom inside the box),
 * opacity, corner radius, keys for x / y / scale / opacity at the playhead, loop, and Reset. Each
 * change is one edit; sliders show a local draft while they move and commit once on release.
 */
export function ClipBoxEditor({ project, item, locked }: { project: ProjectModel; item: Item; locked: boolean }) {
  const frame = usePlayback((s) => Math.round(s.frame));
  // A component (D76) has a box and opacity; fit, zoom, corners and loop are a clip's.
  const component = item.type === "component";
  const state = clipState(project, item.id, frame);
  const scaleDraft = useRef<PreviewDraft | undefined>(undefined);
  const opacityDraft = useRef<PreviewDraft | undefined>(undefined);
  if (!state) return null;
  const { box, local, inside } = state;
  const media = item.media ? project.media.find((m) => m.id === item.media) : undefined;
  const edit = (patch: BoxPatch, summary?: string, d?: PreviewDraft) => send((p) => planClipBox(p, item.id, patch, getPlayback().frame, summary), d);
  const key = (prop: KeyProp) => <KeyButton project={project} item={item} prop={prop} local={local} inside={inside} disabled={locked} />;
  const radius = typeof item.transform?.radius === "number" ? item.transform.radius : 0;
  return (
    <div data-testid="clip-box-editor">
      <Group label="Position & size">
        <div className="field-row key-row">
          <NumberField label="X" testId="insp-box-x" value={Math.round(box.x)} disabled={locked} onCommit={(v) => v !== undefined && edit({ x: v })} />
          {key("x")}
          <NumberField label="Y" testId="insp-box-y" value={Math.round(box.y)} disabled={locked} onCommit={(v) => v !== undefined && edit({ y: v })} />
          {key("y")}
        </div>
        <div className="field-row">
          <NumberField label="W" testId="insp-box-w" value={Math.round(box.w)} min={1} disabled={locked} onCommit={(v) => v !== undefined && edit({ w: v })} />
          <NumberField label="H" testId="insp-box-h" value={Math.round(box.h)} min={1} disabled={locked} onCommit={(v) => v !== undefined && edit({ h: v })} />
        </div>
        {!component && (
          <div className="seg fit" role="group">
            {FITS.map(([fit, label, title]) => (
              <button key={fit} className={box.fit === fit ? "active" : ""} data-testid="insp-fit" data-fit={fit} title={title} disabled={locked} onClick={() => edit({ fit })}>
                {label}
              </button>
            ))}
          </div>
        )}
      </Group>
      <Group label={component ? "Opacity" : "Scale and opacity"}>
        {!component && (
        <div className="slider-row key-row">
          <Slider
            testId="insp-scale"
            value={Math.round(box.scale * 100)}
            min={10}
            max={400}
            title="Zoom inside the box"
            disabled={locked}
            onPreview={(v) => (scaleDraft.current = showDraft(project, planClipBox(project, item.id, { scale: v / 100 }, frame)) ?? scaleDraft.current)}
            onCommit={(v) => {
              const d = scaleDraft.current;
              scaleDraft.current = undefined;
              edit({ scale: v / 100 }, undefined, d);
            }}
          />
          <NumberField label="Scale %" testId="insp-scale-num" value={Math.round(box.scale * 100)} min={5} max={2000} disabled={locked} onCommit={(v) => v !== undefined && edit({ scale: v / 100 })} />
          {key("scale")}
        </div>
        )}
        <div className="slider-row key-row">
          <Slider
            testId="insp-opacity"
            value={Math.round(box.opacity * 100)}
            min={0}
            max={100}
            disabled={locked}
            onPreview={(v) => (opacityDraft.current = showDraft(project, planClipBox(project, item.id, { opacity: v / 100 }, frame)) ?? opacityDraft.current)}
            onCommit={(v) => {
              const d = opacityDraft.current;
              opacityDraft.current = undefined;
              edit({ opacity: v / 100 }, undefined, d);
            }}
          />
          <NumberField label="Opacity %" testId="insp-opacity-num" value={Math.round(box.opacity * 100)} min={0} max={100} disabled={locked} onCommit={(v) => v !== undefined && edit({ opacity: v / 100 })} />
          {key("opacity")}
        </div>
        {!component && (
          <div className="field-row">
            <NumberField label="Radius" testId="insp-radius" value={radius} min={0} disabled={locked} onCommit={(v) => edit({ radius: v ?? 0 })} />
          </div>
        )}
      </Group>
      {keyFrames(item).length > 0 && <KeysGroup project={project} item={item} local={local} inside={inside} locked={locked} />}
      <div className="group">
        {media?.kind === "video" && (
          <label className="check-row">
            <input type="checkbox" data-testid="insp-loop" checked={item.loop === true} disabled={locked} onChange={(e) => {
                const on = e.target.checked;
                send((p) => planLoop(p, item.id, on));
              }} />
            Loop the footage when the clip is longer
          </label>
        )}
        {media?.kind === "video" && (
          <label className="check-row">
            <input type="checkbox" data-testid="insp-hold" checked={item.hold === true} disabled={locked || item.loop === true} onChange={(e) => {
                const on = e.target.checked;
                send((p) => planHold(p, item.id, on));
              }} />
            Hold the last frame when the clip is longer
          </label>
        )}
        <button className="btn" data-testid="insp-box-reset" disabled={locked || (!item.transform && !item.keys)} onClick={() => send((p) => planResetBox(p, item.id))}>
          <RotateCcw />
          Reset position and size
        </button>
      </div>
    </div>
  );
}

/**
 * The clip's keys (F5, D148): previous and next key (also [ and ]), and with the playhead on a key
 * its ease, how it moves on to the next key (the same curve in the preview and the export).
 */
function KeysGroup({ project, item, local, inside, locked }: { project: ProjectModel; item: Item; local: number; inside: boolean; locked: boolean }) {
  const frames = keyFrames(item);
  const ease = inside ? keyEase(item, local) : undefined;
  const go = (dir: -1 | 1) => {
    const to = nearbyKey(project, getPlayback().frame, dir, [item.id]);
    if (to !== undefined) (playback.pause(), playback.seek(to));
  };
  const start = (clipState(project, item.id, getPlayback().frame)?.start ?? 0);
  const at = start + local;
  return (
    <Group label={`Keys (${frames.length})`}>
      <div className="field-row key-nav" data-testid="insp-keys" data-count={frames.length}>
        <Tooltip label="Previous key" shortcut="prevKey">
          <button className="icon-btn" data-testid="insp-key-prev" disabled={!frames.some((f) => start + f < at)} onClick={() => go(-1)}>
            <ChevronLeft />
          </button>
        </Tooltip>
        <span className="mono small" data-testid="insp-key-at">{ease ? `Key at ${(local / project.canvas.fps).toFixed(2)} s` : "Between keys"}</span>
        <Tooltip label="Next key" shortcut="nextKey">
          <button className="icon-btn" data-testid="insp-key-next" disabled={!frames.some((f) => start + f > at)} onClick={() => go(1)}>
            <ChevronRight />
          </button>
        </Tooltip>
      </div>
      {ease && (
        <div className="seg ease" role="group" aria-label="Ease to the next key" data-testid="insp-key-ease" data-ease={ease}>
          {EASE_NAMES.map(([e, label]) => (
            <button key={e} className={ease === e ? "active" : ""} data-testid="insp-ease" data-ease={e} title={`${label} to the next key`} disabled={locked} onClick={() => send((p) => planKeyEase(p, item.id, local, e))}>
              {label}
            </button>
          ))}
        </div>
      )}
    </Group>
  );
}
