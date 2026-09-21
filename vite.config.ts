/**
 * Dashboard build. The server has no build step and no runtime dependencies;
 * this compiles only `web/` into static assets that `server/http/static.ts`
 * serves (or that any CDN could).
 *
 * `base: "./"` so the bundle does not care what path it is mounted at.
 */
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const API_TARGET = process.env.FEST_DEV_API ?? "http://127.0.0.1:8787";

export default defineConfig({
  root: "web",
  base: "./",
  build: { outDir: "dist", emptyOutDir: true, sourcemap: true },
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // `ws: false` and no buffering: /api/live is SSE, and Vite's proxy will
      // happily hold an event stream unless told the response is streamed.
      "/api": { target: API_TARGET, changeOrigin: true, ws: false },
    },
  },
});
