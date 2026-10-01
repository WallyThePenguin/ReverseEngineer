import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts", "apps/{server,worker,jarvis,cli}/src/**/*.test.ts"],
    globalSetup: ["packages/db/src/testing/global-setup.ts"],
    testTimeout: 20_000,
    hookTimeout: 60_000,
    pool: "forks",
  },
});
