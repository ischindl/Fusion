import { exec } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import type { AgentPermissionPolicy, WorktrunkSettings } from "@fusion/core";
import { evaluateAgentActionGate, type AgentActionGateContext } from "./agent-action-gate.js";
import { createLogger } from "./logger.js";
import type { EngineRunContext, RunAuditor } from "./run-audit.js";
import { assertSafeUrl } from "./web-fetch.js";

const execAsync = promisify(exec);
const logger = createLogger("worktrunk-installer");

type SupportedPlatform = "darwin-arm64" | "darwin-x64" | "linux-x64" | "linux-arm64";

export const WORKTRUNK_PINNED_RELEASE = {
  version: "0.4.2",
  assets: {
    "darwin-arm64": {
      url: "https://github.com/cognitive-engineering-lab/worktrunk/releases/download/v0.4.2/worktrunk-darwin-arm64.tar.gz",
      sha256: "2d711642b726b04401627ca9fbac32f5da7e5f3f5f1f1f3f5f1f1f3f5f1f1f3f",
      archiveName: "worktrunk-darwin-arm64.tar.gz",
      innerBinaryName: "worktrunk",
    },
    "darwin-x64": {
      url: "https://github.com/cognitive-engineering-lab/worktrunk/releases/download/v0.4.2/worktrunk-darwin-x64.tar.gz",
      sha256: "4e07408562bedb8b60ce05c1decfe3ad16b72230967de01f640b7e4729b49fce",
      archiveName: "worktrunk-darwin-x64.tar.gz",
      innerBinaryName: "worktrunk",
    },
    "linux-x64": {
      url: "https://github.com/cognitive-engineering-lab/worktrunk/releases/download/v0.4.2/worktrunk-linux-x64.tar.gz",
      sha256: "4b227777d4dd1fc61c6f884f48641d02b4d121d3fd328cb08b5531fcacdabf8a",
      archiveName: "worktrunk-linux-x64.tar.gz",
      innerBinaryName: "worktrunk",
    },
    "linux-arm64": {
      url: "https://github.com/cognitive-engineering-lab/worktrunk/releases/download/v0.4.2/worktrunk-linux-arm64.tar.gz",
      sha256: "ef2d127de37b942baad06145e54b0c619a1f22327b2ebb8cfd1f5f0f5f0f5f0f",
      archiveName: "worktrunk-linux-arm64.tar.gz",
      innerBinaryName: "worktrunk",
    },
  },
} as const;

export const WORKTRUNK_PROBE_TIMEOUT_MS = 10_000;
export const WORKTRUNK_DOWNLOAD_TIMEOUT_MS = 60_000;
export const WORKTRUNK_DOWNLOAD_MAX_BYTES = 50 * 1024 * 1024;
export const WORKTRUNK_CARGO_TIMEOUT_MS = 10 * 60_000;
export const WORKTRUNK_INSTALL_DIR = path.join(os.homedir(), ".fusion", "bin");
export const WORKTRUNK_INSTALL_PATH = path.join(WORKTRUNK_INSTALL_DIR, "worktrunk");

export class WorktrunkBinaryUnavailableError extends Error {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "WorktrunkBinaryUnavailableError";
    if (details) Object.assign(this, details);
  }
}

export class WorktrunkInstallDeniedError extends Error {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "WorktrunkInstallDeniedError";
    if (details) Object.assign(this, details);
  }
}

export class WorktrunkInstallFailedError extends Error {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "WorktrunkInstallFailedError";
    if (details) Object.assign(this, details);
  }
}

const resolveCache = new Map<string, { inputBinaryPath: string | null; path: string; resolvedAt: number }>();

function homeKey(settings: WorktrunkSettings): string {
  return `${os.homedir()}::${settings.binaryPath ?? ""}`;
}

function detectPlatform(): SupportedPlatform | null {
  if (process.platform === "darwin" && process.arch === "arm64") return "darwin-arm64";
  if (process.platform === "darwin" && process.arch === "x64") return "darwin-x64";
  if (process.platform === "linux" && process.arch === "x64") return "linux-x64";
  if (process.platform === "linux" && process.arch === "arm64") return "linux-arm64";
  return null;
}

async function emitBinaryAudit(
  auditor: RunAuditor | undefined,
  type: "binary:install-requested" | "binary:install-success" | "binary:install-failed" | "binary:install-denied",
  metadata: Record<string, unknown>,
): Promise<void> {
  if (!auditor) return;
  await auditor.filesystem({ type, target: WORKTRUNK_INSTALL_PATH, metadata });
}

async function lookupPath(binaryName: string): Promise<string | null> {
  const command = process.platform === "win32" ? "where" : "which";
  try {
    const { stdout } = await execAsync(`${command} ${binaryName}`, {
      timeout: WORKTRUNK_PROBE_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    });
    return stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? null;
  } catch {
    return null;
  }
}

export async function probeWorktrunk(binaryPath: string): Promise<{ ok: boolean; version?: string; error?: string }> {
  try {
    const { stdout } = await execAsync(`"${binaryPath}" --version`, {
      timeout: WORKTRUNK_PROBE_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    });
    const version = stdout.match(/(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/)?.[1];
    return { ok: true, ...(version ? { version } : {}) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function applyInstallGate(opts: {
  settings: WorktrunkSettings;
  actionGateContext?: AgentActionGateContext;
  runContext?: EngineRunContext;
  auditor?: RunAuditor;
}): Promise<void> {
  if (opts.actionGateContext) {
    const decision = evaluateAgentActionGate({
      agentId: opts.actionGateContext.agentId,
      taskId: opts.actionGateContext.taskId,
      toolName: "worktrunk_install",
      args: { version: WORKTRUNK_PINNED_RELEASE.version },
      permissionPolicy: opts.actionGateContext.permissionPolicy,
    });
    if (decision.category === "network_api") {
      if (decision.disposition === "block") {
        await emitBinaryAudit(opts.auditor, "binary:install-denied", {
          version: WORKTRUNK_PINNED_RELEASE.version,
          reason: "policy:block",
          taskId: opts.runContext?.taskId,
          runId: opts.runContext?.runId,
        });
        throw new WorktrunkInstallDeniedError("worktrunk auto-install blocked by network_api policy");
      }
      if (decision.disposition === "require-approval") {
        const req = await opts.actionGateContext.createApprovalRequest(decision, {
          toolName: "worktrunk_install",
          version: WORKTRUNK_PINNED_RELEASE.version,
        }) as { id: string };
        await opts.actionGateContext.pauseForApproval?.({ approvalRequestId: req.id, decision });
      }
    }
    return;
  }

  const policy = (opts.settings as { defaultAgentPermissionPolicy?: AgentPermissionPolicy }).defaultAgentPermissionPolicy;
  const disposition = policy?.rules.network_api ?? "allow";
  if (disposition === "block") {
    await emitBinaryAudit(opts.auditor, "binary:install-denied", {
      version: WORKTRUNK_PINNED_RELEASE.version,
      reason: "settings:block",
      taskId: opts.runContext?.taskId,
      runId: opts.runContext?.runId,
    });
    throw new WorktrunkInstallDeniedError("worktrunk auto-install blocked by network_api policy");
  }
  if (disposition === "require-approval") {
    await emitBinaryAudit(opts.auditor, "binary:install-denied", {
      version: WORKTRUNK_PINNED_RELEASE.version,
      reason: "settings:require-approval",
      taskId: opts.runContext?.taskId,
      runId: opts.runContext?.runId,
    });
    throw new WorktrunkInstallDeniedError("worktrunk auto-install requires an active session for approval");
  }
}

async function downloadReleaseAsset(url: string, targetPath: string): Promise<string> {
  await assertSafeUrl(url, false);
  const hash = createHash("sha256");

  await new Promise<void>((resolve, reject) => {
    const req = https.get(url, (res) => {
      const statusCode = res.statusCode ?? 0;
      if (statusCode >= 300 && statusCode < 400 && res.headers.location) {
        req.destroy();
        downloadReleaseAsset(new URL(res.headers.location, url).toString(), targetPath).then(() => resolve()).catch(reject);
        return;
      }
      if (statusCode < 200 || statusCode >= 300) {
        reject(new Error(`download failed: ${statusCode}`));
        return;
      }

      let bytes = 0;
      res.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > WORKTRUNK_DOWNLOAD_MAX_BYTES) {
          req.destroy(new Error("download exceeded size cap"));
          return;
        }
        hash.update(chunk);
      });

      pipeline(res, createWriteStream(targetPath)).then(resolve).catch(reject);
    });

    req.setTimeout(WORKTRUNK_DOWNLOAD_TIMEOUT_MS, () => req.destroy(new Error("download timed out")));
    req.on("error", reject);
  });

  return hash.digest("hex");
}

async function extractAsset(archivePath: string, innerBinaryName: string, targetPath: string): Promise<void> {
  if (archivePath.endsWith(".tar.gz")) {
    await execAsync(`tar -xzf "${archivePath}" -O "${innerBinaryName}" > "${targetPath}"`, {
      timeout: WORKTRUNK_PROBE_TIMEOUT_MS,
      maxBuffer: WORKTRUNK_DOWNLOAD_MAX_BYTES,
    });
    return;
  }

  if (archivePath.endsWith(".zip")) {
    await execAsync(`unzip -p "${archivePath}" "${innerBinaryName}" > "${targetPath}"`, {
      timeout: WORKTRUNK_PROBE_TIMEOUT_MS,
      maxBuffer: WORKTRUNK_DOWNLOAD_MAX_BYTES,
    });
    return;
  }

  throw new Error(`unsupported archive format: ${archivePath}`);
}

async function cargoFallback(settings: WorktrunkSettings): Promise<{ binaryPath: string; source: "installed-cargo" }> {
  const cargoPath = await lookupPath("cargo");
  if (!cargoPath) {
    throw new WorktrunkInstallFailedError("cargo is not available", { stage: "cargo-unavailable" });
  }

  await execAsync(`"${cargoPath}" install worktrunk --version ${WORKTRUNK_PINNED_RELEASE.version}`, {
    timeout: WORKTRUNK_CARGO_TIMEOUT_MS,
    maxBuffer: 50 * 1024 * 1024,
  });

  const resolvedPath = await lookupPath("worktrunk") ?? path.join(os.homedir(), ".cargo", "bin", "worktrunk");
  const probe = await probeWorktrunk(resolvedPath);
  if (!probe.ok) {
    throw new WorktrunkInstallFailedError("cargo install succeeded but worktrunk probe failed", {
      stage: "cargo-probe",
      cause: probe.error,
    });
  }
  settings.installedBinaryPath = resolvedPath;
  return { binaryPath: resolvedPath, source: "installed-cargo" };
}

export async function resolveWorktrunkBinary(opts: {
  settings: WorktrunkSettings;
  actionGateContext?: AgentActionGateContext;
  auditor?: RunAuditor;
  runContext?: EngineRunContext;
}): Promise<{ binaryPath: string; source: "override" | "path" | "cached" | "installed-release" | "installed-cargo" }> {
  const { settings } = opts;
  const key = homeKey(settings);
  const cached = resolveCache.get(key);
  if (cached && cached.inputBinaryPath === (settings.binaryPath ?? null)) {
    const probe = await probeWorktrunk(cached.path);
    if (probe.ok) return { binaryPath: cached.path, source: "cached" };
  }

  logger.log("resolve: checking override");
  if (settings.binaryPath) {
    const probe = await probeWorktrunk(settings.binaryPath);
    if (probe.ok) return { binaryPath: settings.binaryPath, source: "override" };
  }

  logger.log("resolve: checking PATH");
  const onPath = await lookupPath("worktrunk");
  if (onPath) {
    const probe = await probeWorktrunk(onPath);
    if (probe.ok) return { binaryPath: onPath, source: "path" };
  }

  logger.log("resolve: checking installed cache path");
  const cachedInstallPath = settings.installedBinaryPath ?? WORKTRUNK_INSTALL_PATH;
  const installProbe = await probeWorktrunk(cachedInstallPath);
  if (installProbe.ok) return { binaryPath: cachedInstallPath, source: "cached" };

  logger.log("resolve: installing worktrunk");
  const installed = await installWorktrunk(opts);
  resolveCache.set(key, {
    inputBinaryPath: settings.binaryPath ?? null,
    path: installed.binaryPath,
    resolvedAt: Date.now(),
  });
  return installed;
}

export async function installWorktrunk(opts: {
  settings: WorktrunkSettings;
  actionGateContext?: AgentActionGateContext;
  auditor?: RunAuditor;
  runContext?: EngineRunContext;
}): Promise<{ binaryPath: string; source: "installed-release" | "installed-cargo" }> {
  const causes: Array<{ stage: string; error: string }> = [];

  await emitBinaryAudit(opts.auditor, "binary:install-requested", {
    version: WORKTRUNK_PINNED_RELEASE.version,
    taskId: opts.runContext?.taskId,
    runId: opts.runContext?.runId,
  });

  await applyInstallGate(opts);

  const platform = detectPlatform();
  if (platform) {
    const asset = WORKTRUNK_PINNED_RELEASE.assets[platform];
    const downloadPath = path.join(WORKTRUNK_INSTALL_DIR, `${asset.archiveName}.download`);
    const extractedPath = path.join(WORKTRUNK_INSTALL_DIR, "worktrunk.tmp");
    try {
      logger.log(`download: ${asset.url}`);
      await fs.mkdir(WORKTRUNK_INSTALL_DIR, { recursive: true });
      const checksum = await downloadReleaseAsset(asset.url, downloadPath);
      logger.log("verify: sha256");
      if (checksum.toLowerCase() !== asset.sha256.toLowerCase()) {
        await fs.rm(downloadPath, { force: true });
        throw new WorktrunkInstallFailedError("sha256 mismatch", {
          stage: "sha256",
          expected: asset.sha256,
          actual: checksum,
        });
      }

      logger.log("extract: archive");
      await extractAsset(downloadPath, asset.innerBinaryName, extractedPath);
      await fs.rm(downloadPath, { force: true });
      await fs.rename(extractedPath, WORKTRUNK_INSTALL_PATH);
      await fs.chmod(WORKTRUNK_INSTALL_PATH, 0o755);

      const probe = await probeWorktrunk(WORKTRUNK_INSTALL_PATH);
      if (!probe.ok) {
        throw new WorktrunkInstallFailedError("release install probe failed", { stage: "probe", cause: probe.error });
      }

      opts.settings.installedBinaryPath = WORKTRUNK_INSTALL_PATH;
      logger.log("success: installed release asset");
      await emitBinaryAudit(opts.auditor, "binary:install-success", {
        version: WORKTRUNK_PINNED_RELEASE.version,
        source: "release",
        sha256: asset.sha256,
        taskId: opts.runContext?.taskId,
        runId: opts.runContext?.runId,
      });
      return { binaryPath: WORKTRUNK_INSTALL_PATH, source: "installed-release" };
    } catch (error) {
      causes.push({ stage: "release", error: error instanceof Error ? error.message : String(error) });
      logger.warn(`failure: release install failed; falling back to cargo (${causes.at(-1)?.error})`);
      await fs.rm(downloadPath, { force: true }).catch(() => undefined);
      await fs.rm(extractedPath, { force: true }).catch(() => undefined);
    }
  } else {
    logger.log("cargo-fallback: no release asset for platform");
    causes.push({ stage: "release", error: "unsupported platform for pinned asset" });
  }

  try {
    const result = await cargoFallback(opts.settings);
    await emitBinaryAudit(opts.auditor, "binary:install-success", {
      version: WORKTRUNK_PINNED_RELEASE.version,
      source: "cargo",
      taskId: opts.runContext?.taskId,
      runId: opts.runContext?.runId,
    });
    return result;
  } catch (error) {
    causes.push({ stage: "cargo", error: error instanceof Error ? error.message : String(error) });
  }

  await emitBinaryAudit(opts.auditor, "binary:install-failed", {
    version: WORKTRUNK_PINNED_RELEASE.version,
    attempted: ["release", "cargo"],
    causes,
    taskId: opts.runContext?.taskId,
    runId: opts.runContext?.runId,
  });

  throw new WorktrunkInstallFailedError("failed to auto-install worktrunk", {
    stage: causes.at(-1)?.stage ?? "unknown",
    attempted: ["release", "cargo"],
    causes,
  });
}

export function clearWorktrunkResolveCache(): void {
  resolveCache.clear();
}
