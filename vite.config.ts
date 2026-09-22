/**
 * Dashboard build. The server has no build step and no runtime dependencies;
 * this compiles only `web/` into static assets that `server/http/static.ts`
 * serves (or that any CDN could).
 *
 * `base: "./"` so the bundle does not care what path it is mounted at.
 */
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const API_TARGET = process.env.FEST_DEV_API ?? "http://127.0.0.1:8787";

export default defineConfig({
  root: "web",
  base: "./",
  build: { outDir: "dist", emptyOutDir: true, sourcemap: true },
  plugins: [react(), tailwindcss()],
  // Mirrors `paths` in web/tsconfig.json. Vite does not read tsconfig paths on
  // its own, and shadcn's generated components import through `@/`.
  resolve: {
    alias: { "@": fileURLToPath(new URL("./web/src", import.meta.url)) },
  },
  server: {
    port: 5173,
    proxy: {
      // `ws: false` and no buffering: /api/live is SSE, and Vite's proxy will
      // happily hold an event stream unless told the response is streamed.
      //
      // `changeOrigin` MUST stay false. The gateway's CSRF defence is an
      // origin check — it compares the browser's `Origin` against the request's
      // `Host` (server/auth/guard.ts). Rewriting Host to the gateway's address
      // while the browser still sends the dev server's origin makes those two
      // disagree, and every POST comes back 403 "cross-origin request refused":
      // sign-in and sign-out silently stop working in dev while OAuth, being a
      // GET, keeps going. The gateway does not route on Host, so there is
      // nothing to gain by rewriting it.
      "/api": { target: API_TARGET, changeOrigin: false, ws: false },
    },
  },
});
