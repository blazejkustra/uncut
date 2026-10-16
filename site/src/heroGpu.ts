// The hero's WebGPU background at runtime: plain WebGPU drawing the two passes heroShaders.ts
// defines with TypeGPU. `pnpm site:build` resolves those to WGSL in Node and injects them here as
// __HERO__, so this chunk stays a few KB and TypeGPU never ships to the browser (nor needs eval).
// Loaded only where navigator.gpu exists (hero.ts imports this chunk lazily).

declare const __HERO__: { readonly trail: string; readonly composite: string; readonly simW: number; readonly simH: number; readonly floats: number };

const MAX_DPR = 1.5;
/** The canvas is drawn at this fraction of CSS size × DPR: soft glows lose nothing to it. */
const RENDER_SCALE = 0.75;
/** At most this many frames a second while the pointer moves, fewer when only the glows drift. */
const FPS_ACTIVE = 60;
const FPS_IDLE = 30;
// GPUBufferUsage / GPUTextureUsage flags (the DOM lib types the interfaces but not these globals).
const UNIFORM = 0x40, COPY_DST = 0x08, TEXTURE_BINDING = 0x04, RENDER_ATTACHMENT = 0x10;

export type HeroHandle = { readonly stop: () => void };

/** Starts the effect on `canvas`; resolves false when WebGPU can't run it (the CSS gradient stays). */
export async function startHeroGpu(canvas: HTMLCanvasElement, hero: HTMLElement, reducedMotion: boolean, onFirstFrame: () => void): Promise<boolean> {
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "low-power" });
  if (!adapter) return false;
  const device = await adapter.requestDevice();
  let failed = false;
  device.lost.then(() => { failed = true; });
  device.addEventListener("uncapturederror", (e) => { failed = true; console.warn("hero gpu: " + (e as GPUUncapturedErrorEvent).error.message); });
  const format = navigator.gpu.getPreferredCanvasFormat();
  const context = canvas.getContext("webgpu") as GPUCanvasContext | null;
  if (!context) return false;
  context.configure({ device, format, alphaMode: "premultiplied" });
  const { trail, composite, simW, simH, floats: FLOATS } = __HERO__;

  const paramsBuf = device.createBuffer({ size: FLOATS * 4, usage: UNIFORM | COPY_DST });
  const floats = new Float32Array(FLOATS);
  const samp = device.createSampler({ magFilter: "linear", minFilter: "linear", addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge" });
  const trails = [0, 1].map(() => device.createTexture({ size: [simW, simH], format: "rgba16float", usage: TEXTURE_BINDING | RENDER_ATTACHMENT }));
  const views = trails.map((t) => t.createView());

  device.pushErrorScope("validation");
  const pipeline = async (code: string, target: GPUTextureFormat) => {
    const module = device.createShaderModule({ code });
    return device.createRenderPipelineAsync({ layout: "auto", vertex: { module, entryPoint: "vs" }, fragment: { module, entryPoint: "fs", targets: [{ format: target }] } });
  };
  let trailPipe: GPURenderPipeline, compositePipe: GPURenderPipeline;
  try {
    [trailPipe, compositePipe] = await Promise.all([pipeline(trail, "rgba16float"), pipeline(composite, format)]);
  } catch (error) {
    const scoped = await device.popErrorScope();
    throw new Error(scoped?.message ?? String(error));
  }
  if (await device.popErrorScope()) return false;
  // trailGroups[i] reads trail i (and writes trail 1 - i); compositeGroups[i] shows trail i.
  const group = (pipe: GPURenderPipeline, view: GPUTextureView) => device.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: paramsBuf } }, { binding: 1, resource: view }, { binding: 2, resource: samp }] });
  const trailGroups = views.map((v) => group(trailPipe, v));
  const compositeGroups = views.map((v) => group(compositePipe, v));
  const pass = (enc: GPUCommandEncoder, view: GPUTextureView, pipe: GPURenderPipeline, bind: GPUBindGroup) => {
    const p = enc.beginRenderPass({ colorAttachments: [{ view, loadOp: "clear", storeOp: "store", clearValue: [0, 0, 0, 0] }] });
    p.setPipeline(pipe);
    p.setBindGroup(0, bind);
    p.draw(3);
    p.end();
  };

  // Pointer: the last segment it moved along, in canvas uv; strength from its speed.
  let ax = 0.5, ay = 0.4, bx = 0.5, by = 0.4, moved = 0, lastMove = -1e9, hasPointer = false;
  const onMove = (e: PointerEvent) => {
    const r = canvas.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
    // First contact (or re-entry): start the segment here, so no streak is drawn from elsewhere.
    if (!hasPointer) { ax = bx = x; ay = by = y; hasPointer = true; }
    const step = Math.hypot(x - bx, (y - by) * (r.height / r.width));
    // A jump of over a third of the width in one event is a teleport (touch, a scrolled page): no streak.
    if (step > 0.35) { ax = x; ay = y; } else moved += step;
    bx = x; by = y;
    lastMove = performance.now();
  };
  if (!reducedMotion) {
    hero.addEventListener("pointermove", onMove, { passive: true });
    hero.addEventListener("pointerleave", () => { hasPointer = false; moved = 0; });
  }

  let cur = 0, w = 0, h = 0, started = performance.now(), last = started, raf = 0, visible = true, first = true;
  const resize = () => {
    const r = canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR) * RENDER_SCALE;
    const nw = Math.max(1, Math.round(r.width * dpr)), nh = Math.max(1, Math.round(r.height * dpr));
    if (nw !== w || nh !== h) { w = canvas.width = nw; h = canvas.height = nh; }
  };
  const ro = new ResizeObserver(resize);
  ro.observe(canvas);
  resize();

  const frame = (now: number) => {
    raf = 0;
    if (failed) { stop(); hero.classList.remove("fx-live"); return; }
    const active = now - lastMove < 1500;
    if (now - last < 1000 / (active ? FPS_ACTIVE : FPS_IDLE) - 2) { schedule(); return; }
    const dt = Math.min((now - last) / 1000, 1 / 20);
    last = now;
    const t = reducedMotion ? 12 : (now - started) / 1000 + 12;
    const splat = Math.min(moved * 24, 0.9);
    moved = 0;
    floats.set([w, h, t, dt, ax, ay, bx, by, splat, 0.5 + 0.5 * Math.sin(t * 0.21), 0.85, (t * 7.31) % 1]);
    ax = bx; ay = by;
    device.queue.writeBuffer(paramsBuf, 0, floats);
    const enc = device.createCommandEncoder();
    pass(enc, views[1 - cur]!, trailPipe, trailGroups[cur]!);
    cur = 1 - cur;
    pass(enc, context.getCurrentTexture().createView(), compositePipe, compositeGroups[cur]!);
    device.queue.submit([enc.finish()]);
    if (first) { first = false; onFirstFrame(); }
    if (!reducedMotion) schedule();
  };
  const schedule = () => { if (!raf && visible && !document.hidden && !reducedMotion) raf = requestAnimationFrame(frame); };
  const stop = () => { if (raf) cancelAnimationFrame(raf); raf = 0; };

  const io = new IntersectionObserver((entries) => {
    visible = entries.some((e) => e.isIntersecting);
    if (visible) { last = performance.now(); schedule(); } else stop();
  });
  io.observe(canvas);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stop(); else { last = performance.now(); schedule(); }
  });
  if (reducedMotion) {
    // One still frame: the glows where they rest, no trail, no loop.
    requestAnimationFrame((now) => { last = now - 1000; frame(now); });
  } else {
    schedule();
  }
  return true;
}
