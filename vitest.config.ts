import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "packages/*/src/**/*.test.ts",
      "apps/{server,worker,jarvis,cli}/src/**/*.test.ts",
      "apps/web/src/{lib,canvas,sheets}/**/*.test.ts",
    ],
    globalSetup: ["packages/db/src/testing/global-setup.ts"],
    testTimeout: 20_000,
    hookTimeout: 60_000,
    pool: "forks",
    // Stylesheets are left out of tests, except one imported with ?raw for its text
    // (apps/web/src/lib/tokens.test.ts checks index.css).
    css: { include: [/\.css\?raw$/] },
  },
});
