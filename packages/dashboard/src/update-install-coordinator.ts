import type { UpdateInstallResult } from "./update-check.js";

/**
 * Process-local fence shared by timer and HTTP update paths. It deliberately
 * retains a successfully installed target until this process exits, because an
 * old process must never reinstall files that are waiting for its restart.
 */
export class UpdateInstallCoordinator {
  private inFlight: Promise<UpdateInstallResult> | undefined;
  private pendingVersion: string | undefined;
  private pendingResult: UpdateInstallResult | undefined;
  private restartRequested = false;

  async install(targetVersion: string, operation: () => Promise<UpdateInstallResult>): Promise<UpdateInstallResult> {
    if (this.pendingVersion && this.pendingResult) return this.pendingResult;
    if (!this.inFlight) {
      this.inFlight = operation().then((result) => {
        if (result.updated && result.outcome === "installed") {
          this.pendingVersion = result.latestVersion ?? targetVersion;
          this.pendingResult = result;
        }
        return result;
      }).finally(() => { this.inFlight = undefined; });
    }
    return this.inFlight;
  }

  requestRestart(request: () => boolean): boolean {
    if (this.restartRequested) return true;
    if (!request()) return false;
    this.restartRequested = true;
    return true;
  }
}

/** Shared by the dashboard watcher and update route in this host process. */
export const processUpdateInstallCoordinator = new UpdateInstallCoordinator();
