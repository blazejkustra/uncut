// The Agent tab's composer (D140, D184, t3code-like): a multiline box where Enter sends and ⇧Enter
// is a new line; @ opens a picker of media, items, tracks and markers that inserts an @label chip
// (Add to chat, D141, inserts the same), and a typed time (@0:12, @12s) offers that moment (D183);
// ↑ in an empty box brings back earlier prompts; while a turn runs the button is Stop and Enter
// queues the message for when it ends. Images come in by paste, drop or the paperclip. The bottom
// row picks the provider, model, effort and access, remembered per project (agentPrefs.ts). The
// text, chips and images live in the store.
import { AGENT_ACCESS, AGENT_EFFORTS, AGENT_IMAGE_MAX, AGENT_IMAGE_TYPES, AGENT_IMAGES_MAX, AGENT_MODELS, type AgentAccess, type AgentEffort, type AgentImage, type AgentMention, type AgentTurn } from "@uncut/contracts";
import { mentionCandidates, momentLabel, parseMoment } from "@uncut/core/mentions";
import { ArrowLeftRight, ArrowUp, AtSign, Bot, Check, ChevronDown, Clock3, Eye, Film, Flag, Gauge, ListVideo, MousePointer2, Music, Paperclip, PencilLine, Rows3, Search, ShieldCheck, Sparkles, Square, Star, X } from "lucide-react";
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { usePlayback } from "../preview/playback.ts";
import { setAgentPrefs, toggleFavourite, useAgentPrefs } from "../state/agentPrefs.ts";
import { frameTimecode } from "../state/format.ts";
import { itemLabel } from "../state/project.ts";
import { bridge } from "../state/bridge.ts";
import { isAttachable, quotePaths, sortPasted } from "./pasted.ts";
import { actions, getState, useApp, type Project } from "../state/store.ts";

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// D198: a path in a message (~/…, $HOME/…, ${HOME}/… or absolute), as the server reads one (a
// backslash-escaped space stays in it; trailing punctuation doesn't).
const PATH = String.raw`(?<![^\s"'(<\[])(?:(?:~|\$HOME|\$\{HOME\})\/|\/(?=[^\s/]))(?:\\ |[^\s"'\`)<>\]])*?(?=[.,;:!?]*(?:$|[\s"'\`)<>\]]))`;

/** Text with its @labels (of `labels`) and its paths (D198) as chip spans: the composer's backdrop and the turn card's prompt. */
export function withChips(text: string, labels: ReadonlyArray<string>, className = "chip"): ReactNode {
  const unique = [...new Set(labels.filter(Boolean))].sort((a, b) => b.length - a.length);
  const re = new RegExp(unique.length ? `@(?:${unique.map(escape).join("|")})|${PATH}` : PATH, "g");
  const out: Array<ReactNode> = [];
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (!m[0]) continue;
    const at = m.index;
    if (at > last) out.push(<Fragment key={`t${last}`}>{text.slice(last, at)}</Fragment>);
    const path = !m[0].startsWith("@");
    out.push(
      <mark key={`m${at}`} className={path ? `${className} path` : className} data-testid={path ? "agent-path-chip" : "agent-chip"}>
        {m[0]}
      </mark>,
    );
    last = at + m[0].length;
  }
  if (!out.length) return text;
  if (last < text.length) out.push(<Fragment key={`t${last}`}>{text.slice(last)}</Fragment>);
  return out;
}

const KIND_ICON = { media: Film, item: ListVideo, track: Rows3, marker: Flag, moment: Clock3, range: ArrowLeftRight } as const;

export const ACCESS_INFO: Record<AgentAccess, { name: string; short: string; detail: string; icon: typeof Eye }> = {
  look: { name: "Look only", short: "Look only", detail: "Reads and looks, changes nothing", icon: Eye },
  ask: { name: "Ask before big changes", short: "Ask first", detail: "Removals, transcript cuts and large edits wait for your Allow", icon: ShieldCheck },
  edit: { name: "Edit freely", short: "Edit freely", detail: "Edits as it goes; every turn can be undone", icon: PencilLine },
};
const EFFORT_NAME: Record<AgentEffort, string> = { low: "Low", medium: "Medium", high: "High", max: "Max" };

/** An image file as an attachment (D184), or why it can't be one. */
async function readImage(file: File): Promise<AgentImage | string> {
  if (!(AGENT_IMAGE_TYPES as ReadonlyArray<string>).includes(file.type)) return `${file.name || "That file"} isn't a PNG, JPEG, GIF or WebP image.`;
  if (file.size > AGENT_IMAGE_MAX) return `${file.name || "That image"} is over 5 MB.`;
  const url = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
  return { name: file.name || "Pasted image", mimeType: file.type as AgentImage["mimeType"], data: url.slice(url.indexOf(",") + 1) };
}

export function Composer({ project, online, blocked, turns, running, provider }: { project: Project; online: boolean; blocked: boolean; turns: ReadonlyArray<AgentTurn>; running: string | null; provider: string }) {
  const { agentDraft: draft, agentMentions: mentions, agentQueued: queued, agentFocus, agentImages: images, snapshot } = useApp();
  const [attachError, setAttachError] = useState<string | undefined>(undefined);
  const [dropping, setDropping] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const addFiles = async (files: ReadonlyArray<File>) => {
    const picked = files.filter((f) => f.type.startsWith("image/") || f.size === 0 || !f.type);
    if (!picked.length) return;
    const now = [...images];
    let problem: string | undefined;
    for (const file of picked) {
      if (now.length >= AGENT_IMAGES_MAX) {
        problem = `At most ${AGENT_IMAGES_MAX} images per message.`;
        break;
      }
      const read = await readImage(file).catch(() => `${file.name || "That image"} couldn't be read.`);
      if (typeof read === "string") problem = read;
      else now.push(read);
    }
    setAttachError(problem);
    actions.setAgentImages(now);
  };
  // D201: pasted files: paths (folders, SVGs, videos, fonts, anything from disk that isn't an
  // attachable image) go in at the caret as path chips; images attach.
  const pasteFiles = async (files: ReadonlyArray<File>, text: string, from: number, to: number) => {
    const own = files.map((f) => ({ name: f.name, type: f.type, path: bridge.pathForFile(f) }));
    const copied = own.some((f) => !f.path.startsWith("/")) ? await (bridge.clipboardPaths?.() ?? Promise.resolve([])).catch(() => []) : [];
    const { paths, attach, unknown } = sortPasted(own, copied);
    const now = getState().agentDraft;
    const insert = paths.length ? quotePaths(paths) : attach.length ? "" : text;
    if (insert) {
      const head = now.slice(0, from);
      const piece = `${head && !/\s$/.test(head) && paths.length ? " " : ""}${insert}${paths.length ? " " : ""}`;
      caretTo.current = from + piece.length;
      setDraft(head + piece + now.slice(to));
    }
    await addFiles([...attach, ...unknown].map((i) => files[i]!));
  };
  const input = useRef<HTMLTextAreaElement>(null);
  const backdrop = useRef<HTMLDivElement>(null);
  const [caret, setCaret] = useState(0);
  const [pick, setPick] = useState(0);
  // The @query position the user closed the picker at (Esc), until the text changes.
  const [dismissed, setDismissed] = useState<number | undefined>(undefined);
  const history = useRef<{ at: number; saved: string }>({ at: -1, saved: "" });
  const caretTo = useRef<number | undefined>(undefined);

  // Add to chat: the caret goes to the end of the box.
  useEffect(() => {
    if (!agentFocus) return;
    const el = input.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
    setCaret(el.value.length);
  }, [agentFocus]);
  // A caret position chosen by an edit (a picked mention, a deleted chip) once React has the new text.
  useLayoutEffect(() => {
    const at = caretTo.current;
    if (at === undefined || !input.current) return;
    caretTo.current = undefined;
    input.current.setSelectionRange(at, at);
    setCaret(at);
  }, [draft]);

  const candidates = useMemo(() => mentionCandidates(project as never), [project]);
  const before = draft.slice(0, caret);
  const query = /(?:^|\s)@([^\s@]{0,40})$/.exec(before);
  const at = query ? caret - query[1]!.length - 1 : -1;
  const fps = project.canvas.fps;
  const matches = useMemo(() => {
    if (!query) return [];
    const q = query[1]!.toLowerCase();
    // D183: a typed time (@0:12, @12s, @1:02.5) offers that moment first.
    const frame = parseMoment(q, fps);
    const moment = frame !== undefined ? [{ kind: "moment" as const, id: `frame:${frame}`, label: momentLabel(frame, fps), frame, detail: `Moment, frame ${frame}` }] : [];
    return [...moment, ...candidates.filter((c) => c.label.toLowerCase().includes(q)).slice(0, 8 - moment.length)];
  }, [candidates, query?.[1], fps]);
  const pickerOpen = !!query && dismissed !== at && matches.length > 0 && !blocked;
  useEffect(() => setPick(0), [query?.[1]]);

  const setDraft = (text: string, next?: ReadonlyArray<AgentMention>) => {
    if (text !== draft) setDismissed(undefined);
    actions.setAgentDraft(text, next);
  };
  const choose = (c: (typeof matches)[number]) => {
    const insert = `@${c.label} `;
    const text = draft.slice(0, at) + insert + draft.slice(caret);
    const mention: AgentMention = { kind: c.kind, id: c.id, label: c.label, ...(c.frame !== undefined ? { frame: c.frame } : {}) };
    caretTo.current = at + insert.length;
    setDraft(text, [...mentions.filter((m) => !(m.kind === c.kind && m.id === c.id && m.label === c.label)), mention]);
  };

  const send = async () => {
    const text = draft.trim();
    if (!text || !online || blocked) return;
    history.current = { at: -1, saved: "" };
    const attached = images;
    setAttachError(undefined);
    if (running) {
      // One message waits for the turn to end; a second one joins it.
      actions.agentQueue({ prompt: queued ? `${queued.prompt}\n\n${text}` : text, mentions: [...(queued?.mentions ?? []), ...mentions], images: [...(queued?.images ?? []), ...attached].slice(0, AGENT_IMAGES_MAX) });
      setDraft("", []);
      actions.setAgentImages([]);
      return;
    }
    setDraft("", []);
    actions.setAgentImages([]);
    if (!(await actions.agentSend(text, mentions, attached))) {
      actions.setAgentDraft(text, mentions);
      actions.setAgentImages(attached);
    }
  };

  // Earlier prompts, newest first, for ↑ / ↓.
  const prompts = useMemo(() => [...new Set([...turns].reverse().map((t) => t.prompt))], [turns]);
  const recall = (index: number) => {
    const h = history.current;
    if (h.at === -1) h.saved = draft;
    h.at = index;
    const text = index === -1 ? h.saved : prompts[index]!;
    // The chips of a recalled prompt, found again by their labels.
    const turn = turns.find((t) => t.prompt === text);
    const again = (turn?.mentions ?? []).flatMap((m) => {
      const c = candidates.find((x) => x.kind === m.kind && x.label === m.label);
      return c ? [{ kind: c.kind, id: c.id, label: c.label }] : [];
    });
    caretTo.current = text.length;
    setDraft(text, again);
  };

  const labels = mentions.map((m) => m.label);
  return (
    <div
      className={`composer ${dropping ? "dropping" : ""}`}
      data-testid="composer"
      onDragOver={(e) => {
        if (![...e.dataTransfer.items].some((i) => i.kind === "file")) return;
        e.preventDefault();
        setDropping(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropping(false);
      }}
      onDrop={(e) => {
        if (!e.dataTransfer.files.length) return;
        e.preventDefault();
        setDropping(false);
        // D200, D201: a dropped folder or file that isn't a PNG, JPEG, GIF or WebP (an SVG, a video,
        // a font) goes in as its path (a path chip); those images attach.
        const files = [...e.dataTransfer.files];
        const paths = files.flatMap((f) => (isAttachable(f) ? [] : [bridge.pathForFile(f)].filter((p) => p.startsWith("/"))));
        if (paths.length) {
          const quoted = quotePaths(paths);
          setDraft(draft && !/\s$/.test(draft) ? `${draft} ${quoted} ` : `${draft}${quoted} `);
        }
        void addFiles(files.filter((f) => isAttachable(f) || !bridge.pathForFile(f).startsWith("/")));
      }}
    >
      <ContextLine project={project} />
      {queued && (
        <div className="composer-queued" data-testid="agent-queued">
          <span className="ellipsis">Queued: {queued.prompt}</span>
          <button className="icon-btn" title="Don't send it" data-testid="agent-unqueue" onClick={() => actions.agentQueue(undefined)}>
            <X />
          </button>
        </div>
      )}
      {pickerOpen && (
        <div className="mention-picker" role="listbox" data-testid="mention-picker">
          {matches.map((c, i) => {
            const Icon = c.kind === "media" && c.detail === "Sound" ? Music : KIND_ICON[c.kind];
            return (
              <button
                key={`${c.kind}:${c.id}`}
                role="option"
                aria-selected={i === pick}
                className={`mention-option ${i === pick ? "active" : ""}`}
                data-testid="mention-option"
                data-kind={c.kind}
                onMouseDown={(e) => {
                  e.preventDefault();
                  choose(c);
                }}
                onMouseEnter={() => setPick(i)}
              >
                <Icon />
                <span className="ellipsis grow">{c.label}</span>
                <span className="mention-detail">{c.detail}</span>
              </button>
            );
          })}
        </div>
      )}
      {images.length > 0 && (
        <div className="composer-images" data-testid="agent-attachments">
          {images.map((img, i) => (
            <div key={i} className="composer-image" data-testid="agent-attachment" title={img.name}>
              <img src={`data:${img.mimeType};base64,${img.data}`} alt={img.name} />
              <button className="icon-btn" title="Remove" data-testid="agent-attachment-remove" onClick={() => actions.setAgentImages(images.filter((_, j) => j !== i))}>
                <X />
              </button>
            </div>
          ))}
        </div>
      )}
      {attachError && (
        <div className="composer-attach-error small" data-testid="agent-attach-error">
          {attachError}
        </div>
      )}
      <div className="composer-box">
        <div className="composer-hl" ref={backdrop} aria-hidden="true">
          {withChips(draft, labels)}
          {"​"}
        </div>
        <textarea
          ref={input}
          id="agent-input"
          data-testid="agent-input"
          rows={3}
          value={draft}
          spellCheck={false}
          disabled={!online || blocked}
          placeholder={blocked ? "Set up Claude Code to use the agent" : running ? "Write the next message; it's sent when this turn ends" : "Ask for an edit; @ to point at media or a clip"}
          onChange={(e) => {
            history.current.at = -1;
            setCaret(e.target.selectionStart);
            setDraft(e.target.value);
          }}
          onSelect={(e) => setCaret((e.target as HTMLTextAreaElement).selectionStart)}
          onPaste={(e) => {
            const files = [...e.clipboardData.files];
            if (!files.length) return;
            // Finder also puts the names as text; the paste is the files (D201).
            e.preventDefault();
            void pasteFiles(files, e.clipboardData.getData("text/plain"), e.currentTarget.selectionStart, e.currentTarget.selectionEnd);
          }}
          onScroll={(e) => backdrop.current && (backdrop.current.scrollTop = (e.target as HTMLTextAreaElement).scrollTop)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            const el = e.currentTarget;
            if (pickerOpen) {
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                setPick((p) => (p + (e.key === "ArrowDown" ? 1 : matches.length - 1)) % matches.length);
                return;
              }
              if (e.key === "Enter" || e.key === "Tab") {
                e.preventDefault();
                choose(matches[pick]!);
                return;
              }
              if (e.key === "Escape") {
                e.preventDefault();
                setDismissed(at);
                return;
              }
            }
            // A chip goes whole with one Backspace.
            if (e.key === "Backspace" && el.selectionStart === el.selectionEnd) {
              const head = draft.slice(0, el.selectionStart);
              const chip = labels.filter((l) => head.endsWith(`@${l}`)).sort((a, b) => b.length - a.length)[0];
              if (chip) {
                e.preventDefault();
                const from = el.selectionStart - chip.length - 1;
                caretTo.current = from;
                setDraft(draft.slice(0, from) + draft.slice(el.selectionStart));
                return;
              }
            }
            // ↑ in an empty box (or at its start) brings back the last prompt; ↓ goes forward again.
            if (e.key === "ArrowUp" && !e.shiftKey && prompts.length && el.selectionStart === 0 && el.selectionEnd === 0 && (draft === "" || history.current.at >= 0)) {
              e.preventDefault();
              recall(Math.min(prompts.length - 1, history.current.at + 1));
              return;
            }
            if (e.key === "ArrowDown" && history.current.at >= 0 && el.selectionStart === draft.length) {
              e.preventDefault();
              recall(history.current.at - 1);
              return;
            }
            // Enter sends (or queues while a turn runs), ⇧Enter is a new line.
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
      </div>
      <div className="composer-foot">
        <input
          ref={fileInput}
          type="file"
          accept={AGENT_IMAGE_TYPES.join(",")}
          multiple
          hidden
          data-testid="agent-attach-input"
          onChange={(e) => {
            void addFiles([...(e.target.files ?? [])]);
            e.target.value = "";
          }}
        />
        <button className="icon-btn composer-at" title="Attach images (or paste or drop them)" data-testid="agent-attach" disabled={!online || blocked} onClick={() => fileInput.current?.click()}>
          <Paperclip />
        </button>
        <button
          className="icon-btn composer-at"
          title="Point at media, a clip, a track or a marker"
          data-testid="agent-at"
          disabled={!online || blocked}
          onClick={() => {
            const el = input.current;
            if (!el) return;
            const pos = el.selectionStart;
            const pad = pos > 0 && !/\s/.test(draft[pos - 1]!) ? " @" : "@";
            caretTo.current = pos + pad.length;
            setDraft(draft.slice(0, pos) + pad + draft.slice(pos));
            el.focus();
          }}
        >
          <AtSign />
        </button>
        {snapshot && <ComposerChoices dir={snapshot.dir} provider={provider} />}
        <span className="composer-spacer" />
        {running ? (
          <button className="send stop" data-testid="agent-stop" title="Stop" disabled={!online} onClick={() => void actions.agentCancel()}>
            <Square />
          </button>
        ) : (
          <button className="send" data-testid="agent-send" title="Send (Enter)" disabled={!draft.trim() || !online || blocked} onClick={() => void send()}>
            <ArrowUp />
          </button>
        )}
      </div>
    </div>
  );
}

/** What the agent is told about where you are: the playhead and the selected item. */
function ContextLine({ project }: { project: Project }) {
  const frame = usePlayback((s) => Math.floor(s.frame));
  const selected = usePlayback((s) => s.selected);
  const item = selected ? project.tracks.flatMap((t) => t.items).find((i) => i.id === selected) : undefined;
  return (
    <div className="composer-ctx" data-testid="agent-context">
      <MousePointer2 />
      <span className="ellipsis">
        Playhead {frameTimecode(frame, project.canvas.fps)}
        {item ? `, selected ${itemLabel(project, item)}` : ""}
      </span>
    </div>
  );
}

type Menu = "provider" | "model" | "effort" | "access" | undefined;
type Provider = "claude" | "codex";

/**
 * D209 (issue #23): the providers' marks. Anthropic's trademark guidelines allow its marks only in
 * materials it approves beforehand, and OpenAI's ask for permission before its logo is used, so
 * neither logo ships: each provider is its product's name set as a wordmark in the app's own type,
 * with a plain monogram tile beside it (no lab colours, no drawn logo), and "Claude" never as
 * "Claude Code" branding.
 */
const PROVIDERS: Record<Provider, { readonly name: string; readonly lab: string; readonly monogram: string }> = {
  claude: { name: "Claude", lab: "Anthropic", monogram: "C" },
  codex: { name: "Codex", lab: "OpenAI", monogram: "Cx" },
};

export function ProviderMark({ provider, size = "sm" }: { provider: Provider; size?: "sm" | "md" }) {
  return (
    <span className={`provider-mark ${size}`} data-testid="provider-mark" data-provider={provider} aria-hidden>
      {PROVIDERS[provider].monogram}
    </span>
  );
}

const ProviderWordmark = ({ provider }: { provider: Provider }) => (
  <span className="provider-wordmark" data-testid="provider-wordmark" data-provider={provider}>
    {PROVIDERS[provider].name}
  </span>
);

/** ⌘1–⌘4 pick the models in AGENT_MODELS order (like t3code's picker). */
const MODEL_KEYS = AGENT_MODELS.slice(0, 4).map((m, i) => ({ id: m.id, key: String(i + 1) }));

/**
 * The composer's bottom row (D184): provider (Claude Code; Codex to come), model (searchable, with
 * favourites), effort and access. Each opens a small menu above the box; Esc or a click elsewhere
 * closes it. Remembered per project; a new model or effort applies from the next message.
 */
function ComposerChoices({ dir, provider }: { dir: string; provider: string }) {
  const { prefs, favourites } = useAgentPrefs(dir);
  const [open, setOpen] = useState<Menu>(undefined);
  const [search, setSearch] = useState("");
  const row = useRef<HTMLDivElement>(null);
  // ⌘1–⌘4: a model, while the model menu is open or the composer has the focus.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey || e.shiftKey || e.altKey || e.ctrlKey) return;
      const hit = MODEL_KEYS.find((k) => k.key === e.key);
      if (!hit) return;
      const inComposer = row.current?.closest(".composer")?.contains(document.activeElement);
      if (open !== "model" && !inComposer) return;
      e.preventDefault();
      e.stopPropagation();
      setAgentPrefs(dir, { model: hit.id });
      setOpen(undefined);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, dir]);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!row.current?.contains(e.target as Node)) setOpen(undefined);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(undefined);
      }
    };
    window.addEventListener("pointerdown", away, true);
    window.addEventListener("keydown", esc, true);
    return () => {
      window.removeEventListener("pointerdown", away, true);
      window.removeEventListener("keydown", esc, true);
    };
  }, [open]);
  const toggle = (menu: Menu) => {
    setSearch("");
    setOpen(open === menu ? undefined : menu);
  };
  const pick = (patch: Parameters<typeof setAgentPrefs>[1]) => {
    setAgentPrefs(dir, patch);
    setOpen(undefined);
  };
  const model = AGENT_MODELS.find((m) => m.id === prefs.model);
  const access = ACCESS_INFO[prefs.access];
  const AccessIcon = access.icon;
  const models = useMemo(() => {
    const q = search.trim().toLowerCase();
    const all = [{ id: "", name: "Default", detail: "Claude Code's choice", provider: "claude" as const, isNew: false }, ...AGENT_MODELS].filter((m) => !q || m.name.toLowerCase().includes(q) || m.detail.toLowerCase().includes(q));
    // Favourites first, in the list's order.
    return [...all.filter((m) => favourites.includes(m.id)), ...all.filter((m) => !favourites.includes(m.id))];
  }, [search, favourites]);
  return (
    <div className="composer-choices" ref={row}>
      <button className={`choice provider ${open === "provider" ? "open" : ""}`} data-testid="agent-provider" data-provider="claude" title={`Claude, through ${provider} with your subscription`} onClick={() => toggle("provider")}>
        <ProviderMark provider="claude" />
      </button>
      <button className={`choice model ${open === "model" ? "open" : ""}`} data-testid="agent-model" data-model={prefs.model ?? ""} title={`Model: ${model?.name ?? "Default (Claude Code's choice)"}`} onClick={() => toggle("model")}>
        <ProviderWordmark provider="claude" />
        <span className="choice-label">{model?.name ?? "Default"}</span>
        <ChevronDown className="choice-caret" />
      </button>
      <button className={`choice ${open === "effort" ? "open" : ""}`} data-testid="agent-effort" data-effort={prefs.effort ?? ""} title={`Effort: ${prefs.effort ? EFFORT_NAME[prefs.effort] : "Auto"}`} onClick={() => toggle("effort")}>
        <Gauge />
        <span className="choice-label">{prefs.effort ? EFFORT_NAME[prefs.effort] : "Auto"}</span>
      </button>
      <button className={`choice ${open === "access" ? "open" : ""}`} data-testid="agent-access" data-access={prefs.access} title={`${access.name}: ${access.detail}`} onClick={() => toggle("access")}>
        <AccessIcon />
        <span className="choice-label">{access.short}</span>
      </button>
      {open === "provider" && (
        <div className="choice-menu" role="listbox" data-testid="agent-provider-menu">
          <div className="choice-head">Agents</div>
          <button className="choice-option active" role="option" aria-selected data-testid="agent-provider-claude" onClick={() => setOpen(undefined)}>
            <ProviderMark provider="claude" size="md" />
            <span className="grow">
              <ProviderWordmark provider="claude" />
              <span className="choice-detail">Through {provider}, with your subscription</span>
            </span>
            <Check />
          </button>
          <button className="choice-option" role="option" aria-selected={false} disabled data-testid="agent-provider-codex">
            <ProviderMark provider="codex" size="md" />
            <span className="grow">
              <ProviderWordmark provider="codex" />
              <span className="choice-detail">Coming later</span>
            </span>
          </button>
          <div className="choice-foot">Not made by or affiliated with Anthropic or OpenAI.</div>
        </div>
      )}
      {open === "model" && (
        <div className="choice-menu model-menu" role="listbox" data-testid="agent-model-menu">
          <div className="model-rail" data-testid="agent-model-rail">
            <button className="model-rail-btn active" title="Claude" data-testid="agent-model-rail-claude">
              <ProviderMark provider="claude" size="md" />
            </button>
            <button className="model-rail-btn" disabled title="Codex: coming later" data-testid="agent-model-rail-codex">
              <ProviderMark provider="codex" size="md" />
            </button>
          </div>
          <div className="model-list">
          <label className="choice-search">
            <Search />
            <input
              autoFocus
              value={search}
              placeholder="Search models"
              data-testid="agent-model-search"
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && models[0]) pick({ model: models[0].id || undefined });
              }}
            />
          </label>
          {models.map((m) => {
            const on = (prefs.model ?? "") === m.id;
            const fav = favourites.includes(m.id);
            return (
              <div key={m.id || "default"} className={`choice-option ${on ? "active" : ""}`} role="option" aria-selected={on} data-testid="agent-model-option" data-model={m.id} onClick={() => pick({ model: m.id || undefined })}>
                <ProviderMark provider={m.provider} />
                <span className="grow">
                  <span className="model-name">
                    {m.name}
                    {m.isNew && (
                      <span className="new-badge" data-testid="agent-model-new">
                        NEW
                      </span>
                    )}
                  </span>
                  <span className="choice-detail">{m.detail}</span>
                </span>
                {on && <Check />}
                {MODEL_KEYS.find((k) => k.id === m.id) && (
                  <kbd className="model-key" data-testid="agent-model-key">
                    ⌘{MODEL_KEYS.find((k) => k.id === m.id)!.key}
                  </kbd>
                )}
                {m.id && (
                  <button
                    className={`icon-btn choice-star ${fav ? "on" : ""}`}
                    title={fav ? "Remove from favourites" : "Add to favourites"}
                    data-testid="agent-model-star"
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleFavourite(m.id);
                    }}
                  >
                    <Star />
                  </button>
                )}
              </div>
            );
          })}
          {!models.length && <div className="choice-empty">No model matches</div>}
          </div>
        </div>
      )}
      {open === "effort" && (
        <div className="choice-menu" role="listbox" data-testid="agent-effort-menu">
          {([undefined, ...AGENT_EFFORTS] as const).map((e) => {
            const on = prefs.effort === e;
            return (
              <button key={e ?? "auto"} className={`choice-option ${on ? "active" : ""}`} role="option" aria-selected={on} data-testid="agent-effort-option" data-effort={e ?? ""} onClick={() => pick({ effort: e })}>
                <span className="grow">
                  {e ? EFFORT_NAME[e] : "Auto"}
                  <span className="choice-detail">{e === "low" ? "Quick answers" : e === "medium" ? "Balanced" : e === "high" ? "Thinks longer" : e === "max" ? "Thinks the longest" : "Claude Code's default"}</span>
                </span>
                {on && <Check />}
              </button>
            );
          })}
        </div>
      )}
      {open === "access" && (
        <div className="choice-menu" role="listbox" data-testid="agent-access-menu">
          {AGENT_ACCESS.map((a) => {
            const info = ACCESS_INFO[a];
            const Icon = info.icon;
            const on = prefs.access === a;
            return (
              <button key={a} className={`choice-option ${on ? "active" : ""}`} role="option" aria-selected={on} data-testid="agent-access-option" data-access={a} onClick={() => pick({ access: a })}>
                <Icon />
                <span className="grow">
                  {info.name}
                  <span className="choice-detail">{info.detail}</span>
                </span>
                {on && <Check />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
