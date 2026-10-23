import { AtSign, AudioLines, AudioWaveform, Image as ImageIcon, Film, Plus, RefreshCw, Sparkles, X } from "lucide-react";
import React, { useState, useRef, useEffect, type ReactNode } from "react";
import { timecode } from "../../state/format.ts";
import { type MediaItem, useApp, isRemote, actions, getState, activeAnalyses, thumbUrl, mediaUrl, proxyOf, proxyUrl } from "../../state/store.ts";
import { useProxiesOn } from "../../settings/proxies.ts";
import { MEDIA_DRAG_TYPE } from "../../timeline/dnd.ts";
import { openMenu } from "../../timeline/ContextMenu.tsx";
import { RenameField } from "../../timeline/RenameField.tsx";
import { analysisText } from "../../state/analysisText.ts";
import { actionFor, keymap, keyOf } from "../../editor/keymap.ts";
import { Tooltip } from "../../ui/Tooltip.tsx";
import { getPlayback, playback } from "../../preview/playback.ts";
import "./mediaChat.css";

/** "59.94", "30", "23.98" */
const fpsLabel = (fps: number) => String(Math.round(fps * 100) / 100);

/** "3840×2160, 59.94 fps" for video, "4096×3072" for images, "Audio" for sound. */
export function mediaMeta(m: MediaItem) {
  const size = m.probe?.width && m.probe?.height ? `${m.probe.width}×${m.probe.height}` : undefined;
  if (m.kind === "audio") return "Audio";
  if (m.kind === "image") return size ?? "Image";
  return [size, m.probe?.fps ? `${fpsLabel(m.probe.fps)} fps` : undefined].filter(Boolean).join(", ");
}

/** What a tile in Media › Generated adds (D240, #74): its prompt and model, Again and Edit prompt. */
export type GeneratedTileInfo = {
  readonly prompt: string;
  /** "GPT Image, OpenAI"; "Made with Claude Code" for the SVG generator */
  readonly by: string;
  /** Again works (the model's key is set and there is a prompt). */
  readonly canAgain: boolean;
  readonly againTitle: string;
  readonly again: () => void;
  readonly edit: () => void;
};

/** D240 (#73): the Analyze button's tooltip; it used to be an unexplained speedometer. */
export const ANALYZE_TITLE = "Analyse the sound: find its silences and loudness (used for silence cuts and auto-ducking)";

export function MediaTile({ item, fps, online, used, selected, onSelect, onRemove, generated }: { item: MediaItem; fps: number; online: boolean; used: boolean; selected: boolean; onSelect: () => void; onRemove: () => void; generated?: GeneratedTileInfo }) {
  const app = useApp();
  const { thumbIds } = app;
  // G4: renamed in place (double-click the name, or Rename in its menu).
  const [renaming, setRenaming] = useState(false);
  const tileRef = useRef<HTMLDivElement>(null);
  // "Show in Media" (T7): scrolled into view and flashed.
  const focusSeq = app.mediaFocus?.id === item.id ? app.mediaFocus.seq : undefined;
  const [flash, setFlash] = useState(false);
  useEffect(() => {
    if (focusSeq === undefined) return;
    tileRef.current?.scrollIntoView({ block: "nearest" });
    setFlash(true);
    const t = setTimeout(() => setFlash(false), 1200);
    return () => clearTimeout(t);
  }, [focusSeq]);
  const menu = (e: React.MouseEvent) => {
    e.preventDefault();
    const local = !isRemote();
    openMenu(e.clientX, e.clientY, [
      // D264 (#77): the media (or a generated picture) as a chip in the Agent tab's composer.
      { id: "media-add-to-chat", label: "Add to chat", run: () => void actions.addMediaToChat(item.id) },
      "-",
      ...(generated
        ? [
            { id: "generated-add", label: "Add at playhead", disabled: !online, run: () => void actions.addAtPlayhead(item.id) },
            { id: "generated-again", label: "Make again", disabled: !online || !generated.canAgain, run: generated.again },
            { id: "generated-edit", label: "Edit prompt", disabled: !online, run: generated.edit },
          ]
        : [{ id: "media-add", label: "Add to timeline", disabled: !online, run: () => void actions.addMedia(item.id) }]),
      { id: "media-rename", label: "Rename", disabled: !online, run: () => setRenaming(true) },
      ...(local ? [{ id: "media-reveal", label: "Reveal in Finder", run: () => void actions.showInFolder(item.path.startsWith("/") ? item.path : `${getState().snapshot?.dir ?? ""}/${item.path}`) }] : []),
      "-",
      { id: "media-remove", label: "Remove from project", shortcut: "⌫", danger: true, disabled: !online, run: onRemove },
    ], "Media");
  };
  // Analysis (D66) runs on demand: the Analyze button, or the agent's media_analyze.
  const analysis = activeAnalyses(app, item.id)[0];
  const hasSound = !generated && (item.kind === "audio" || (item.kind === "video" && item.probe?.hasAudio !== false));
  const [broken, setBroken] = useState(false);
  const Icon = item.kind === "audio" ? AudioLines : item.kind === "image" ? ImageIcon : Film;
  // An SVG has no poster (ffmpeg can't read it): the tile shows the file itself (D76).
  const src = thumbIds.has(item.id) ? thumbUrl(item.id, item.path) : item.kind === "image" && /\.svg$/i.test(item.path) ? mediaUrl(item.id, item.path) : undefined;
  const seconds = item.probe?.frames ? item.probe.frames / fps : undefined;
  // D212: the preview proxy of heavy footage (made in the background after import).
  const proxy = proxyOf(app, item.id);
  const proxiesOn = useProxiesOn();
  // F26 (D168): hovering a video's thumbnail scrubs through it (one muted video, only while hovered).
  const [scrub, setScrub] = useState<number | undefined>(undefined);
  const scrubRef = useRef<HTMLVideoElement>(null);
  const canScrub = item.kind === "video" && !!seconds && !renaming;
  useEffect(() => {
    const v = scrubRef.current;
    if (!v || scrub === undefined || !seconds) return;
    const t = Math.min(seconds - 0.05, Math.max(0, scrub * seconds));
    if (v.readyState >= 1) v.currentTime = t;
    else v.onloadedmetadata = () => (v.currentTime = t);
  }, [scrub, seconds]);
  // A tile that goes while skimmed (removed, another project) leaves the preview to the playhead.
  useEffect(() => () => void (getPlayback().hoverMedia?.media === item.id && playback.hoverMedia(undefined)), [item.id]);
  return (
    <div
      className={`tile ${flash ? "flash" : ""} ${selected ? "selected" : ""}${generated ? " gen-tile" : ""}`}
      data-testid={generated ? "generated-item" : "media-tile"}
      data-id={item.id}
      data-used={used ? "true" : undefined}
      data-selected={selected ? "true" : undefined}
      title={generated ? `${item.name}\n${generated.prompt || "No prompt saved"}\n${generated.by}` : item.path}
      ref={tileRef}
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        // D264: the add-to-chat key (⌘L) on the focused tile adds this media, not the timeline's selection.
        if (e.target === e.currentTarget) {
          const pressed = keyOf(e.nativeEvent);
          if (pressed !== undefined && actionFor(keymap.bindings(), pressed) === "addToChat") {
            e.preventDefault();
            e.stopPropagation();
            if (!e.repeat) actions.addMediaToChat(item.id);
            return;
          }
        }
        // ⌫ / Delete on the selected tile (not while its name is edited): Remove from project, never the timeline's selection.
        if (e.target !== e.currentTarget || (e.key !== "Backspace" && e.key !== "Delete")) return;
        e.preventDefault();
        e.stopPropagation();
        onRemove();
      }}
      onContextMenu={(e) => {
        onSelect();
        menu(e);
      }}
      draggable={online && !renaming}
      onDragStart={(e) => {
        e.dataTransfer.setData(MEDIA_DRAG_TYPE, item.id);
        e.dataTransfer.effectAllowed = "copy";
      }}
    >
      <div
        className="thumb"
        onPointerMove={(e) => {
          if (!canScrub) return;
          const r = e.currentTarget.getBoundingClientRect();
          const at = Math.min(1, Math.max(0, (e.clientX - r.left) / Math.max(1, r.width)));
          setScrub(at);
          // Issue #118: and the main preview shows that frame too (skimming), while no button is held.
          if (e.buttons === 0) playback.hoverMedia(item.id, Math.min(seconds! - 0.05, Math.max(0, at * seconds!)));
        }}
        onPointerLeave={() => {
          setScrub(undefined);
          playback.hoverMedia(undefined);
        }}
        onPointerDown={() => playback.hoverMedia(undefined)}
      >
        {src && !broken ? <img key={src} src={src} alt="" draggable={false} onError={() => setBroken(true)} data-testid="thumb" /> : <Icon />}
        {canScrub && scrub !== undefined && (
          <>
            <video ref={scrubRef} className="thumb-scrub" data-testid="thumb-scrub" src={proxiesOn && proxy?.phase === "done" && proxy.key ? proxyUrl(item.id, proxy.key) : mediaUrl(item.id, item.path)} muted playsInline preload="auto" />
            <span className="thumb-scrub-bar" style={{ left: `${scrub * 100}%` }} />
          </>
        )}
        {used && (
          <span className="tile-used" data-testid="media-used" title="On the timeline">
            Used
          </span>
        )}
        {generated && (
          <span className="tile-gen-badge" data-testid="generated-badge" title="Generated: made in the Generate tab" aria-label="Generated" role="img">
            <Sparkles />
          </span>
        )}
        {proxy && proxy.phase !== "failed" && !generated && (
          <span
            className={`tile-proxy ${proxy.phase}`}
            data-testid="media-proxy"
            data-phase={proxy.phase}
            title={proxy.phase === "done" ? (proxiesOn ? "The preview plays a proxy of this file; export uses the original." : "Proxy made; the preview plays the original (Settings).") : proxy.phase === "running" ? "Making a proxy for the preview" : proxy.waiting ? "Proxy waits for the export to finish" : "Proxy queued"}
            style={proxy.phase === "running" ? { backgroundImage: `linear-gradient(90deg, rgb(255 255 255 / 22%) ${Math.round((proxy.progress ?? 0) * 100)}%, transparent 0)` } : undefined}
          >
            {proxy.phase === "running" ? `Proxy ${Math.round((proxy.progress ?? 0) * 100)}%` : "Proxy"}
          </span>
        )}
        {seconds !== undefined && !analysis && (
          <span className="dur" data-testid="duration">
            {timecode(Math.round(seconds * fps), fps).replace(/^00:/, "")}
          </span>
        )}
        <Tooltip label={generated ? "Put it on the timeline at the playhead" : item.kind === "audio" ? "Add to the audio track" : "Add to the end of the main track"}>
          <button
            className="tile-add"
            data-testid={generated ? "generated-add" : "add-to-timeline"}
            disabled={!online}
            onClick={(e) => {
              e.currentTarget.blur();
              void (generated ? actions.addAtPlayhead(item.id) : actions.addMedia(item.id));
            }}
          >
            <Plus />
          </button>
        </Tooltip>
        <Tooltip label="Add to chat" shortcut="addToChat">
          <button
            className={`tile-chat${generated || (hasSound && !analysis) ? " second" : ""}`}
            data-testid="media-add-to-chat"
            onClick={(e) => {
              e.stopPropagation();
              e.currentTarget.blur();
              actions.addMediaToChat(item.id);
            }}
          >
            <AtSign />
          </button>
        </Tooltip>
        {generated && (
          <Tooltip label={generated.againTitle}>
            <button
              className="tile-analyze"
              data-testid="generated-again"
              aria-label="Make again"
              disabled={!online || !generated.canAgain}
              onClick={(e) => {
                e.stopPropagation();
                e.currentTarget.blur();
                generated.again();
              }}
            >
              <RefreshCw />
            </button>
          </Tooltip>
        )}
        {hasSound && !analysis && (
          <Tooltip label={ANALYZE_TITLE}>
            <button
              className="tile-analyze"
              data-testid="analyze"
              aria-label="Analyse the sound"
              disabled={!online}
              onClick={(e) => {
                e.currentTarget.blur();
                void actions.analyzeMedia(item.id);
              }}
            >
              <AudioWaveform />
            </button>
          </Tooltip>
        )}
        {analysis && (
          <div className="tile-analysis" data-testid="analysis-progress" data-phase={analysis.phase} data-analyzer={analysis.analyzer} title={analysisText(analysis)}>
            <AudioWaveform />
            <div className="bar">
              <span style={{ width: `${Math.round((analysis.phase === "running" ? analysis.progress : 0) * 100)}%` }} />
            </div>
            <Tooltip label="Stop the analysis">
              <button className="tile-analysis-cancel" data-testid="analysis-cancel" disabled={!online} onClick={() => void actions.cancelAnalysis(analysis.id)}>
                <X />
              </button>
            </Tooltip>
          </div>
        )}
      </div>
      <div className="tile-name" data-testid="tile-name" title={item.name} onDoubleClick={() => online && setRenaming(true)}>
        {renaming ? <RenameField testId="media-rename" value={item.name} onDone={(name) => (name !== undefined && name.trim() && name !== item.name && void actions.renameMedia(item.id, name), setRenaming(false))} /> : item.name}
      </div>
      <div className="tile-sub" data-testid="tile-meta">
        {generated ? <span className="gen-by">{generated.by}</span> : mediaMeta(item)}
      </div>
    </div>
  );
}

export function Empty({ icon, title, children, testId }: { icon: ReactNode; title: string; children?: ReactNode; testId?: string }) {
  return (
    <div className="empty" data-testid={testId}>
      <div className="empty-icon">{icon}</div>
      <div className="empty-title">{title}</div>
      <div className="empty-sub">{children}</div>
    </div>
  );
}
