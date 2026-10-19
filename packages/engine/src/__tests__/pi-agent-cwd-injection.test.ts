/**
 * RUFU-334 — the engine registration seam must hand the Claude lane a working directory.
 *
 * FNXC:AgentCwdBoundary 2026-10-18-10:31:
 * Upstream pi's `SimpleStreamOptions` carries no `cwd`, so `@fusion/pi-claude-cli`
 * received no working directory from pi at all and used to fall back to
 * `process.cwd()` — the engine/dashboard launch directory, a production deployment
 * checkout on the incident host. The extension now refuses a missing directory, so the
 * seam that knows the session's acquired checkout (`registerExtensionProviders`) has to
 * supply it. These cases pin that supply, its precedence, and the two ways it must NOT
 * behave: no injection into other providers, and no substitution of a relative path.
 */
import { describe, it, expect } from "vitest";
import type { ProviderConfig } from "@earendil-works/pi-coding-agent";

describe("withAgentCwd — Claude runtime lane working directory", () => {
  /** Recorded by the fake transport; `cwd` arrives outside pi's declared option type. */
  function makeRecordingConfig() {
    const seen: Array<Record<string, unknown> | undefined> = [];
    const config: ProviderConfig = {
      streamSimple: ((_model: unknown, _context: unknown, options?: Record<string, unknown>) => {
        seen.push(options);
        return { model: _model, context: _context, stream: true };
      }) as never,
    };
    return { config, seen };
  }

  it("stamps the session checkout onto the Claude CLI provider when the caller named none", async () => {
    const { withAgentCwd } = await import("../pi.js");
    const { config, seen } = makeRecordingConfig();

    const patched = withAgentCwd("pi-claude-cli", config, "/work/fusion-checkouts/fusion-rufu-334");
    (patched.streamSimple as (m: unknown, c: unknown, o?: unknown) => unknown)(null, null, {});

    // This is the whole defect: pi never populates cwd, so the registration seam must.
    expect(seen[0]?.cwd).toBe("/work/fusion-checkouts/fusion-rufu-334");
  });

  it("leaves a caller-supplied directory in charge", async () => {
    const { withAgentCwd } = await import("../pi.js");
    const { config, seen } = makeRecordingConfig();

    const patched = withAgentCwd("pi-claude-cli", config, "/work/session-checkout");
    (patched.streamSimple as (m: unknown, c: unknown, o?: unknown) => unknown)(null, null, {
      cwd: "/work/caller-checkout",
    });

    expect(seen[0]?.cwd).toBe("/work/session-checkout");
  });

  it("returns a non-Claude provider config untouched", async () => {
    const { withAgentCwd } = await import("../pi.js");
    const { config } = makeRecordingConfig();

    // HTTP-backed providers ignore unknown stream options; stamping a write-path notion
    // into every registered provider would widen a lane this task never touched.
    expect(withAgentCwd("anthropic", config, "/work/session-checkout")).toBe(config);
  });

  it("refuses to inject a relative session directory, so the transport's own guard stays in charge", async () => {
    const { withAgentCwd } = await import("../pi.js");
    const { config, seen } = makeRecordingConfig();

    // A relative path is resolved by `spawn` against the process directory — the exact
    // inheritance being removed, wearing a relative spelling.
    const patched = withAgentCwd("pi-claude-cli", config, "kb-worktrees/prod-deploy");
    expect(patched).toBe(config);
    (patched.streamSimple as (m: unknown, c: unknown, o?: unknown) => unknown)(null, null, {});
    expect(seen[0]?.cwd).toBeUndefined();
  });

  it("passes the model and transcript through to the wrapped transport", async () => {
    const { withAgentCwd } = await import("../pi.js");
    const { config } = makeRecordingConfig();
    const patched = withAgentCwd("pi-claude-cli", config, "/work/session-checkout");

    const result = (patched.streamSimple as (m: unknown, c: unknown, o?: unknown) => Record<string, unknown>)(
      { id: "claude-sonnet-4-5" },
      { messages: [] },
      {},
    );

    expect(result).toEqual({ model: { id: "claude-sonnet-4-5" }, context: { messages: [] }, stream: true });
  });
});
