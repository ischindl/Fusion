import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
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
    environment: "node",
    include: ["src/__tests__/**/*.test.ts"],
    setupFiles: [fileURLToPath(new URL("../../packages/core/src/__test-utils__/vitest-setup.ts", import.meta.url))],
    globalSetup: [fileURLToPath(new URL("../../packages/core/src/__test-utils__/vitest-teardown.ts", import.meta.url))],
    pool: "threads",
    maxWorkers,
    minWorkers: 1,
    /*
    FNXC:PluginPgTestTimeout 2026-11-20-02:49:
    persistence.pg.test.ts drives the shared PG harness
    (packages/core/src/__test-utils__/pg-test-harness.ts), whose golden-schema-template cold
    start is budgeted for the 15s testTimeout of its home package (@fusion/core). Plugin packages ran at
    vitest's 5s default and timed out on loaded CI runners for the WhatsApp plugin (2026-07-23); this
    plugin declares the same budget for the same reason.
    */
    testTimeout: 15_000,
  },
});
