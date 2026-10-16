var re=Object.defineProperty;var X=(e,n,a)=>()=>{if(a)throw a[0];try{return e&&(n=e(e=0)),n}catch(c){throw a=[c],c}};var ae=(e,n)=>{for(var a in n)re(e,a,{get:n[a],enumerable:!0})};var A,h=X(()=>{A={trail:`struct vs_Output {
  @builtin(position) pos: vec4f,
}

@vertex fn vs(@builtin(vertex_index) vi: u32) -> vs_Output {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vs_Output(vec4f(p[vi], 0.0, 1.0));
}

struct Params {
  res: vec2f,
  time: f32,
  dt: f32,
  a: vec2f,
  b: vec2f,
  strength: f32,
  hue: f32,
  intensity: f32,
  seed: f32,
}

@group(0) @binding(0) var<uniform> params: Params;

fn hash2(p: vec2f) -> f32 {
  let q = fract(p * vec2f(123.34, 456.21));
  let r = q + dot(q, q + 45.32);
  return fract(r.x * r.y);
}

fn vnoise(p: vec2f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash2(i), hash2(i + vec2f(1.0, 0.0)), u.x), mix(hash2(i + vec2f(0.0, 1.0)), hash2(i + vec2f(1.0, 1.0)), u.x), u.y);
}

@group(0) @binding(1) var tex: texture_2d<f32>;

@group(0) @binding(2) var samp: sampler;

@fragment fn fs(@builtin(position) pos: vec4f) -> @location(0)  vec4f {
  let uv = pos.xy / vec2f(320.0, 200.0);
  let aspect = params.res.x / params.res.y;
  let q = vec2f(uv.x * aspect, uv.y) * 1.7 + vec2f(params.time * 0.035, -params.time * 0.025);
  let e = 0.03;
  let n0 = vnoise(q);
  let curl = vec2f(vnoise(q + vec2f(0.0, e)) - n0, -(vnoise(q + vec2f(e, 0.0)) - n0)) / e;
  let back = uv - (curl * 0.02 + vec2f(0.0, -0.006)) * params.dt;
  let t = vec2f(0.003125, 0.005000);
  var c = textureSampleLevel(tex, samp, back, 0.0) * 0.8;
  c += textureSampleLevel(tex, samp, back + vec2f(t.x, 0.0), 0.0) * 0.05;
  c += textureSampleLevel(tex, samp, back - vec2f(t.x, 0.0), 0.0) * 0.05;
  c += textureSampleLevel(tex, samp, back + vec2f(0.0, t.y), 0.0) * 0.05;
  c += textureSampleLevel(tex, samp, back - vec2f(0.0, t.y), 0.0) * 0.05;
  c = c * exp(-params.dt * 0.7);
  let pa = vec2f(params.a.x * aspect, params.a.y);
  let ab = vec2f(params.b.x * aspect, params.b.y) - pa;
  let pp = vec2f(uv.x * aspect, uv.y);
  let h = clamp(dot(pp - pa, ab) / max(dot(ab, ab), 0.000001), 0.0, 1.0);
  let r = pp - pa - ab * h;
  let s = exp(-dot(r, r) / 0.0028) * params.strength;
  let dens = min(c.r + s, 2.5);
  return vec4f(dens, min(c.g + s * params.hue, dens), 0.0, 1.0);
}`,composite:`struct vs_Output {
  @builtin(position) pos: vec4f,
}

@vertex fn vs(@builtin(vertex_index) vi: u32) -> vs_Output {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vs_Output(vec4f(p[vi], 0.0, 1.0));
}

struct Params {
  res: vec2f,
  time: f32,
  dt: f32,
  a: vec2f,
  b: vec2f,
  strength: f32,
  hue: f32,
  intensity: f32,
  seed: f32,
}

@group(0) @binding(0) var<uniform> params: Params;

fn hash2(p: vec2f) -> f32 {
  let q = fract(p * vec2f(123.34, 456.21));
  let r = q + dot(q, q + 45.32);
  return fract(r.x * r.y);
}

fn vnoise(p: vec2f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash2(i), hash2(i + vec2f(1.0, 0.0)), u.x), mix(hash2(i + vec2f(0.0, 1.0)), hash2(i + vec2f(1.0, 1.0)), u.x), u.y);
}

@group(0) @binding(1) var tex: texture_2d<f32>;

@group(0) @binding(2) var samp: sampler;

@fragment fn fs(@builtin(position) pos: vec4f) -> @location(0)  vec4f {
  let uv = pos.xy / params.res;
  let aspect = params.res.x / params.res.y;
  let p = vec2f(uv.x * aspect, uv.y);
  let T = params.time;
  // A low-frequency warp so the glows breathe instead of sliding like discs.
  let w = vec2f(vnoise(p * 1.3 + vec2f(T * 0.04, 0.0)), vnoise(p * 1.3 + vec2f(0.0, T * 0.05) + 7.0)) - 0.5;
  let pw = p + w * 0.35;
  let c1 = vec2f(aspect * (0.72 + 0.12 * sin(T * 0.11)), 0.30 + 0.10 * cos(T * 0.09));
  let c2 = vec2f(aspect * (0.26 + 0.10 * cos(T * 0.07 + 1.3)), 0.62 + 0.10 * sin(T * 0.08 + 0.4));
  let c3 = vec2f(aspect * (0.50 + 0.22 * sin(T * 0.05 + 2.1)), 0.12 + 0.06 * sin(T * 0.13));
  // Narrow (phone) canvases get smaller, dimmer glows so they don't flood the whole column.
  let narrow = clamp(aspect * 0.9, 0.45, 1.0);
  let g1 = exp(-dot(pw - c1, pw - c1) / (0.10 * narrow));
  let g2 = exp(-dot(pw - c2, pw - c2) / (0.08 * narrow));
  let g3 = exp(-dot(pw - c3, pw - c3) / (0.05 * narrow));
  let blue = vec3f(0.36, 0.47, 1.0);
  let violet = vec3f(0.50, 0.30, 0.98);
  let deep = vec3f(0.16, 0.20, 0.62);
  var col = blue * g1 * 0.55 + violet * g2 * 0.45 + deep * g3 * 0.5;
  var a = g1 * 0.55 + g2 * 0.45 + g3 * 0.5;
  // The pointer's tex.
  let tr = textureSampleLevel(tex, samp, uv, 0.0);
  let dens = 1.0 - exp(-tr.r * 1.1);
  let hue = clamp(tr.g / max(tr.r, 0.0001), 0.0, 1.0);
  let tcol = mix(mix(blue, violet, hue), vec3f(0.62, 0.70, 1.0), dens * dens * 0.35);
  col += tcol * dens * 0.8;
  a += dens * 0.8;
  // Keep the headline band and the lede calm: less light at the middle, more at the edges.
  let m = vec2f((uv.x - 0.5) * 1.5, (uv.y - 0.36) * 2.4);
  let calm = 1.0 - 0.45 * exp(-dot(m, m) * 2.2);
  // Fade out towards the bottom (the screenshot sits there) and top.
  let fade = smoothstep(1.0, 0.62, uv.y) * smoothstep(0.0, 0.08, uv.y);
  let k = params.intensity * calm * fade * mix(0.7, 1.0, narrow);
  // Never brighter than about half-lit: the muted lede keeps at least ~4.5:1 over any of it.
  let lit = a * k;
  let capped = min(lit, 0.46);
  col = col * k * (capped / max(lit, 0.0001));
  a = capped;
  // Film grain, only where there is light, so the black stays black.
  let n = hash2(pos.xy + vec2f(params.seed * 91.0, params.seed * 37.0)) - 0.5;
  col = max(col + vec3f(n * 0.06 * a), vec3f(0.0));
  return vec4f(min(col, vec3f(a)), a);
}`,simW:320,simH:200,floats:12}});var Y={};ae(Y,{startHeroGpu:()=>oe});async function oe(e,n,a,c){let C=await navigator.gpu.requestAdapter({powerPreference:"low-power"});if(!C)return!1;let s=await C.requestDevice(),y=!1;s.lost.then(()=>{y=!0}),s.addEventListener("uncapturederror",t=>{y=!0,console.warn("hero gpu: "+t.error.message)});let G=navigator.gpu.getPreferredCanvasFormat(),w=e.getContext("webgpu");if(!w)return!1;w.configure({device:s,format:G,alphaMode:"premultiplied"});let{trail:W,composite:K,simW:J,simH:Q,floats:k}=A,F=s.createBuffer({size:k*4,usage:72}),O=new Float32Array(k),Z=s.createSampler({magFilter:"linear",minFilter:"linear",addressModeU:"clamp-to-edge",addressModeV:"clamp-to-edge"}),E=[0,1].map(()=>s.createTexture({size:[J,Q],format:"rgba16float",usage:20})).map(t=>t.createView());s.pushErrorScope("validation");let H=async(t,r)=>{let o=s.createShaderModule({code:t});return s.createRenderPipelineAsync({layout:"auto",vertex:{module:o,entryPoint:"vs"},fragment:{module:o,entryPoint:"fs",targets:[{format:r}]}})},P,T;try{[P,T]=await Promise.all([H(W,"rgba16float"),H(K,G)])}catch(t){let r=await s.popErrorScope();throw new Error(r?.message??String(t))}if(await s.popErrorScope())return!1;let U=(t,r)=>s.createBindGroup({layout:t.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:F}},{binding:1,resource:r},{binding:2,resource:Z}]}),ee=E.map(t=>U(P,t)),te=E.map(t=>U(T,t)),N=(t,r,o,i)=>{let l=t.beginRenderPass({colorAttachments:[{view:r,loadOp:"clear",storeOp:"store",clearValue:[0,0,0,0]}]});l.setPipeline(o),l.setBindGroup(0,i),l.draw(3),l.end()},g=.5,x=.4,f=.5,m=.4,b=0,I=-1e9,_=!1,ne=t=>{let r=e.getBoundingClientRect();if(!r.width||!r.height)return;let o=(t.clientX-r.left)/r.width,i=(t.clientY-r.top)/r.height;_||(g=f=o,x=m=i,_=!0);let l=Math.hypot(o-f,(i-m)*(r.height/r.width));l>.35?(g=o,x=i):b+=l,f=o,m=i,I=performance.now()};a||(n.addEventListener("pointermove",ne,{passive:!0}),n.addEventListener("pointerleave",()=>{_=!1,b=0}));let d=0,S=0,R=0,D=performance.now(),p=D,u=0,L=!0,B=!0,z=()=>{let t=e.getBoundingClientRect(),r=Math.min(window.devicePixelRatio||1,1.5)*.75,o=Math.max(1,Math.round(t.width*r)),i=Math.max(1,Math.round(t.height*r));(o!==S||i!==R)&&(S=e.width=o,R=e.height=i)};new ResizeObserver(z).observe(e),z();let V=t=>{if(u=0,y){M(),n.classList.remove("fx-live");return}let r=t-I<1500;if(t-p<1e3/(r?60:30)-2){v();return}let o=Math.min((t-p)/1e3,1/20);p=t;let i=a?12:(t-D)/1e3+12,l=Math.min(b*24,.9);b=0,O.set([S,R,i,o,g,x,f,m,l,.5+.5*Math.sin(i*.21),.85,i*7.31%1]),g=f,x=m,s.queue.writeBuffer(F,0,O);let q=s.createCommandEncoder();N(q,E[1-d],P,ee[d]),d=1-d,N(q,w.getCurrentTexture().createView(),T,te[d]),s.queue.submit([q.finish()]),B&&(B=!1,c()),a||v()},v=()=>{!u&&L&&!document.hidden&&!a&&(u=requestAnimationFrame(V))},M=()=>{u&&cancelAnimationFrame(u),u=0};return new IntersectionObserver(t=>{L=t.some(r=>r.isIntersecting),L?(p=performance.now(),v()):M()}).observe(e),document.addEventListener("visibilitychange",()=>{document.hidden?M():(p=performance.now(),v())}),a?requestAnimationFrame(t=>{p=t-1e3,V(t)}):v(),!0}var $=X(()=>{"use strict";h()});h();var ie="blazejkustra/uncut",j="uncut-stars";function ce(e){if(e<1e3)return String(e);let n=e/1e3;return`${n>=100?Math.round(n):n.toFixed(1).replace(/\.0$/,"")}k`}function le(){try{let e=sessionStorage.getItem(j);return e===null?void 0:e==="none"?null:Number(e)}catch{return}}function pe(e){try{sessionStorage.setItem(j,e===null?"none":String(e))}catch{}}async function ue(){let e=document.querySelector("[data-stars]");if(!e)return;let n=le();if(n===void 0){try{let a=await fetch(`https://api.github.com/repos/${ie}`,{headers:{Accept:"application/vnd.github+json"}}),c=a.ok?await a.json():null;n=typeof c?.stargazers_count=="number"?c.stargazers_count:null}catch{n=null}pe(n)}typeof n!="number"||!Number.isFinite(n)||(e.textContent=ce(n),e.closest("a")?.setAttribute("aria-label",`GitHub, ${n} stars`),e.closest("a")?.classList.add("has-stars"))}async function fe(){let e=document.querySelector(".hero"),n=e?.querySelector(".hero-fx canvas");if(!e||!n||!("gpu"in navigator)||!navigator.gpu)return;let a=window.matchMedia("(prefers-reduced-motion: reduce)").matches;try{let{startHeroGpu:c}=await Promise.resolve().then(()=>($(),Y));await c(n,e,a,()=>e.classList.add("fx-live"))}catch(c){console.warn("hero background: "+String(c?.message??c))}}ue();fe();
