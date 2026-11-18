/*
FNXC:MemorySurfaceTruth 2026-11-18-02:05:
Two memory surfaces reported a result from a backend the operator never configured, and both were
indistinguishable from success. Measured 2026-11-18 on a project with `memoryBackendType: "stash"`:

1. `POST /api/memory/test` overrode the settings object with `{ memoryBackendType: "qmd" }` before
   searching, so with Stash configured it probed qmd and reported the LAST Stash read outcome as if
   it were this test's result. The operator's "test" button could therefore answer `ok` while the
   configured server was unreachable, and it did — the same afternoon's audit carried
   `memory:stash-read-refused` (`code: unreachable`, `keyResolved: true`) beside a test surface that
   never asked the configured backend anything.
2. `PUT /api/memory/file` gates on the configured backend's `capabilities.writable` (Stash answers
   `writable: true`) and then calls `writeProjectMemoryFile`, which writes the local workspace and
   returns `backend: "file"`. `MemoryBackend` has no path-scoped write (`read`/`write`/`exists`/
   `get`/`search` only), so routing that save through `writeMemory()` is NOT a fix — it would put a
   per-file body into the long-term memory blob and discard the path. The honest deliverable is
   therefore disclosure: the response names where the bytes landed and says when that is not where
   the memory screen reads from.

Both decisions are pure functions here so they are testable without a server boot, and so the route
layer cannot re-derive them differently.
*/

import {
  DEFAULT_MEMORY_BACKEND,
  MEMORY_BACKEND_SETTINGS_KEYS,
} from "./memory-backend.js";

/*
FNXC:MemorySurfaceTruth 2026-11-18-02:05:
These modules mirror `resolveMemoryBackend` rather than restating it: the absent setting resolves to
`DEFAULT_MEMORY_BACKEND` ("qmd"), NOT "file". A locally invented "file" default would have made
`describeMemoryFileWrite` claim no divergence for exactly the projects whose screen reads qmd.
`MemorySettings` is not exported from `memory-backend.ts`, so the shape is declared structurally
here and stays assignment-compatible with it.
*/

/** Structural mirror of the settings shape `resolveMemoryBackend` accepts. */
export interface MemoryBackendSettingsInput {
  memoryEnabled?: boolean;
  memoryBackendType?: string;
  [key: string]: unknown;
}

function configuredBackendType(settings?: MemoryBackendSettingsInput): string {
  const raw = settings?.[MEMORY_BACKEND_SETTINGS_KEYS.MEMORY_BACKEND_TYPE] as string | undefined;
  return raw || DEFAULT_MEMORY_BACKEND;
}

/** What a memory probe actually exercised, and what the operator must know about it. */
export interface MemoryTestTarget {
  /** Backend the search ran against. `qmd` only when qmd is the configured backend. */
  testedBackend: string;
  /** True only when qmd is configured but not installed, so the probe fell back to files. */
  usedFallback: boolean;
  /** Operator-visible truth about the gap, or null when the probe tested what was configured. */
  notice: string | null;
}

/**
 * Decide which backend a memory test must exercise. The configured backend always wins; the qmd
 * fallback exists solely because a qmd-configured project with no qmd binary still deserves an
 * answer from the local files. A configured `stash` never silently becomes a qmd test.
 */
export function resolveMemoryTestTarget(
  settings?: MemoryBackendSettingsInput,
  qmdAvailable = false,
): MemoryTestTarget {
  const configured = configuredBackendType(settings);
  if (configured === "qmd" && !qmdAvailable) {
    return {
      testedBackend: "file",
      usedFallback: true,
      notice:
        "qmd is configured but not installed, so this test read the local memory files. Install qmd to test the configured backend.",
    };
  }
  return { testedBackend: configured, usedFallback: false, notice: null };
}

/** Settings object that makes `searchProjectMemory` hit `target`, without mutating the caller's. */
export function settingsForMemoryTestTarget(
  settings: MemoryBackendSettingsInput | undefined,
  target: MemoryTestTarget,
): MemoryBackendSettingsInput | undefined {
  if (target.testedBackend === configuredBackendType(settings)) return settings;
  return {
    ...(settings ?? {}),
    [MEMORY_BACKEND_SETTINGS_KEYS.MEMORY_BACKEND_TYPE]: target.testedBackend,
  };
}

/** Where a per-file memory save landed, relative to what the memory screen reads. */
export interface MemoryFileWriteTruth {
  /** Always `file`: the per-file editor writes the local memory workspace. */
  storedIn: "file";
  /** Backend the memory screen reads from, which may not be `file`. */
  configuredBackend: string;
  /** True when the configured backend never received the bytes, i.e. the file will not appear there. */
  diverges: boolean;
  /** Operator-visible sentence explaining the divergence, or null when there is none. */
  notice: string | null;
}

/**
 * Describe what a per-file write did. Callers must not pretend the configured backend accepted it:
 * the writable-capability gate that passes for Stash does not mean Stash received the bytes.
 *
 * `indexRefreshed` is true when the caller reconciled the workspace write into the configured
 * backend afterwards — today that is only the qmd path (`scheduleQmdProjectMemoryRefresh`). A qmd
 * project therefore does NOT diverge; a Stash project does, because nothing carries the file there.
 */
export function describeMemoryFileWrite(
  settings?: MemoryBackendSettingsInput,
  opts: { indexRefreshed?: boolean } = {},
): MemoryFileWriteTruth {
  const configured = configuredBackendType(settings);
  const diverges = configured !== "file" && opts.indexRefreshed !== true;
  return {
    storedIn: "file",
    configuredBackend: configured,
    diverges,
    notice: diverges
      ? `This file was saved to the local memory workspace, not to the "${configured}" backend your memory screen reads from, so it will not appear there.`
      : null,
  };
}
