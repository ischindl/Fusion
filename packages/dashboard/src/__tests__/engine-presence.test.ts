/**
 * RUFU-938 — the manager-free engine-presence reader, pinned at its own seam.
 *
 * A `--no-engine` dashboard beside a live engine host reported "no engine" because its only liveness
 * source was a manager it does not have. This module is the replacement signal, and its contract has
 * two halves that must both be testable:
 *
 *   1. it may never turn a failed or absent observation into a live claim (fail closed);
 *   2. it may never do anything except observe — the split deployment dies the moment a UI-only host
 *      starts a second engine for a project another process already owns.
 *
 * Half (1) is covered behaviorally below. Half (2) is covered by a call-count assertion here plus a
 * call-site guard in `engine-presence-no-start-guard.test.ts`; the engine package's own suite
 * (`packages/engine/src/__tests__/engine-singleton-lock.test.ts`) proves the underlying probe takes
 * neither singleton guard and binds nothing.
 */
// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import {
  anyEngineSingletonLive,
  createPresenceCandidateReader,
  dedupePresenceCandidates,
  isEngineSingletonLive,
} from "../engine-presence.js";

describe("isEngineSingletonLive", () => {
  it("passes the project id through and reports what the probe saw", async () => {
    const probe = vi.fn(async () => true);
    await expect(isEngineSingletonLive("proj_aaa", probe)).resolves.toBe(true);
    expect(probe).toHaveBeenCalledWith("proj_aaa");
  });

  it("reports not-live for a throwing, non-boolean, or unnamed project", async () => {
    const throwing = vi.fn(async () => {
      throw new Error("PROBE_MUST_NOT_FAIL_THE_CALLER");
    });
    // A host whose probe resolves something that is not the literal `true` proved nothing.
    const notABoolean = vi.fn(async () => undefined as unknown as boolean);

    await expect(isEngineSingletonLive("proj_aaa", throwing)).resolves.toBe(false);
    await expect(isEngineSingletonLive("proj_aaa", notABoolean)).resolves.toBe(false);

    // An unnamed project names no address, so nothing is even asked.
    const neverAsked = vi.fn(async () => true);
    await expect(isEngineSingletonLive(undefined, neverAsked)).resolves.toBe(false);
    await expect(isEngineSingletonLive("", neverAsked)).resolves.toBe(false);
    expect(neverAsked).not.toHaveBeenCalled();
  });
});

describe("anyEngineSingletonLive", () => {
  it("is true on a single positive proof among candidates", async () => {
    const probe = vi.fn(async (id: string) => id === "proj_live");
    await expect(
      anyEngineSingletonLive(["proj_dead", "proj_live", "proj_dead"], probe),
    ).resolves.toBe(true);
  });

  it("asks about each candidate once, deduped and trimmed", async () => {
    const probe = vi.fn(async () => false);
    await expect(anyEngineSingletonLive(["proj_a", " proj_a ", "", "proj_b"], probe)).resolves.toBe(false);
    expect(probe.mock.calls.map(([id]) => id)).toEqual(["proj_a", "proj_b"]);
  });

  it("does not let one hostile probe erase another candidate's proof", async () => {
    const probe = vi.fn(async (id: string) => {
      if (id === "proj_hostile") throw new Error("unreadable address");
      return id === "proj_live";
    });
    await expect(anyEngineSingletonLive(["proj_hostile", "proj_live"], probe)).resolves.toBe(true);
  });

  it("touches nothing when there is nothing to ask", async () => {
    const probe = vi.fn(async () => true);
    await expect(anyEngineSingletonLive([], probe)).resolves.toBe(false);
    expect(probe).not.toHaveBeenCalled();
  });
});

describe("createPresenceCandidateReader", () => {
  it("unions the already-known project identities", async () => {
    const read = createPresenceCandidateReader({
      listRegisteredProjectIds: () => ["proj_registered", "proj_a"],
      resolveDefaultProjectId: async () => "proj_a",
    });
    await expect(read()).resolves.toEqual(["proj_registered", "proj_a"]);
  });

  it("degrades to what it can read instead of failing the liveness question", async () => {
    const read = createPresenceCandidateReader({
      listRegisteredProjectIds: () => {
        throw new Error("registry unreadable");
      },
      resolveDefaultProjectId: async () => "proj_default",
    });
    await expect(read()).resolves.toEqual(["proj_default"]);

    const nothing = createPresenceCandidateReader({});
    await expect(nothing()).resolves.toEqual([]);
  });
});

describe("dedupePresenceCandidates", () => {
  it("drops blanks and non-strings rather than probing a blank address", () => {
    expect(dedupePresenceCandidates(["a", "a", "  ", "", undefined, null, 3 as unknown as string])).toEqual(["a"]);
  });
});
