import { spawn } from "node:child_process";

export interface DroidBinaryStatus {
  available: boolean;
  authenticated?: boolean;
  binaryPath?: string;
  version?: string;
  reason?: string;
  probeDurationMs: number;
}

async function run(binary: string, args: string[], timeoutMs = 2000): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {
        // ignore kill errors
      }
      resolve({ code: 124, stdout, stderr });
    }, timeoutMs);
    child.stdout?.on("data", (c: Buffer) => { stdout += c.toString("utf-8"); });
    child.stderr?.on("data", (c: Buffer) => { stderr += c.toString("utf-8"); });
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ code: 127, stdout, stderr });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

export async function probeDroidBinary(options?: { binaryPath?: string; timeoutMs?: number }): Promise<DroidBinaryStatus> {
  const startedAt = Date.now();
  const binaryPath = options?.binaryPath?.trim() || "droid";
  const timeoutMs = options?.timeoutMs ?? 2000;

  const versionRun = await run(binaryPath, ["--version"], timeoutMs);
  if (versionRun.code !== 0) {
    return {
      available: false,
      binaryPath,
      reason: versionRun.code === 124 ? `Probe timed out after ${timeoutMs}ms` : "`droid` not found on PATH",
      probeDurationMs: Date.now() - startedAt,
    };
  }

  return {
    available: true,
    binaryPath,
    version: versionRun.stdout.trim() || undefined,
    probeDurationMs: Date.now() - startedAt,
  };
}
