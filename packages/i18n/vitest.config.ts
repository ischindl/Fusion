import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // Use @fusion/core's TypeScript source so tests don't require a dist build.
      "@fusion/core": resolve(__dirname, "../core/src/index.ts"),
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
  },
});
