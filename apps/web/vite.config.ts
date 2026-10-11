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
        content: "default-src 'self'; connect-src ws://127.0.0.1:*; style-src 'self' 'unsafe-inline'",
      },
      injectTo: "head",
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
