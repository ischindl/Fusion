/*
FNXC:PromptWriteIntegrity 2026-11-11-22:52 (RUFU-534):
Step 1 invariant: a verified authoritative prompt write must never silently keep wrong bytes, and a
compensation must never replace bytes a newer write landed. Three branches under test with a mocked
`node:fs/promises` so a "rename that lands a partial file" is deterministic:
  (a) rename lands a partial file + compensation on  -> previous bytes restored byte-for-byte + throw.
  (b) a newer write lands between the rename and the compensating re-read -> the newer bytes survive on
      disk and the thrown error names the superseded arm. THIS CASE FAILS AGAINST AN UNCONDITIONAL
      RESTORE and is the whole reason the fence exists.
  (c) a mismatch with compensation off -> throws and changes nothing on disk.
The existing `prompt-file-atomic-write.test.ts` stays green separately, proving the new optional
parameters did not change the default contract for any of the ten best-effort/seed callers.
*/
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  /** committed files keyed by absolute path */
  files: new Map<string, string>(),
  /** when set, the NEXT rename lands only the first N bytes of the tmp content, simulating a truncating rename */
  truncateNextRenameBytes: null as number | null,
  renamesCompleted: 0,
  readsAfterRename: 0,
  /** invoked exactly once, on the second read of PROMPT_PATH after a rename (the compensation fence re-read) */
  interleave: null as (() => void) | null,
  watchPath: "",
}));

vi.mock("node:fs/promises", () => ({
  mkdir: vi.fn(async () => undefined),
  writeFile: vi.fn(async (path: string, data: string) => {
    state.files.set(String(path), typeof data === "string" ? data : String(data));
  }),
  rename: vi.fn(async (src: string, dst: string) => {
    const data = state.files.get(String(src)) ?? "";
    state.files.delete(String(src));
    const landed = state.truncateNextRenameBytes === null ? data : data.slice(0, state.truncateNextRenameBytes);
    state.truncateNextRenameBytes = null;
    state.files.set(String(dst), landed);
    state.renamesCompleted += 1;
  }),
  readFile: vi.fn(async (path: string) => {
    const key = String(path);
    if (key === state.watchPath && state.renamesCompleted > 0) {
      state.readsAfterRename += 1;
      if (state.readsAfterRename === 2 && state.interleave) {
        // Simulate a concurrent legitimate write landing between the verify read and the fence re-read.
        state.interleave();
        state.interleave = null;
      }
    }
    const value = state.files.get(key);
    if (value === undefined) {
      throw Object.assign(new Error(`ENOENT: no such file, open '${key}'`), { code: "ENOENT" });
    }
    return value;
  }),
  unlink: vi.fn(async (path: string) => {
    state.files.delete(String(path));
  }),
}));

import {
  PromptWriteIntegrityError,
  PromptShrinkRejectedError,
  assertNoAuthoritativePromptShrink,
  isMaterialPromptShrink,
  largestPriorPromptBytes,
  writePromptFileAtomic,
  PROMPT_SHRINK_MIN_PRIOR_BYTES,
} from "../task-store/prompt-file.js";

const PROMPT_PATH = "/task/PROMPT.md";

function makeContent(bytes: number, marker: string): string {
  // Build a body of at least `bytes` UTF-8 bytes with a recognisable marker.
  const base = `${marker}\n`;
  const filler = "x".repeat(Math.max(0, bytes - base.length));
  return base + filler;
}

beforeEach(() => {
  state.files.clear();
  state.truncateNextRenameBytes = null;
  state.renamesCompleted = 0;
  state.readsAfterRename = 0;
  state.interleave = null;
  state.watchPath = PROMPT_PATH;
});

describe("writePromptFileAtomic landed-byte verification + fenced compensation", () => {
  it("(a) restores the previous bytes byte-for-byte and throws when a rename lands a partial file with compensation on", async () => {
    const prior = makeContent(120, "PRIOR SPEC");
    const submitted = makeContent(400, "NEW SPEC");
    state.files.set(PROMPT_PATH, prior);
    state.truncateNextRenameBytes = 10; // rename lands only the first 10 bytes of `submitted`

    await expect(
      writePromptFileAtomic(PROMPT_PATH, submitted, { verifyLanded: true, compensateOnMismatch: true, label: "updateTask FN-1" }),
    ).rejects.toBeInstanceOf(PromptWriteIntegrityError);

    // The prior spec survives exactly, not the partial and not the submitted bytes.
    expect(state.files.get(PROMPT_PATH)).toBe(prior);
  });

  it("(b) leaves a newer write's bytes on disk and names the superseded arm instead of restoring a stale spec", async () => {
    const prior = makeContent(120, "PRIOR SPEC");
    const submitted = makeContent(400, "NEW SPEC");
    const newer = makeContent(500, "A FRESHER LEGITIMATE WRITE");
    state.files.set(PROMPT_PATH, prior);
    state.truncateNextRenameBytes = 10; // authoritative write lands a partial file
    state.interleave = () => {
      // A different, newer authoritative write replaces our bytes before the fence re-read completes.
      state.files.set(PROMPT_PATH, newer);
    };

    let thrown: unknown;
    try {
      await writePromptFileAtomic(PROMPT_PATH, submitted, { verifyLanded: true, compensateOnMismatch: true, label: "updateTask FN-2" });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(PromptWriteIntegrityError);
    const integrity = thrown as PromptWriteIntegrityError;
    expect(integrity.details.superseded).toBe(true);
    // The newer legitimate write survives; the stale prior was never pasted over it.
    expect(state.files.get(PROMPT_PATH)).toBe(newer);
    expect(integrity.message).toMatch(/superseded/i);
  });

  it("(c) throws and changes nothing on disk when compensation is off", async () => {
    const submitted = makeContent(400, "NEW SPEC");
    state.truncateNextRenameBytes = 10; // rename lands a partial file, no prior to compare against
    // No compensation: a prior file on disk must remain unread and the landed bytes untouched.
    state.files.set(PROMPT_PATH, "PRE-EXISTING THAT MUST NOT BE READ");

    let thrown: unknown;
    try {
      await writePromptFileAtomic(PROMPT_PATH, submitted, { verifyLanded: true, compensateOnMismatch: false, label: "seed-write" });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(PromptWriteIntegrityError);
    const integrity = thrown as PromptWriteIntegrityError;
    expect(integrity.details.superseded).toBe(false);
    expect(integrity.details.priorBytes).toBeNull(); // the uncompensated path read nothing extra
    // Whatever landed is left exactly as-is; it is the partial, and it was never restored.
    expect(state.files.get(PROMPT_PATH)).toBe(submitted.slice(0, 10));
  });

  it("passes through cleanly when the verified write lands the exact submitted bytes", async () => {
    const submitted = makeContent(200, "COMPLETE SPEC");
    await expect(
      writePromptFileAtomic(PROMPT_PATH, submitted, { verifyLanded: true, compensateOnMismatch: true, label: "updateTask FN-3" }),
    ).resolves.toBeUndefined();
    expect(state.files.get(PROMPT_PATH)).toBe(submitted);
  });
});

describe("isMaterialPromptShrink + largestPriorPromptBytes (pure)", () => {
  it("refuses only a prior at/above the floor falling below half its size", () => {
    // The RUFU-519 numbers: 57 814 B accepted, 1 579 B landed.
    expect(isMaterialPromptShrink(57814, 1579)).toBe(true);
    // Below the floor a short spec stays legitimately short.
    expect(isMaterialPromptShrink(PROMPT_SHRINK_MIN_PRIOR_BYTES - 1, 10)).toBe(false);
    // At/above the floor but not losing half is a legitimate slim edit.
    expect(isMaterialPromptShrink(PROMPT_SHRINK_MIN_PRIOR_BYTES, PROMPT_SHRINK_MIN_PRIOR_BYTES - 1)).toBe(false);
    expect(isMaterialPromptShrink(10000, 5000)).toBe(false); // exactly half is NOT a material shrink
    expect(isMaterialPromptShrink(10000, 4999)).toBe(true); // below half is
  });

  it("names the largest stored copy, not the newest", () => {
    expect(largestPriorPromptBytes(["small", makeContent(9000, "biggest"), makeContent(300, "middle")])).toBeGreaterThanOrEqual(9000);
    expect(largestPriorPromptBytes([null, undefined, ""])).toBe(0);
  });
});

describe("assertNoAuthoritativePromptShrink (mocked fs)", () => {
  it("is a no-op when there is no prior file to shrink", async () => {
    state.files.delete(PROMPT_PATH);
    await expect(
      assertNoAuthoritativePromptShrink({ promptPath: PROMPT_PATH, nextContent: "tiny", allowShrink: false, label: "seed" }),
    ).resolves.toBeUndefined();
  });

  it("allows a large prior with a legitimate small edit", async () => {
    state.files.set(PROMPT_PATH, makeContent(5000, "prior"));
    await expect(
      assertNoAuthoritativePromptShrink({ promptPath: PROMPT_PATH, nextContent: makeContent(4000, "slimmed"), allowShrink: false, label: "op" }),
    ).resolves.toBeUndefined();
  });

  it("refuses a material shrink with the PROMPT_SHRINK_REJECTED prefix and byte counts", async () => {
    state.files.set(PROMPT_PATH, makeContent(57814, "prior spec"));
    let thrown: unknown;
    try {
      await assertNoAuthoritativePromptShrink({ promptPath: PROMPT_PATH, nextContent: makeContent(1579, "trunc"), allowShrink: false, label: "updateTask FN-519" });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(PromptShrinkRejectedError);
    const rejection = thrown as PromptShrinkRejectedError;
    expect(rejection.message.startsWith("PROMPT_SHRINK_REJECTED:")).toBe(true);
    expect(rejection.details.priorBytes).toBeGreaterThanOrEqual(57814);
    expect(rejection.details.nextBytes).toBe(1579);
    expect(rejection.message).toMatch(/57814|57,814/);
  });

  it("names the passed recovery pointer in the refusal", async () => {
    state.files.set(PROMPT_PATH, makeContent(20000, "prior"));
    await expect(
      assertNoAuthoritativePromptShrink({ promptPath: PROMPT_PATH, nextContent: makeContent(100, "t"), allowShrink: false, label: "updateTask", recovery: 'task document "plan" revision 3 (20 000 B)' }),
    ).rejects.toThrow(/revision 3/);
  });

  it("is authorized away when allowShrink is set", async () => {
    state.files.set(PROMPT_PATH, makeContent(57814, "prior"));
    await expect(
      assertNoAuthoritativePromptShrink({ promptPath: PROMPT_PATH, nextContent: makeContent(100, "t"), allowShrink: true, label: "operator edit" }),
    ).resolves.toBeUndefined();
  });
});
