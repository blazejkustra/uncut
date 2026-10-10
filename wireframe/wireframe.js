// Uncut wireframe. The timeline, preview and mixer are drawn from the example
// project file, so the wireframe and the format describe the same video.
const PROJECT_URL = "../spec/examples/close-the-loop.uncut/project.json";

const STATES = {
  editor: { lib: "media", side: "inspector", bottom: "timeline", selected: "sim-login", frame: 330 },
  text: { lib: "text", side: "inspector", bottom: "timeline", selected: "txt-hook", frame: 30, editingText: true },
  agent: { lib: "media", side: "agent", bottom: "timeline", selected: "sim-login", frame: 330 },
  mixer: { lib: "audio", side: "inspector", bottom: "mixer", selected: "aud-music", frame: 330 },
  transcript: { lib: "media", side: "inspector", bottom: "transcript", selected: "aud-vo", frame: 330 },
  generate: { lib: "generate", side: "inspector", bottom: "timeline", selected: "sim-login", frame: 330 },
  capture: { lib: "capture", side: "inspector", bottom: "timeline", selected: "sim-login", frame: 330 },
  onboarding: { lib: "media", side: "inspector", bottom: "timeline", selected: "sim-login", frame: 330, modal: "onboarding" },
  export: { lib: "media", side: "inspector", bottom: "timeline", selected: "sim-login", frame: 330, modal: "export" },
};

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const icon = (name) => `<i data-lucide="${name}"></i>`;

let project;
let ui;

// ---------- project helpers ----------

/** Main-track items have no `start`; they sit back to back. Resolve it once. */
function resolveTimes(p) {
  for (const track of p.tracks) {
    if (track.role === "main") {
      let t = 0;
      for (const item of track.items) { item._start = t; t += item.duration; }
    } else {
      for (const item of track.items) item._start = item.start;
    }
  }
  p._duration = Math.max(...p.tracks.flatMap((t) => t.items.map((i) => i._start + i.duration)));
}
const allItems = () => project.tracks.flatMap((t) => t.items.map((item) => ({ item, track: t })));
const findItem = (id) => allItems().find((x) => x.item.id === id);
const mediaById = (id) => project.media.find((m) => m.id === id);
const fps = () => project.canvas.fps;

function tc(frames) {
  const f = Math.round(frames);
  const s = Math.floor(f / fps());
  const mm = String(Math.floor(s / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  const ff = String(f % fps()).padStart(2, "0");
  return `${mm}:${ss}:${ff}`;
}
const secs = (frames) => `${(frames / fps()).toFixed(1)}s`;

function itemLabel(item) {
  if (item.type === "text") return item.text.replace(/\[\[|\]\]/g, "").replace(/\n/g, " ");
  if (item.media) return mediaById(item.media)?.name ?? item.media;
  if (item.type === "component") return componentName(item.component);
  return item.id;
}
const componentName = (id) =>
  ({
    "component.solid": "Background",
    "component.terminal": "Terminal",
    "component.device-frame": "Device frame",
    "component.end-card": "End card",
    "component.callout": "Callout",
  })[id] ?? id;

const PROP_LABELS = { "iphone-16-pro": "iPhone 16 Pro", bg: "Background colour" };

// ---------- library (left) ----------

const LIBRARY = {
  media() {
    const tiles = project.media
      .map((m) => {
        const dur = m.probe?.frames ? `<span class="dur">${secs(m.probe.frames)}</span>` : "";
        const kindIcon = { video: "film", image: "image", audio: "audio-lines" }[m.kind];
        return `<button class="tile" data-media="${m.id}"><div class="thumb">${icon(kindIcon)}${dur}</div>
          <div class="tile-name">${esc(m.name)}</div></button>`;
      })
      .join("");
    return `<div class="lib-head">Media <button class="icon-btn" title="Import"><i data-lucide="plus"></i></button></div>
      <div class="search">${icon("search")} Search media</div>
      <div class="lib-section"><div class="lib-label">In this project</div><div class="grid2">${tiles}</div></div>`;
  },
  capture() {
    const flows = [
      ["Login flow", "flows/login.yaml", "Recorded today"],
      ["Onboarding", "flows/onboarding.yaml", "UI changed since last take"],
    ];
    return `<div class="lib-head">Capture <span class="muted small">Argent module</span></div>
      <div class="lib-section">
        <div class="lib-label">Devices</div>
        <div class="list">
          <div class="row">${icon("smartphone")}<div class="grow">iPhone 16 Pro<div class="sub">iOS 26 simulator, booted</div></div><span class="dot ok"></span></div>
          <div class="row">${icon("tablet-smartphone")}<div class="grow">Pixel 9<div class="sub">Android emulator, off</div></div><span class="dot"></span></div>
          <div class="row">${icon("globe")}<div class="grow">Chrome<div class="sub">Web app on port 9222</div></div><span class="dot ok"></span></div>
          <div class="row">${icon("monitor")}<div class="grow">This Mac<div class="sub">Screen or one window</div></div></div>
          <div class="row">${icon("mic")}<div class="grow">Microphone<div class="sub">Voiceover onto the Voice track</div></div></div>
        </div>
        <button class="btn primary full" style="margin-top:10px">${icon("circle-dot")}Record iPhone 16 Pro</button>
      </div>
      <div class="lib-section">
        <div class="lib-label">Saved flows (re-shoot when the UI changes)</div>
        <div class="list">${flows
          .map(([n, f, s]) => `<div class="row">${icon("repeat")}<div class="grow">${n}<div class="sub">${s}</div></div><button class="link-btn">Re-shoot</button></div>`)
          .join("")}</div>
      </div>`;
  },
  text() {
    const presets = [
      ["title", "Title", "Claude Code tests your app now"],
      ["header", "Header", "It taps through the login itself"],
      ["lower", "Lower third", "<b>Blaze Kustra</b>Software Mansion"],
      ["caption", "Captions", "taps through <span>the login</span>"],
      ["foot", "Footnote", "Sped up 3×"],
      ["mono", "Mono label", "argent.swmansion.com"],
    ];
    return `<div class="lib-head">Text <button class="icon-btn" title="Add text (T)"><i data-lucide="plus"></i></button></div>
      <div class="lib-section"><div class="lib-label">Styles from this project's theme</div><div class="grid2">${presets
        .map(([k, n, t]) => `<button class="tile" data-preset="${k}"><div class="tp ${k}"><div>${t}</div></div><div class="tile-name">${n}</div></button>`)
        .join("")}</div></div>`;
  },
  components() {
    const items = [
      ["smartphone", "Device frame"], ["terminal", "Terminal"], ["code", "Code block"], ["mouse-pointer-click", "Callout"],
      ["badge-check", "End card"], ["chart-column", "Chart"], ["list-ordered", "Steps"], ["scan", "Zoom and pan"],
      ["captions", "Caption styles"], ["user-plus", "Follow card"],
    ];
    return `<div class="lib-head">Elements <span class="muted small">Community library</span></div>
      <div class="search">${icon("search")} Search elements</div>
      <div class="lib-section"><div class="grid2">${items
        .map(([i, n]) => `<button class="tile"><div class="thumb">${icon(i)}</div><div class="tile-name">${n}</div></button>`)
        .join("")}</div></div>`;
  },
  transitions() {
    const items = [["minus", "Cut"], ["blend", "Crossfade"], ["arrow-left-to-line", "Push"], ["columns-2", "Wipe"], ["zoom-in", "Zoom"], ["circle", "Iris"]];
    return `<div class="lib-head">Transitions</div>
      <div class="lib-section"><div class="lib-label">Drag between two clips on the main track</div><div class="grid2">${items
        .map(([i, n]) => `<button class="tile"><div class="thumb">${icon(i)}</div><div class="tile-name">${n}</div></button>`)
        .join("")}</div></div>`;
  },
  audio() {
    const mode = ui.audioMode ?? "music";
    const inProject = project.media.filter((m) => m.kind === "audio");
    const libMusic = [
      ["Cozy Rhodes", "Calm", "84 BPM", "2:00"],
      ["Warm tape", "Calm", "72 BPM", "1:45"],
      ["Soft guitar", "Warm", "90 BPM", "2:20"],
      ["Night drive", "Steady", "100 BPM", "2:40"],
      ["Paper planes", "Light", "110 BPM", "1:58"],
    ];
    const libSfx = [["Soft tap", "UI", "0.3s"], ["Whoosh, short", "Motion", "0.6s"], ["Keyboard typing", "Desk", "4.0s"], ["Notification", "UI", "0.8s"]];
    const add = `<button class="icon-btn" title="Add to project">${icon("plus")}</button>`;
    const rows =
      mode === "music"
        ? libMusic.map(([n, mood, bpm, d]) => `<div class="row">${icon("play")}<div class="grow">${n}<div class="sub">${mood}, ${bpm}, ${d}</div></div>${add}</div>`)
        : libSfx.map(([n, k, d]) => `<div class="row">${icon("play")}<div class="grow">${n}<div class="sub">${k}, ${d}</div></div>${add}</div>`);
    return `<div class="lib-head">Audio <button class="icon-btn" title="Import audio">${icon("upload")}</button></div>
      <div class="lib-section" style="padding-bottom:4px"><div class="lib-label">In this project</div><div class="list">${inProject
        .map((m) => `<div class="row" data-media="${m.id}">${icon("audio-lines")}<div class="grow">${esc(m.name)}<div class="sub">${secs(m.probe.frames)}${m.source?.module === "core.microphone" ? ", recorded here" : ""}</div></div></div>`)
        .join("")}</div></div>
      <div class="lib-section">
        <div class="lib-label">Free library, royalty free (CC0)</div>
        <div class="seg" style="margin-bottom:8px"><button data-audio-mode="music" class="${mode === "music" ? "active" : ""}">Music</button><button data-audio-mode="sfx" class="${mode === "sfx" ? "active" : ""}">Sound effects</button></div>
        <div class="search" style="margin:0 0 6px">${icon("search")} ${mode === "music" ? "Search by name, mood or BPM" : "Search sound effects"}</div>
        <div class="list">${rows.join("")}</div>
      </div>`;
  },
  generate() {
    const mode = ui.genMode ?? "image";
    const cfg = {
      image: { ph: "A flat illustration of a phone on a desk, soft morning light", model: "GPT Image 2", opts: "4:5, 2 variants" },
      video: { ph: "Slow push-in on a laptop showing a terminal, 4 seconds", model: "Veo 3.1", opts: "4:5, 4s" },
      audio: { ph: "Soft whoosh for a quick push transition", model: "ElevenLabs Sound", opts: "Sound effect, 1s" },
    }[mode];
    const actions = `<div class="gen-actions"><button class="link-btn">${icon("plus")}Add at playhead</button><button class="link-btn">${icon("refresh-cw")}Again</button><button class="link-btn">${icon("pencil")}Edit prompt</button></div>`;
    const results =
      mode === "audio"
        ? `<div class="gen-result selected"><div class="row">${icon("play")}<div class="grow">Soft whoosh, take 1<div class="sub">0.9s, saved to Media</div></div></div></div>
           <div class="gen-result"><div class="row">${icon("loader-circle")}<div class="grow">Soft whoosh, take 2<div class="sub">Generating</div></div></div></div>${actions}`
        : `<div class="grid2">
            <div class="gen-result selected"><div class="thumb tall">${icon(mode === "video" ? "film" : "image")}${mode === "video" ? '<span class="dur">4.0s</span>' : ""}</div></div>
            <div class="gen-result"><div class="thumb tall gen-pending">${icon("loader-circle")}<span class="muted small">Generating</span></div></div>
          </div>${actions}`;
    return `<div class="lib-head">Generate</div>
      <div class="lib-section">
        <div class="seg" style="margin-bottom:10px"><button data-gen-mode="image" class="${mode === "image" ? "active" : ""}">Image</button><button data-gen-mode="video" class="${mode === "video" ? "active" : ""}">Video</button><button data-gen-mode="audio" class="${mode === "audio" ? "active" : ""}">Audio</button></div>
        <div class="composer" style="margin:0"><textarea placeholder="${cfg.ph}"></textarea>
          <div class="composer-foot"><span class="ctx">${cfg.model}, ${cfg.opts}</span><button class="send">${icon("arrow-up")}</button></div></div>
        <div class="lib-label" style="margin-top:14px">Results</div>
        ${results}
        <div class="gen-flow">
          <div class="lib-label" style="margin:0 0 2px">After generating</div>
          <div>${icon("folder-down")}Every result lands in Media, Generated, with its prompt</div>
          <div>${icon("mouse-pointer-2")}Add it at the playhead or drag it onto the timeline</div>
          <div>${icon("refresh-cw")}Again or Edit prompt makes a new take next to it</div>
          <div>${icon("bot")}The agent generates through the same tab, so its results show here too</div>
        </div>
      </div>`;
  },
};

// ---------- preview (centre) ----------

function renderPreview() {
  const frame = $("#frame");
  const f = ui.frame;
  const W = project.canvas.width;
  const H = project.canvas.height;
  const at = allItems().filter(({ item }) => item._start <= f && f < item._start + item.duration);
  let html = "";
  for (const { item } of at) {
    if (item.type === "component" && item.component === "component.device-frame") {
      html += `<div class="pv-phone"><div class="pv-screen"><div class="ttl"></div><div class="fld"></div><div class="fld"></div><div class="cta"><span class="tap"></span></div></div></div>`;
    }
    if (item.type === "component" && item.component === "component.terminal") {
      html += `<div class="pv-text mono" style="left:6.7%;top:40%;font-size:3cqh;font-weight:400;color:#8c8c91">› ${esc(item.props.prompt)}</div>`;
    }
    if (item.type === "component" && item.component === "component.end-card") {
      html += `<div class="pv-text" style="left:6.7%;top:44%;font-size:5cqh">${esc(item.props.line)}</div>
        <div class="pv-text" style="left:6.7%;top:52%;font-size:2.4cqh;font-weight:400;color:#8c8c91">${esc(item.props.url)}</div>`;
    }
  }
  for (const { item } of at.filter((x) => x.item.type === "text")) {
    const left = (item.transform.x / W) * 100;
    const top = (item.transform.y / H) * 100;
    const size = (item.style.size / H) * 100;
    const text = esc(item.text).replace(/\[\[(.*?)\]\]/g, '<span class="accent">$1</span>');
    const selected = item.id === ui.selected;
    html += `<div class="pv-text ${selected ? "sel-box" : ""}" data-item="${item.id}" style="left:${left}%;top:${top}%;font-size:${size}cqh">${text}${
      selected && ui.editingText ? '<span class="caret"></span>' : ""
    }</div>`;
  }
  frame.innerHTML = html;
  $("#timecode").textContent = `${tc(f)} / ${tc(project._duration)}`;
}

// ---------- inspector / agent (right) ----------

function field(k, v) {
  return `<div class="field"><span class="k">${k}</span><span class="v">${v}</span></div>`;
}
function select(v, k = "") {
  return `<div class="field select">${k ? `<span class="k">${k}</span>` : ""}<span class="v">${v}</span>${icon("chevron-down")}</div>`;
}

function renderInspector() {
  const found = findItem(ui.selected);
  if (!found) return `<div class="insp-sub" style="padding:14px">Select something on the timeline or in the preview.</div>`;
  const { item, track } = found;
  const timing = `<div class="group"><div class="group-label">Timing</div>
    <div class="field-row">${field("Start", tc(item._start))}${field("Length", tc(item.duration))}</div></div>`;

  if (item.type === "text") {
    const tabs = ["Style", "Animation", "Captions"];
    const tab = ui.textTab ?? "Style";
    const st = item.style;
    const color = project.theme.colors[st.color] ?? st.color;
    let body = "";
    if (tab === "Style") {
      body = `<div class="group"><div class="group-label">Preset</div><div class="chip-row">
          ${["Title", "Header", "Lower third", "Footnote"].map((p, i) => `<span class="preset ${i === 0 ? "active" : ""}">${p}</span>`).join("")}</div></div>
        <div class="group"><div class="group-label">Font</div>
          <div class="field-row">${select(project.theme.fonts.sans)}${select("Semibold")}</div>
          <div class="field-row three">${field("Size", st.size)}${field("Track", st.tracking ?? 0)}${field("Line", "1.05")}</div>
          <div class="field-row"><div class="field"><span class="swatch" style="background:${color}"></span><span class="k">Colour</span><span class="v">${esc(st.color)}</span></div>
            <div class="field"><span class="k">Align</span><span style="margin-left:auto;display:flex;gap:2px">${icon("align-left")}</span></div></div></div>
        <div class="group"><div class="group-label">Look</div>
          ${["Stroke", "Shadow", "Background"].map((n) => `<div class="row" style="padding:5px 0"><span class="grow">${n}</span><span class="toggle off"></span></div>`).join("")}</div>`;
    } else if (tab === "Animation") {
      const a = item.animation ?? {};
      body = `<div class="group"><div class="group-label">In</div><div class="field-row">${select(a.in ? "Fade" : "None")}${field("Length", a.in ? secs(a.in.duration) : "–")}</div></div>
        <div class="group"><div class="group-label">Out</div><div class="field-row">${select("None")}${field("Length", "–")}</div></div>
        <div class="group"><div class="group-label">Per word</div><div class="row" style="padding:5px 0"><span class="grow">Animate word by word</span><span class="toggle off"></span></div></div>`;
    } else {
      body = `<div class="group"><div class="group-label">Captions</div><p class="muted small" style="margin:0">This text is not linked to a transcript. Captions made from a voice or video track keep word timings and stay editable as text.</p></div>`;
    }
    return `<div class="insp-title">${icon("type")}Text</div><div class="insp-sub">${esc(track.name)} track</div>
      <div class="subtabs">${tabs.map((t) => `<button data-text-tab="${t}" class="${t === tab ? "active" : ""}">${t}</button>`).join("")}</div>
      ${body}${timing}`;
  }

  if (item.type === "audio") {
    const m = mediaById(item.media);
    return `<div class="insp-title">${icon("audio-lines")}${esc(m.name)}</div><div class="insp-sub">${esc(track.name)} track</div>
      <div class="group"><div class="group-label">Clip</div>
        <div class="field-row">${field("Fade in", secs(item.fadeIn ?? 0))}${field("Fade out", secs(item.fadeOut ?? 0))}</div>
        <div class="field-row">${field("Gain", "0 dB")}${field("Keys", (item.gainKeys ?? []).length)}</div></div>
      <div class="group"><div class="group-label">Track effects</div>
        <div class="fx">${(track.mixer?.effects ?? []).map((e) => `<div>${esc(e.module.replace("audio.", ""))}</div>`).join("")}<div class="add">+ Add effect</div></div></div>
      <div class="group"><div class="group-label">Loudness</div><div class="field-row">${field("Target", `${project.master.loudness.targetLufs} LUFS`)}${field("Measured", "−16.2")}</div></div>
      ${timing}`;
  }

  const m = item.media ? mediaById(item.media) : null;
  const clipGroup = m
    ? `<div class="group"><div class="group-label">Source</div>
        <div class="row" style="padding:4px 0">${icon("film")}<div class="grow">${esc(m.name)}<div class="sub">${esc(m.source?.module === "argent.capture" ? "Recorded with Argent" : m.path)}</div></div><button class="link-btn">Re-shoot</button></div>
        <div class="field-row">${field("In", tc(item.in ?? 0))}${field("Speed", "1×")}</div></div>`
    : "";
  const props = Object.entries(item.props ?? {})
    .filter(([, v]) => typeof v !== "object")
    .map(([k, v]) => select(esc(PROP_LABELS[v] ?? v), k))
    .join("");
  const trans = item.transitionIn
    ? `<div class="group"><div class="group-label">Transition in</div><div class="field-row">${select(item.transitionIn.module.replace("transition.", ""))}${field("Length", secs(item.transitionIn.duration))}</div></div>`
    : "";
  return `<div class="insp-title">${icon("shapes")}${componentName(item.component)}</div>
    <div class="insp-sub">${esc(track.name)} track${track.role === "main" ? ", magnetic" : ""}</div>
    ${clipGroup}
    <div class="group"><div class="group-label">Options</div><div class="field-row one">${props}</div></div>
    <div class="group"><div class="group-label">Transform</div>
      <div class="field-row">${field("X", 0)}${field("Y", 0)}</div><div class="field-row">${field("Scale", "100%")}${field("Rotate", "0°")}</div></div>
    ${trans}${timing}`;
}

function renderAgent() {
  return `<div class="thread" data-testid="agent-thread">
      <div class="msg-user">Make a 28 second promo for Argent from the login recording. Hook first, then the prompt in the terminal, then the run.</div>
      <div class="turn">
        <div class="turn-body">Built five scenes around the recording. The hook reads on frame 1, and the music sits at −16 LUFS.
          <ul class="turn-edits">
            <li>${icon("plus")}Added 5 clips to Main</li>
            <li>${icon("type")}Added 3 texts</li>
            <li>${icon("music")}Added Cozy Rhodes, faded out over 2s</li>
          </ul></div>
        <div class="turn-foot">Claude Code, 41s<span class="spacer"></span><button class="link-btn">${icon("undo-2")}Undo turn</button></div>
      </div>
      <details class="manual-note" open>
        <summary>${icon("pencil")}You made 3 edits by hand since then</summary>
        <ul><li>Trimmed Login flow from 15.0s to 12.0s</li><li>Moved the hook text up 24 px</li><li>Lowered the music by 2 dB</li></ul>
        The agent sees these as intentional and keeps them.
      </details>
      <div class="msg-user">The test run drags. Tighten it but keep the tap on Sign in.</div>
      <div class="turn">
        <div class="turn-body">
          <div class="steps">
            <div>${icon("check")}Read the timeline</div>
            <div>${icon("check")}Looked at a contact sheet of Login flow, 8s to 20s</div>
            <div>${icon("check")}Measured motion: 3.4s with no change on screen</div>
            <div>${icon("loader-circle")}Cutting the idle parts</div>
          </div></div>
        <div class="turn-foot">Working<span class="spacer"></span></div>
      </div>
    </div>
    <div class="composer">
      <div class="composer-ctx">${icon("mouse-pointer-2")}Selection: Login flow, 8.0s to 20.0s</div>
      <textarea placeholder="Ask Uncut to edit, or how to do something"></textarea>
      <div class="composer-foot">
        <button class="icon-btn" title="Attach">${icon("paperclip")}</button>
        <span class="grow"></span>
        <button class="link-btn">Claude Code, Opus 5.5 ${icon("chevron-down")}</button>
        <button class="send stop" title="Stop">${icon("square")}</button>
      </div>
    </div>`;
}

// ---------- timeline / mixer (bottom) ----------

function renderTimeline() {
  const body = $("#bottom-body");
  const width = Math.max(600, body.clientWidth - 148 - 40);
  const ppf = width / project._duration;
  const x = (frame) => frame * ppf;
  const sec = fps();

  let ruler = "";
  for (let s = 0; s * sec <= project._duration; s++) {
    ruler += `<div class="tick" style="left:${x(s * sec)}px">${s % 2 === 0 ? `<span>${s}s</span>` : ""}</div>`;
  }
  for (const sc of project.scenes) ruler += `<div class="scene" style="left:${x(sc.start)}px">${esc(sc.name)}</div>`;
  // Beats come from the analysis cache (.cache/analysis), not from project.json: 84 BPM here.
  const beat = (60 / 84) * sec;
  for (let b = 0; b < project._duration; b += beat) ruler += `<div class="beat" style="left:${x(b)}px"></div>`;

  let heads = `<div class="tl-corner"></div>`;
  let lanes = `<div class="tl-ruler">${ruler}</div>`;
  const rows = [];
  for (const track of project.tracks) {
    const main = track.role === "main";
    const kindIcon = { text: "type", video: main ? "film" : "layers", audio: "audio-lines" }[track.kind];
    const toggles =
      track.kind === "audio"
        ? `<button class="icon-btn" title="Mute">${icon("volume-2")}</button>`
        : `<button class="icon-btn" title="Hide">${icon("eye")}</button>`;
    rows.push({
      head: `<div class="tl-head ${main ? "main" : ""}"><div class="name">${icon(kindIcon)}${esc(track.name)}${
        main ? `<span class="badge">${icon("magnet")}</span>` : ""
      }</div>${toggles}<button class="icon-btn" title="Lock">${icon("lock")}</button></div>`,
      lane: laneHtml(track, x),
    });
  }
  for (const r of rows) { heads += r.head; lanes += r.lane; }

  body.innerHTML = `<div class="tl" data-testid="timeline">
      <div class="tl-heads">${heads}</div>
      <div class="tl-lanes" style="position:relative;width:${width + 24}px">${lanes}
        <div class="playhead" style="left:${x(ui.frame)}px"></div></div>
    </div>`;
}

function laneHtml(track, x) {
  const main = track.role === "main";
  let html = "";
  for (const item of track.items) {
    const cls = item.type === "clip" || item.media && item.type !== "audio" ? "video" : item.type;
    const sel = item.id === ui.selected ? "selected" : "";
    let inner = `<span class="nm">${esc(itemLabel(item))}</span>`;
    if (item.type === "audio") {
      const n = Math.max(4, Math.round((x(item.duration) - 8) / 4));
      let seed = item.id.length * 97;
      const bars = Array.from({ length: n }, () => {
        seed = (seed * 9301 + 49297) % 233280;
        return `<i style="height:${20 + (seed / 233280) * 80}%"></i>`;
      }).join("");
      inner += `<div class="wave">${bars}</div>`;
      if (item.gainKeys) {
        const w = x(item.duration);
        const gy = (db) => 9 - db * 3;
        const pts = item.gainKeys.map((k) => `${x(k.frame)},${gy(k.db)}`).join(" ");
        inner += `<svg class="gain" viewBox="0 0 ${w} 36" preserveAspectRatio="none"><polyline points="${pts} ${w},${gy(item.gainKeys.at(-1).db)}" fill="none" stroke="#ededed" stroke-width="1.25" vector-effect="non-scaling-stroke"/></svg>`;
      }
    } else {
      inner += `<span class="meta">${secs(item.duration)}</span>`;
    }
    html += `<div class="clip ${cls} ${sel}" data-item="${item.id}" style="left:${x(item._start)}px;width:${x(item.duration) - 2}px">${inner}</div>`;
    if (main && item.transitionIn) {
      html += `<div class="trans" title="${esc(item.transitionIn.module)}" style="left:${x(item._start)}px">${icon("blend")}</div>`;
    }
  }
  return `<div class="tl-lane ${main ? "main" : ""}" data-track="${track.id}">${html}</div>`;
}

function renderMixer() {
  const strips = project.tracks
    .filter((t) => t.kind === "audio")
    .map((t, i) => {
      const fx = (t.mixer.effects ?? []).map((e) => `<div>${esc(e.module.replace("audio.", ""))}</div>`).join("");
      const pos = 30 - t.mixer.gainDb * 3;
      return `<div class="strip" data-testid="mixer-strip"><div class="strip-name">${esc(t.name)}<span class="muted">${t.mixer.gainDb} dB</span></div>
        <div class="fx">${fx}<div class="add">+ Add</div></div>
        <div class="fader-wrap"><div class="fader"><span style="top:${pos}%"></span></div><div class="meter"><span style="height:${i ? 25 : 62}%"></span></div><div class="meter"><span style="height:${i ? 22 : 58}%"></span></div></div>
        <div class="field"><span class="k">Pan</span><span class="v">C</span></div>
        <div class="strip-foot"><button>M</button><button>S</button></div></div>`;
    })
    .join("");
  const master = project.master;
  $("#bottom-body").innerHTML = `<div class="mixer">${strips}
    <div class="strip master"><div class="strip-name">Master</div>
      <div class="fx">${master.effects.map((e) => `<div>${esc(e.module.replace("audio.", ""))}</div>`).join("")}<div class="add">+ Add</div></div>
      <div class="muted small">Integrated loudness</div><div class="lufs">−16.2</div>
      <div class="muted small">Target ${master.loudness.targetLufs} LUFS (social). YouTube: −14</div>
    </div></div>`;
}

// Words come from the transcript in the analysis cache, not from project.json.
const TRANSCRIPT = [
  { start: 250, words: "I asked Claude Code to test the login." },
  { start: 330, words: "It opened the simulator, um, typed the email", filler: ["um,"] },
  { start: 400, pause: "0.8s" },
  { start: 424, words: "and tapped Sign in on its own." },
  { start: 470, words: "Then it found the bug, uh, before I did.", filler: ["uh,"] },
];

function renderTranscript() {
  const lines = TRANSCRIPT.map((l) => {
    const time = `<span class="tr-time">${tc(l.start)}</span>`;
    if (l.pause) return `<div class="tr-line">${time}<span class="tr-pause">${icon("pause")}${l.pause} pause</span></div>`;
    const words = l.words
      .split(" ")
      .map((w, i) => {
        const cls = l.filler?.includes(w) ? "tr-word filler" : l.start === 330 && i === 3 ? "tr-word current" : "tr-word";
        return `<span class="${cls}">${esc(w)}</span>`;
      })
      .join(" ");
    return `<div class="tr-line">${time}<span>${words}</span></div>`;
  }).join("");
  $("#bottom-body").innerHTML = `<div class="transcript" data-testid="transcript">
      <div class="tr-head">
        <div><b>Voiceover</b> <span class="muted small">transcribed, 5 lines</span></div>
        <div class="tr-actions">
          <button class="btn">${icon("eraser")}Remove 2 fillers</button>
          <button class="btn">${icon("scissors")}Cut 1 long pause</button>
          <button class="btn">${icon("captions")}Make captions</button>
        </div>
      </div>
      <div class="tr-body">${lines}</div>
      <div class="tr-hint muted small">Delete words here to cut them from the video. Select words to make captions from them, or to ask the agent about that part.</div>
    </div>`;
}

// ---------- modals ----------

function renderModal() {
  const layer = $("#modal-layer");
  if (!ui.modal) { layer.hidden = true; layer.innerHTML = ""; return; }
  layer.hidden = false;
  layer.innerHTML = ui.modal === "onboarding" ? renderOnboarding() : renderExport();
}

const ready = `<span class="wiz-ready">${icon("check")}Ready</span>`;
const wizRow = (ic, name, sub, right) =>
  `<div class="wiz-row">${icon(ic)}<div class="grow"><div class="wiz-name">${name}</div><div class="wiz-sub">${sub}</div></div>${right}</div>`;

function renderOnboarding() {
  const step = ui.obStep ?? 0;
  const steps = ["Agents", "Capture", "First video"];
  const stepper = `<ol class="wiz-steps">${steps
    .map((s, i) => `<li><button data-ob-step="${i}" class="${i === step ? "current" : ""}"><span class="wiz-num ${i < step ? "done" : i === step ? "now" : ""}">${i < step ? icon("check") : i + 1}</span>${s}</button></li>`)
    .join("")}</ol>`;
  let body;
  if (step === 0) {
    body = `<h1>Connect your agents</h1>
      <p class="wiz-lead">Uncut runs on the Claude Code or Codex you already use, with your own subscription. No API keys needed.</p>
      <div class="wiz-list">
        ${wizRow("sparkle", "Claude Code", "Signed in, Max plan", ready)}
        ${wizRow("terminal", "Codex", "Not installed", `<button class="btn ghost">${icon("terminal")}Install</button>`)}
        <div class="wiz-term"><div class="wiz-term-head">Review the command, then press Enter to run it.<button class="link-btn">Close</button></div>
          <div class="wiz-term-body mono">~ $ npm i -g @openai/codex<span class="caret"></span></div></div>
      </div>
      <div class="wiz-foot"><p>One agent is enough. Add more any time in Settings.</p><button class="btn primary" data-ob-step="1">Continue${icon("arrow-right")}</button></div>`;
  } else if (step === 1) {
    body = `<h1>Record your apps</h1>
      <p class="wiz-lead">Argent records simulators, emulators, web and desktop apps. The agent can drive the app while it records.</p>
      <div class="wiz-list">
        ${wizRow("circle-dot", "Argent", "Installed, version 0.9", ready)}
        ${wizRow("smartphone", "iOS simulators", "Xcode 26, 3 simulators", ready)}
        ${wizRow("tablet-smartphone", "Android emulators", "Android SDK not found", `<button class="btn ghost">${icon("terminal")}Set up</button>`)}
        ${wizRow("mic", "Microphone", "For voiceovers", `<button class="btn ghost">Allow</button>`)}
      </div>
      <div class="wiz-foot"><p>Optional. Skip it if you only edit footage you already have.</p><div class="wiz-btns"><button class="btn ghost" data-ob-step="2">Skip</button><button class="btn primary" data-ob-step="2">Continue${icon("arrow-right")}</button></div></div>`;
  } else {
    body = `<h1>Start a video</h1>
      <p class="wiz-lead">Pick a shape. You can change it later, and the agent can reframe for other formats.</p>
      <div class="wiz-cards">
        <button class="wiz-card active"><div class="wiz-shape" style="aspect-ratio:4/5"></div>Social<span>4:5, 1080×1350</span></button>
        <button class="wiz-card"><div class="wiz-shape" style="aspect-ratio:9/16"></div>Vertical<span>9:16, 1080×1920</span></button>
        <button class="wiz-card"><div class="wiz-shape" style="aspect-ratio:16/9"></div>YouTube<span>16:9, 3840×2160</span></button>
      </div>
      <div class="wiz-list" style="margin-top:12px">${wizRow("folder-open", "Open a project", "A .uncut folder on this Mac", `<button class="btn ghost">Choose</button>`)}</div>
      <div class="wiz-foot"><p class="wiz-privacy"><span class="toggle"></span>Share anonymous usage stats. Never media, prompts or file names. <a href="#">What we collect</a></p><button class="btn primary" data-close>Create video${icon("arrow-right")}</button></div>`;
  }
  return `<div class="modal wiz" data-testid="onboarding">
    <div class="wiz-header"><div class="wiz-brand">Uncut</div>${stepper}</div>
    <div class="wiz-panel">${body}</div>
  </div>`;
}

function renderExport() {
  const preset = ui.exportPreset ?? "full";
  const W = project.canvas.width, H = project.canvas.height;
  const presets = [
    ["full", "Full quality", `${W}×${H}`, "About 24 MB"],
    ["draft", "Quick draft", `${W / 2}×${H / 2}`, "About 5 MB"],
    ["double", "2× sharper", `${W * 2}×${H * 2}`, "About 80 MB"],
  ];
  return `<div class="modal wiz" data-testid="export">
    <div class="wiz-header"><div class="wiz-brand">Export</div><div class="muted">${esc(project.name)}, ${secs(project._duration)}, 4:5</div></div>
    <div class="wiz-panel">
      <div class="wiz-cards">${presets
        .map(([k, n, s, size]) => `<button class="wiz-card ${k === preset ? "active" : ""}" data-preset-card="${k}">${n}<span>${s}</span><span>${size}</span></button>`)
        .join("")}</div>
      <div class="wiz-list" style="margin-top:14px">
        <div class="wiz-field"><span>File</span><b>close-the-loop.mp4</b><button class="link-btn">~/Movies/Uncut${icon("chevron-down")}</button></div>
        <div class="wiz-field"><span>Sound</span><b>${project.master.loudness.targetLufs} LUFS</b><span class="muted small">Right for X, LinkedIn and Instagram</span></div>
      </div>
      <p class="wiz-meta">H.264, ${project.canvas.fps} fps, takes about 20 seconds</p>
      <div class="wiz-foot"><p>Opens in Finder when it's done.</p><div class="wiz-btns"><button class="btn ghost" data-close>Cancel</button><button class="btn primary" data-close>${icon("download")}Export</button></div></div>
    </div>
  </div>`;
}

// ---------- render + state ----------

function render() {
  $$("#rail [data-lib]").forEach((b) => b.classList.toggle("active", b.dataset.lib === ui.lib));
  $("#library").innerHTML = LIBRARY[ui.lib]();
  $$("[data-side]").forEach((b) => b.classList.toggle("active", b.dataset.side === ui.side));
  $("#side-body").innerHTML = ui.side === "agent" ? renderAgent() : renderInspector();
  $$("[data-bottom]").forEach((b) => b.classList.toggle("active", b.dataset.bottom === ui.bottom));
  $("#timeline-tools").style.visibility = ui.bottom === "timeline" ? "visible" : "hidden";
  if (ui.bottom === "mixer") renderMixer();
  else if (ui.bottom === "transcript") renderTranscript();
  else renderTimeline();
  renderPreview();
  renderModal();
  $$("#review a").forEach((a) => a.classList.toggle("active", a.getAttribute("href") === `#${ui.state}`));
  window.lucide?.createIcons();
  const thread = $(".thread");
  if (thread) thread.scrollTop = thread.scrollHeight;
}

function applyHash() {
  const state = location.hash.slice(1) || "editor";
  ui = { state, ...(STATES[state] ?? STATES.editor) };
  render();
}

document.addEventListener("click", (e) => {
  const t = e.target.closest("[data-lib],[data-side],[data-bottom],[data-item],[data-text-tab],[data-close],[data-state-link],[data-audio-mode],[data-gen-mode],[data-ob-step],[data-preset-card]");
  if (!t) return;
  if (t.dataset.lib) ui.lib = t.dataset.lib;
  else if (t.dataset.side) ui.side = t.dataset.side;
  else if (t.dataset.bottom) ui.bottom = t.dataset.bottom;
  else if (t.dataset.textTab) ui.textTab = t.dataset.textTab;
  else if (t.dataset.audioMode) ui.audioMode = t.dataset.audioMode;
  else if (t.dataset.genMode) ui.genMode = t.dataset.genMode;
  else if (t.dataset.obStep) ui.obStep = Number(t.dataset.obStep);
  else if (t.dataset.presetCard) ui.exportPreset = t.dataset.presetCard;
  else if (t.dataset.close !== undefined) ui.modal = null;
  else if (t.dataset.stateLink) { location.hash = t.dataset.stateLink; return; }
  else if (t.dataset.item) {
    ui.selected = t.dataset.item;
    ui.side = "inspector";
    ui.editingText = false;
    ui.textTab = undefined;
    const found = findItem(ui.selected);
    if (found && t.closest(".clip")) ui.frame = Math.min(found.item._start + Math.floor(found.item.duration / 2), project._duration - 1);
  }
  render();
});
window.addEventListener("hashchange", applyHash);
window.addEventListener("resize", () => ui && render());

project = await (await fetch(PROJECT_URL)).json();
resolveTimes(project);
$("#project-name").textContent = project.name;
$("#canvas-info").textContent = `${project.canvas.width}×${project.canvas.height}, ${project.canvas.fps} fps`;
applyHash();
document.body.dataset.ready = "true";
