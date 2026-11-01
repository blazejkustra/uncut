// The review page's own style and script, inlined into its one HTML file (reviewPage.ts). The script
// builds every comment with textContent and never reads anything back as markup.
export const REVIEW_STYLE = String.raw`
:root { color-scheme: dark; --bg: #0a0a0a; --panel: #141414; --line: rgb(255 255 255 / 12%); --fg: #ededed; --muted: #9a9a9a; --accent: #6d8cff; }
* { box-sizing: border-box; }
[hidden] { display: none !important; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; }
main { display: grid; grid-template-columns: minmax(0, 1fr) 340px; gap: 20px; max-width: 1400px; margin: 0 auto; padding: 20px; }
h1 { margin: 0 0 12px; font-size: 18px; font-weight: 600; overflow-wrap: anywhere; }
#stage { position: relative; background: #000; line-height: 0; }
video { display: block; width: 100%; height: auto; }
#region, #draw .box { position: absolute; border: 2px solid var(--accent); background: rgb(109 140 255 / 16%); pointer-events: none; }
#draw { position: absolute; inset: 0; cursor: crosshair; touch-action: none; }
#video-problem { color: #f87171; }
#pins { position: relative; height: 22px; margin-top: 8px; border-radius: 4px; background: var(--panel); }
#pins button { position: absolute; top: 3px; width: 8px; height: 16px; margin-left: -4px; padding: 0; border: 0; border-radius: 2px; background: var(--accent); cursor: pointer; }
form, .send { display: grid; gap: 10px; padding: 12px; border: 1px solid var(--line); border-radius: 10px; background: var(--panel); }
.send { margin-top: 12px; color: var(--muted); font-size: 13px; }
.send p { margin: 0; }
#unsaved { color: #fbbf24; }
label { display: grid; gap: 4px; color: var(--muted); font-size: 13px; }
label b { color: var(--fg); font-family: ui-monospace, Menlo, monospace; font-weight: 500; }
input, textarea { width: 100%; padding: 7px 9px; border: 1px solid var(--line); border-radius: 6px; background: var(--bg); color: var(--fg); font: inherit; resize: vertical; }
.row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.row .primary { margin-left: auto; }
.send .row .primary { margin-left: 0; }
button { padding: 6px 11px; border: 1px solid var(--line); border-radius: 6px; background: transparent; color: var(--fg); font: inherit; cursor: pointer; }
button:hover { border-color: rgb(255 255 255 / 30%); }
button.primary, button[aria-pressed="true"] { border-color: var(--accent); background: var(--accent); color: #0a0a0a; }
#marked { color: var(--muted); font-size: 13px; }
ol { display: grid; gap: 8px; margin: 12px 0 0; padding: 0; list-style: none; }
li { padding: 10px 12px; border: 1px solid var(--line); border-radius: 10px; background: var(--panel); }
li header { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
li .time { padding: 0; border: 0; color: var(--accent); font-family: ui-monospace, Menlo, monospace; }
li .who { overflow: hidden; color: var(--muted); font-size: 13px; text-overflow: ellipsis; white-space: nowrap; }
li .remove { margin-left: auto; padding: 0 6px; border: 0; color: var(--muted); font-size: 13px; }
li p { margin: 0; overflow-wrap: anywhere; white-space: pre-wrap; }
#none { color: var(--muted); }
@media (max-width: 860px) { main { grid-template-columns: minmax(0, 1fr); } }
`;

export const REVIEW_SCRIPT = String.raw`
"use strict";
const review = JSON.parse(document.getElementById("review-data").textContent);
const byId = (id) => document.getElementById(id);
const video = byId("video");
const stage = byId("stage");
const commentsKey = "uncut.review." + review.reviewId;
const authorKey = "uncut.review.author";
let comments = [];
let pendingRegion;

function readStored(key, fallback) {
  try {
    const stored = localStorage.getItem(key);
    return stored === null ? fallback : JSON.parse(stored);
  } catch {
    return fallback;
  }
}

function store(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    byId("unsaved").hidden = true;
  } catch {
    byId("unsaved").hidden = false;
  }
}

function timecode(seconds) {
  const frame = review.from + Math.round(seconds * review.fps);
  const whole = Math.floor(frame / review.fps);
  const pad = (n) => String(n).padStart(2, "0");
  const rest = pad(Math.floor(whole / 60)) + ":" + pad(whole % 60);
  return rest + ":" + pad(frame - Math.ceil(whole * review.fps - 1e-9));
}

function newId() {
  const bytes = crypto.getRandomValues(new Uint8Array(9));
  return Array.from(bytes, (b) => b.toString(36).padStart(2, "0")).join("");
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function place(node, region) {
  node.style.left = region.x * 100 + "%";
  node.style.top = region.y * 100 + "%";
  node.style.width = region.w * 100 + "%";
  node.style.height = region.h * 100 + "%";
}

function showRegion(region) {
  const box = byId("region");
  box.hidden = !region;
  if (region) place(box, region);
}

function jumpTo(comment) {
  video.pause();
  video.currentTime = comment.seconds;
  showRegion(comment.region);
}

function commentRow(comment) {
  const row = element("li");
  const head = element("header");
  const time = element("button", "time", timecode(comment.seconds));
  time.type = "button";
  time.addEventListener("click", () => jumpTo(comment));
  head.append(time);
  if (comment.author) head.append(element("span", "who", comment.author));
  const remove = element("button", "remove", "Remove");
  remove.type = "button";
  remove.addEventListener("click", () => {
    comments = comments.filter((c) => c.id !== comment.id);
    changed();
  });
  head.append(remove);
  row.append(head, element("p", "", comment.text));
  return row;
}

function pin(comment) {
  const button = element("button");
  button.type = "button";
  button.title = timecode(comment.seconds) + " " + comment.text;
  button.style.left = (video.duration ? (comment.seconds / video.duration) * 100 : 0) + "%";
  button.addEventListener("click", () => jumpTo(comment));
  return button;
}

function render() {
  const sorted = [...comments].sort((a, b) => a.seconds - b.seconds);
  byId("comments").replaceChildren(...sorted.map(commentRow));
  byId("pins").replaceChildren(...sorted.map(pin));
  byId("none").hidden = comments.length > 0;
}

function changed() {
  store(commentsKey, comments);
  render();
}

function exchange() {
  const { format, reviewId, project, cut, from } = review;
  return JSON.stringify({ format, reviewId, project, cut, from, comments }, null, 1);
}

function setRegionMode(on) {
  byId("draw").hidden = !on;
  byId("mark").setAttribute("aria-pressed", String(on));
  if (on) video.pause();
}

function setPendingRegion(region) {
  pendingRegion = region;
  byId("marked").hidden = !region;
  showRegion(region);
}

function pointIn(event) {
  const bounds = stage.getBoundingClientRect();
  const clamp = (n) => Math.min(1, Math.max(0, n));
  return { x: clamp((event.clientX - bounds.left) / bounds.width), y: clamp((event.clientY - bounds.top) / bounds.height) };
}

function boxBetween(a, b) {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
}

function setUpRegionDrawing() {
  const draw = byId("draw");
  const box = element("div", "box");
  let start;
  draw.addEventListener("pointerdown", (event) => {
    start = pointIn(event);
    draw.setPointerCapture(event.pointerId);
    place(box, boxBetween(start, start));
    draw.append(box);
  });
  draw.addEventListener("pointermove", (event) => {
    if (start) place(box, boxBetween(start, pointIn(event)));
  });
  draw.addEventListener("pointerup", (event) => {
    const region = boxBetween(start, pointIn(event));
    start = undefined;
    box.remove();
    setRegionMode(false);
    if (region.w > 0.005 && region.h > 0.005) setPendingRegion(region);
  });
}

function addComment(event) {
  event.preventDefault();
  const text = byId("text").value.trim();
  if (!text) return;
  const author = byId("author").value.trim();
  store(authorKey, author);
  comments.push({
    id: newId(),
    seconds: Math.round(video.currentTime * 1000) / 1000,
    text,
    ...(author ? { author } : {}),
    at: new Date().toISOString(),
    ...(pendingRegion ? { region: pendingRegion } : {}),
  });
  byId("text").value = "";
  setPendingRegion(undefined);
  changed();
}

function saveFile() {
  const url = URL.createObjectURL(new Blob([exchange()], { type: "application/json" }));
  const link = element("a");
  link.href = url;
  link.download = review.fileName;
  link.click();
  URL.revokeObjectURL(url);
}

function copyBlock() {
  const block = byId("block");
  block.value = exchange();
  block.hidden = false;
  block.select();
  const written = navigator.clipboard ? navigator.clipboard.writeText(block.value) : Promise.reject(new Error("no clipboard"));
  written.catch(() => document.execCommand("copy"));
}

function updateAt() {
  byId("at").textContent = timecode(video.currentTime);
}

function start() {
  document.title = review.project + ": review";
  byId("title").textContent = review.project;
  stage.style.aspectRatio = review.width + " / " + review.height;
  const stored = readStored(commentsKey, []);
  comments = Array.isArray(stored) ? stored : [];
  byId("author").value = readStored(authorKey, "");
  byId("author").maxLength = review.authorMax;
  byId("text").maxLength = review.textMax;
  video.addEventListener("timeupdate", updateAt);
  video.addEventListener("seeked", updateAt);
  video.addEventListener("loadedmetadata", render);
  video.addEventListener("error", () => (byId("video-problem").hidden = false));
  video.addEventListener("play", () => showRegion(undefined));
  byId("text").addEventListener("focus", () => video.pause());
  byId("add").addEventListener("submit", addComment);
  byId("mark").addEventListener("click", () => setRegionMode(byId("draw").hidden));
  byId("save").addEventListener("click", saveFile);
  byId("copy").addEventListener("click", copyBlock);
  setUpRegionDrawing();
  updateAt();
  render();
}

start();
`;
