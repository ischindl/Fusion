import { fileURLToPath } from "node:url";
import { runLinter } from "i18next-cli";
import { describe, expect, it } from "vitest";
import config from "../../../../i18next.config.ts";

const repoRoot = fileURLToPath(new URL("../../../..", import.meta.url));

/*
FNXC:i18n-LintBaseline 2026-08-18-19:26:
Run the installed linter API against the production root configuration so this regression covers the same shipping inputs as pnpm i18n:lint without replacing static analysis with a source-text count or a shell command.
Protocol identifiers remain data in the production components; only rendered labels belong in the app catalog.

FNXC:i18n-LintBaseline 2026-08-23-22:11:
RUFU-152 budgets this pass against its measured runtime: the runLinter sweep over the full
shipping surface (dashboard + CLI inputs) measured ~6.9s against Vitest's 5000ms per-test
default, so the single test carries an explicit 30000ms third-arg timeout. Package-wide
timeouts (testTimeout/hookTimeout in vitest.config.ts) are intentionally untouched.
*/
describe("production i18n lint baseline", () => {
  it("keeps the configured shipping inputs free of hardcoded copy", async () => {
    // Vitest package commands run from packages/i18n; the root config's relative
    // globs must be evaluated from the repository root just like pnpm i18n:lint.
    const previousCwd = process.cwd();
    process.chdir(repoRoot);
    let result: Awaited<ReturnType<typeof runLinter>>;
    try {
      result = await runLinter(config);
    } finally {
      process.chdir(previousCwd);
    }
    const issueReport = Object.entries(result.files)
      .map(([file, issues]) => `${file}\n${issues.map((issue) => `  ${issue.line}: ${issue.text}`).join("\n")}`)
      .join("\n");

    expect(result.success, `${result.message}\n${issueReport}`).toBe(true);
  }, 30000);
});
