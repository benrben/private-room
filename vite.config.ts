import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],
  // Electron loads the packaged renderer from a file inside app.asar.  Every
  // emitted asset therefore uses a relative URL rather than a web-root URL.
  base: "./",
  worker: {
    // PSD/TIFF/JXL decoders are lazy ESM chunks inside a dedicated worker.
    // Rollup's IIFE worker default cannot represent that code-split graph.
    format: "es" as const,
  },

  // Keep the renderer server stable for Electron main's ARCELLE_RENDERER_URL.
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: "127.0.0.1",
    hmr: { protocol: "ws" },
    watch: {
      ignored: ["**/electron-migration/electron-app/dist_package/**"],
    },
  },
}));
