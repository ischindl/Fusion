import { describe, expect, it } from "vitest";
import { buildSpawnEnv } from "../acp/process-manager.js";

/*
FNXC:NonInteractiveGit 2026-09-11-22:40 (RUFU-210):
Every autonomous lane's git must be non-interactive — a `git commit -e`/`rebase --continue` that
opens an editor blocks on a TTY that will never come (measured orphan: 1d13h in `vi` inside an
already-deleted worktree on a production host, 2026-09-09). The floor is applied at the
`buildSpawnEnv` return site, NOT inside the allow-list loop, so the KTD6b contract stays intact:
the untrusted bridge never receives an allow-listed-out variable, and the floor's fixed keys
(never values from the excluded env) are the only additions.
*/
describe("buildSpawnEnv non-interactive git floor", () => {
  it("returns only the floor with an empty allow-list even when the source env asks for an editor", () => {
    expect(
      buildSpawnEnv([], { sourceEnv: { GIT_EDITOR: "vim", GIT_PAGER: "less" } }),
    ).toEqual({
      GIT_EDITOR: "true",
      GIT_SEQUENCE_EDITOR: "true",
      GIT_PAGER: "cat",
      GIT_TERMINAL_PROMPT: "0",
      GIT_MERGE_AUTOEDIT: "no",
    });
  });

  it("never lets a non-floor GIT_* key cross the allow-list boundary", () => {
    const env = buildSpawnEnv([], {
      sourceEnv: { GIT_ASKPASS: "/usr/bin/askpass", GIT_CONFIG_GLOBAL: "/tmp/evil" },
    });
    expect(env.GIT_ASKPASS).toBeUndefined();
    expect(env.GIT_CONFIG_GLOBAL).toBeUndefined();
  });

  it("beats an explicitly allow-listed interactive value (floor applies after the allow-list)", () => {
    const env = buildSpawnEnv(["GIT_EDITOR", "HOME"], {
      sourceEnv: { GIT_EDITOR: "vim", HOME: "/home/user" },
    });
    expect(env.GIT_EDITOR).toBe("true");
    expect(env.HOME).toBe("/home/user");
  });

  it("keeps the allow-list copy semantics otherwise unchanged", () => {
    const env = buildSpawnEnv(["PATH"], {
      sourceEnv: { PATH: "/bin", XAI_API_KEY: "secret" },
    });
    expect(env.PATH).toBe("/bin");
    expect(env.XAI_API_KEY).toBeUndefined();
  });
});
