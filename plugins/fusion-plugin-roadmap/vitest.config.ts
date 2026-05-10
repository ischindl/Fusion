import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { computeMaxWorkers } from "../../packages/core/src/__test-utils__/vitest-workers";

const maxWorkers = computeMaxWorkers();

export default defineConfig({
  resolve: {
    alias: {
      "@fusion/core": fileURLToPath(new URL("../../packages/core/src/index.ts", import.meta.url)),
      "@fusion/plugin-sdk": fileURLToPath(new URL("../../packages/plugin-sdk/src/index.ts", import.meta.url)),
    },
  },
  test: {
    setupFiles: [fileURLToPath(new URL("../../packages/core/src/__test-utils__/vitest-setup.ts", import.meta.url))],
    globalSetup: [fileURLToPath(new URL("../../packages/core/src/__test-utils__/vitest-teardown.ts", import.meta.url))],
    pool: "threads",
    maxWorkers,
    poolOptions: { threads: { minThreads: 1, maxThreads: maxWorkers }, forks: { minForks: 1, maxForks: maxWorkers } },
    projects: [
      {
        extends: true,
        test: {
          name: "roadmap-dashboard",
          environment: "jsdom",
          include: ["src/dashboard/**/__tests__/**/*.test.{ts,tsx}", "src/dashboard/**/*.test.{ts,tsx}"],
          setupFiles: [fileURLToPath(new URL("./src/dashboard/test-setup.ts", import.meta.url))],
        },
      },
      {
        extends: true,
        test: {
          name: "roadmap-node",
          environment: "node",
          include: ["src/**/__tests__/**/*.test.{ts,tsx}", "src/**/*.test.{ts,tsx}"],
          exclude: ["src/dashboard/**/__tests__/**/*.test.{ts,tsx}", "src/dashboard/**/*.test.{ts,tsx}"],
        },
      },
    ],
  },
});
