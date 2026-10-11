// Uncut editor renderer. Draws the project, plays real footage and turns gestures
// into edit ops. Every change goes through the main process (window.uncut.edit),
// which validates it, saves project.json and sends back the new project.
import { esc, textHtml } from "./render.js";

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const icon = (name) => `<i data-lucide="${name}"></i>`;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

let snap; // { dir, project, revision, media: {id: url}, canUndo, canRedo }
let duration = 0;
const ui = { frame: 0, playing: false, selected: null, selectedTransition: null, side: "inspector", lib: "media", ppf: null };
const thumbs = new Map(); // mediaId -> sprite meta

const project = () => snap.project;
const fps = () => snap.project.canvas.fps;
const mainTrack = () => project().tracks.find((t) => t.role === "main");
const mediaById = (id) => project().media.find((m) => m.id === id);
const allItems = () => project().tracks.flatMap((track) => track.items.map((item) => ({ item, track })));
const findItem = (id) => allItems().find((x) => x.item.id === id);

function tc(frames) {
  const f = Math.floor(frames);
  const s = Math.floor(f / fps());
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}:${String(f % fps()).padStart(2, "0")}`;
}
const secs = (frames) => `${(frames / fps()).toFixed(1)}s`;

function itemLabel(item) {
  if (item.type === "text") return item.text.replace(/\[\[|\]\]/g, "").replace(/\n/g, " ");
  if (item.media) return item.id.charAt(0).toUpperCase() + item.id.slice(1).replace(/-/g, " ");
  return item.id;
}

/** Main-track items sit back to back; free items carry `start`. */
function derive() {
  for (const track of project().tracks) {
    let t = 0;
    for (const item of track.items) {
      if (track.role === "main") { item._start = t; t += item.duration; } else item._start = item.start;
    }
  }
  duration = Math.max(1, ...allItems().map(({ item }) => item._start + item.duration));
  ui.frame = clamp(ui.frame, 0, duration - 1);
  if (ui.selected && !findItem(ui.selected)) ui.selected = null;
  if (ui.selectedTransition && !findItem(ui.selectedTransition)?.item.transitionIn) ui.selectedTransition = null;
}

// ---------- compositor ----------

/**
 * Everything visible at frame f, bottom layer first. A transition is centred on its cut:
 * the outgoing clip runs half the transition past its end, the incoming one starts half
 * before its start, and the incoming clip fades in on top.
 */
function visualsAt(f) {
  const out = [];
  const tracks = [...project().tracks].reverse();
  for (const track of tracks) {
    if (track.hidden || track.kind === "audio") continue;
    const items = track.items;
    items.forEach((item, i) => {
      const half = item.transitionIn ? item.transitionIn.duration / 2 : 0;
      const nextHalf = track.role === "main" && items[i + 1]?.transitionIn ? items[i + 1].transitionIn.duration / 2 : 0;
      const from = item._start - half;
      const to = item._start + item.duration + nextHalf;
      if (f < from || f >= to) return;
      let opacity = 1;
      if (half && f < item._start + half) opacity = clamp((f - from) / (2 * half), 0, 1);
      if (item.type === "text") {
        const fadeIn = item.animation?.in?.module === "move.fade" ? item.animation.in.duration : 0;
        if (fadeIn) opacity = clamp((f - item._start) / fadeIn, 0, 1);
      }
      out.push({ item, track, opacity, source: item.media ? (item.in + (f - item._start)) / fps() : 0 });
    });
  }
  return out;
}

const videos = new Map(); // itemId -> <video>

function videoFor(item) {
  let el = videos.get(item.id);
  if (el) return el;
  el = document.createElement("video");
  el.muted = true;
  el.playsInline = true;
  el.preload = "auto";
  el.src = snap.media[item.media];
  el.dataset.item = item.id;
  el.addEventListener("seeked", () => {
    if (el._want != null && Math.abs(el.currentTime - el._want) > 0.004) el.currentTime = el._want;
    else el._want = null;
  });
  videos.set(item.id, el);
  $("#video-layer").append(el);
  return el;
}

/** Seek without piling up: while a seek runs, only the latest target is kept. */
function seek(el, t) {
  el._want = t;
  if (!el.seeking && Math.abs(el.currentTime - t) > 0.004) el.currentTime = t;
}

function renderPreview() {
  const f = ui.frame;
  const vis = visualsAt(f);
  const clips = vis.filter((v) => v.item.type === "clip");
  // Warm up the next main clip two seconds ahead so the cut doesn't wait for a decoder.
  const ahead = mainTrack().items.find((it) => it._start - (it.transitionIn?.duration ?? 0) / 2 > f && it._start - f < 2 * fps());
  const keep = new Set([...clips.map((c) => c.item.id), ahead?.id].filter(Boolean));
  for (const [id, el] of videos) {
    if (!keep.has(id)) { el.pause(); el.removeAttribute("src"); el.load(); el.remove(); videos.delete(id); }
  }
  clips.forEach((c, z) => {
    const el = videoFor(c.item);
    el.style.opacity = c.opacity;
    el.style.zIndex = z + 1;
    el.muted = c.opacity < 1 || !mediaById(c.item.media)?.probe?.hasAudio;
    const target = c.source + 0.0001;
    if (ui.playing) {
      if (el.paused) { seek(el, target); el.play().catch(() => {}); }
      else if (Math.abs(el.currentTime - target) > 0.12) seek(el, target);
    } else {
      if (!el.paused) el.pause();
      seek(el, target);
    }
  });
  if (ahead && !clips.some((c) => c.item.id === ahead.id)) {
    const el = videoFor(ahead);
    el.style.opacity = 0;
    el.style.zIndex = 0;
    el.pause();
    seek(el, (ahead.in - (ahead.transitionIn?.duration ?? 0) / 2) / fps() + 0.0001);
  }

  $("#text-layer").innerHTML = vis
    .filter((v) => v.item.type === "text")
    .map(({ item, opacity }) => textHtml(item, project().canvas, { opacity, selected: item.id === ui.selected }))
    .join("");
  $("#timecode").textContent = `${tc(f)} / ${tc(duration)}`;
  const ph = $(".playhead");
  if (ph) ph.style.left = `${f * ui.ppf}px`;
}

/** Fit the canvas into the stage at the project's aspect ratio. */
function fitFrame() {
  const box = $("#stage-canvas").getBoundingClientRect();
  const { width: W, height: H } = project().canvas;
  const s = Math.min((box.width - 36) / W, (box.height - 36) / H);
  Object.assign($("#frame").style, { width: `${W * s}px`, height: `${H * s}px` });
}

// ---------- playback ----------

let clock = null;

function play() {
  if (ui.playing) return;
  if (ui.frame >= duration - 1) ui.frame = 0;
  ui.playing = true;
  clock = { f0: ui.frame, t0: performance.now() };
  requestAnimationFrame(tick);
  renderTransport();
}

function pause() {
  ui.playing = false;
  ui.frame = Math.floor(ui.frame);
  for (const el of videos.values()) el.pause();
  renderTransport();
  renderPreview();
}

/**
 * The wall clock drives playback, but it follows the top visible video: if decoding
 * starts late, the clock is re-anchored to the video instead of seeking the video.
 */
function tick(now) {
  if (!ui.playing) return;
  let f = clock.f0 + ((now - clock.t0) * fps()) / 1000;
  const top = visualsAt(f).filter((v) => v.item.type === "clip" && v.opacity === 1).at(-1);
  const el = top && videos.get(top.item.id);
  if (el && !el.paused && !el.seeking && el.readyState >= 3) {
    const vf = top.item._start + el.currentTime * fps() - top.item.in;
    if (Math.abs(vf - f) > 2) { clock = { f0: vf, t0: now }; f = vf; }
  }
  if (f >= duration - 1) { ui.frame = duration - 1; pause(); return; }
  ui.frame = f;
  renderPreview();
  requestAnimationFrame(tick);
}

function setFrame(f) {
  ui.frame = clamp(Math.round(f), 0, duration - 1);
  if (ui.playing) clock = { f0: ui.frame, t0: performance.now() };
  renderPreview();
}

function renderTransport() {
  $("#play").innerHTML = icon(ui.playing ? "pause" : "play");
  $("#play").title = ui.playing ? "Pause (Space)" : "Play (Space)";
  window.lucide.createIcons();
}

// ---------- edits ----------

let toastTimer;
function toast(msg, ok = false) {
  const el = $("#toast");
  el.textContent = msg;
  el.className = `toast ${ok ? "ok" : ""}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), ok ? 8000 : 6000);
}

function accept(next) {
  snap = next;
  derive();
  renderAll();
  $("#save-state").textContent = `Saved · revision ${snap.revision}`;
}

async function commit(ops, summary) {
  const r = await window.uncut.edit({ ops, summary });
  if (r.error) {
    toast(r.details?.length ? `${r.error}: ${r.details[0]}` : r.error);
    renderTimeline();
    return false;
  }
  accept(r);
  return true;
}

async function undo() { accept(await window.uncut.undo()); }
async function redo() { accept(await window.uncut.redo()); }

function uniqueId(base) {
  const ids = new Set(allItems().map(({ item }) => item.id));
  for (let n = 2; ; n++) if (!ids.has(`${base}-${n}`)) return `${base}-${n}`;
}

function splitAtPlayhead() {
  const f = Math.floor(ui.frame);
  const under = (it) => it._start < f && f < it._start + it.duration;
  const sel = ui.selected && findItem(ui.selected)?.item;
  const target = sel && under(sel) ? sel : mainTrack().items.find(under);
  if (!target) return toast("Put the playhead over a clip to split it.");
  commit([{ op: "split_item", item: target.id, at: f - target._start, newId: uniqueId(target.id.replace(/-\d+$/, "")) }], `Split ${target.id}`);
}

function deleteSelected() {
  if (ui.selectedTransition) return commit([{ op: "set_transition", item: ui.selectedTransition, transition: null }], "Removed transition");
  if (ui.selected) commit([{ op: "delete_item", item: ui.selected }], `Deleted ${ui.selected}`);
}

// ---------- timeline ----------

const TH = 44; // thumb height inside a main clip
function stripHtml(item, width) {
  const t = thumbs.get(item.media);
  if (!t) return "";
  const tw = Math.round((t.w / t.h) * TH);
  let html = "";
  for (let x = 0; x < width; x += tw) {
    const sec = (item.in + x / ui.ppf) / fps();
    const i = Math.min(Math.floor(sec / t.every), t.cols * t.rows - 1);
    html += `<i style="left:${x}px;width:${tw}px;background-image:url('${t.url}');background-size:${t.cols * tw}px ${t.rows * TH}px;background-position:-${(i % t.cols) * tw}px -${Math.floor(i / t.cols) * TH}px"></i>`;
  }
  return `<div class="strip">${html}</div>`;
}

function fitZoom() {
  const w = $("#bottom-body").clientWidth - 148 - 60;
  ui.ppf = Math.max(0.02, w / duration);
}

function renderTimeline() {
  if (!ui.ppf) fitZoom();
  const ppf = ui.ppf;
  const x = (frame) => frame * ppf;
  const width = x(duration) + 240;
  const step = [1, 2, 5, 10, 30, 60].find((s) => s * fps() * ppf >= 60) ?? 120;
  let ruler = "";
  for (let s = 0; s * fps() <= duration + step * fps(); s += step) ruler += `<div class="tick" style="left:${x(s * fps())}px"><span>${s}s</span></div>`;

  let heads = `<div class="tl-corner"></div>`;
  let lanes = `<div class="tl-ruler" id="ruler">${ruler}</div>`;
  for (const track of project().tracks) {
    const main = track.role === "main";
    const kindIcon = { text: "type", video: main ? "film" : "layers", audio: "audio-lines" }[track.kind];
    heads += `<div class="tl-head ${main ? "main" : ""}"><div class="name">${icon(kindIcon)}${esc(track.name)}${main ? `<span class="badge">${icon("magnet")}</span>` : ""}</div></div>`;
    let html = "";
    track.items.forEach((item, i) => {
      const cls = item.type === "clip" ? "video" : item.type;
      const sel = item.id === ui.selected ? "selected" : "";
      const w = Math.max(4, x(item.duration) - 2);
      const strip = item.type === "clip" ? stripHtml(item, w) : "";
      html += `<div class="clip ${cls} ${sel}" data-item="${item.id}" data-track="${track.id}" style="left:${x(item._start)}px;width:${w}px">${strip}<span class="nm">${esc(itemLabel(item))}</span><span class="meta">${secs(item.duration)}</span><span class="edge l" data-edge="start"></span><span class="edge r" data-edge="end"></span></div>`;
      if (main && i > 0) {
        const tsel = ui.selectedTransition === item.id ? "selected" : "";
        html += item.transitionIn
          ? `<div class="trans ${tsel}" data-transition="${item.id}" title="${esc(item.transitionIn.module)}, ${item.transitionIn.duration} frames" style="left:${x(item._start)}px">${icon("blend")}</div>`
          : "";
      }
    });
    lanes += `<div class="tl-lane ${main ? "main" : ""}" data-track="${track.id}">${html}</div>`;
  }
  const scroll = $(".tl-scroll")?.scrollLeft ?? 0;
  $("#bottom-body").innerHTML = `<div class="tl-heads">${heads}</div>
    <div class="tl-scroll"><div class="tl-lanes" data-testid="timeline" style="width:${width}px">${lanes}<div class="playhead" style="left:${x(ui.frame)}px"></div></div></div>`;
  $(".tl-scroll").scrollLeft = scroll;
  window.lucide.createIcons();
}

function frameAtClientX(clientX) {
  const r = $(".tl-lanes").getBoundingClientRect();
  return (clientX - r.left) / ui.ppf;
}

/** Pointer gestures on the timeline: scrub the ruler, select, trim edges, move free clips. */
function onTimelineDown(e) {
  if (e.button !== 0) return;
  if (e.target.closest("#ruler")) {
    if (ui.playing) pause();
    setFrame(frameAtClientX(e.clientX));
    const move = (ev) => setFrame(frameAtClientX(ev.clientX));
    const up = () => { removeEventListener("pointermove", move); removeEventListener("pointerup", up); };
    addEventListener("pointermove", move);
    addEventListener("pointerup", up);
    return;
  }
  const tr = e.target.closest("[data-transition]");
  if (tr) {
    ui.selectedTransition = tr.dataset.transition;
    ui.selected = null;
    ui.side = "inspector";
    renderAll();
    return;
  }
  const clipEl = e.target.closest(".clip");
  if (!clipEl) {
    if (e.target.closest(".tl-lanes")) { setFrame(frameAtClientX(e.clientX)); }
    return;
  }
  const { item, track } = findItem(clipEl.dataset.item);
  const edge = e.target.dataset.edge;
  const x0 = e.clientX;
  const left0 = parseFloat(clipEl.style.left);
  const width0 = parseFloat(clipEl.style.width);
  let moved = false;
  if (ui.selected !== item.id || ui.selectedTransition) {
    ui.selected = item.id;
    ui.selectedTransition = null;
    ui.side = "inspector";
    renderSide();
    $$(".clip.selected").forEach((c) => c.classList.remove("selected"));
    clipEl.classList.add("selected");
    renderPreview();
  }
  const delta = (ev) => Math.round((ev.clientX - x0) / ui.ppf);
  const move = (ev) => {
    const d = delta(ev);
    if (!moved && Math.abs(ev.clientX - x0) < 3) return;
    moved = true;
    clipEl.classList.add("dragging");
    if (edge === "start") Object.assign(clipEl.style, { left: `${left0 + d * ui.ppf}px`, width: `${Math.max(4, width0 - d * ui.ppf)}px` });
    else if (edge === "end") clipEl.style.width = `${Math.max(4, width0 + d * ui.ppf)}px`;
    else if (track.role !== "main") clipEl.style.left = `${left0 + d * ui.ppf}px`;
  };
  const up = (ev) => {
    removeEventListener("pointermove", move);
    removeEventListener("pointerup", up);
    if (!moved) {
      setFrame(frameAtClientX(ev.clientX));
      return;
    }
    const d = delta(ev);
    if (!d) return renderTimeline();
    if (edge === "start") commit([{ op: "trim_item", item: item.id, edge: "start", frames: d }], `Trimmed ${item.id}`);
    else if (edge === "end") commit([{ op: "trim_item", item: item.id, edge: "end", frames: -d }], `Trimmed ${item.id}`);
    else if (track.role !== "main") commit([{ op: "move_item", item: item.id, start: Math.max(0, item.start + d) }], `Moved ${item.id}`);
    else renderTimeline();
  };
  addEventListener("pointermove", move);
  addEventListener("pointerup", up);
}

// ---------- inspector ----------

const TRANSITIONS = [
  ["transition.crossfade", "Crossfade"],
  ["transition.wipe", "Wipe"],
  ["transition.push-left", "Push left"],
  ["transition.zoom", "Zoom"],
  ["transition.iris", "Iris"],
];

function numField(label, value, attrs) {
  return `<label class="field"><span class="k">${label}</span><input type="number" value="${value}" ${attrs} /></label>`;
}

function renderInspector() {
  if (ui.selectedTransition) {
    const { item } = findItem(ui.selectedTransition);
    const tr = item.transitionIn;
    return `<div class="insp-title">${icon("blend")}Transition</div>
      <div class="insp-sub">Into ${esc(itemLabel(item))}</div>
      <div class="group"><div class="group-label">Style</div>
        <label class="field select"><select data-transition-module="${item.id}">${TRANSITIONS.map(([id, n]) => `<option value="${id}" ${id === tr.module ? "selected" : ""}>${n}</option>`).join("")}</select></label>
        <div style="height:8px"></div>
        ${numField("Frames", tr.duration, `data-transition-duration="${item.id}" min="2" step="2"`)}
      </div>
      <div class="hint">Preview draws every style as a crossfade for now. <kbd>⌫</kbd> removes it.</div>`;
  }
  const found = ui.selected && findItem(ui.selected);
  if (!found) {
    const p = project();
    return `<div class="insp-title">${icon("clapperboard")}${esc(p.name)}</div>
      <div class="insp-sub">${p.canvas.width}×${p.canvas.height}, ${p.canvas.fps} fps</div>
      <div class="group"><div class="kv"><span>Length</span><span>${secs(duration)}</span></div>
        <div class="kv"><span>Media</span><span>${p.media.length}</span></div>
        <div class="kv"><span>Folder</span><span title="${esc(snap.dir)}">${esc(snap.dir.split("/").pop())}</span></div></div>
      <div class="hint">Click a clip to select it. Drag its edges to trim. <kbd>S</kbd> splits at the playhead, <kbd>⌫</kbd> deletes, <kbd>Space</kbd> plays, <kbd>←</kbd><kbd>→</kbd> step a frame, <kbd>⌘Z</kbd> undoes.</div>`;
  }
  const { item, track } = found;
  const main = track.role === "main";
  if (item.type === "text") {
    return `<div class="insp-title">${icon("type")}Text</div>
      <div class="insp-sub">${esc(track.name)} track</div>
      <div class="group"><div class="group-label">Content</div><textarea class="text-edit" data-text="${item.id}">${esc(item.text)}</textarea></div>
      <div class="group"><div class="group-label">Style</div>
        <div class="field-row">${numField("Size", item.style.size, `data-style-size="${item.id}" min="8"`)}${numField("Weight", item.style.weight ?? 600, `data-style-weight="${item.id}" min="100" max="900" step="50"`)}</div></div>
      <div class="group"><div class="group-label">Position</div>
        <div class="field-row">${numField("X", item.transform.x, `data-pos="x" data-id="${item.id}"`)}${numField("Y", item.transform.y, `data-pos="y" data-id="${item.id}"`)}</div></div>
      <div class="group"><div class="group-label">Timing</div>
        <div class="kv"><span>Starts</span><span>${tc(item._start)}</span></div><div class="kv"><span>Length</span><span>${secs(item.duration)}</span></div></div>`;
  }
  const m = mediaById(item.media);
  const idx = track.items.indexOf(item);
  return `<div class="insp-title">${icon("film")}${esc(itemLabel(item))}</div>
    <div class="insp-sub" title="${esc(m.path)}">${esc(m.name)}</div>
    <div class="group"><div class="group-label">Timing</div>
      <div class="kv"><span>Starts</span><span>${tc(item._start)}</span></div>
      <div class="kv"><span>Length</span><span>${secs(item.duration)}</span></div>
      <div class="kv"><span>Source in</span><span>${tc(item.in)}</span></div>
      <div class="kv"><span>Source out</span><span>${tc(item.in + item.duration)}</span></div></div>
    ${main && idx > 0 ? `<div class="group"><div class="group-label">Transition in</div>
      <label class="field select"><select data-transition-module="${item.id}"><option value="">None (cut)</option>${TRANSITIONS.map(([id, n]) => `<option value="${id}" ${id === item.transitionIn?.module ? "selected" : ""}>${n}</option>`).join("")}</select></label></div>` : ""}
    <div class="group"><div class="group-label">Source</div>
      <div class="kv"><span>Size</span><span>${m.probe.width}×${m.probe.height}</span></div>
      <div class="kv"><span>Frame rate</span><span>${m.probe.fps} fps</span></div></div>`;
}

function renderAgent() {
  return `<div class="hint">The agent arrives with spike B.</div>`;
}

function renderSide() {
  $$("[data-side]").forEach((b) => b.classList.toggle("active", b.dataset.side === ui.side));
  $("#side-body").innerHTML = ui.side === "agent" ? renderAgent() : renderInspector();
  window.lucide.createIcons();
}

async function onSideChange(e) {
  const t = e.target;
  if (t.dataset.transitionModule !== undefined) {
    const id = t.dataset.transitionModule;
    const cur = findItem(id).item.transitionIn;
    const transition = t.value ? { module: t.value, duration: cur?.duration ?? 30 } : null;
    await commit([{ op: "set_transition", item: id, transition }], "Changed transition");
  } else if (t.dataset.transitionDuration) {
    const id = t.dataset.transitionDuration;
    await commit([{ op: "set_transition", item: id, transition: { ...findItem(id).item.transitionIn, duration: Number(t.value) } }], "Changed transition length");
  } else if (t.dataset.text) {
    await commit([{ op: "update_item", item: t.dataset.text, set: { text: t.value } }], "Edited text");
  } else if (t.dataset.styleSize) {
    await commit([{ op: "update_item", item: t.dataset.styleSize, set: { style: { size: Number(t.value) } } }], "Text size");
  } else if (t.dataset.styleWeight) {
    await commit([{ op: "update_item", item: t.dataset.styleWeight, set: { style: { weight: Number(t.value) } } }], "Text weight");
  } else if (t.dataset.pos) {
    await commit([{ op: "update_item", item: t.dataset.id, set: { transform: { [t.dataset.pos]: Number(t.value) } } }], "Moved text");
  }
}

// ---------- library ----------

function renderLibrary() {
  $$("#rail [data-lib]").forEach((b) => b.classList.toggle("active", b.dataset.lib === ui.lib));
  let html = "";
  if (ui.lib === "media") {
    html = `<div class="lib-head">Media</div><div class="lib-section"><div class="grid2">${project()
      .media.map((m) => {
        const t = thumbs.get(m.id);
        const bg = t ? `background-image:url('${t.url}');background-size:${t.cols * 100}% ${t.rows * 100}%;background-position:0 0` : "";
        return `<button class="tile media-tile" data-add-media="${m.id}" title="Add 5 s to the end of the main track"><div class="thumb" style="${bg}"><span class="dur">${secs(m.probe.frames)}</span></div><div class="tile-name">${esc(m.name)}</div><div class="tile-sub">${m.probe.width}×${m.probe.height}, ${m.probe.fps} fps</div></button>`;
      })
      .join("")}</div></div><div class="hint">Click a clip to add its first 5 s to the end of the main track, then trim it to the part you want.</div>`;
  } else if (ui.lib === "text") {
    html = `<div class="lib-head">Text</div><div class="lib-section"><div class="grid2">
      <button class="tile" data-add-text="title"><div class="tp title"><div>Title</div></div><div class="tile-name">Title</div></button>
      <button class="tile" data-add-text="lower"><div class="tp lower"><div><b>Lower third</b>Subtitle</div></div><div class="tile-name">Lower third</div></button>
    </div></div><div class="hint">Adds the text at the playhead on the Text track.</div>`;
  } else {
    html = `<div class="lib-head">Transitions</div><div class="lib-section"><div class="list">${TRANSITIONS.map(([id, n]) => `<button class="row" data-add-transition="${id}">${icon("blend")}<span class="grow">${n}</span></button>`).join("")}</div></div><div class="hint">Adds the transition at the cut nearest the playhead.</div>`;
  }
  $("#library").innerHTML = html;
  window.lucide.createIcons();
}

async function onLibraryClick(e) {
  const t = e.target.closest("[data-add-media],[data-add-text],[data-add-transition]");
  if (!t) return;
  if (t.dataset.addMedia) {
    const m = mediaById(t.dataset.addMedia);
    const len = Math.min(5 * fps(), m.probe.frames);
    const id = uniqueId("shot");
    const ok = await commit([{ op: "insert_item", track: mainTrack().id, item: { id, type: "clip", media: m.id, in: 0, duration: len } }], `Added ${id}`);
    if (ok) { ui.selected = id; setFrame(findItem(id).item._start); renderAll(); }
  } else if (t.dataset.addText) {
    const textTrack = project().tracks.find((tr) => tr.kind === "text");
    if (!textTrack) return toast("This project has no text track.");
    const start = Math.floor(ui.frame);
    const next = textTrack.items.filter((i) => i.start > start).sort((a, b) => a.start - b.start)[0];
    const len = Math.min(3 * fps(), (next?.start ?? Infinity) - start);
    if (len < fps() / 2 || textTrack.items.some((i) => i.start <= start && start < i.start + i.duration)) return toast("There's already text at the playhead. Move the playhead to an empty spot on the Text track.");
    const lower = t.dataset.addText === "lower";
    const H = project().canvas.height;
    const id = uniqueId("txt");
    const item = { id, type: "text", start, duration: len, text: lower ? "Lower third" : "Title", transform: { x: Math.round(project().canvas.width * 0.0625), y: Math.round(H * (lower ? 0.83 : 0.7)) }, style: { preset: lower ? "text.lower-third" : "text.title", size: Math.round(H * (lower ? 0.05 : 0.1)), weight: 600, color: "fg" } };
    if (await commit([{ op: "insert_item", track: textTrack.id, item }], `Added ${id}`)) { ui.selected = id; renderAll(); }
  } else if (t.dataset.addTransition) {
    const items = mainTrack().items;
    const cut = items.slice(1).reduce((best, it) => (Math.abs(it._start - ui.frame) < Math.abs((best?._start ?? Infinity) - ui.frame) ? it : best), null);
    if (!cut) return toast("Transitions go between two clips on the main track.");
    if (await commit([{ op: "set_transition", item: cut.id, transition: { module: t.dataset.addTransition, duration: 30 } }], "Added transition")) {
      ui.selectedTransition = cut.id; ui.selected = null; renderAll();
    }
  }
}

// ---------- export ----------

let exporting = false;
async function exportVideo() {
  if (exporting) return;
  exporting = true;
  if (ui.playing) pause();
  const btn = $("#export-btn");
  btn.disabled = true;
  btn.innerHTML = `${icon("loader")}Exporting 0%`;
  window.lucide.createIcons();
  const r = await window.uncut.exportVideo();
  exporting = false;
  btn.disabled = false;
  btn.innerHTML = `${icon("download")}Export`;
  window.lucide.createIcons();
  if (r.error) return toast(r.error);
  lastExport = r.file;
  toast(`Exported ${r.file.split("/").pop()} in ${r.seconds.toFixed(0)} s. Click to show in Finder.`, true);
}
let lastExport = null;

// ---------- wiring ----------

function renderAll() {
  $("#project-name").textContent = project().name;
  $("#canvas-info").textContent = `${project().canvas.width}×${project().canvas.height}, ${project().canvas.fps} fps`;
  $("#undo").disabled = !snap.canUndo;
  $("#redo").disabled = !snap.canRedo;
  renderLibrary();
  renderSide();
  renderTimeline();
  renderPreview();
}

async function loadThumbs() {
  await Promise.all(project().media.filter((m) => m.kind === "video" && !thumbs.has(m.id)).map(async (m) => {
    const t = await window.uncut.thumbs(m.id).catch(() => null);
    if (t) thumbs.set(m.id, t);
  }));
  renderTimeline();
  renderLibrary();
}

function bind() {
  $("#bottom-body").addEventListener("pointerdown", onTimelineDown);
  $("#play").onclick = () => (ui.playing ? pause() : play());
  $("#prev-frame").onclick = () => setFrame(ui.frame - 1);
  $("#next-frame").onclick = () => setFrame(ui.frame + 1);
  $("#undo").onclick = undo;
  $("#export-btn").onclick = exportVideo;
  window.uncut.onExportProgress((f) => {
    if (exporting) $("#export-btn").lastChild.textContent = `Exporting ${Math.round(f * 100)}%`;
  });
  $("#toast").onclick = () => lastExport && window.uncut.reveal(lastExport);
  $("#redo").onclick = redo;
  $("#split").onclick = splitAtPlayhead;
  $("#delete").onclick = deleteSelected;
  $("#zoom-in").onclick = () => { ui.ppf *= 1.5; renderTimeline(); };
  $("#zoom-out").onclick = () => { ui.ppf /= 1.5; renderTimeline(); };
  $("#zoom-fit").onclick = () => { fitZoom(); renderTimeline(); };
  $("#open-project").onclick = async () => { const r = await window.uncut.choose(); if (r) { thumbs.clear(); ui.ppf = null; ui.frame = 0; accept(r); loadThumbs(); } };
  $("#side-body").addEventListener("change", onSideChange);
  $("#library").addEventListener("click", onLibraryClick);
  $("#rail").addEventListener("click", (e) => { const b = e.target.closest("[data-lib]"); if (b) { ui.lib = b.dataset.lib; renderLibrary(); } });
  $$("[data-side]").forEach((b) => (b.onclick = () => { ui.side = b.dataset.side; renderSide(); }));
  $("#text-layer").addEventListener("pointerdown", (e) => {
    const t = e.target.closest("[data-item]");
    ui.selected = t?.dataset.item ?? null;
    ui.selectedTransition = null;
    renderAll();
  });
  addEventListener("resize", () => { fitFrame(); renderTimeline(); });
  addEventListener("keydown", (e) => {
    if (e.target.closest("input, textarea, select")) return;
    const mod = e.metaKey || e.ctrlKey;
    if (e.code === "Space") { e.preventDefault(); ui.playing ? pause() : play(); }
    else if (e.key === "ArrowLeft") setFrame(ui.frame - (e.shiftKey ? fps() : 1));
    else if (e.key === "ArrowRight") setFrame(ui.frame + (e.shiftKey ? fps() : 1));
    else if (mod && e.key.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); }
    else if (!mod && e.key.toLowerCase() === "s") splitAtPlayhead();
    else if (e.key === "Backspace" || e.key === "Delete") deleteSelected();
    else if (e.key === "=" || e.key === "+") $("#zoom-in").click();
    else if (e.key === "-") $("#zoom-out").click();
    else if (e.key === "0") $("#zoom-fit").click();
    else if (e.key === "Escape") { ui.selected = null; ui.selectedTransition = null; renderAll(); }
  });
}

// Test hook: lets the automated tests read state without scraping the DOM.
window.__uncut = {
  get frame() { return ui.frame; },
  get playing() { return ui.playing; },
  get project() { return snap.project; },
  get revision() { return snap.revision; },
  get duration() { return duration; },
  get lastExport() { return lastExport; },
  exportVideo,
  videos: () => [...videos.entries()].map(([id, el]) => ({ id, time: el.currentTime, paused: el.paused, seeking: el.seeking, ready: el.readyState, opacity: Number(el.style.opacity), z: Number(el.style.zIndex) })),
  setFrame,
  play,
  pause,
  visualsAt: (f) => visualsAt(f).map((v) => ({ id: v.item.id, opacity: v.opacity, source: v.source })),
};

const dir = new URLSearchParams(location.search).get("project");
try {
  snap = await window.uncut.open(dir);
  derive();
  bind();
  fitFrame();
  renderAll();
  renderTransport();
  loadThumbs();
  document.body.dataset.ready = "true";
} catch (e) {
  document.body.innerHTML = `<div class="hint" style="padding:40px">Couldn't open ${esc(dir)}: ${esc(e.message)}</div>`;
  document.body.dataset.ready = "error";
}
