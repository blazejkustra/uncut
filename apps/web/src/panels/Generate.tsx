// The Generate tab (D31, D99, D145, redesigned for issue #63 in D234): a Picture / Video / Sound
// switch at the top, then that type's models with their labs' marks (the wired ones first, then
// the ones coming soon, whose real options show but can't be used), the prompt in a composer-like
// box, the model's options as segmented choices and selects (no chips, D263), and one Generate button that says what it costs: your
// subscription for Claude's, your key for the keyed ones. Progress and Cancel stay here; results go
// to Media, marked Generated (GeneratedSection), with Add, Again and Edit prompt.
import type { GenerateJob, GeneratorInfo, KeyProvider } from "@uncut/contracts";
import { AudioLines, Check, Film, FolderOpen, Image as ImageIcon, ImagePlus, LoaderCircle, Plus, RefreshCw, Sparkles, X } from "lucide-react";
import React, { useEffect, useRef, useState } from "react";

import { actions, useApp, type GenerateDraft, type Project } from "../state/store.ts";
import { MediaTile } from "./library/MediaTile.tsx";
import { firstModel, modelsFor, type GenType, type Model, type ModelOption } from "./generate/catalog.ts";
import { LabMark } from "./generate/marks.tsx";
import { Tooltip } from "../ui/Tooltip.tsx";
import "./generate/generate.css";

const SIZE_LABEL: Record<string, string> = { canvas: "Project canvas", "1536x1024": "1536×1024 landscape", "1024x1024": "1024×1024 square", "1024x1536": "1024×1536 portrait", "16:9": "16:9 landscape", "9:16": "9:16 portrait", "1920x1080": "1920×1080", "1080x1920": "1080×1920", "1080x1350": "1080×1350" };
const sizeLabel = (s: string) => SIZE_LABEL[s] ?? s.replace("x", "×");
const CHIP_LABEL: Record<string, string> = { canvas: "Canvas", "1536x1024": "Landscape", "1024x1024": "Square", "1024x1536": "Portrait", "16:9": "16:9", "9:16": "9:16" };
const chipLabel = (s: string) => CHIP_LABEL[s] ?? s.replace("x", "×");

/** A rough price for the button, in dollars (0 on the subscription). */
export function estimateOf(g: GeneratorInfo, kind: GenType, size: string | undefined, seconds: number | undefined): number {
  if (!g.provider) return 0;
  if (g.id === "generate.veo") return (seconds ?? 4) * 0.4;
  if (g.id === "generate.sound") return (seconds ?? 5) * 0.01;
  if (g.id === "generate.gpt-image") return size === "1024x1024" ? 0.032 : 0.048;
  return kind === "video" ? 1 : 0.05;
}
const dollars = (n: number) => `$${n.toFixed(2)}`;
const PROVIDER: Record<KeyProvider, string> = { openai: "OpenAI", google: "Google", elevenlabs: "ElevenLabs", freesound: "Freesound" };

const TYPES: ReadonlyArray<{ id: GenType; label: string; noun: string; icon: typeof ImageIcon }> = [
  { id: "image", label: "Picture", noun: "picture", icon: ImageIcon },
  { id: "video", label: "Video", noun: "video", icon: Film },
  { id: "audio", label: "Sound", noun: "sound", icon: AudioLines },
];
const PLACEHOLDER: Record<GenType, string> = {
  image: "A flat illustration of a phone on a desk, soft light",
  video: "A logo drawing itself on a dark background",
  audio: "A short whoosh as a card slides in",
};

/** Price per item, in a few words (a coming-soon model has none yet). */
const priceOf = (m: Model) => {
  const g = m.info;
  if (!g) return "Soon";
  if (!g.provider) return "Subscription";
  return g.id === "generate.veo" ? "$0.40 a second" : g.id === "generate.sound" ? "$0.01 a second" : g.id === "generate.gpt-image" ? "$0.05 each" : g.billing;
};
/** The line under a model's name: what it costs, and whether its key is set. */
const subOf = (m: Model) => {
  const g = m.info;
  if (!g) return m.lab;
  if (!g.provider) return "Uses your Claude subscription";
  return `${priceOf(m)}, ${g.ready ? "your key is set" : (g.needs ? g.needs.charAt(0).toLowerCase() + g.needs.slice(1) : `needs your ${PROVIDER[g.provider]} key`)}`;
};

/** Generated media (source.module generate.*), newest last as in the project. */
export const generatedMedia = (project: Project) => project.media.filter((m) => typeof m.source?.module === "string" && m.source.module.startsWith("generate."));

export function GenerateLibrary({ project: _project }: { project: Project }) {
  const app = useApp();
  const online = app.connection === "connected";
  useEffect(() => {
    if (online) void actions.listGenerators();
  }, [online]);
  const generators = app.generators ?? [];
  const [type, setType] = useState<GenType>("image");
  const [draft, setDraft] = useState<GenerateDraft>({ generator: "generate.svg", prompt: "" });
  const prompt = useRef<HTMLTextAreaElement>(null);
  // "Edit prompt" on a result in Media fills the form once.
  useEffect(() => {
    const d = app.generateDraft;
    if (!d) return;
    setType(d.kind === "audio" ? "audio" : d.kind === "video" ? "video" : "image");
    setDraft(d);
    prompt.current?.focus();
  }, [app.generateDraft?.seq]);
  const models = modelsFor(generators, type);
  const m = models.find((x) => x.id === draft.generator) ?? firstModel(models);
  const g = m?.info;
  const size = g && draft.size && g.sizes.includes(draft.size) ? draft.size : g?.sizes[0];
  const seconds = g?.seconds && type !== "image" ? (draft.seconds !== undefined && g.seconds.includes(draft.seconds) ? draft.seconds : g.id === "generate.sound" ? 5 : g.seconds[0]) : undefined;
  const fullPrompt = draft.prompt.trim();
  const jobs = app.generateJobs.filter((j) => j.projectDir === app.snapshot?.dir);
  const running = jobs.filter((j) => j.phase === "running" || j.phase === "importing");
  const last = [...jobs].reverse().find((j) => j.phase === "done" || j.phase === "failed");
  const estimate = g ? estimateOf(g, type, size, seconds) : 0;
  // The same request already running (a double click, or Generate again while it works): not twice.
  const same = running.some((j) => j.generator === g?.id && j.prompt === fullPrompt && j.kind === type && (j.size ?? undefined) === (size ?? undefined) && (j.seconds ?? undefined) === (seconds ?? undefined));
  const canRun = online && !!g && !m?.soon && g.ready && fullPrompt.length > 0 && !!app.snapshot && !same;
  const run = () => {
    if (!canRun || !g) return;
    void actions.startGenerate({ generator: g.id, prompt: fullPrompt, kind: type, ...(size ? { size } : {}), ...(seconds !== undefined ? { seconds } : {}) });
  };
  const pickType = (t: GenType) => {
    setType(t);
    const first = firstModel(modelsFor(generators, t));
    setDraft((d) => ({ ...d, generator: first?.id ?? d.generator, kind: t, size: undefined, seconds: undefined }));
  };
  const noun = TYPES.find((t) => t.id === type)!.noun;
  const wired = models.filter((x) => !x.soon);
  const soon = models.filter((x) => x.soon);
  const why = !app.snapshot ? "Open a project first" : m?.soon ? `${m.name} is coming soon` : g && !g.ready ? g.needs : same ? "This one is being made now" : !fullPrompt ? "Describe what to make first" : "Generate (⌘↩)";
  const modelRow = (x: Model) => (
    <button
      key={x.id}
      role="radio"
      aria-checked={x.id === m?.id}
      aria-disabled={x.soon || undefined}
      className={`gen-model${x.id === m?.id ? " active" : ""}${x.soon ? " soon" : x.info?.ready ? "" : " later"}`}
      data-testid="generator"
      data-id={x.id}
      data-ready={x.info?.ready ?? false}
      data-soon={x.soon}
      title={x.soon ? `${x.name} by ${x.lab}: coming soon` : `${x.name} by ${x.lab}`}
      onClick={() => setDraft((d) => ({ ...d, generator: x.id, size: undefined, seconds: undefined }))}
    >
      <LabMark brand={x.brand} lab={x.lab} />
      <span className="gen-model-text">
        <span className="gen-model-name">{x.name}</span>
        <span className="gen-model-sub" data-testid={x.soon ? "generator-soon" : "generator-price"}>
          {subOf(x)}
        </span>
      </span>
    </button>
  );
  return (
    <aside className="library gen-panel" data-testid="generate-library">
      <div className="lib-head">
        Generate
        <Tooltip label="Check the generators and keys again">
          <button className="icon-btn" data-testid="generate-refresh" disabled={!online} onClick={() => void actions.listGenerators()}>
            <RefreshCw />
          </button>
        </Tooltip>
      </div>
      <div className="lib-section gen-form" data-type={type}>
        <div className="seg gen-types" role="radiogroup" aria-label="What to make" data-testid="generate-types">
          {TYPES.map((t) => (
            <button key={t.id} role="radio" aria-checked={t.id === type} className={t.id === type ? "active" : ""} data-testid={`generate-type-${t.id}`} onClick={() => pickType(t.id)}>
              <t.icon />
              {t.label}
            </button>
          ))}
        </div>
        <div className="gen-models" data-testid="generators" role="radiogroup" aria-label="Model">
          {wired.map(modelRow)}
          {soon.length > 0 && <div className="gen-group-label">Coming soon</div>}
          {soon.length > 0 && <div className="gen-soon-grid">{soon.map(modelRow)}</div>}
          {models.length === 0 && <div className="small muted">Nothing can make this yet.</div>}
        </div>
        {g && !g.ready && g.provider && <InlineKey provider={g.provider} needs={g.needs ?? `Needs your ${PROVIDER[g.provider]} key`} />}
        <div className="gen-box">
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
        </div>
        <div className={`gen-options${m?.soon ? " soon" : ""}`} data-testid="generate-options" data-model={m?.id}>
          {g && g.sizes.length > 1 && (
            <div className="gen-opt" data-testid="generate-sizes">
              <span className="k">Size</span>
              {/* A plain select (D263): up to five sizes don't fit a segmented control in the panel. */}
              <select className="field input gen-select" data-testid="generate-size" aria-label="Size" value={size} onChange={(e) => setDraft((d) => ({ ...d, size: e.target.value }))}>
                {g.sizes.map((s) => (
                  <option key={s} value={s} title={sizeLabel(s)}>
                    {chipLabel(s)}
                  </option>
                ))}
              </select>
            </div>
          )}
          {g?.seconds && type !== "image" && (
            <div className="gen-opt" data-testid="generate-lengths">
              <span className="k">Length</span>
              <span className="seg" role="radiogroup" aria-label="Length">
                {g.seconds.map((n) => (
                  <button key={n} className={n === seconds ? "active" : ""} role="radio" aria-checked={n === seconds} data-testid={`generate-seconds-${n}`} data-value={n} onClick={() => setDraft((d) => ({ ...d, seconds: n }))}>
                    {n} s
                  </button>
                ))}
              </span>
            </div>
          )}
          {m?.soon && m.options?.map((o) => <SoonOption key={o.label} option={o} />)}
        </div>
        <div className="gen-go">
          <button className="gen-run" data-testid="generate-run" disabled={!canRun} title={why} onClick={run}>
            <Sparkles />
            <span>Generate {noun}</span>
            <kbd>⌘↩</kbd>
          </button>
          <div className="gen-cost small" data-testid="generate-estimate">
            {m?.soon ? `${m.name} is coming soon` : g?.provider ? `About ${dollars(estimate)}, billed to your ${PROVIDER[g.provider]} key` : "Uses your Claude subscription"}
          </div>
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
            <span className="gen-done-actions">
              <button className="link-btn" data-testid="generate-show" onClick={() => actions.openPanel("media")}>
                <FolderOpen />
                Show in Media
              </button>
              <button className="link-btn" data-testid="generate-add" disabled={!online} onClick={() => void actions.addAtPlayhead(last.mediaId!)}>
                <Plus />
                Add to timeline
              </button>
            </span>
          </div>
        )}
      </div>
    </aside>
  );
}

/** A coming-soon model's option, as it will look, disabled. */
function SoonOption({ option: o }: { option: ModelOption }) {
  if (o.kind === "frames")
    return (
      <div className="gen-opt" data-testid="generate-option" data-kind="frames">
        <span className="k">{o.label}</span>
        <span className="gen-frames">
          {o.slots.map((s) => (
            <button key={s} className="gen-frame" disabled title={`${s}: coming soon`}>
              <ImagePlus />
              <span>{s}</span>
            </button>
          ))}
        </span>
      </div>
    );
  if (o.kind === "toggle")
    return (
      <label className="gen-opt gen-toggle" data-testid="generate-option" data-kind="toggle">
        <input type="checkbox" disabled />
        <span>{o.label}</span>
      </label>
    );
  if (o.kind === "text")
    return (
      <div className="gen-opt" data-testid="generate-option" data-kind="text">
        <span className="k">{o.label}</span>
        <input className="field input gen-text" disabled placeholder={o.placeholder} />
      </div>
    );
  return (
    <div className="gen-opt" data-testid="generate-option" data-kind="choice">
      <span className="k">{o.label}</span>
      {/* A plain select, not chips (D263). */}
      <select className="field input gen-select" disabled aria-label={o.label} defaultValue={o.values[0]}>
        {o.values.map((v) => (
          <option key={v} value={v}>
            {v}
          </option>
        ))}
      </select>
    </div>
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

const draftOf = (m: Project["media"][number]): GenerateDraft => {
  const s = (m.source ?? {}) as { module?: unknown; prompt?: unknown; kind?: unknown; size?: unknown; seconds?: unknown };
  return {
    generator: String(s.module),
    prompt: typeof s.prompt === "string" ? s.prompt : "",
    ...(s.kind === "image" || s.kind === "video" || s.kind === "audio" ? { kind: s.kind } : {}),
    ...(typeof s.size === "string" ? { size: s.size } : {}),
    ...(typeof s.seconds === "number" ? { seconds: s.seconds } : {}),
  };
};

/**
 * Media › Generated (D31, D234; compact in D240, #74): each result a media tile like the others
 * (same size, following the grid/list view), with a small Generated badge; + adds it at the
 * playhead, ↻ makes it again, and its menu has Edit prompt. The prompt and model are its tooltip.
 */
export function GeneratedSection({ project, onEdit, mode, used, selected, onSelect, onRemove }: { project: Project; onEdit?: () => void; mode: "grid" | "list"; used: ReadonlySet<string>; selected: string | undefined; onSelect: (id: string) => void; onRemove: (m: Project["media"][number]) => void }) {
  const app = useApp();
  const online = app.connection === "connected";
  const items = generatedMedia(project);
  if (items.length === 0) return null;
  const generators = app.generators ?? [];
  return (
    <div className="lib-section" data-testid="generated">
      <div className="lib-label gen-section-label">
        <Sparkles />
        Generated
      </div>
      <div className={mode === "list" ? "media-list" : "grid2"} data-testid="generated-grid" data-view={mode}>
        {[...items].reverse().map((m) => {
          const draft = draftOf(m);
          const ready = generators.find((g) => g.id === draft.generator)?.ready !== false;
          const type: GenType = m.kind === "audio" ? "audio" : m.kind === "video" ? "video" : "image";
          const by = modelsFor(generators, type).find((x) => x.id === draft.generator);
          return (
            <MediaTile
              key={m.id}
              item={m}
              fps={project.canvas.fps}
              online={online}
              used={used.has(m.id)}
              selected={selected === m.id}
              onSelect={() => onSelect(m.id)}
              onRemove={() => onRemove(m)}
              generated={{
                prompt: draft.prompt,
                by: by ? `${by.name}, ${by.lab}` : draft.generator,
                canAgain: ready && !!draft.prompt,
                againTitle: !draft.prompt ? "No prompt saved" : ready ? "Make another one from the same prompt" : "Needs its key: Settings › Keys",
                again: () => void actions.startGenerate(draft),
                edit: () => {
                  actions.editPrompt(draft);
                  onEdit?.();
                },
              }}
            />
          );
        })}
      </div>
    </div>
  );
}
