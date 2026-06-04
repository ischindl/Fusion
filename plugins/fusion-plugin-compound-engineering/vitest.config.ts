import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { computeMaxWorkers } from "../../packages/core/src/__test-utils__/vitest-workers";

const maxWorkers = computeMaxWorkers();

const coreSetup = fileURLToPath(
  new URL("../../packages/core/src/__test-utils__/vitest-setup.ts", import.meta.url),
);
const dashboardSetup = fileURLToPath(new URL("./src/dashboard/test-setup.ts", import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@fusion-plugin-examples\/compound-engineering\/dashboard-view$/,
        replacement: fileURLToPath(new URL("./src/dashboard-view.tsx", import.meta.url)),
      },
      {
        find: /^@fusion-plugin-examples\/compound-engineering$/,
        replacement: fileURLToPath(new URL("./src/index.ts", import.meta.url)),
      },
      { find: "@fusion/core", replacement: fileURLToPath(new URL("../../packages/core/src/index.ts", import.meta.url)) },
      {
        find: "@fusion/plugin-sdk",
        replacement: fileURLToPath(new URL("../../packages/plugin-sdk/src/index.ts", import.meta.url)),
      },
      { find: "@fusion/dashboard", replacement: fileURLToPath(new URL("../../packages/dashboard", import.meta.url)) },
      {
        find: "lucide-react",
        replacement: fileURLToPath(new URL("../../packages/dashboard/node_modules/lucide-react", import.meta.url)),
      },
    ],
  },
  test: {
    // coreSetup runs for all projects via extends: true inheritance.
    setupFiles: [coreSetup],
    globalSetup: [fileURLToPath(new URL("../../packages/core/src/__test-utils__/vitest-teardown.ts", import.meta.url))],
    pool: "threads",
    maxWorkers,
    poolOptions: { threads: { minThreads: 1, maxThreads: maxWorkers }, forks: { minForks: 1, maxForks: maxWorkers } },
    projects: [
      {
        extends: true,
        test: {
          name: "compound-engineering-dashboard",
          environment: "jsdom",
          include: ["src/dashboard/**/__tests__/**/*.test.{ts,tsx}", "src/dashboard/**/*.test.{ts,tsx}"],
          // jsdom-specific setup; coreSetup is inherited via extends: true.
          setupFiles: [dashboardSetup],
        },
      },
      {
        extends: true,
        test: {
          name: "compound-engineering-node",
          environment: "node",
          include: ["src/**/__tests__/**/*.test.{ts,tsx}", "src/**/*.test.{ts,tsx}"],
          exclude: ["src/dashboard/**/__tests__/**/*.test.{ts,tsx}", "src/dashboard/**/*.test.{ts,tsx}"],
        },
      },
    ],
  },
});
