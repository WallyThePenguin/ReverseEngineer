import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

// In development the web app runs on 5173 and forwards API calls to the server on 4400.
export default defineConfig({
  plugins: [solid(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      // ws: the live browser view is a WebSocket.
      "/api": { target: "http://127.0.0.1:4400", changeOrigin: false, ws: true },
    },
  },
  // The doc editor (CodeMirror and Loro) loads on its own when a note opens.
  build: { outDir: "dist", target: "es2022", sourcemap: true, chunkSizeWarningLimit: 800 },
});
