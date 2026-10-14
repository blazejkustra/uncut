// The Generate tab (D31, D99, redesigned in D145): the prompt first, then what to make (Picture,
// Video, Sound, Title card), the model for it (its price per item and whether its key is set; a
// missing key can be pasted right there), chips for the size and length that type takes, Generate
// with live progress and Cancel. This project's generations are a grid underneath (hover plays a
// video; a sound has its play button): Add to timeline, Variation (the same request again), Edit
// (back into the form), Show in Media. Media › Generated keeps its list (GeneratedSection).
import type { GenerateJob, GenerateKind, GeneratorInfo, KeyProvider } from "@uncut/contracts";
import { AudioLines, Check, Film, FolderOpen, Image as ImageIcon, LoaderCircle, Pause, Play, Plus, RefreshCw, Sparkles, SquarePen, Type, X } from "lucide-react";
import React, { useEffect, useRef, useState } from "react";

import { actions, mediaUrl, thumbUrl, useApp, type GenerateDraft, type MediaItem, type Project } from "../state/store.ts";
import { MEDIA_DRAG_TYPE } from "../timeline/dnd.ts";

const KIND_LABEL: Record<GenerateKind, string> = { image: "Picture", video: "Video", audio: "Sound" };
const SIZE_LABEL: Record<string, string> = { canvas: "Project canvas", "1536x1024": "1536×1024 landscape", "1024x1024": "1024×1024 square", "1024x1536": "1024×1536 portrait", "16:9": "16:9 landscape", "9:16": "9:16 portrait", "1920x1080": "1920×1080", "1080x1920": "1080×1920", "1080x1350": "1080×1350", };
const sizeLabel = (s: string) => SIZE_LABEL[s] ?? s.replace("x", "×");
const CHIP_LABEL: Record<string, string> = { canvas: "Canvas", "1536x1024": "Landscape", "1024x1024": "Square", "1024x1536": "Portrait", "16:9": "16:9", "9:16": "9:16" };
const chipLabel = (s: string) => CHIP_LABEL[s] ?? s.replace("x", "×");

/** A rough price for the button: "about $1.60", "free". */
export function estimateOf(g: GeneratorInfo, kind: GenerateKind, size: string | undefined, seconds: number | undefined): number {
  if (!g.provider) return 0;
  if (g.id === "generate.veo") return (seconds ?? 4) * 0.4;
  if (g.id === "generate.sound") return (seconds ?? 5) * 0.01;
  if (g.id === "generate.gpt-image") return size === "1024x1024" ? 0.032 : 0.048;
  return kind === "video" ? 1 : 0.05;
}
const dollars = (n: number) => `$${n.toFixed(2)}`;
const PROVIDER: Record<KeyProvider, string> = { openai: "OpenAI", google: "Google", elevenlabs: "ElevenLabs", freesound: "Freesound" };

/** What the user picks first: each maps onto a generator kind (a title card is a still drawn by Claude). */
type GenType = "image" | "video" | "audio" | "title";
const TYPES: ReadonlyArray<{ id: GenType; label: string; icon: typeof ImageIcon }> = [
  { id: "image", label: "Picture", icon: ImageIcon },
  { id: "video", label: "Video", icon: Film },
  { id: "audio", label: "Sound", icon: AudioLines },
  { id: "title", label: "Title card", icon: Type },
];
const kindOf = (t: GenType): GenerateKind => (t === "title" ? "image" : t);
/** The models for a type: the free one (Claude) first, then the keyed ones. */
const modelsFor = (generators: ReadonlyArray<GeneratorInfo>, t: GenType) =>
  generators.filter((g) => (t === "title" ? !g.provider && g.kinds.includes("image") : g.kinds.includes(kindOf(t)))).sort((a, b) => Number(!!a.provider) - Number(!!b.provider));
const modelName = (g: GeneratorInfo, t: GenType) => (!g.provider ? (t === "video" ? "Animation by Claude" : t === "title" ? "Title card by Claude" : "Drawn by Claude (SVG)") : g.name);
/** Price per item, in a few words. */
const priceOf = (g: GeneratorInfo) => (!g.provider ? "Free" : g.id === "generate.veo" ? "$0.40 a second" : g.id === "generate.sound" ? "About $0.01 a second" : g.id === "generate.gpt-image" ? "About $0.05 each" : g.billing);
const typeOfSource = (m: MediaItem): GenType => (m.kind === "audio" ? "audio" : m.kind === "video" ? "video" : "image");
const PLACEHOLDER: Record<GenType, string> = {
  image: "A flat illustration of a phone on a desk, soft light",
  video: "A logo drawing itself on a dark background",
  audio: "A short whoosh as a card slides in",
  title: "Launch day, in big white letters on deep blue",
};
const TITLE_PREFIX = "Title card: ";

/** Generated media (source.module generate.*), newest last as in the project. */
export const generatedMedia = (project: Project) => project.media.filter((m) => typeof m.source?.module === "string" && m.source.module.startsWith("generate."));

export function GenerateLibrary({ project }: { project: Project }) {
  const app = useApp();
  const online = app.connection === "connected";
  useEffect(() => {
    if (online) void actions.listGenerators();
  }, [online]);
  const generators = app.generators ?? [];
  const [type, setType] = useState<GenType>("image");
  const [draft, setDraft] = useState<GenerateDraft>({ generator: "generate.svg", prompt: "" });
  const prompt = useRef<HTMLTextAreaElement>(null);
  // "Edit" on a result fills the form once.
  useEffect(() => {
    const d = app.generateDraft;
    if (!d) return;
    const title = d.generator === "generate.svg" && d.prompt.startsWith(TITLE_PREFIX);
    setType(title ? "title" : d.kind === "audio" ? "audio" : d.kind === "video" ? "video" : "image");
    setDraft({ ...d, prompt: title ? d.prompt.slice(TITLE_PREFIX.length) : d.prompt });
    prompt.current?.focus();
  }, [app.generateDraft?.seq]);
  const models = modelsFor(generators, type);
  const g = models.find((x) => x.id === draft.generator) ?? models[0];
  const kind = kindOf(type);
  const size = g && draft.size && g.sizes.includes(draft.size) ? draft.size : g?.sizes[0];
  const seconds = g?.seconds && kind !== "image" ? (draft.seconds !== undefined && g.seconds.includes(draft.seconds) ? draft.seconds : g.id === "generate.sound" ? 5 : g.seconds[0]) : undefined;
  const fullPrompt = type === "title" && draft.prompt.trim() ? `${TITLE_PREFIX}${draft.prompt.trim()}` : draft.prompt.trim();
  const jobs = app.generateJobs.filter((j) => j.projectDir === app.snapshot?.dir);
  const running = jobs.filter((j) => j.phase === "running" || j.phase === "importing");
  const last = [...jobs].reverse().find((j) => j.phase === "done" || j.phase === "failed");
  const estimate = g ? estimateOf(g, kind, size, seconds) : 0;
  // The same request already running (a double click, or Generate again while it works): not twice.
  const same = running.some((j) => j.generator === g?.id && j.prompt === fullPrompt && j.kind === kind && (j.size ?? undefined) === (size ?? undefined) && (j.seconds ?? undefined) === (seconds ?? undefined));
  const canRun = online && !!g && g.ready && fullPrompt.length > 0 && !!app.snapshot && !same;
  const run = () => {
    if (!canRun || !g) return;
    void actions.startGenerate({ generator: g.id, prompt: fullPrompt, kind, ...(size ? { size } : {}), ...(seconds !== undefined ? { seconds } : {}) });
  };
  const pickType = (t: GenType) => {
    setType(t);
    const first = modelsFor(generators, t).find((x) => x.ready) ?? modelsFor(generators, t)[0];
    setDraft((d) => ({ ...d, generator: first?.id ?? d.generator, kind: kindOf(t), size: undefined, seconds: undefined }));
  };
  return (
    <aside className="library" data-testid="generate-library">
      <div className="lib-head">
        Generate
        <button className="icon-btn" data-testid="generate-refresh" disabled={!online} title="Check the generators and keys again" onClick={() => void actions.listGenerators()}>
          <RefreshCw />
        </button>
      </div>
      <div className="lib-section gen-form">
        <textarea
          ref={prompt}
          className="gen-prompt"
          data-testid="generate-prompt"
          placeholder={PLACEHOLDER[type]}
          value={draft.prompt}
          maxLength={4000}
          onChange={(e) => setDraft((d) => ({ ...d, prompt: e.target.value }))}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) run();
          }}
        />
        <div className="seg gen-types" role="radiogroup" data-testid="generate-types">
          {TYPES.map((t) => (
            <button key={t.id} role="radio" aria-checked={t.id === type} className={t.id === type ? "active" : ""} data-testid={`generate-type-${t.id}`} onClick={() => pickType(t.id)}>
              <t.icon />
              {t.label}
            </button>
          ))}
        </div>
        <div className="gen-list" data-testid="generators" role="radiogroup">
          {models.map((x) => (
            <button key={x.id} role="radio" aria-checked={x.id === g?.id} className={`gen-row${x.id === g?.id ? " active" : ""}${x.ready ? "" : " later"}`} data-testid="generator" data-id={x.id} data-ready={x.ready} onClick={() => setDraft((d) => ({ ...d, generator: x.id, size: undefined, seconds: undefined }))}>
              <span className="gen-name">
                {modelName(x, type)}
                <span className="gen-sub">{x.provider ? (x.ready ? `Your ${PROVIDER[x.provider]} key is set` : x.needs) : "On your Claude subscription"}</span>
              </span>
              <span className="gen-price" data-testid="generator-price">
                {priceOf(x)}
              </span>
            </button>
          ))}
          {models.length === 0 && <div className="small muted">Nothing can make this yet.</div>}
        </div>
        {g && !g.ready && g.provider && <InlineKey provider={g.provider} needs={g.needs ?? `Needs your ${PROVIDER[g.provider]} key`} />}
        {g && g.sizes.length > 1 && (
          <div className="gen-chips" data-testid="generate-sizes">
            <span className="k">Size</span>
            {g.sizes.map((s) => (
              <button key={s} className={`chip-btn${s === size ? " active" : ""}`} data-testid={`generate-size-${s}`} data-value={s} title={sizeLabel(s)} onClick={() => setDraft((d) => ({ ...d, size: s }))}>
                {chipLabel(s)}
              </button>
            ))}
          </div>
        )}
        {g?.seconds && kind !== "image" && (
          <div className="gen-chips" data-testid="generate-lengths">
            <span className="k">Length</span>
            {g.seconds.map((n) => (
              <button key={n} className={`chip-btn${n === seconds ? " active" : ""}`} data-testid={`generate-seconds-${n}`} data-value={n} onClick={() => setDraft((d) => ({ ...d, seconds: n }))}>
                {n} s
              </button>
            ))}
          </div>
        )}
        <div className="gen-go">
          <span className="gen-cost small muted" data-testid="generate-estimate">
            {g?.provider ? `About ${dollars(estimate)}, billed to your ${PROVIDER[g.provider]} key` : "Free on your Claude subscription"}
          </span>
          <button className="btn primary" data-testid="generate-run" disabled={!canRun} title={!app.snapshot ? "Open a project first" : g && !g.ready ? g.needs : same ? "This one is being made now" : "Generate (⌘↩)"} onClick={run}>
            <Sparkles />
            Generate
          </button>
        </div>
        {running.map((j) => (
          <JobRow key={j.id} job={j} online={online} />
        ))}
        {app.generateError && (
          <div className="inline-error small" data-testid="generate-error">
            {app.generateError}
          </div>
        )}
        {last && running.length === 0 && last.phase === "failed" && (
          <div className="inline-error small gen-failed" data-testid="generate-failed">
            <span>{last.error}</span>
            <button className="link-btn" data-testid="generate-retry" disabled={!online} onClick={() => void actions.startGenerate({ generator: last.generator, prompt: last.prompt, kind: last.kind, ...(last.size ? { size: last.size } : {}), ...(last.seconds !== undefined ? { seconds: last.seconds } : {}) })}>
              <RefreshCw />
              Try again
            </button>
          </div>
        )}
        {last && running.length === 0 && last.phase === "done" && last.mediaId && (
          <div className="gen-done small" data-testid="generate-done">
            <Check />
            <span>{last.name} is in Media.</span>
            <button className="link-btn" data-testid="generate-add" disabled={!online} onClick={() => void actions.addAtPlayhead(last.mediaId!)}>
              Add to timeline
            </button>
          </div>
        )}
      </div>
      <GenerateGrid project={project} running={running} />
    </aside>
  );
}

/** A missing key, pasted right here (it goes to the server once and never comes back, D99). */
function InlineKey({ provider, needs }: { provider: KeyProvider; needs: string }) {
  const app = useApp();
  const [key, setKey] = useState("");
  const [saving, setSaving] = useState(false);
  const save = async () => {
    if (!key.trim()) return;
    setSaving(true);
    const ok = await actions.setKey(provider, key.trim());
    setSaving(false);
    if (ok) {
      setKey("");
      void actions.listGenerators();
    }
  };
  return (
    <div className="gen-needs small" data-testid="generate-needs">
      <span>{needs}.</span>
      <div className="gen-key-row">
        <input
          className="field input"
          type="password"
          data-testid="generate-key-input"
          placeholder={`${PROVIDER[provider]} API key`}
          autoComplete="off"
          spellCheck={false}
          value={key}
          onChange={(e) => setKey(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void save();
          }}
        />
        <button className="btn" data-testid="generate-key-save" disabled={!key.trim() || saving || app.connection !== "connected"} onClick={() => void save()}>
          Save
        </button>
      </div>
      {app.keysError && <div className="inline-error small">{app.keysError}</div>}
      <button className="link-btn" data-testid="generate-open-keys" onClick={() => actions.openKeys()}>
        Settings › Keys
      </button>
    </div>
  );
}

function JobRow({ job, online }: { job: GenerateJob; online: boolean }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, []);
  const secs = Math.max(0, Math.floor((now - Date.parse(job.startedAt)) / 1000));
  return (
    <div className="import-progress gen-progress" data-testid="generate-progress">
      <LoaderCircle className="spin" />
      <span className="gen-status">
        {job.status ?? "Working…"} <span className="muted">{secs} s</span>
      </span>
      <button className="link-btn" data-testid="generate-cancel" disabled={!online} title="Stop this generation; nothing is added" onClick={() => void actions.cancelGenerate(job.id)}>
        <X />
        Cancel
      </button>
      <div className="bar indeterminate">
        <span />
      </div>
    </div>
  );
}

/** This project's generations as a grid, newest first, with the ones being made at the front. */
function GenerateGrid({ project, running }: { project: Project; running: ReadonlyArray<GenerateJob> }) {
  const app = useApp();
  const online = app.connection === "connected";
  const items = [...generatedMedia(project)].reverse();
  if (items.length === 0 && running.length === 0) return null;
  const generators = app.generators ?? [];
  return (
    <div className="lib-section" data-testid="generated">
      <div className="lib-label">In this project</div>
      <div className="gen-grid">
        {running.map((j) => (
          <div key={j.id} className="gen-tile making" data-testid="generate-tile-running">
            <div className="gen-tile-media">
              <LoaderCircle className="spin" />
            </div>
            <div className="gen-tile-prompt" title={j.prompt}>
              {j.prompt}
            </div>
          </div>
        ))}
        {items.map((m) => {
          const draft = draftOf(m);
          const info = generators.find((x) => x.id === draft.generator);
          const ready = info?.ready !== false;
          return (
            <div
              key={m.id}
              className="gen-tile"
              data-testid="generated-item"
              data-id={m.id}
              draggable={online}
              onDragStart={(e) => {
                e.dataTransfer.setData(MEDIA_DRAG_TYPE, m.id);
                e.dataTransfer.effectAllowed = "copy";
              }}
            >
              <TilePreview m={m} />
              <div className="gen-tile-prompt" data-testid="generated-prompt" title={`${m.name}\n${draft.prompt}`}>
                {draft.prompt || m.name}
              </div>
              <div className="gen-tile-by">{info ? modelName(info, draft.prompt.startsWith(TITLE_PREFIX) ? "title" : typeOfSource(m)) : draft.generator}</div>
              <div className="gen-tile-actions">
                <button className="icon-btn" data-testid="generated-add" disabled={!online} title="Add to timeline at the playhead" onClick={() => void actions.addAtPlayhead(m.id)}>
                  <Plus />
                </button>
                <button className="icon-btn" data-testid="generated-again" disabled={!online || !ready || !draft.prompt} title={ready ? "Variation: make another from the same prompt" : "Needs its key"} onClick={() => void actions.startGenerate(draft)}>
                  <RefreshCw />
                </button>
                <button className="icon-btn" data-testid="generated-edit" disabled={!online} title="Edit the prompt and make it again" onClick={() => actions.editPrompt(draft)}>
                  <SquarePen />
                </button>
                <button className="icon-btn" data-testid="generated-show" title="Show in Media" onClick={() => actions.openPanel("media")}>
                  <FolderOpen />
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** A result's picture; a video plays while hovered, a sound has a play button. */
function TilePreview({ m }: { m: MediaItem }) {
  const app = useApp();
  const video = useRef<HTMLVideoElement>(null);
  const audio = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const thumb = app.thumbIds.has(m.id) ? thumbUrl(m.id, m.path) : m.kind === "image" && /\.svg$/i.test(m.path) ? mediaUrl(m.id, m.path) : undefined;
  if (m.kind === "audio") {
    return (
      <div className="gen-tile-media audio">
        <AudioLines />
        <audio ref={audio} src={mediaUrl(m.id, m.path)} preload="none" onEnded={() => setPlaying(false)} onPause={() => setPlaying(false)} />
        <button
          className="icon-btn gen-tile-play"
          data-testid="generated-play"
          title={playing ? "Pause" : "Play"}
          onClick={() => {
            const a = audio.current;
            if (!a) return;
            if (a.paused) void a.play().then(() => setPlaying(true), () => setPlaying(false));
            else a.pause();
          }}
        >
          {playing ? <Pause /> : <Play />}
        </button>
      </div>
    );
  }
  return (
    <div
      className="gen-tile-media"
      onMouseEnter={() => void video.current?.play().catch(() => {})}
      onMouseLeave={() => {
        const v = video.current;
        if (v) {
          v.pause();
          v.currentTime = 0;
        }
      }}
    >
      {thumb ? <img src={thumb} alt="" draggable={false} /> : m.kind === "video" ? <Film /> : <ImageIcon />}
      {m.kind === "video" && <video ref={video} className="gen-tile-video" data-testid="generated-video" src={mediaUrl(m.id, m.path)} muted loop playsInline preload="none" />}
    </div>
  );
}

const draftOf = (m: MediaItem): GenerateDraft => {
  const s = (m.source ?? {}) as { module?: unknown; prompt?: unknown; kind?: unknown; size?: unknown; seconds?: unknown };
  return {
    generator: String(s.module),
    prompt: typeof s.prompt === "string" ? s.prompt : "",
    ...(s.kind === "image" || s.kind === "video" || s.kind === "audio" ? { kind: s.kind } : {}),
    ...(typeof s.size === "string" ? { size: s.size } : {}),
    ...(typeof s.seconds === "number" ? { seconds: s.seconds } : {}),
  };
};

/** Media › Generated: each result with its prompt, Add at playhead, Again and Edit prompt (D31). */
export function GeneratedSection({ project, onEdit }: { project: Project; onEdit?: () => void }) {
  const app = useApp();
  const online = app.connection === "connected";
  const items = generatedMedia(project);
  if (items.length === 0) return null;
  const names = new Map((app.generators ?? []).map((g) => [g.id, g.name]));
  return (
    <div className="lib-section" data-testid="generated">
      <div className="lib-label">Generated</div>
      <div className="gen-results">
        {[...items].reverse().map((m) => {
          const draft = draftOf(m);
          const ready = (app.generators ?? []).find((g) => g.id === draft.generator)?.ready !== false;
          const src = app.thumbIds.has(m.id) ? thumbUrl(m.id, m.path) : m.kind === "image" && /\.svg$/i.test(m.path) ? mediaUrl(m.id, m.path) : undefined;
          const Icon = m.kind === "audio" ? AudioLines : m.kind === "image" ? ImageIcon : Film;
          return (
            <div
              key={m.id}
              className="gen-result"
              data-testid="generated-item"
              data-id={m.id}
              draggable={online}
              onDragStart={(e) => {
                e.dataTransfer.setData(MEDIA_DRAG_TYPE, m.id);
                e.dataTransfer.effectAllowed = "copy";
              }}
            >
              <div className="gen-thumb">{src ? <img src={src} alt="" draggable={false} /> : <Icon />}</div>
              <div className="gen-body">
                <div className="gen-title" title={m.path}>
                  {m.name}
                </div>
                <div className="gen-prompt-text" data-testid="generated-prompt" title={draft.prompt}>
                  {draft.prompt || "No prompt saved"}
                </div>
                <div className="gen-by">{names.get(draft.generator) ?? draft.generator}</div>
                <div className="gen-actions">
                  <button className="link-btn" data-testid="generated-add" disabled={!online} title="Put it on the timeline at the playhead" onClick={() => void actions.addAtPlayhead(m.id)}>
                    <Plus />
                    Add at playhead
                  </button>
                  <button className="link-btn" data-testid="generated-again" disabled={!online || !ready || !draft.prompt} title={ready ? "Make another one from the same prompt" : "Needs its key: Settings › Keys"} onClick={() => void actions.startGenerate(draft)}>
                    <RefreshCw />
                    Again
                  </button>
                  <button
                    className="link-btn"
                    data-testid="generated-edit"
                    disabled={!online}
                    title="Change the prompt and make it again"
                    onClick={() => {
                      actions.editPrompt(draft);
                      onEdit?.();
                    }}
                  >
                    <SquarePen />
                    Edit prompt
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
