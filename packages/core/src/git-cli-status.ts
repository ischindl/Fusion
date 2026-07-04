import { execFile } from "node:child_process";
import type { ExecFileException } from "node:child_process";

export const GIT_INSTALL_URL = "https://git-scm.com/downloads";
export const DEFAULT_GIT_CLI_STATUS_TIMEOUT_MS = 2_500;

export interface GitCliStatus {
  available: boolean;
  version?: string;
  installUrl: string;
}

export interface ProbeGitCliStatusOptions {
  timeoutMs?: number;
}

function parseGitVersion(stdout: string): string | undefined {
  const trimmed = stdout.trim();
  if (!trimmed) return undefined;
  const match = trimmed.match(/git version\s+(.+)/i);
  return match?.[1]?.trim() || trimmed;
}

/**
 * FNXC:Onboarding 2026-07-03-00:00:
 * First-run GitHub onboarding must detect whether `git` is available on the Fusion server host before clone/init flows fail later.
 * Keep this probe bounded and argument-vector based so auth status can include prerequisite guidance without shell interpolation or long subprocess hangs.
 */
export async function probeGitCliStatus(options: ProbeGitCliStatusOptions = {}): Promise<GitCliStatus> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_GIT_CLI_STATUS_TIMEOUT_MS;

  return new Promise((resolve) => {
    const child = execFile(
      "git",
      ["--version"],
      {
        encoding: "utf-8",
        timeout: timeoutMs,
        windowsHide: true,
      },
      (error: ExecFileException | null, stdout: string | Buffer) => {
        if (error) {
          resolve({ available: false, installUrl: GIT_INSTALL_URL });
          return;
        }
        resolve({
          available: true,
          version: parseGitVersion(String(stdout)),
          installUrl: GIT_INSTALL_URL,
        });
      },
    );

    child.stdin?.end();
  });
}
