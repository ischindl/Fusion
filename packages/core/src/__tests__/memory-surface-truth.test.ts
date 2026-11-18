/*
FNXC:MemorySurfaceTruth 2026-11-18-02:05:
Acceptance for the two surfaces that reported a result the operator never configured.
`POST /api/memory/test` pinned `memoryBackendType: "qmd"` before searching, so a Stash project's test
button probed qmd and echoed the last Stash read outcome as its own verdict; `PUT /api/memory/file`
gated on the configured backend's `writable` capability and then wrote the local workspace, returning
`{ success: true }` with no word about where the bytes went (measured 2026-11-18 with
`memoryBackendType: "stash"`, `memory:stash-read-refused` `code: unreachable` in the same day's audit).
These are pure-function assertions so the decision is covered without booting the dashboard.
*/

import { describe, expect, it } from "vitest";

import {
  describeMemoryFileWrite,
  resolveMemoryTestTarget,
  settingsForMemoryTestTarget,
} from "../memory/memory-surface-truth.js";
import { resolveMemoryBackend } from "../memory/memory-backend.js";

describe("resolveMemoryTestTarget — the test button tests what the operator configured", () => {
  it("tests Stash when Stash is configured, even though qmd is installed", () => {
    const target = resolveMemoryTestTarget({ memoryBackendType: "stash" }, true);
    expect(target.testedBackend).toBe("stash");
    expect(target.usedFallback).toBe(false);
    expect(target.notice).toBeNull();
  });

  it("tests the configured backend for every configured type", () => {
    for (const type of ["file", "readonly", "qmd", "stash"]) {
      expect(resolveMemoryTestTarget({ memoryBackendType: type }, true).testedBackend).toBe(type);
    }
  });

  it("falls back to files only for a qmd project whose qmd binary is missing", () => {
    const target = resolveMemoryTestTarget({ memoryBackendType: "qmd" }, false);
    expect(target.testedBackend).toBe("file");
    expect(target.usedFallback).toBe(true);
    expect(target.notice).toContain("qmd");
  });

  it("agrees with resolveMemoryBackend when the setting is absent, instead of inventing a default", () => {
    // The drift this pins: a locally invented "file" default would have disagreed with the resolver,
    // which defaults to "qmd", and the test surface would quietly probe the wrong store.
    expect(resolveMemoryTestTarget(undefined, true).testedBackend).toBe(resolveMemoryBackend().type);
    expect(resolveMemoryTestTarget({}, true).testedBackend).toBe(resolveMemoryBackend({}).type);
  });
});

describe("settingsForMemoryTestTarget — the probe reaches that backend", () => {
  it("passes the caller's settings through untouched when no override is needed", () => {
    const settings = { memoryBackendType: "stash", stashUrl: "http://127.0.0.1:3457" };
    expect(settingsForMemoryTestTarget(settings, resolveMemoryTestTarget(settings, true))).toBe(settings);
  });

  it("overrides only the backend key for the fallback, and never mutates the caller's settings", () => {
    const settings = { memoryBackendType: "qmd", stashUrl: "http://127.0.0.1:3457" };
    const next = settingsForMemoryTestTarget(settings, resolveMemoryTestTarget(settings, false));
    expect(next?.memoryBackendType).toBe("file");
    expect(next?.stashUrl).toBe("http://127.0.0.1:3457");
    expect(settings.memoryBackendType).toBe("qmd");
  });
});

describe("describeMemoryFileWrite — a workspace save says where it landed", () => {
  it("discloses that a Stash project's file save did not reach Stash", () => {
    const truth = describeMemoryFileWrite({ memoryBackendType: "stash" });
    expect(truth.storedIn).toBe("file");
    expect(truth.configuredBackend).toBe("stash");
    expect(truth.diverges).toBe(true);
    expect(truth.notice).toContain("stash");
    expect(truth.notice).toContain("will not appear");
  });

  it("does not cry divergence for a qmd project, whose save the caller re-indexes", () => {
    const truth = describeMemoryFileWrite({ memoryBackendType: "qmd" }, { indexRefreshed: true });
    expect(truth.diverges).toBe(false);
    expect(truth.notice).toBeNull();
  });

  it("reports divergence for a qmd project when the caller did not re-index", () => {
    expect(describeMemoryFileWrite({ memoryBackendType: "qmd" }).diverges).toBe(true);
  });

  it("is quiet for a file project and mirrors the resolver's default otherwise", () => {
    expect(describeMemoryFileWrite({ memoryBackendType: "file" }).diverges).toBe(false);
    expect(describeMemoryFileWrite(undefined).configuredBackend).toBe(resolveMemoryBackend().type);
  });
});
