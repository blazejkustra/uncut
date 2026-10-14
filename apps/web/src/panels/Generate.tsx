// The Generate tab (D31, D99): pick a generator, write a prompt, set the size or length, Generate
// (progress and Cancel). The result lands in Media › Generated with its prompt, where it can go on
// the timeline at the playhead, be made again or have its prompt edited. A generator billed to a key
// the user hasn't stored says "Needs your … key" with a link to Settings › Keys. The SVG and HTML
// generator needs no key: Claude writes the picture on the user's subscription.
import type { GenerateJob, GenerateKind, GeneratorInfo } from "@uncut/contracts";
import { AudioLines, Check, Film, Image as ImageIcon, LoaderCircle, Plus, RefreshCw, Sparkles, SquarePen, X } from "lucide-react";
import React, { useEffect, useState } from "react";

import { actions, mediaUrl, thumbUrl, useApp, type GenerateDraft, type MediaItem, type Project } from "../state/store.ts";
import { MEDIA_DRAG_TYPE } from "../timeline/dnd.ts";

const KIND_LABEL: Record<GenerateKind, string> = { image: "Picture", video: "Video", audio: "Sound" };
const SIZE_LABEL: Record<string, string> = { canvas: "Project canvas", "1536x1024": "1536×1024 landscape", "1024x1024": "1024×1024 square", "1024x1536": "1024×1536 portrait", "16:9": "16:9 landscape", "9:16": "9:16 portrait", "1920x1080": "1920×1080", "1080x1920": "1080×1920", "1080x1350": "1080×1350", };
const sizeLabel = (s: string) => SIZE_LABEL[s] ?? s.replace("x", "×");

/** A rough price for the button: "about $1.60", "free". */
export function estimateOf(g: GeneratorInfo, kind: GenerateKind, size: string | undefined, seconds: number | undefined): number {
  if (!g.provider) return 0;
  if (g.id === "generate.veo") return (seconds ?? 4) * 0.4;
  if (g.id === "generate.sound") return (seconds ?? 5) * 0.01;
  if (g.id === "generate.gpt-image") return size === "1024x1024" ? 0.032 : 0.048;
  return kind === "video" ? 1 : 0.05;
}
const dollars = (n: number) => `$${n.toFixed(2)}`;

/** Generated media (source.module generate.*), newest last as in the project. */
export const generatedMedia = (project: Project) => project.media.filter((m) => typeof m.source?.module === "string" && m.source.module.startsWith("generate."));

export function GenerateLibrary({ project }: { project: Project }) {
  const app = useApp();
  const online = app.connection === "connected";
  useEffect(() => {
    if (online) void actions.listGenerators();
  }, [online]);
  const generators = app.generators ?? [];
  const [draft, setDraft] = useState<GenerateDraft>({ generator: "generate.svg", prompt: "" });
  // "Edit prompt" on a result fills the form once.
  useEffect(() => {
    if (app.generateDraft) setDraft(app.generateDraft);
  }, [app.generateDraft?.seq]);
  const g = generators.find((x) => x.id === draft.generator) ?? generators[0];
  const kind = g && draft.kind && g.kinds.includes(draft.kind) ? draft.kind : g?.kinds[0];
  const size = g && draft.size && g.sizes.includes(draft.size) ? draft.size : g?.sizes[0];
  const seconds = g?.seconds && kind !== "image" ? (draft.seconds !== undefined && g.seconds.includes(draft.seconds) ? draft.seconds : g.id === "generate.sound" ? 5 : g.seconds[0]) : undefined;
  const jobs = app.generateJobs.filter((j) => j.projectDir === app.snapshot?.dir);
  const running = jobs.filter((j) => j.phase === "running" || j.phase === "importing");
  const last = [...jobs].reverse().find((j) => j.phase === "done" || j.phase === "failed");
  const estimate = g && kind ? estimateOf(g, kind, size, seconds) : 0;
  // The same request already running (a double click, or Generate again while it works): not twice.
  const same = running.some((j) => j.generator === g?.id && j.prompt === draft.prompt.trim() && j.kind === kind && (j.size ?? undefined) === (size ?? undefined) && (j.seconds ?? undefined) === (seconds ?? undefined));
  const canRun = online && !!g && g.ready && draft.prompt.trim().length > 0 && !!app.snapshot && !same;
  const run = () => {
    if (!canRun || !g || !kind) return;
    void actions.startGenerate({ generator: g.id, prompt: draft.prompt.trim(), kind, ...(size ? { size } : {}), ...(seconds !== undefined ? { seconds } : {}) });
  };
  return (
    <aside className="library" data-testid="generate-library">
      <div className="lib-head">
        Generate
        <button className="icon-btn" data-testid="generate-refresh" disabled={!online} title="Check the generators and keys again" onClick={() => void actions.listGenerators()}>
          <RefreshCw />
        </button>
      </div>
      <div className="lib-section">
        <div className="lib-label">Generator</div>
        <div className="gen-list" data-testid="generators">
          {generators.map((x) => (
            <button key={x.id} className={`gen-row${x.id === g?.id ? " active" : ""}${x.ready ? "" : " later"}`} data-testid="generator" data-id={x.id} data-ready={x.ready} onClick={() => setDraft((d) => ({ ...d, generator: x.id, kind: undefined, size: undefined, seconds: undefined }))}>
              {x.kinds.includes("audio") ? <AudioLines /> : x.kinds.includes("video") && !x.kinds.includes("image") ? <Film /> : x.provider ? <ImageIcon /> : <Sparkles />}
              <span className="gen-name">
                {x.name}
                <span className="gen-sub">{x.ready ? x.billing : x.needs}</span>
              </span>
            </button>
          ))}
        </div>
        {g && !g.ready && (
          <div className="gen-needs small" data-testid="generate-needs">
            <span>{g.needs}.</span>
            <button className="link-btn" data-testid="generate-open-keys" onClick={() => actions.openKeys()}>
              Settings › Keys
            </button>
          </div>
        )}
      </div>
      {g && (
        <div className="lib-section gen-form">
          {g.kinds.length > 1 && (
            <div className="gen-kinds" role="radiogroup">
              {g.kinds.map((k) => (
                <button key={k} className={`chip-btn${k === kind ? " active" : ""}`} data-testid={`generate-kind-${k}`} onClick={() => setDraft((d) => ({ ...d, kind: k }))}>
                  {k === "video" && !g.provider ? "Animation" : KIND_LABEL[k]}
                </button>
              ))}
            </div>
          )}
          <textarea
            className="gen-prompt"
            data-testid="generate-prompt"
            placeholder={g.kinds.includes("audio") ? "A short whoosh as a card slides in" : kind === "video" ? "A logo drawing itself on a dark background" : "A flat illustration of a phone on a desk, soft light"}
            value={draft.prompt}
            maxLength={4000}
            onChange={(e) => setDraft((d) => ({ ...d, prompt: e.target.value }))}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) run();
            }}
          />
          <div className="field-row">
            {g.sizes.length > 0 && (
              <label className="field">
                <span className="k">Size</span>
                <select className="gen-select" data-testid="generate-size" value={size} onChange={(e) => setDraft((d) => ({ ...d, size: e.target.value }))}>
                  {g.sizes.map((s) => (
                    <option key={s} value={s}>
                      {sizeLabel(s)}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {g.seconds && kind !== "image" && (
              <label className="field">
                <span className="k">Length</span>
                <select className="gen-select" data-testid="generate-seconds" value={seconds} onChange={(e) => setDraft((d) => ({ ...d, seconds: Number(e.target.value) }))}>
                  {g.seconds.map((s) => (
                    <option key={s} value={s}>
                      {s} s
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
          <div className="gen-go">
            <span className="gen-cost small muted" data-testid="generate-estimate">
              {g.provider ? `About ${dollars(estimate)}, billed to your ${g.provider === "openai" ? "OpenAI" : g.provider === "google" ? "Google" : "ElevenLabs"} key` : "Free on your Claude subscription"}
            </span>
            <button className="btn primary" data-testid="generate-run" disabled={!canRun} title={!app.snapshot ? "Open a project first" : !g.ready ? g.needs : same ? "This one is being made now" : "Generate (⌘↩)"} onClick={run}>
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
            <div className="inline-error small" data-testid="generate-failed">
              {last.error}
            </div>
          )}
          {last && running.length === 0 && last.phase === "done" && last.mediaId && (
            <div className="gen-done small" data-testid="generate-done">
              <Check />
              <span>{last.name} is in Media.</span>
              <button className="link-btn" data-testid="generate-add" disabled={!online} onClick={() => void actions.addAtPlayhead(last.mediaId!)}>
                Add at playhead
              </button>
            </div>
          )}
        </div>
      )}
      <GeneratedSection project={project} />
    </aside>
  );
}

function JobRow({ job, online }: { job: GenerateJob; online: boolean }) {
  return (
    <div className="import-progress gen-progress" data-testid="generate-progress">
      <LoaderCircle className="spin" />
      <span className="gen-status">{job.status ?? "Working…"}</span>
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
