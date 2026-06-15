import { defineConfig } from "vite";
import { resolve } from "path";

// Tauri expects a fixed port and ignores vite's HMR over network unless told.
const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  // Multi-page app: control panel, overlay, region selector.
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        overlay: resolve(__dirname, "overlay.html"),
        selector: resolve(__dirname, "selector.html"),
        session: resolve(__dirname, "session.html"),
        chat: resolve(__dirname, "chat.html"),
      },
    },
    target: "esnext",
    minify: false,
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? { protocol: "ws", host, port: 1421 }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
});
