import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  base: "/",

  // Vite copies publicDir into the build output. publicDir defaults to
  // "public/", which here holds ~1.1 GB of actor media — including the body
  // reference photographs a character's likeness is built from. Every `vite
  // build` duplicated all of it into dist/, and dist/ is served by
  // express.static with no auth at all, so each build re-published those
  // photographs on a second path.
  //
  // Nothing reads dist/media: media is served from public/media by express
  // (and by nginx, which has the auth rules). So there is nothing to copy.
  publicDir: false,

  build: {
    outDir: "dist",
    minify: "esbuild",
    target: "es2022",
  },
  esbuild: {
    minifyIdentifiers: false,
  },
  server: {
    port: 3000,
    proxy: { "/api": "http://localhost:4001" },
  },
});
