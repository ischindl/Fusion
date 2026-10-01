/**
 * FNXC:NonInteractiveGit 2026-09-11-22:40 (RUFU-210):
 * Contract: no autonomous lane's env may carry an interactive git editor/pager. The floor must
 * survive plugin- and task-supplied values (RUFU-210 design decision 2: Fusion's hardening wins)
 * and must never mutate the input object (inputs include `process.env` and shared parent envs).
 * The incident this guards: a `git rebase --continue` blocked on `git commit -e` → `vi` for
 * 1 day 13 hours as an orphan inside an already-deleted worktree.
 */
import { describe, expect, it } from "vitest";
import { NON_INTERACTIVE_GIT_ENV, applyNonInteractiveGitEnv } from "../git/non-interactive-git-env.js";

describe("applyNonInteractiveGitEnv", () => {
  it("applies the full hardened value set on a bare env", () => {
    const out = applyNonInteractiveGitEnv({ PATH: "/bin" });
    expect(out.GIT_EDITOR).toBe("true");
    expect(out.GIT_SEQUENCE_EDITOR).toBe("true");
    expect(out.GIT_PAGER).toBe("cat");
    expect(out.GIT_TERMINAL_PROMPT).toBe("0");
    expect(out.GIT_MERGE_AUTOEDIT).toBe("no");
  });

  it("overrides an interactive editor/pager supplied by a plugin or task", () => {
    const out = applyNonInteractiveGitEnv({ GIT_EDITOR: "vim", GIT_PAGER: "less", GIT_TERMINAL_PROMPT: "1" });
    expect(out.GIT_EDITOR).toBe("true");
    expect(out.GIT_SEQUENCE_EDITOR).toBe("true");
    expect(out.GIT_PAGER).toBe("cat");
    expect(out.GIT_TERMINAL_PROMPT).toBe("0");
  });

  it("passes non-git keys through byte-identical and leaves the input unmutated", () => {
    const input: NodeJS.ProcessEnv = {
      PATH: "/usr/bin:/bin",
      HOME: "/home/operator",
      ANTHROPIC_API_KEY: "sk-secret-untouched",
      COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
    };
    const snapshot = { ...input };
    const out = applyNonInteractiveGitEnv(input);
    expect(out).not.toBe(input);
    for (const key of Object.keys(snapshot)) {
      expect(out[key]).toBe(snapshot[key]);
    }
    expect(input).toEqual(snapshot);
  });

  it("exports a frozen constant map (values cannot be re-decided at call sites)", () => {
    expect(Object.isFrozen(NON_INTERACTIVE_GIT_ENV)).toBe(true);
    expect({ ...NON_INTERACTIVE_GIT_ENV }).toEqual({
      GIT_EDITOR: "true",
      GIT_SEQUENCE_EDITOR: "true",
      GIT_PAGER: "cat",
      GIT_TERMINAL_PROMPT: "0",
      GIT_MERGE_AUTOEDIT: "no",
    });
  });
});
