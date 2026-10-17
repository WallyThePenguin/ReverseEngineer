import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { brotliCompress, constants, gzip } from "node:zlib";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, type Plugin } from "vite";
import solid from "vite-plugin-solid";
import { buildId, versionStamp } from "../../scripts/version-stamp.ts";

/**
 * Stamps the build: dist/version.json, and the build's id in index.html for UpdateNotice. Not in
 * the scripts: the main script's name is how the service worker tells builds apart (public/sw.js),
 * so a deploy that doesn't change the app keeps its files cached.
 */
function hearthVersion(): Plugin {
  const stamp = versionStamp(fileURLToPath(new URL("../..", import.meta.url)));
  return {
    name: "hearth-version",
    transformIndexHtml: () => [
      { tag: "meta", attrs: { name: "hearth-build", content: buildId(stamp) }, injectTo: "head" },
    ],
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "version.json",
        source: `${JSON.stringify(stamp, null, 2)}\n`,
      });
    },
  };
}

const COMPRESSIBLE = /\.(js|mjs|css|html|svg|json|webmanifest|wasm|txt)$/;

/**
 * Writes a .br and a .gz copy of each built file next to it, so Hearth's server sends the small
 * one without compressing on every request (apps/server/src/app.ts). Source maps are skipped:
 * only developer tools fetch them.
 */
function precompress(): Plugin {
  let outDir = "dist";
  return {
    name: "hearth-precompress",
    apply: "build",
    configResolved(config) {
      outDir = config.build.outDir;
    },
    async closeBundle() {
      const root = fileURLToPath(new URL(".", import.meta.url));
      const dir = join(root, outDir);
      const files = (await readdir(dir, { recursive: true })).filter((f) => COMPRESSIBLE.test(f));
      await Promise.all(
        files.map(async (f) => {
          const path = join(dir, f);
          const data = await readFile(path);
          if (data.length < 1024) return;
          const [br, gz] = await Promise.all([
            promisify(brotliCompress)(data, {
              params: {
                [constants.BROTLI_PARAM_QUALITY]: 11,
                [constants.BROTLI_PARAM_SIZE_HINT]: data.length,
              },
            }),
            promisify(gzip)(data, { level: 9 }),
          ]);
          await Promise.all([writeFile(`${path}.br`, br), writeFile(`${path}.gz`, gz)]);
        }),
      );
    },
  };
}

// In development the web app runs on 5173 and forwards API calls to the server on 4400.
export default defineConfig(({ command }) => ({
  plugins: [solid(), tailwindcss(), hearthVersion(), precompress()],
  resolve: {
    // Built, every "loro-crdt" import (the doc editor's and loro-codemirror's) gets Loro loaded
    // without blocking the page (src/lib/loro.ts). Development keeps the package's own entry.
    alias:
      command === "build"
        ? [
            {
              find: /^loro-crdt$/,
              replacement: fileURLToPath(new URL("./src/lib/loro.ts", import.meta.url)),
            },
          ]
        : [],
  },
  server: {
    port: 5173,
    // Like Hearth itself (app.ts): no other page may frame it, so a frame can't be worked.
    headers: { "Content-Security-Policy": "frame-ancestors 'none'" },
    proxy: {
      // ws: the live browser view is a WebSocket.
      "/api": { target: "http://127.0.0.1:4400", changeOrigin: false, ws: true },
    },
  },
  // The doc editor (CodeMirror and Loro) loads on its own when a note opens.
  build: { outDir: "dist", target: "es2022", sourcemap: true, chunkSizeWarningLimit: 800 },
}));
