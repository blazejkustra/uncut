// The review page: one HTML file beside the rendered video. It loads nothing else (its CSP allows
// only its own script and style and the video next to it), keeps comments in the browser, and hands
// them over as a file or a block for Uncut to import (core review.ts). Project text goes in as a
// JSON data block and comes out through textContent, so neither it nor a comment is ever markup.
import { createHash, randomUUID } from "node:crypto";

import { REVIEW_AUTHOR_MAX, REVIEW_NOTES_FORMAT, REVIEW_TEXT_MAX, inertJson, reviewCut, type Project } from "@uncut/core";

import { REVIEW_SCRIPT, REVIEW_STYLE } from "./reviewPageAssets.ts";

export const REVIEW_PAGE = "index.html";
export const REVIEW_VIDEO = "video.mp4";

export interface ReviewManifest {
  readonly format: typeof REVIEW_NOTES_FORMAT;
  readonly reviewId: string;
  readonly project: string;
  readonly cut: string;
  readonly fps: number;
  readonly from: number;
  readonly width: number;
  readonly height: number;
  readonly fileName: string;
  readonly textMax: number;
  readonly authorMax: number;
}

/** `/exports/Launch.mp4` makes the folder `/exports/Launch review`. */
export const reviewFolderFor = (output: string) => `${output.replace(/\.mp4$/i, "")} review`;

const safeName = (name: string) => name.replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "") || "review";

export const reviewManifest = (project: Project, from: number, size: { readonly width: number; readonly height: number }): ReviewManifest => ({
  format: REVIEW_NOTES_FORMAT,
  reviewId: randomUUID().replaceAll("-", "").slice(0, 12),
  project: project.name,
  cut: reviewCut(project),
  fps: project.canvas.fps,
  from,
  width: size.width,
  height: size.height,
  fileName: `${safeName(project.name)}.uncut-review.json`,
  textMax: REVIEW_TEXT_MAX,
  authorMax: REVIEW_AUTHOR_MAX,
});

const escapeHtml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const sha256 = (text: string) => `'sha256-${createHash("sha256").update(text).digest("base64")}'`;

const contentPolicy = () =>
  [
    "default-src 'none'",
    `script-src ${sha256(REVIEW_SCRIPT)}`,
    `style-src ${sha256(REVIEW_STYLE)}`,
    "media-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");

export function reviewPageHtml(manifest: ReviewManifest): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${contentPolicy()}">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(manifest.project)}: review</title>
<style>${REVIEW_STYLE}</style>
</head>
<body>
<main>
  <section class="player">
    <h1 id="title"></h1>
    <div id="stage">
      <video id="video" src="${REVIEW_VIDEO}" controls playsinline preload="metadata"></video>
      <div id="region" hidden></div>
      <div id="draw" hidden></div>
    </div>
    <p id="video-problem" role="alert" hidden>The video didn't load. Keep ${REVIEW_VIDEO} in the same folder as this page.</p>
    <div id="pins" aria-label="Comments along the video"></div>
  </section>
  <aside>
    <form id="add">
      <label>Your name <input id="author" autocomplete="name"></label>
      <label>Comment at <b id="at">00:00:00</b>
        <textarea id="text" rows="3" required></textarea>
      </label>
      <div class="row">
        <button type="button" id="mark" aria-pressed="false">Mark a region</button>
        <span id="marked" hidden>Region marked</span>
        <button type="submit" class="primary">Add comment</button>
      </div>
    </form>
    <ol id="comments"></ol>
    <p id="none">No comments yet. Pause on a moment and write one.</p>
    <div class="send">
      <p>Comments stay in this browser and nothing is uploaded. There is no live sync: nobody sees them until you send them to the editor, and you won't see anyone else's here.</p>
      <p id="unsaved" role="alert" hidden>This browser isn't keeping comments, so send them before you close the page.</p>
      <div class="row">
        <button type="button" id="save" class="primary">Save comments file</button>
        <button type="button" id="copy">Copy comments</button>
      </div>
      <textarea id="block" rows="4" readonly hidden aria-label="Comments as a block to paste into Uncut"></textarea>
    </div>
  </aside>
</main>
<script type="application/json" id="review-data">${inertJson(manifest)}</script>
<script>${REVIEW_SCRIPT}</script>
</body>
</html>
`;
}
