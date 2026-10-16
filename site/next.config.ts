// uncut.video as a static export (out/) for Cloudflare Pages. scripts/site-build.ts runs `next build`,
// then copies _headers (with the hashes of Next's inline scripts in the CSP) and _routes.json in.
// The hero background's shaders are authored with TypeGPU (src/heroShaders.ts) and resolved to WGSL
// here, at build time, in Node; the result reaches heroGpu.ts as __HERO__, so the browser runs plain
// WebGPU and never downloads TypeGPU.
import type { NextConfig } from "next";
import { heroWgsl } from "./src/heroShaders.ts";

const config: NextConfig = {
  output: "export",
  trailingSlash: true,
  images: { unoptimized: true },
  poweredByHeader: false,
  reactStrictMode: true,
  productionBrowserSourceMaps: false,
  // The repo typechecks the site with its own TypeScript 7 (`pnpm typecheck`, tsc -p site), whose DOM
  // lib has the WebGPU types; Next would check with the 5.x it bundles against, which lacks them.
  typescript: { ignoreBuildErrors: true },
  compiler: { define: { __HERO__: JSON.stringify(heroWgsl()) } },
};

export default config;
