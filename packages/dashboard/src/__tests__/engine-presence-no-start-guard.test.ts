/**
 * RUFU-938 — the UI-only liveness read may observe, never act.
 *
 * The card's own constraint is that fixing false-negative liveness must never make a `--no-engine`
 * dashboard able to start an engine: in the split deployment (UI host + engine host, one shared
 * database) a second engine for a project another process owns is the destruction of the working
 * system, and `EngineAlreadyRunningError` is the only thing standing between the two. Detection is
 * deliberately weaker than control here, on purpose.
 *
 * Behavior tests cannot exclude this shape — a future edit that swaps the connect-probe for
 * `acquireEngineSingleton` would still return the right boolean right up until it stole the address
 * from the running engine. So this is an architectural ratchet over the two sources that own the
 * manager-free answer, comments stripped (prose is not a test subject; the call sites are).
 */
// @vitest-environment node

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** Same comment-stripping discipline as `packages/engine/src/__tests__/legacy-tombstones.test.ts`. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

function sourceOf(file: string): string {
  return stripComments(readFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), "utf8"));
}

/**
 * The actions that would make a liveness read into an engine start. Named explicitly; a new
 * start-shaped API has to be added here, which is the point.
 */
const FORBIDDEN = [
  "acquireEngineSingleton",
  "ProjectEngineManager",
  "ensureEngine",
  "resumeProject",
  ".listen(",
] as const;

describe("engine-presence.ts is observation-only", () => {
  const presence = sourceOf("engine-presence.ts");

  for (const forbidden of FORBIDDEN) {
    it(`never calls ${forbidden}`, () => {
      expect(presence).not.toContain(forbidden);
    });
  }

  it("reaches the lock only through the read-only probe", () => {
    expect(presence).toContain("probeEngineSingletonPresence");
  });
});

/**
 * The manager-free arm of the status builder lives in `server.ts` beside the manager-bearing ladder,
 * so the ratchet has to name its function body rather than its file.
 */
describe("the manager-free status arm cannot start anything", () => {
  const server = sourceOf("server.ts");
  const start = server.indexOf("async function buildManagerFreeEngineStatusPayload");
  const end = server.indexOf("\n}", server.indexOf("runningAgentCount === undefined ? {}", start));

  it("has a body that is findable in the source", () => {
    // A rename would silently empty this guard; fail loudly instead.
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
  });

  it("names no start action in that arm", () => {
    const body = server.slice(start, end);
    for (const forbidden of FORBIDDEN) {
      expect(body).not.toContain(forbidden);
    }
    expect(body).toContain("isEngineSingletonLive");
    expect(body).toContain("resolveRunningAgentCountFromOpenStores");
  });
});
