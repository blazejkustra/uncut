// D221: the GPU compositor (issue #12 item 4, behind Settings › App › Preview "Draw the preview on
// the GPU", off by default). One WebGL2 canvas under the preview's media layer draws, in track order,
// the bottom run of layers it supports: video and image clips (their box, content rect and fit,
// rounded corners, opacity, a wipe or an iris) with their picture effects (D136's FxRenderer, run in
// this same context into a framebuffer, instead of a WebGL context per clip), and plain-colour
// backgrounds. From the first layer it doesn't support (text, components, graphics, a shader, a blur,
// an overlay effect, a mask) everything above stays on the DOM path, so z-order and the export's
// order are kept. The <video> and <img> elements stay where they are (sound, the clock, hit-testing),
// made transparent; the canvas reads their current frames.
// Export doesn't use it: it stays on ffmpeg (see D221).
import type { ClipBox } from "@uncut/core/box";
import type { ClipFx } from "@uncut/core/fx";
import { FxRenderer } from "./fx.ts";

const VERTEX = `#version 300 es
layout(location = 0) in vec2 aPos;
uniform vec4 uRect;
uniform vec2 uCanvas;
out vec2 vP;
void main() {
  vec2 p = uRect.xy + aPos*uRect.zw;
  vP = p;
  vec2 n = p / uCanvas*2.0 - 1.0;
  gl_Position = vec4(n.x, -n.y, 0.0, 1.0);
}`;

// vP is in canvas px (top-left origin). The box clips (rounded, antialiased over one device pixel
// like the browser's border-radius), the picture fills uImg (its fit already worked out), a wipe
// shows what's left of uWipe, an iris the circle uIris.
const FRAGMENT = `#version 300 es
precision highp float;
in vec2 vP;
out vec4 outColor;
uniform sampler2D uTex;
uniform bool uSolid;
uniform vec4 uColour;
uniform vec4 uBox;
uniform float uRadius;
uniform vec4 uImg;
uniform float uOpacity;
uniform float uWipe;
uniform vec3 uIris;
uniform float uPx;
uniform bool uFlipY;
void main() {
  vec2 h = uBox.zw*0.5;
  float r = min(uRadius, min(h.x, h.y));
  vec2 q = abs(vP - (uBox.xy + h)) - (h - r);
  float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
  float cover = clamp(0.5 - d / uPx, 0.0, 1.0);
  cover *= clamp((uWipe - vP.x) / uPx + 0.5, 0.0, 1.0);
  if (uIris.z >= 0.0) cover *= clamp((uIris.z - length(vP - uIris.xy)) / uPx + 0.5, 0.0, 1.0);
  vec4 c;
  if (uSolid) c = uColour;
  else {
    vec2 uv = (vP - uImg.xy) / uImg.zw;
    if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) discard;
    if (uFlipY) uv.y = 1.0 - uv.y;
    c = texture(uTex, uv);
  }
  outColor = c*(uOpacity*cover);
}`;

type Rect = { readonly x: number; readonly y: number; readonly w: number; readonly h: number };

/** One layer the compositor draws. */
export interface GpuPicture {
  readonly id: string;
  readonly source: HTMLVideoElement | HTMLImageElement | HTMLCanvasElement;
  readonly box: ClipBox;
  readonly opacity: number;
  /** The share of the canvas width a wipe shows (undefined: no wipe). */
  readonly wipe?: number | undefined;
  /** An iris's circle in canvas px. */
  readonly iris?: { readonly x: number; readonly y: number; readonly r: number } | undefined;
  /** Picture effects: drawn at `size` (core's fxPictureSize), `t` s from the clip's start. */
  readonly fx?: { readonly fx: ClipFx; readonly size: { readonly w: number; readonly h: number }; readonly t: number } | undefined;
}

export interface GpuSolid {
  readonly id: string;
  /** Premultiplied RGBA, 0–1. */
  readonly colour: readonly [number, number, number, number];
  readonly opacity: number;
}

/** A source's natural size (0 when it has no picture yet). */
const naturalSize = (s: GpuPicture["source"]) =>
  s instanceof HTMLVideoElement ? { w: s.videoWidth, h: s.videoHeight } : s instanceof HTMLImageElement ? { w: s.naturalWidth, h: s.naturalHeight } : { w: s.width, h: s.height };

/** What a source shows now, so a paused one isn't uploaded again. */
const frameKey = (s: GpuPicture["source"]) => (s instanceof HTMLVideoElement ? `v${s.currentTime}|${s.paused ? "p" : performance.now()}` : s instanceof HTMLImageElement ? `i${s.currentSrc}` : `c${s.dataset.scrub}|${s.dataset.sample}`);

/** Where a picture of size n lands in rect r with an object-fit (centred, as CSS's default object-position). */
export function fitInto(r: Rect, n: { w: number; h: number }, fit: string): Rect {
  if (fit === "fill" || !n.w || !n.h) return r;
  const k = fit === "cover" ? Math.max(r.w / n.w, r.h / n.h) : Math.min(r.w / n.w, r.h / n.h);
  const w = n.w * k;
  const h = n.h * k;
  return { x: r.x + (r.w - w) / 2, y: r.y + (r.h - h) / 2, w, h };
}

/** Parses a CSS colour (any form the browser takes) to premultiplied RGBA, or undefined for anything that isn't one plain colour. */
let probe: CanvasRenderingContext2D | null | undefined;
export function plainColour(css: string): readonly [number, number, number, number] | undefined {
  if (/gradient|url\(|,\s*(?:radial|linear|repeating)/i.test(css)) return undefined;
  probe ??= document.createElement("canvas").getContext("2d");
  if (!probe) return undefined;
  probe.fillStyle = "#010203";
  probe.fillStyle = css;
  const v = String(probe.fillStyle);
  if (v === "#010203" && !/^#010203$/i.test(css.trim())) return undefined;
  let rgba: Array<number>;
  const hex = /^#([0-9a-f]{6})$/i.exec(v);
  if (hex) rgba = [0, 2, 4].map((i) => parseInt(hex[1]!.slice(i, i + 2), 16) / 255).concat(1);
  else {
    const m = /^rgba?\(([^)]+)\)$/.exec(v);
    if (!m) return undefined;
    const parts = m[1]!.split(/[,\s/]+/).filter(Boolean).map(Number);
    rgba = [parts[0]! / 255, parts[1]! / 255, parts[2]! / 255, parts[3] ?? 1];
  }
  const a = rgba[3]!;
  return [rgba[0]! * a, rgba[1]! * a, rgba[2]! * a, a];
}

type Uniforms = Record<string, WebGLUniformLocation | null>;

export class GpuCompositor {
  readonly canvas: HTMLCanvasElement;
  private readonly gl: WebGL2RenderingContext;
  private program!: WebGLProgram;
  private vao!: WebGLVertexArrayObject;
  private quad!: WebGLBuffer;
  private u: Uniforms = {};
  private readonly textures = new Map<string, { tex: WebGLTexture; key: string }>();
  private readonly fxTargets = new Map<string, { tex: WebGLTexture; fbo: WebGLFramebuffer; w: number; h: number }>();
  private fx: FxRenderer | undefined;
  private used = new Set<string>();
  private canvasSize = { w: 1, h: 1 };
  private px = 1;
  /** The context is lost: the preview draws on the DOM path until it's back. */
  lost = false;
  onRestored: (() => void) | undefined;

  constructor() {
    this.canvas = document.createElement("canvas");
    this.canvas.className = "pv-gpu";
    this.canvas.dataset.gpuCompositor = "";
    const gl = this.canvas.getContext("webgl2", { alpha: true, premultipliedAlpha: true, antialias: false, preserveDrawingBuffer: false });
    if (!gl) throw new Error("WebGL2 isn't available");
    this.gl = gl;
    this.init();
    this.canvas.addEventListener("webglcontextlost", (e) => {
      e.preventDefault();
      this.lost = true;
    });
    this.canvas.addEventListener("webglcontextrestored", () => {
      this.lost = false;
      this.textures.clear();
      this.fxTargets.clear();
      this.init();
      this.onRestored?.();
    });
  }

  private init() {
    const gl = this.gl;
    const shader = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`compositor: ${gl.getShaderInfoLog(s)}`);
      return s;
    };
    const program = gl.createProgram()!;
    gl.attachShader(program, shader(gl.VERTEX_SHADER, VERTEX));
    gl.attachShader(program, shader(gl.FRAGMENT_SHADER, FRAGMENT));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`compositor: ${gl.getProgramInfoLog(program)}`);
    this.program = program;
    this.u = {};
    for (const name of ["uRect", "uCanvas", "uTex", "uSolid", "uColour", "uBox", "uRadius", "uImg", "uOpacity", "uWipe", "uIris", "uPx", "uFlipY"]) this.u[name] = gl.getUniformLocation(program, name);
    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    this.quad = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    this.fx = undefined;
  }

  static available(): boolean {
    try {
      return !!document.createElement("canvas").getContext("webgl2");
    } catch {
      return false;
    }
  }

  /** Starts a frame: the canvas (canvas px) drawn at `scale` device px per canvas px. */
  begin(width: number, height: number, scale: number) {
    const gl = this.gl;
    const k = Math.max(0.1, Math.min(2, scale));
    const bw = Math.max(1, Math.round(width * k));
    const bh = Math.max(1, Math.round(height * k));
    if (this.canvas.width !== bw) this.canvas.width = bw;
    if (this.canvas.height !== bh) this.canvas.height = bh;
    this.canvasSize = { w: width, h: height };
    this.px = width / bw;
    this.used = new Set();
    this.bindOwn();
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  /** The compositor's own state (after FxRenderer used the context). */
  private bindOwn() {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.uniform2f(this.u.uCanvas!, this.canvasSize.w, this.canvasSize.h);
    gl.uniform1f(this.u.uPx!, this.px);
    gl.uniform1i(this.u.uTex!, 0);
  }

  private texture(id: string) {
    const gl = this.gl;
    let t = this.textures.get(id);
    if (!t) {
      const tex = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      // Bilinear, as the browser's compositor scales a <video> or <img> (mipmaps measured softer than the DOM path).
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      t = { tex, key: "" };
      this.textures.set(id, t);
    }
    return t;
  }

  private fxTarget(id: string, w: number, h: number) {
    const gl = this.gl;
    let t = this.fxTargets.get(id);
    if (!t) {
      const tex = gl.createTexture()!;
      t = { tex, fbo: gl.createFramebuffer()!, w: 0, h: 0 };
      this.fxTargets.set(id, t);
    }
    if (t.w !== w || t.h !== h) {
      t.w = w;
      t.h = h;
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, t.tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t.tex, 0);
    }
    return t;
  }

  private clip(rect: Rect & { radius?: number }, wipe: number | undefined, iris: GpuPicture["iris"]) {
    const gl = this.gl;
    // The box's straight edges on whole device pixels, hard, as the browser clips a box (measured).
    const k = 1 / this.px;
    const x0 = Math.round(rect.x * k) / k;
    const y0 = Math.round(rect.y * k) / k;
    const box = { x: x0, y: y0, w: Math.round((rect.x + rect.w) * k) / k - x0, h: Math.round((rect.y + rect.h) * k) / k - y0, radius: rect.radius };
    gl.uniform4f(this.u.uRect!, box.x, box.y, box.w, box.h);
    gl.uniform4f(this.u.uBox!, box.x, box.y, box.w, box.h);
    gl.uniform1f(this.u.uRadius!, box.radius ?? 0);
    gl.uniform1f(this.u.uWipe!, wipe === undefined ? 1e9 : this.canvasSize.w * wipe);
    gl.uniform3f(this.u.uIris!, iris?.x ?? 0, iris?.y ?? 0, iris ? iris.r : -1);
  }

  /** A clip's picture (with its effects when it has some). False when there's nothing to draw yet. */
  drawPicture(p: GpuPicture): boolean {
    const gl = this.gl;
    if (this.lost) return false;
    const n = naturalSize(p.source);
    const ready = p.source instanceof HTMLVideoElement ? p.source.readyState >= 2 : n.w > 0;
    if (!ready || !n.w || !n.h) return false;
    this.used.add(p.id);
    let tex: WebGLTexture;
    let img: Rect;
    let flip = false;
    if (p.fx) {
      this.fx ??= new FxRenderer(this.canvas, gl);
      const { w, h } = p.fx.size;
      const target = this.fxTarget(p.id, w, h);
      gl.disable(gl.BLEND);
      gl.bindVertexArray(null);
      const ok = this.fx.render(p.source, p.fx.fx, w, h, p.fx.t, 1, undefined, target.fbo);
      this.bindOwn();
      if (!ok) return this.drawPicture({ ...p, fx: undefined });
      tex = target.tex;
      // The effects canvas is stretched over the content rect (as the DOM path's canvas, object-fit fill).
      img = p.box.content;
      flip = true;
    } else {
      const t = this.texture(p.id);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, t.tex);
      const key = frameKey(p.source);
      if (t.key !== key) {
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
        gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.BROWSER_DEFAULT_WEBGL);
        try {
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, p.source);
        } catch {
          return false;
        }
        t.key = key;
      }
      tex = t.tex;
      // The element's origin on a whole device pixel, as the browser places a <video>'s layer; its picture fitted inside.
      const k = 1 / this.px;
      const c = p.box.content;
      img = fitInto({ x: Math.round(c.x * k) / k, y: Math.round(c.y * k) / k, w: c.w, h: c.h }, n, p.box.fit);
    }
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    this.clip(p.box, p.wipe, p.iris);
    gl.uniform1i(this.u.uSolid!, 0);
    gl.uniform4f(this.u.uImg!, img.x, img.y, img.w, img.h);
    gl.uniform1f(this.u.uOpacity!, p.opacity);
    gl.uniform1i(this.u.uFlipY!, flip ? 1 : 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    return true;
  }

  /** A plain-colour background over the whole canvas. */
  drawSolid(s: GpuSolid) {
    const gl = this.gl;
    if (this.lost) return;
    this.clip({ x: 0, y: 0, w: this.canvasSize.w, h: this.canvasSize.h }, undefined, undefined);
    gl.uniform1i(this.u.uSolid!, 1);
    gl.uniform4f(this.u.uColour!, ...s.colour);
    gl.uniform1f(this.u.uOpacity!, s.opacity);
    gl.uniform1i(this.u.uFlipY!, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  /** Ends a frame: textures of layers no longer drawn go. */
  end() {
    const gl = this.gl;
    for (const [id, t] of [...this.textures]) {
      if (this.used.has(id)) continue;
      gl.deleteTexture(t.tex);
      this.textures.delete(id);
    }
    for (const [id, t] of [...this.fxTargets]) {
      if (this.used.has(id)) continue;
      gl.deleteTexture(t.tex);
      gl.deleteFramebuffer(t.fbo);
      this.fxTargets.delete(id);
    }
  }

  /** Nothing drawn (every layer back on the DOM path). */
  clear() {
    if (this.lost) return;
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    this.used = new Set();
    this.end();
  }

  dispose() {
    this.gl.getExtension("WEBGL_lose_context")?.loseContext();
    this.canvas.remove();
  }
}
