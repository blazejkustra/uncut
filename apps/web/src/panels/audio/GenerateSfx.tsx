import { Check, Plus, RefreshCw, Sparkles, X } from "lucide-react";
import { useEffect, useState } from "react";
import { type Project, actions, useApp } from "../../state/store.ts";
import { KeyRow } from "./KeyRow.tsx";
import { Tooltip } from "../../ui/Tooltip.tsx";

const GENERATOR = "generate.sound";
const LENGTHS = [2, 5, 10] as const;

/**
 * Generate a sound effect (D250): optional, with the user's own ElevenLabs key (the Generate tab's
 * generate.sound, D99): a description (the search words to start with), a length, Generate. The
 * result lands in Media like any generated file; + puts it at the playhead.
 */
export function GenerateSfx({ project, online, query }: { project: Project; online: boolean; query: string }) {
  const app = useApp();
  const [open, setOpen] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [seconds, setSeconds] = useState<number>(2);
  useEffect(() => {
    if (open && online && !app.generators) void actions.listGenerators();
  }, [open, online]);
  const g = app.generators?.find((x) => x.id === GENERATOR);
  const jobs = app.generateJobs.filter((j) => j.generator === GENERATOR && j.projectDir === app.snapshot?.dir);
  const running = jobs.filter((j) => j.phase === "running" || j.phase === "importing");
  const last = [...jobs].reverse().find((j) => j.phase === "done" || j.phase === "failed");
  const text = prompt.trim();
  const canRun = online && !!g?.ready && text.length > 0 && !running.some((j) => j.prompt === text && j.seconds === seconds);
  if (!open)
    return (
      <button
        className="btn ghost lib-generate-toggle"
        data-testid="sfx-generate-toggle"
        onClick={() => {
          setOpen(true);
          if (!prompt) setPrompt(query.trim());
        }}
      >
        <Sparkles /> Generate a sound effect
      </button>
    );
  return (
    <div className="lib-generate" data-testid="sfx-generate">
      <div className="lib-generate-head">
        <span>Generate a sound effect</span>
        <Tooltip label="Close">
          <button className="icon-btn" data-testid="sfx-generate-close" onClick={() => setOpen(false)}>
            <X />
          </button>
        </Tooltip>
      </div>
      {g && !g.ready ? (
        <KeyRow provider="elevenlabs" text="Sound effects are made by ElevenLabs with your own key, billed to your ElevenLabs credits." placeholder="ElevenLabs API key" />
      ) : (
        <>
          <textarea
            className="field input"
            data-testid="sfx-generate-prompt"
            rows={2}
            placeholder="Describe the sound: a soft whoosh into a deep hit"
            value={prompt}
            spellCheck={false}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && canRun) void actions.startGenerate({ generator: GENERATOR, prompt: text, kind: "audio", seconds });
            }}
          />
          <div className="lib-selects">
            <select className="field input" data-testid="sfx-generate-seconds" aria-label="Length" value={seconds} onChange={(e) => setSeconds(Number(e.target.value))}>
              {LENGTHS.map((s) => (
                <option key={s} value={s}>
                  {s} s
                </option>
              ))}
            </select>
            <button className="btn primary" data-testid="sfx-generate-run" disabled={!canRun} onClick={() => void actions.startGenerate({ generator: GENERATOR, prompt: text, kind: "audio", seconds })}>
              {running.length ? <RefreshCw className="spin" /> : <Sparkles />} Generate
            </button>
          </div>
          <div className="lib-generate-cost muted small" data-testid="sfx-generate-cost">
            Your ElevenLabs credits: about ${(seconds * 0.01).toFixed(2)} for {seconds} s
          </div>
        </>
      )}
      {running.map((j) => (
        <div key={j.id} className="muted small" data-testid="sfx-generate-running">
          <RefreshCw className="spin" /> {j.status ?? "Generating…"}
        </div>
      ))}
      {app.generateError && (
        <div className="inline-error small" data-testid="sfx-generate-error">
          {app.generateError}
        </div>
      )}
      {last && running.length === 0 && last.phase === "failed" && (
        <div className="inline-error small" data-testid="sfx-generate-failed">
          {last.error}
        </div>
      )}
      {last && running.length === 0 && last.phase === "done" && last.mediaId && project.media.some((m) => m.id === last.mediaId) && (
        <div className="lib-generate-done small" data-testid="sfx-generate-done" data-media={last.mediaId}>
          <Check />
          <span>{last.name} is in Media.</span>
          <button className="link-btn" data-testid="sfx-generate-add" disabled={!online} onClick={() => void actions.addAtPlayhead(last.mediaId!)}>
            <Plus /> Add at the playhead
          </button>
        </div>
      )}
    </div>
  );
}
