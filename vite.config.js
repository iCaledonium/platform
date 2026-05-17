import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  base: "/",
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
