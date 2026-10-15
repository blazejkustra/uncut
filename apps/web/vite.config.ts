import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

// Only the built app gets a CSP: the dev server needs an inline script for React refresh.
const csp: Plugin = {
  name: "uncut-csp",
  apply: "build",
  transformIndexHtml: () => [
    {
      tag: "meta",
      attrs: {
        "http-equiv": "Content-Security-Policy",
        // Thumbnails, footage and waveforms come from the local server's token-protected /media routes;
        // the bundled fonts are data: URLs (D77); the composer previews attached images as data: URLs (D201); graphic items are sandboxed iframes served by the
        // local server with their own CSP (D78).
        // D219: no plugins (object-src), no <base> rewriting relative URLs, no form posting anywhere;
        // first in <head>, before the script tag.
        content: "default-src 'self'; connect-src ws://127.0.0.1:* http://127.0.0.1:*; img-src 'self' data: http://127.0.0.1:*; media-src http://127.0.0.1:*; style-src 'self' 'unsafe-inline'; font-src data:; frame-src http://127.0.0.1:*; object-src 'none'; base-uri 'self'; form-action 'none'",
      },
      injectTo: "head-prepend",
    },
  ],
};

export default defineConfig({
  plugins: [react(), csp],
  // Relative asset URLs so the packaged app can load index.html over file://.
  base: "./",
  server: { host: "127.0.0.1", port: 5733, strictPort: true },
  build: { outDir: "dist", emptyOutDir: true },
});
