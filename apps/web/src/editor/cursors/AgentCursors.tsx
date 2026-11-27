// D348: each working agent as a cursor over the editor, moving to what its tool calls touch, with
// its current step on a pill. The cursors take no pointer events (only the pill, which opens the
// agent's chat), hide while the user drags in the same panel, and never touch the playhead or
// the selection. Positions are written to the DOM each animation frame; React only draws the parts.
import type { AgentCursor, AgentCursorChild, AgentInfo, AgentTurn } from "@uncut/contracts";
import { friendlyText } from "@uncut/core/mentions";
import { useEffect, useRef, useState } from "react";

import { agentsOf } from "../../state/agents.ts";
import type { ProjectModel } from "../../state/project.ts";
import { actions, useAppSelect } from "../../state/store.ts";
import { nowText } from "../../panels/agent/workLog.tsx";
import { panels, rememberSideTab } from "../layout.ts";
import { followAgent } from "./follow.ts";
import { advance, emptyGlide, progress, receive, type Glide, type Leg } from "./glide.ts";
import { lerp, pillColour, type Point } from "./place.ts";
import { followScroll, parkSpot, resolveTarget, type Spot } from "./resolve.ts";
import "./cursors.css";

/** At most this many children show; the rest are "+N" on the agent's pill. */
export const CHILDREN_SHOWN = 4;
const FADE_MS = 400;
const CHILD_GLIDE_MS = 300;

const motionQuery = typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : undefined;
const reducedMotion = () => motionQuery?.matches ?? false;
const px = (p: Point) => `translate3d(${Math.round(p.x)}px, ${Math.round(p.y)}px, 0)`;

let pressedPanel: Element | undefined;

/** The panel the user is pressing or dragging in: cursors there hide until the press ends. */
function useUserPress() {
  useEffect(() => {
    const down = (e: PointerEvent) => {
      if (e.button !== 0 || !(e.target instanceof Element) || e.target.closest(".agent-cursors")) return;
      pressedPanel = e.target.closest(".bottom-body, [data-testid=stage], [data-testid=transcript-panel], aside.side") ?? undefined;
    };
    const up = () => (pressedPanel = undefined);
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("pointerup", up, true);
    window.addEventListener("pointercancel", up, true);
    return () => {
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("pointerup", up, true);
      window.removeEventListener("pointercancel", up, true);
    };
  }, []);
}

/** Opens the agent's chat at the turn the cursor belongs to, its running step in view. */
function openAgentAt(agentId: string, turnId: string, dir: string) {
  actions.agentSelect(agentId);
  if (!panels.get().focus) panels.show("side");
  rememberSideTab(dir, "agent");
  setTimeout(() => {
    const turn = document.querySelector(`[data-testid=agent-turn][data-turn="${CSS.escape(turnId)}"]`);
    const target = turn?.querySelector("[data-testid=agent-now]") ?? turn;
    target?.scrollIntoView({ block: "end", behavior: reducedMotion() ? "auto" : "smooth" });
  }, 80);
}

function follow(leg: Leg) {
  const scroll = followAgent.get() ? followScroll(leg.stop.target) : undefined;
  scroll?.body.scrollBy({ left: scroll.by, behavior: reducedMotion() ? "auto" : "smooth" });
}

export function AgentCursors({ project, dir }: { project: ProjectModel; dir: string }) {
  const agent = useAppSelect((s) => s.agent);
  useUserPress();
  const agents = agentsOf(agent);
  return (
    <div className="agent-cursors" data-testid="agent-cursors">
      {agents.map((a, row) => (
        <AgentCursorView
          key={a.id}
          info={a}
          row={row}
          named={agents.length > 1}
          project={project}
          dir={dir}
          turn={agent?.turns.find((t) => t.id === a.running)}
        />
      ))}
    </div>
  );
}

/** A child (subagent, critic round) as drawn: still running, or gliding back into its agent's cursor. */
interface ChildDrawn {
  readonly child: AgentCursorChild;
  readonly leftAt?: number;
}

interface ChildMotion {
  readonly key: string;
  readonly from: Point;
  readonly startedAt: number;
  at: Point;
}

/** The children to draw: the running ones, plus those that just finished, for a moment. */
function useChildren(children: ReadonlyArray<AgentCursorChild>): ReadonlyArray<ChildDrawn> {
  const [leaving, setLeaving] = useState<ReadonlyArray<ChildDrawn>>([]);
  const before = useRef<ReadonlyArray<AgentCursorChild>>([]);
  const ids = children.map((c) => c.id).join("\n");
  useEffect(() => {
    const leftAt = performance.now();
    const gone = before.current.filter((c) => !children.some((x) => x.id === c.id));
    before.current = children;
    if (!gone.length) return;
    setLeaving((list) => [...list, ...gone.map((child) => ({ child, leftAt }))]);
    setTimeout(() => setLeaving((list) => list.filter((l) => l.leftAt !== leftAt)), FADE_MS);
  }, [ids]);
  const running = children.map((child) => ({ child }));
  return [...running, ...leaving.filter((l) => !children.some((c) => c.id === l.child.id))];
}

/** Where a child sits: its own target, else stacked under its agent's pill. */
function childGoal(drawn: ChildDrawn, index: number, main: Point, project: ProjectModel, row: number): Point {
  if (drawn.leftAt !== undefined) return main;
  const spot = drawn.child.target ? resolveTarget(drawn.child.target, project, row) : undefined;
  return spot ?? { x: main.x + 14, y: main.y + 40 + index * 26 };
}

function AgentCursorView({
  info,
  row,
  named,
  project,
  dir,
  turn,
}: {
  info: AgentInfo;
  row: number;
  named: boolean;
  project: ProjectModel;
  dir: string;
  turn: AgentTurn | undefined;
}) {
  const [shown, setShown] = useState<AgentCursor | undefined>(info.cursor);
  const [leaving, setLeaving] = useState(false);
  const [leg, setLeg] = useState<Leg | undefined>();
  const glide = useRef<Glide>(emptyGlide());
  const root = useRef<HTMLDivElement>(null);
  const band = useRef<HTMLDivElement>(null);
  const childEls = useRef(new Map<string, HTMLDivElement>());
  const motion = useRef({ from: undefined as Point | undefined, to: undefined as Spot | undefined, at: undefined as Point | undefined });
  const childMotion = useRef(new Map<string, ChildMotion>());
  const live = info.cursor;

  useEffect(() => {
    if (!live) return;
    if (live.turnId !== shown?.turnId) {
      glide.current = emptyGlide();
      motion.current = { from: undefined, to: undefined, at: undefined };
      setLeg(undefined);
    }
    setShown(live);
    setLeaving(false);
    glide.current = receive(glide.current, live.stops, performance.now());
  }, [live]);

  useEffect(() => {
    if (live || !shown) return;
    setLeaving(true);
    const timer = setTimeout(() => setShown(undefined), FADE_MS);
    return () => clearTimeout(timer);
  }, [live, shown]);

  const children = useChildren(live?.children ?? []);
  const drawnChildren = children.slice(0, CHILDREN_SHOWN);
  const extra = Math.max(0, (live?.children.length ?? 0) - CHILDREN_SHOWN);

  const frame = useRef({ project, row, leaving, children: drawnChildren });
  frame.current = { project, row, leaving, children: drawnChildren };
  const visible = shown !== undefined;

  useEffect(() => {
    if (!visible) return;
    let raf = 0;
    const startLeg = (next: Leg) => {
      const m = motion.current;
      m.from = m.at ?? parkSpot(frame.current.row);
      m.to = undefined;
      follow(next);
      setLeg(next);
    };
    const drawChild = (drawn: ChildDrawn, index: number, main: Point, now: number) => {
      const el = childEls.current.get(drawn.child.id);
      if (!el) return;
      const goal = childGoal(drawn, index, main, frame.current.project, frame.current.row);
      const key = `${JSON.stringify(drawn.child.target ?? null)}|${drawn.leftAt ?? ""}`;
      const before = childMotion.current.get(drawn.child.id);
      const m = before && before.key === key ? before : { key, from: before?.at ?? main, startedAt: now, at: before?.at ?? main };
      const t = reducedMotion() ? 1 : progress({ startedAt: m.startedAt, ms: CHILD_GLIDE_MS }, now);
      m.at = lerp(m.from, goal, t);
      childMotion.current.set(drawn.child.id, m);
      el.style.transform = px(m.at);
      el.dataset.state = drawn.leftAt !== undefined ? "leaving" : "on";
    };
    const drawBand = (spot: Spot | undefined) => {
      const b = band.current;
      const stretch = frame.current.leaving ? undefined : spot?.band;
      if (!b) return;
      b.style.display = stretch ? "block" : "none";
      if (stretch)
        b.style.transform = `translate3d(${Math.round(stretch.left)}px, ${Math.round(stretch.y)}px, 0) scaleX(${Math.max(2, stretch.right - stretch.left)})`;
    };
    const drawMain = (at: Point, spot: Spot | undefined) => {
      const el = root.current;
      if (!el) return;
      el.style.transform = px(at);
      el.dataset.pin = spot?.pin ?? "";
      el.dataset.parked = spot?.parked ? "true" : "";
      el.dataset.hidden = pressedPanel && spot?.panel === pressedPanel ? "true" : "";
      el.dataset.state = frame.current.leaving ? "leaving" : "on";
      const pill = el.querySelector<HTMLElement>(".agent-cursor-pill");
      el.dataset.flip = pill && !spot?.parked && at.x + pill.offsetWidth + 40 > window.innerWidth ? "true" : "";
    };
    const tick = (now: number) => {
      const next = advance(glide.current, now, reducedMotion());
      if (next.leg && next.leg !== glide.current.leg) startLeg(next.leg);
      glide.current = next;
      const m = motion.current;
      const resolved = resolveTarget(next.leg?.stop.target ?? { kind: "park" }, frame.current.project, frame.current.row);
      if (resolved) m.to = resolved;
      const to = m.to ?? m.at ?? parkSpot(frame.current.row);
      m.at = next.leg ? lerp(m.from ?? to, to, progress(next.leg, now)) : to;
      drawMain(m.at, m.to);
      drawBand(m.to);
      frame.current.children.forEach((drawn, index) => drawChild(drawn, index, m.at!, now));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [visible, info.id]);

  if (!shown) return null;
  const colour = info.colour;
  const pill = pillColour(colour);
  const stop = leg ? (shown.stops.find((s) => s.seq === leg.stop.seq) ?? leg.stop) : undefined;
  const friendly = (text: string) => friendlyText(project as never, text);
  const label = stop?.label ?? (turn ? nowText(turn, info.status === "waiting", friendly) : "Working");
  const open = () => openAgentAt(info.id, shown.turnId, dir);
  return (
    <>
      <div className="agent-cursor-band" ref={band} style={{ background: colour }} />
      <div
        className="agent-cursor"
        ref={root}
        data-testid="agent-cursor"
        data-agent={info.id}
        data-target={stop?.target.kind ?? "park"}
        data-item={stop?.target.item}
        data-at={stop?.target.at}
        data-frame={stop?.target.frame}
        data-step={stop?.step}
        style={{ ["--agent-colour" as string]: colour, ["--agent-pill" as string]: pill }}
      >
        <CursorArrow />
        <span className="agent-cursor-pin" />
        <button className="agent-cursor-pill" data-testid="agent-cursor-pill" title={`Open ${info.name}'s chat`} onClick={open}>
          {named && <b>{info.name}</b>}
          <span className="agent-cursor-label" data-testid="agent-cursor-label">
            {label}
          </span>
          {extra > 0 && (
            <span className="agent-cursor-more" data-testid="agent-cursor-more">
              +{extra}
            </span>
          )}
        </button>
      </div>
      {drawnChildren.map((drawn) => (
        <div
          key={drawn.child.id}
          className="agent-cursor child"
          data-testid="agent-cursor-child"
          data-agent={info.id}
          data-child={drawn.child.id}
          ref={(el) => {
            if (el) childEls.current.set(drawn.child.id, el);
            else childEls.current.delete(drawn.child.id);
          }}
          style={{ ["--agent-colour" as string]: colour, ["--agent-pill" as string]: pill }}
        >
          <CursorArrow />
          <button className="agent-cursor-pill" title={`Open ${info.name}'s chat`} onClick={open}>
            <span className="agent-cursor-label">{drawn.child.label}</span>
          </button>
        </div>
      ))}
    </>
  );
}

const CursorArrow = () => (
  <svg className="agent-cursor-arrow" width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
    <path d="M2.2 2.2 L16 7.6 L9.6 9.6 L7.6 16 Z" />
  </svg>
);
