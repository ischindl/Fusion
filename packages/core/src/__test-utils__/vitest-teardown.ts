/**
 * Vitest globalSetup hook.
 *
 * We publish a per-invocation worker-root env var. Teardown removes that private
 * root after the project finishes so workspace isolation checks do not report
 * the run-local worker/home directories as leaks.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

let workerRootRmSync = rmSync;
let workerRootSleepMsSync = sleepMsSync;

export function __setWorkerRootRmSyncForTests(nextRmSync: typeof rmSync): void {
  workerRootRmSync = typeof nextRmSync === "function" ? nextRmSync : rmSync;
}

export function __setWorkerRootSleepMsSyncForTests(nextSleep: (ms: number) => void): void {
  workerRootSleepMsSync = typeof nextSleep === "function" ? nextSleep : sleepMsSync;
}

function sleepMsSync(ms: number): void {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isEnoent(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

export function removeWorkerRootWithRetry(workerRoot: string, retries = 3, delayMs = 75): void {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      workerRootRmSync(workerRoot, { recursive: true, force: true });
      return;
    } catch (error) {
      if (isEnoent(error)) return;
      lastError = error;
      if (attempt < retries) {
        workerRootSleepMsSync(delayMs);
      }
    }
  }

  const message = lastError instanceof Error ? lastError.message : String(lastError);
  console.warn(`[vitest-teardown] failed to remove worker root ${workerRoot} after ${retries} attempts: ${message}`);
}

export default function setup(): () => Promise<void> {
  // Use a fresh root for each Vitest invocation. A static shared root makes the
  // setup-time redirect sweep proportional to stale directories left by every
  // prior interrupted run.
  const workerRoot = resolve(mkdtempSync(join(tmpdir(), "fusion-test-workers-")));
  process.env.FUSION_TEST_WORKER_ROOT = workerRoot;

  return async function teardown() {
    try {
      process.chdir(tmpdir());
    } catch {
      // Ignore — cleanup below is best-effort and uses an absolute path.
    }
    // FN-6360: macOS can report transient EBUSY/ENOTEMPTY while SQLite WALs or
    // redirected temp dirs are still closing. Retry boundedly so a brief busy-fd
    // race does not leak the per-invocation fusion-test-workers-* root.
    removeWorkerRootWithRetry(workerRoot);
  };
}
