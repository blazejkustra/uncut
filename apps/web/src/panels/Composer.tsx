// The Agent tab's composer (D140, D184, t3code-like): a multiline box where Enter sends and ⇧Enter
// is a new line; @ opens a picker of media, items, tracks and markers that inserts an @label chip
// (Add to chat, D141, inserts the same), and a typed time (@0:12, @12s) offers that moment (D183);
// ↑ in an empty box brings back earlier prompts; while a turn runs the button is Stop and Enter
// queues the message for when it ends. D232 (issue #60): / offers the installed skills (a picked
// one goes in as /name; the server sends its instructions with the message), and since issue #111
// a Templates group above them: a picked template is filled from the project and lands here as a
// brief to edit before sending. Images come in by
// paste, drop or the paperclip. The bottom
// row picks the provider, model, effort and access, remembered per project (agentPrefs.ts). The
// text, chips and images live in the store.
import { AGENT_IMAGE_MAX, AGENT_IMAGE_TYPES, AGENT_IMAGES_MAX, type AgentImage, type AgentMention, type AgentTurn } from "@uncut/contracts";
import { mentionCandidates, momentLabel, parseMoment } from "@uncut/core/mentions";
import {
  ArrowLeftRight,
  ArrowUp,
  AtSign,
  Blend,
  BookOpen,
  Clock3,
  FileText,
  Film,
  Flag,
  ListVideo,
  MousePointer2,
  Music,
  Paperclip,
  Rows3,
  Sparkles,
  Square,
  SquareDashed,
  X,
} from "lucide-react";
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { usePlayback } from "../preview/playback.ts";
import { frameTimecode } from "../state/format.ts";
import { itemLabel } from "../state/project.ts";
import { bridge } from "../state/bridge.ts";
import { isAttachable, quotePaths, sortPasted } from "./pasted.ts";
import { actions, getState, useApp, type Project } from "../state/store.ts";
import { ComposerChoices } from "./composer/Choices.tsx";
import { slashItems, type SlashItem } from "./composer/slash.ts";
import { ColdMessageLine } from "./ColdMessageLine.tsx";
import { TokenMeter } from "./TokenMeter.tsx";
import { Tooltip } from "../ui/Tooltip.tsx";
import "./skills/skills.css";
export { ACCESS_INFO, ProviderMark } from "./composer/Choices.tsx";

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

const SLASH_GROUPS = { template: "Templates", skill: "Skills", claude: "Your Claude Code skills" } as const;
const KIND_ICON = {
  media: Film,
  item: ListVideo,
  track: Rows3,
  marker: Flag,
  moment: Clock3,
  range: ArrowLeftRight,
  effect: Sparkles,
  transition: Blend,
  region: SquareDashed,
} as const;

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

export function Composer({
  project,
  online,
  blocked,
  agentId,
  turns,
  running,
  provider,
}: {
  project: Project;
  online: boolean;
  blocked: boolean;
  agentId: string;
  turns: ReadonlyArray<AgentTurn>;
  running: string | null;
  provider: string;
}) {
  const { agentDraft: draft, agentMentions: mentions, agentQueued, agentFocus, agentImages: images, snapshot, brand, templates } = useApp();
  const queued = agentQueued?.[agentId];
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
    const moment =
      frame !== undefined ? [{ kind: "moment" as const, id: `frame:${frame}`, label: momentLabel(frame, fps), frame, detail: `Moment, frame ${frame}` }] : [];
    return [...moment, ...candidates.filter((c) => c.label.toLowerCase().includes(q)).slice(0, 8 - moment.length)];
  }, [candidates, query?.[1], fps]);
  const pickerOpen = !!query && dismissed !== at && matches.length > 0 && !blocked;
  // D232: /name calls a skill; the picker lists the installed ones (a path closes it). Issue #111:
  // the templates come first as their own group, the skills after them.
  useEffect(() => {
    if (online && !templates) void actions.templatesGet();
  }, [online, !templates]);
  const slash = !query ? /(?:^|\s)\/([A-Za-z0-9:._-]{0,80})$/.exec(before) : null;
  const slashAt = slash ? caret - slash[1]!.length - 1 : -1;
  const skillMatches = useMemo(
    () => (slash ? slashItems(slash[1]!, brand?.skills ?? [], templates ?? [], brand?.claudeSkills ?? []) : []),
    [brand?.skills, brand?.claudeSkills, templates, slash?.[1]],
  );
  const skillOpen = !!slash && dismissed !== slashAt && skillMatches.length > 0 && !blocked;
  useEffect(() => setPick(0), [query?.[1], slash?.[1]]);

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

  const chooseSkill = (x: SlashItem) => {
    if (x.kind === "template") {
      // The /query goes at once; the filled brief comes in where it was when the server answers.
      caretTo.current = slashAt;
      setDraft(draft.slice(0, slashAt) + draft.slice(caret));
      void actions.useTemplate(x.id, slashAt);
      return;
    }
    const insert = `/${x.id} `;
    caretTo.current = slashAt + insert.length;
    setDraft(draft.slice(0, slashAt) + insert + draft.slice(caret));
  };

  const send = async () => {
    const text = draft.trim();
    if (!text || !online || blocked) return;
    history.current = { at: -1, saved: "" };
    const attached = images;
    setAttachError(undefined);
    if (running) {
      // One message waits for the turn to end; a second one joins it.
      actions.agentQueue(agentId, {
        prompt: queued ? `${queued.prompt}\n\n${text}` : text,
        mentions: [...(queued?.mentions ?? []), ...mentions],
        images: [...(queued?.images ?? []), ...attached].slice(0, AGENT_IMAGES_MAX),
      });
      setDraft("", []);
      actions.setAgentImages([]);
      return;
    }
    setDraft("", []);
    actions.setAgentImages([]);
    if (!(await actions.agentSend(text, mentions, attached, { agentId }))) {
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
      <ColdMessageLine online={online} agentId={agentId} />
      <ContextLine project={project} />
      {queued && (
        <div className="composer-queued" data-testid="agent-queued">
          <span className="ellipsis">Queued: {queued.prompt}</span>
          <Tooltip label="Don't send it">
            <button className="icon-btn" data-testid="agent-unqueue" onClick={() => actions.agentQueue(agentId, undefined)}>
              <X />
            </button>
          </Tooltip>
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
      {skillOpen && (
        <div className="mention-picker" role="listbox" data-testid="skill-picker">
          {skillMatches.map((x, i) => (
            <Fragment key={`${x.kind}:${x.id}`}>
              {x.kind !== skillMatches[i - 1]?.kind && (
                <div className="slash-group" role="presentation" data-testid={`${x.kind === "claude" ? "claude-skill" : x.kind}-group`}>
                  {SLASH_GROUPS[x.kind]}
                </div>
              )}
              <button
                role="option"
                aria-selected={i === pick}
                className={`mention-option ${i === pick ? "active" : ""}`}
                data-testid={`${x.kind === "claude" ? "claude-skill" : x.kind}-option`}
                {...(x.kind === "template" ? { "data-template": x.id } : { "data-skill": x.id })}
                title={x.description}
                onMouseDown={(e) => {
                  e.preventDefault();
                  chooseSkill(x);
                }}
                onMouseEnter={() => setPick(i)}
              >
                {x.kind === "template" ? <FileText /> : <BookOpen />}
                <span className="ellipsis skill-name">{x.name}</span>
                <span className="skill-call">{x.kind === "template" ? (x.builtin ? "template" : "yours") : `/${x.id}`}</span>
              </button>
            </Fragment>
          ))}
        </div>
      )}
      {images.length > 0 && (
        <div className="composer-images" data-testid="agent-attachments">
          {images.map((img, i) => (
            <div key={i} className="composer-image" data-testid="agent-attachment" title={img.name}>
              <img src={`data:${img.mimeType};base64,${img.data}`} alt={img.name} />
              <Tooltip label="Remove">
                <button className="icon-btn" data-testid="agent-attachment-remove" onClick={() => actions.setAgentImages(images.filter((_, j) => j !== i))}>
                  <X />
                </button>
              </Tooltip>
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
          placeholder={
            blocked
              ? "Set up Claude Code to use the agent"
              : running
                ? "Write the next message; it's sent when this turn ends"
                : "Ask for an edit; @ to point at media or a clip, / for a skill or a template"
          }
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
            if (skillOpen) {
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                setPick((p) => (p + (e.key === "ArrowDown" ? 1 : skillMatches.length - 1)) % skillMatches.length);
                return;
              }
              if (e.key === "Enter" || e.key === "Tab") {
                e.preventDefault();
                chooseSkill(skillMatches[Math.min(pick, skillMatches.length - 1)]!);
                return;
              }
              if (e.key === "Escape") {
                e.preventDefault();
                setDismissed(slashAt);
                return;
              }
            }
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
            if (
              e.key === "ArrowUp" &&
              !e.shiftKey &&
              prompts.length &&
              el.selectionStart === 0 &&
              el.selectionEnd === 0 &&
              (draft === "" || history.current.at >= 0)
            ) {
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
        <Tooltip label="Attach images (or paste or drop them)">
          <button className="icon-btn composer-at" data-testid="agent-attach" disabled={!online || blocked} onClick={() => fileInput.current?.click()}>
            <Paperclip />
          </button>
        </Tooltip>
        <Tooltip label="Point at media, a clip, a track or a marker">
          <button
            className="icon-btn composer-at"
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
        </Tooltip>
        {snapshot && <ComposerChoices dir={snapshot.dir} provider={provider} />}
        <span className="composer-spacer" />
        {running ? (
          <Tooltip label="Stop">
            <button className="send stop" data-testid="agent-stop" disabled={!online} onClick={() => void actions.agentCancel(agentId)}>
              <Square />
            </button>
          </Tooltip>
        ) : (
          <Tooltip label="Send" keys={["↩"]}>
            <button className="send" data-testid="agent-send" disabled={!draft.trim() || !online || blocked} onClick={() => void send()}>
              <ArrowUp />
            </button>
          </Tooltip>
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
      <TokenMeter />
    </div>
  );
}
