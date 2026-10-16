/* uncutMotion (Uncut, MIT): one-take motion film helpers for graphics (D292). Load it with the
   marker uncut:lib/motion.js (a script tag with that src). Every function is a pure function of its
   arguments (time in seconds): no state, no timers, so render(t) can be called in any order.
     uncutMotion.spring(t, "spring.snap")                  // closed-form step response, 0 → 1 (same as uncutSpring)
     uncutMotion.springs(t, [{ at: 0, to: 0 }, { at: 1, to: 200 }, { at: 1.4, to: 80 }], "spring.snap")
                                                         // sum of one spring per target change: retargets stay continuous
     uncutMotion.edges(t, [{ at: 0, left: 0, right: 100 }, { at: 1, left: 200, right: 300 }], { lead: "spring.snap", trail: "spring.settle" })
                                                         // { left, right }: the leading edge rides the faster spring (liquid tab indicator, toggle knob)
     uncutMotion.rise(t, { at: 0.5, out: 2, height: 80 }) // { y, visible }: text rising out of a mask line (wrap it in overflow: hidden), and leaving upward
     uncutMotion.flood(t, { at, x, y, r, width, height, dur: 0.3, until, to: { x, y, r } })
                                                         // { x, y, r, full }: a circle that overscales past the frame's corners, then contracts into the next shape
     uncutMotion.cover(x, y, width, height)              // the radius that covers the frame from (x, y), 6 % past the farthest corner
     uncutMotion.shape(t, [{ at, x, y, w, h, r }, { at, bleed: true }, ...], { width, height, spring })
                                                         // { x, y, w, h, r, full }: ONE rounded rect (x, y its centre) morphing key to key;
                                                         // bleed: true is the whole frame 12 % past every edge, square corners (a flood is a morph)
     uncutMotion.shapePath(ctx, s)                       // that shape as the canvas path (clip to it, then draw the footage)
     uncutMotion.footageRect(srcW, srcH, width, height, s) // { x, y, w, h }: draw the clip there: covers the frame and the shape,
                                                         // the same scale while the shape fits the frame (no zoom-in that goes soft, no flat edges)
     uncutMotion.riseText(ctx, text, x, baseline, t, { at, out, size })
                                                         // draws a line rising out of its mask line and leaving upward, whole:
                                                         // the mask has room for ascenders and descenders, the exit is quick (spring.snap)
     uncutMotion.iris(open, { x, y, r, blades: 6, turn }) // blade polygons [[x, y], ...]: open 1 = no blades in the circle, 0 = closed
     uncutMotion.squeeze(xs, widths, anchor, f)           // [{ x, scale }]: letters pulled toward anchor by f (1 = as set, 0 = in the anchor), widths follow
     uncutMotion.cursor(t, [{ at, x, y, click }], { spring })  // { x, y, scale, down }: a drawn cursor's path with real presses
     uncutMotion.camera(t, [{ at, x, y, zoom }], spring)  // { x, y, zoom }: the world point at the frame's centre and its zoom;
                                                         // zoom rides the spring in log space (an even push, no lurch); a key
                                                         // missing x, y or zoom keeps the previous key's
     uncutMotion.frameRect(left, top, w, h, { width, height, fit, pad, align })
                                                         // a camera key { x, y, zoom } that frames a UI rect (world px, top-left):
                                                         // by default it COVERS the frame (the UI surface is the frame, the overflow
                                                         // cropped at align { x, y }, 0.5 = centred); fit: true shows all of it, pad px around
     uncutMotion.apply(ctx, cam, width, height)          // ctx.transform for that camera (save first): draw the UI in world px after it
     uncutMotion.toScreen(cam, x, y, width, height)      // [sx, sy]: a world point on screen (the cursor, a headline pinned to the UI)
     uncutMotion.morph(t, from, to, { at, dur: 0.3 })     // { x, y, w, h, r, p, full }: rect to rect (centres, corner radius) in dur s,
                                                         // eased; to: "bleed" is the whole frame past every edge. The button grows into
                                                         // the next scene's full shape; never shrink a scene to a dot
     uncutMotion.coverage(s, width, height)              // 0..1: the share of the frame inside shape s (keep it at 0.7 or more on every frame)
   DOM, CSS and SVG are first class (backdrop-filter, SVG filters, masks, variable-font axes all export):
     uncutMotion.cameraCSS(cam, width, height)           // "matrix(...)" for a world div (transform-origin: 0 0)
     uncutMotion.shapeCSS(s)                             // { left, top, width, height, borderRadius } in px for a div
     uncutMotion.riseCSS(t, { at, out, size })           // { height, transform, visible }: a mask div of that height
                                                         // (overflow: hidden) around a span with that transform
     uncutMotion.swap(t, at, { out: 0.1, in: 0.14, gap: 0.03, blur: 6, lift: 14 })
                                                         // { out: { alpha, blur, dy, visible }, in: {...} }: the content inside a morphing
                                                         // shape swaps on its own timing: the old content leaves (up, a few px of blur),
                                                         // then the new arrives; draw each with ctx.globalAlpha, ctx.filter = blur(px), dy
     uncutMotion.beat(n, { bpm: 120, offset: 0 })         // seconds of beat n
     uncutMotion.loop(t, duration)                        // t wrapped into [0, duration): the last frame meets the first
     uncutMotion.ease.inOut(p), .out(p), .in(p)           // cubic eases for opacity or colour
     uncutMotion.mix(a, b, p), uncutMotion.clamp(v, lo, hi), uncutMotion.mixColor("#000000", "#ffffff", p)
*/
(function () {
  "use strict";
  var PRESETS = {
    "spring.snap": { stiffness: 400, damping: 36 },
    "spring.settle": { stiffness: 170, damping: 20 },
    "spring.land": { stiffness: 220, damping: 17 },
    "spring.bounce": { stiffness: 300, damping: 9 },
    spring: { stiffness: 170, damping: 20 },
  };
  function params(p) {
    var s = typeof p === "string" ? PRESETS[p] || PRESETS.spring : p || PRESETS["spring.snap"];
    var k = typeof s.stiffness === "number" && s.stiffness > 0 ? s.stiffness : 170;
    var c = typeof s.damping === "number" && s.damping >= 0 ? s.damping : 20;
    var m = typeof s.mass === "number" && s.mass > 0 ? s.mass : 1;
    var v = typeof s.velocity === "number" && Number.isFinite(s.velocity) ? s.velocity : 0;
    return { k: k, c: c, m: m, v: v };
  }
  // The damped spring's step response (0 at t <= 0, settling at 1), as in packages/core/src/visual/spring.ts.
  function spring(t, preset) {
    var p = params(preset);
    if (!(t > 0)) return 0;
    var w0 = Math.sqrt(p.k / p.m);
    var zeta = p.c / (2 * Math.sqrt(p.k * p.m));
    if (Math.abs(zeta - 1) < 1e-6) return 1 + (-1 + (p.v - w0) * t) * Math.exp(-w0 * t);
    if (zeta < 1) {
      var wd = w0 * Math.sqrt(1 - zeta * zeta);
      var b = (p.v - zeta * w0) / wd;
      return 1 + Math.exp(-zeta * w0 * t) * (-Math.cos(wd * t) + b * Math.sin(wd * t));
    }
    var root = w0 * Math.sqrt(zeta * zeta - 1);
    var r1 = -zeta * w0 + root;
    var r2 = -zeta * w0 - root;
    var c2 = (p.v + r1) / (r2 - r1);
    var c1 = -1 - c2;
    return 1 + c1 * Math.exp(r1 * t) + c2 * Math.exp(r2 * t);
  }
  function sorted(keys) {
    return (keys || []).slice().sort(function (a, b) {
      return a.at - b.at;
    });
  }
  // A value with many targets: the first key's value, plus one spring per change, each from its own key's time.
  function springs(t, keys, preset, field) {
    var ks = sorted(keys);
    if (!ks.length) return 0;
    var f = field || "to";
    var v = ks[0][f];
    for (var i = 1; i < ks.length; i++) {
      var d = ks[i][f] - ks[i - 1][f];
      if (d) v += d * spring(t - ks[i].at, ks[i].spring || preset);
    }
    return v;
  }
  // Two edges of one shape: on each change, the edge moving in the direction of travel leads (faster spring).
  function edges(t, keys, o) {
    var ks = sorted(keys);
    var lead = (o && o.lead) || "spring.snap";
    var trail = (o && o.trail) || { stiffness: 140, damping: 22 };
    if (!ks.length) return { left: 0, right: 0 };
    var left = ks[0].left;
    var right = ks[0].right;
    for (var i = 1; i < ks.length; i++) {
      var dl = ks[i].left - ks[i - 1].left;
      var dr = ks[i].right - ks[i - 1].right;
      var forward = dl + dr >= 0;
      left += dl * spring(t - ks[i].at, forward ? trail : lead);
      right += dr * spring(t - ks[i].at, forward ? lead : trail);
    }
    return { left: left, right: right };
  }
  // Text rising out of a mask line: y is the offset inside an overflow: hidden box of `height`.
  function rise(t, o) {
    var h = o.height || 100;
    var s = o.spring || "spring.snap";
    var y = h * (1 - spring(t - o.at, s));
    if (o.out !== undefined) y -= h * spring(t - o.out, o.outSpring || s);
    return { y: y, visible: t >= o.at && (o.out === undefined || y > -h + 0.5) };
  }
  function cover(x, y, w, h) {
    var dx = Math.max(x, w - x);
    var dy = Math.max(y, h - y);
    return Math.sqrt(dx * dx + dy * dy) * 1.06;
  }
  function easeInOut(p) {
    p = p <= 0 ? 0 : p >= 1 ? 1 : p;
    return p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
  }
  function easeOut(p) {
    p = p <= 0 ? 0 : p >= 1 ? 1 : p;
    return 1 - Math.pow(1 - p, 3);
  }
  function easeIn(p) {
    p = p <= 0 ? 0 : p >= 1 ? 1 : p;
    return p * p * p;
  }
  // A flood: the shape grows past the corners in `dur` s (it never covers half the frame in one
  // frame), stays full until `until`, then contracts into `to` over `dur`.
  function flood(t, o) {
    var dur = o.dur || 0.3;
    var R = cover(o.x, o.y, o.width, o.height);
    var p = easeInOut((t - o.at) / dur);
    var x = o.x, y = o.y, r = o.r + (R - o.r) * p;
    if (o.until !== undefined && o.to && t > o.until) {
      var q = easeInOut((t - o.until) / dur);
      var R2 = cover(o.to.x, o.to.y, o.width, o.height);
      x = o.to.x;
      y = o.to.y;
      r = R2 + (o.to.r - R2) * q;
    }
    return { x: x, y: y, r: r, full: r >= cover(x, y, o.width, o.height) / 1.06 };
  }
  // D296: one rounded rect morphing between keys (centre x, y, size w, h, corner r); bleed keys
  // fill the frame past its edges. Each field is a sum of springs (springs), so it's continuous.
  function shape(t, keys, o) {
    o = o || {};
    var W = o.width || 1080;
    var H = o.height || 1350;
    var pre = o.spring || "spring.snap";
    var ks = sorted(keys).map(function (k) {
      if (!k.bleed) return k;
      return { at: k.at, x: W / 2, y: H / 2, w: W * 1.24, h: H * 1.24, r: 0, spring: k.spring };
    });
    if (!ks.length) return { x: W / 2, y: H / 2, w: W, h: H, r: 0, full: true };
    var out = {};
    ["x", "y", "w", "h", "r"].forEach(function (f) {
      out[f] = springs(t, ks, pre, f);
    });
    out.w = Math.max(0, out.w);
    out.h = Math.max(0, out.h);
    out.r = clamp(out.r, 0, Math.min(out.w, out.h) / 2);
    out.full = out.x - out.w / 2 <= 0 && out.y - out.h / 2 <= 0 && out.x + out.w / 2 >= W && out.y + out.h / 2 >= H;
    return out;
  }
  function shapePath(ctx, s) {
    var x = s.x - s.w / 2, y = s.y - s.h / 2, r = clamp(s.r || 0, 0, Math.min(s.w, s.h) / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + s.w, y, x + s.w, y + s.h, r);
    ctx.arcTo(x + s.w, y + s.h, x, y + s.h, r);
    ctx.arcTo(x, y + s.h, x, y, r);
    ctx.arcTo(x, y, x + s.w, y, r);
    ctx.closePath();
  }
  // Where to draw a srcW × srcH clip so it covers the frame and the shape's whole extent, centred on
  // the frame: while the shape stays inside the frame the scale never changes (no zoom on resize).
  function footageRect(srcW, srcH, W, H, s) {
    var x0 = 0, y0 = 0, x1 = W, y1 = H;
    if (s) {
      x0 = Math.min(0, s.x - s.w / 2);
      y0 = Math.min(0, s.y - s.h / 2);
      x1 = Math.max(W, s.x + s.w / 2);
      y1 = Math.max(H, s.y + s.h / 2);
    }
    var bw = 2 * Math.max(W / 2 - x0, x1 - W / 2);
    var bh = 2 * Math.max(H / 2 - y0, y1 - H / 2);
    var k = Math.max(bw / srcW, bh / srcH);
    return { x: W / 2 - (srcW * k) / 2, y: H / 2 - (srcH * k) / 2, w: srcW * k, h: srcH * k };
  }
  // A line rising out of its mask line and leaving upward, never cut while it rests: the mask runs
  // from 1.05 × size above the baseline to 0.35 × size below it, the line travels that whole box.
  function riseText(ctx, text, x, baseline, t, o) {
    var size = o.size || 96;
    var top = baseline - size * 1.05;
    var h = size * 1.4;
    var r = rise(t, { at: o.at, out: o.out, height: h, spring: o.spring || "spring.snap", outSpring: o.outSpring || "spring.snap" });
    if (!r.visible) return false;
    ctx.save();
    ctx.beginPath();
    ctx.rect(-1e5, top, 2e5, h);
    ctx.clip();
    ctx.fillText(text, x, baseline + r.y);
    ctx.restore();
    return true;
  }
  // Iris: `blades` blades around a regular polygon aperture. Each blade is its two aperture vertices,
  // both edge extensions out to the circle, and the short arc between them.
  function iris(open, o) {
    var n = Math.max(3, Math.round(o.blades || 6));
    var R = o.r;
    var a = Math.max(0, Math.min(1, open)) * R * 1.0001;
    var turn = (o.turn === undefined ? Math.PI / 3 : o.turn) * (1 - Math.max(0, Math.min(1, open)));
    var V = [];
    for (var i = 0; i < n; i++) {
      var ang = (i / n) * Math.PI * 2 + turn;
      V.push([o.x + Math.cos(ang) * a, o.y + Math.sin(ang) * a]);
    }
    // Where the ray from p along d leaves the circle.
    function hit(p, d) {
      var px = p[0] - o.x, py = p[1] - o.y;
      var len = Math.hypot(d[0], d[1]) || 1;
      var ux = d[0] / len, uy = d[1] / len;
      var b = px * ux + py * uy;
      var c = px * px + py * py - R * R;
      var s = -b + Math.sqrt(Math.max(0, b * b - c));
      return [p[0] + ux * s, p[1] + uy * s];
    }
    var blades = [];
    for (var j = 0; j < n; j++) {
      var A = V[j], B = V[(j + 1) % n], P = V[(j - 1 + n) % n];
      // At open 0 every vertex is the centre: the edge direction comes from the angles.
      var angA = (j / n) * Math.PI * 2 + turn, angB = ((j + 1) / n) * Math.PI * 2 + turn, angP = ((j - 1) / n) * Math.PI * 2 + turn;
      var dAB = a > 1e-6 ? [B[0] - A[0], B[1] - A[1]] : [Math.cos(angB) - Math.cos(angA), Math.sin(angB) - Math.sin(angA)];
      var dPA = a > 1e-6 ? [A[0] - P[0], A[1] - P[1]] : [Math.cos(angA) - Math.cos(angP), Math.sin(angA) - Math.sin(angP)];
      var Q1 = hit(B, dAB);
      var Q0 = hit(A, dPA);
      var poly = [A, B, Q1];
      // The short arc from Q1 back to Q0.
      var a1 = Math.atan2(Q1[1] - o.y, Q1[0] - o.x);
      var a0 = Math.atan2(Q0[1] - o.y, Q0[0] - o.x);
      var da = a0 - a1;
      while (da > Math.PI) da -= Math.PI * 2;
      while (da < -Math.PI) da += Math.PI * 2;
      for (var k = 1; k < 8; k++) poly.push([o.x + Math.cos(a1 + (da * k) / 8) * R, o.y + Math.sin(a1 + (da * k) / 8) * R]);
      poly.push(Q0);
      blades.push(poly);
    }
    return blades;
  }
  // Wordmark squeeze into its own period: every letter moves toward the anchor by the same factor
  // and its drawn width follows, so neighbours stay touching.
  function squeeze(xs, widths, anchor, f) {
    var out = [];
    for (var i = 0; i < xs.length; i++) out.push({ x: anchor + (xs[i] - anchor) * f, scale: f, width: (widths[i] || 0) * f });
    return out;
  }
  // A drawn cursor: x and y ride springs from waypoint to waypoint; a click dips the scale and comes back.
  function cursor(t, path, o) {
    var s = (o && o.spring) || { stiffness: 120, damping: 22 };
    var ks = sorted(path);
    var x = springs(t, ks, s, "x");
    var y = springs(t, ks, s, "y");
    var scale = 1;
    var down = false;
    for (var i = 0; i < ks.length; i++) {
      if (!ks[i].click) continue;
      var c = ks[i].click === true ? ks[i].at : ks[i].click;
      var hold = ks[i].hold || 0.12;
      if (t >= c && t < c + hold) down = true;
      scale -= 0.12 * (spring(t - c, "spring.snap") - spring(t - c - hold, "spring.snap"));
    }
    return { x: x, y: y, scale: scale, down: down };
  }
  // Screen-studio camera: (x, y) is the world point at the frame's centre. Missing fields carry
  // over from the previous key; zoom springs in log space, so a 1x to 3x push moves evenly.
  function camera(t, keys, preset) {
    var ks = sorted(keys);
    var s = preset || "spring.settle";
    if (!ks.length) return { x: 0, y: 0, zoom: 1 };
    var full = [];
    for (var i = 0; i < ks.length; i++) {
      var p = full[i - 1] || { x: 0, y: 0, zoom: 1 };
      var k = ks[i];
      full.push({ at: k.at, spring: k.spring, x: k.x === undefined ? p.x : k.x, y: k.y === undefined ? p.y : k.y, lz: Math.log(Math.max(1e-3, k.zoom === undefined ? p.zoom : k.zoom)), zoom: k.zoom === undefined ? p.zoom : k.zoom });
    }
    return { x: springs(t, full, s, "x"), y: springs(t, full, s, "y"), zoom: Math.exp(springs(t, full, s, "lz")) };
  }
  // A camera key framing a UI rect (left, top, w, h in world px): cover (default) fills the frame
  // with it, cropping the overflow at align; fit shows all of it with pad px around.
  function frameRect(left, top, w, h, o) {
    o = o || {};
    var W = o.width || 1080;
    var H = o.height || 1350;
    var pad = o.pad || 0;
    var al = o.align || {};
    var ax = al.x === undefined ? 0.5 : al.x;
    var ay = al.y === undefined ? 0.5 : al.y;
    var zw = W / Math.max(1, w + 2 * pad);
    var zh = H / Math.max(1, h + 2 * pad);
    var zoom = o.fit ? Math.min(zw, zh) : Math.max(zw, zh);
    var vw = W / zoom;
    var vh = H / zoom;
    // The visible window slides inside the rect (cover) or centres on it (fit) along align.
    var x = left + (o.fit ? w / 2 : vw / 2 + (w - vw) * ax);
    var y = top + (o.fit ? h / 2 : vh / 2 + (h - vh) * ay);
    return { x: x, y: y, zoom: zoom };
  }
  function apply(ctx, cam, W, H) {
    var z = cam.zoom;
    ctx.transform(z, 0, 0, z, W / 2 - cam.x * z, H / 2 - cam.y * z);
  }
  function toScreen(cam, x, y, W, H) {
    return [(x - cam.x) * cam.zoom + W / 2, (y - cam.y) * cam.zoom + H / 2];
  }
  // Rect to rect (centre x, y, size w, h, corner r) over dur s from at, eased in and out.
  function morph(t, from, to, o) {
    o = o || {};
    var W = o.width || 1080;
    var H = o.height || 1350;
    var bleed = function (k) {
      return k === "bleed" || (k && k.bleed) ? { x: W / 2, y: H / 2, w: W * 1.24, h: H * 1.24, r: 0 } : k;
    };
    var a = bleed(from);
    var b = bleed(to);
    var p = easeInOut((t - (o.at || 0)) / (o.dur || 0.3));
    var out = { p: p };
    ["x", "y", "w", "h", "r"].forEach(function (f) {
      out[f] = mix(a[f] || 0, b[f] || 0, p);
    });
    out.r = clamp(out.r, 0, Math.min(out.w, out.h) / 2);
    out.full = out.x - out.w / 2 <= 0 && out.y - out.h / 2 <= 0 && out.x + out.w / 2 >= W && out.y + out.h / 2 >= H;
    return out;
  }
  // DOM twins of apply, shapePath and riseText.
  function cameraCSS(cam, W, H) {
    var z = cam.zoom;
    return "matrix(" + z + ", 0, 0, " + z + ", " + (W / 2 - cam.x * z) + ", " + (H / 2 - cam.y * z) + ")";
  }
  function shapeCSS(s) {
    var r = clamp(s.r || 0, 0, Math.min(s.w, s.h) / 2);
    return { left: s.x - s.w / 2, top: s.y - s.h / 2, width: s.w, height: s.h, borderRadius: r };
  }
  function riseCSS(t, o) {
    var size = o.size || 96;
    var h = size * 1.4;
    var r = rise(t, { at: o.at, out: o.out, height: h, spring: o.spring || "spring.snap", outSpring: o.outSpring || "spring.snap" });
    return { height: h, transform: "translateY(" + Math.round(r.y * 100) / 100 + "px)", visible: r.visible };
  }
  // Content swapping inside a morphing shape: the old content leaves first (alpha down, lifting,
  // a short blur), the new one arrives after a gap; both quick, so the swap reads as one change.
  function swap(t, at, o) {
    o = o || {};
    var dOut = o.out || 0.1;
    var dIn = o.in || 0.14;
    var gap = o.gap === undefined ? 0.03 : o.gap;
    var blur = o.blur === undefined ? 6 : o.blur;
    var lift = o.lift === undefined ? 14 : o.lift;
    var po = easeIn((t - at) / dOut);
    var pi = easeOut((t - at - dOut - gap) / dIn);
    return {
      out: { alpha: 1 - po, blur: blur * po, dy: -lift * po, visible: po < 1 },
      in: { alpha: pi, blur: blur * (1 - pi), dy: lift * (1 - pi), visible: pi > 0 },
    };
  }
  // The share of the W x H frame inside the rounded rect s (its corners' cut-outs subtracted where
  // they fall inside the frame).
  function coverage(s, W, H) {
    var x0 = s.x - s.w / 2, y0 = s.y - s.h / 2, x1 = s.x + s.w / 2, y1 = s.y + s.h / 2;
    var iw = Math.max(0, Math.min(W, x1) - Math.max(0, x0));
    var ih = Math.max(0, Math.min(H, y1) - Math.max(0, y0));
    var area = iw * ih;
    var r = clamp(s.r || 0, 0, Math.min(s.w, s.h) / 2);
    var cut = r * r * (1 - Math.PI / 4);
    [[x0, y0], [x1 - r, y0], [x0, y1 - r], [x1 - r, y1 - r]].forEach(function (c) {
      if (c[0] >= 0 && c[1] >= 0 && c[0] + r <= W && c[1] + r <= H) area -= cut;
    });
    return clamp(area / (W * H), 0, 1);
  }
  function beat(n, o) {
    var bpm = (o && o.bpm) || 120;
    return ((o && o.offset) || 0) + (n * 60) / bpm;
  }
  function loop(t, d) {
    return d > 0 ? ((t % d) + d) % d : t;
  }
  function mix(a, b, p) {
    return a + (b - a) * p;
  }
  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }
  function hex(c) {
    var h = String(c).replace("#", "");
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function mixColor(a, b, p) {
    var A = hex(a), B = hex(b), q = clamp(p, 0, 1);
    return "rgb(" + Math.round(mix(A[0], B[0], q)) + ", " + Math.round(mix(A[1], B[1], q)) + ", " + Math.round(mix(A[2], B[2], q)) + ")";
  }
  window.uncutMotion = {
    spring: spring,
    springs: springs,
    edges: edges,
    rise: rise,
    flood: flood,
    cover: cover,
    shape: shape,
    shapePath: shapePath,
    footageRect: footageRect,
    riseText: riseText,
    iris: iris,
    squeeze: squeeze,
    cursor: cursor,
    camera: camera,
    frameRect: frameRect,
    apply: apply,
    toScreen: toScreen,
    morph: morph,
    coverage: coverage,
    swap: swap,
    cameraCSS: cameraCSS,
    shapeCSS: shapeCSS,
    riseCSS: riseCSS,
    beat: beat,
    loop: loop,
    ease: { inOut: easeInOut, out: easeOut, in: easeIn },
    mix: mix,
    clamp: clamp,
    mixColor: mixColor,
    presets: PRESETS,
  };
})();
