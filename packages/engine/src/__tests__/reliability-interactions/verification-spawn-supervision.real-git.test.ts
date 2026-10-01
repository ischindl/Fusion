import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = resolve(process.cwd(), "..", "..");
const fixturePath = join(repoRoot, "packages", "core", "src", "__tests__", "fixtures", "process-supervisor-child.mjs");

type Scenario = "clean-exit" | "sigterm" | "uncaught-exception";

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ESRCH") {
      return false;
    }
    throw error;
  }
}

async function waitForDead(pid: number, timeoutMs = 10_000): Promise<void> {
  const startedAt = Date.now();
  while (isAlive(pid)) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`Timed out waiting for supervised child ${pid} to exit`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function buildParentScript(scenario: Scenario): string {
  return `
    import { superviseSpawn } from "./packages/core/src/index.ts";
    const child = superviseSpawn(process.execPath, [${JSON.stringify(fixturePath)}, "keepalive"], {
      stdio: "ignore",
      killGraceMs: 50,
      maxLifetimeMs: 500,
    });
    await new Promise((resolve) => process.stdout.write(String(child.pid) + "\\n", resolve));
    if (${JSON.stringify(scenario)} === "clean-exit") {
      process.exit(0);
    } else if (${JSON.stringify(scenario)} === "sigterm") {
      process.on("SIGTERM", () => process.exit(0));
      setInterval(() => {}, 1_000);
    } else {
      setTimeout(() => {
        throw new Error("FN-5189 uncaught parent failure");
      }, 10);
      setInterval(() => {}, 1_000);
    }
  `;
}

async function spawnParent(scenario: Scenario): Promise<{ parent: ReturnType<typeof spawn>; childPid: number }> {
  const parent = spawn(process.execPath, ["--import", "tsx/esm", "--input-type=module", "--eval", buildParentScript(scenario)], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  parent.stdout?.on("data", (chunk: Buffer | string) => {
    stdout += chunk.toString();
  });

  const childPid = await new Promise<number>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Timed out waiting for supervised child pid from scenario ${scenario}`));
    }, 15_000);

    const onData = (chunk: Buffer | string) => {
      stdout += chunk.toString();
      const pid = Number.parseInt(stdout.trim().split(/\s+/)[0] ?? "", 10);
      if (!Number.isFinite(pid)) {
        return;
      }
      clearTimeout(timeout);
      parent.stdout?.off("data", onData);
      resolve(pid);
    };

    parent.stdout?.on("data", onData);
    parent.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    parent.once("exit", (code, signal) => {
      if (!Number.isFinite(Number.parseInt(stdout.trim().split(/\s+/)[0] ?? "", 10))) {
        clearTimeout(timeout);
        reject(new Error(`Parent exited before printing child pid (code=${code} signal=${signal})`));
      }
    });
  });

  return { parent, childPid };
}

describe("reliability interactions: FN-5189 verification spawn supervision", () => {
  const spawnedParents = new Set<ReturnType<typeof spawn>>();

  afterEach(async () => {
    for (const parent of spawnedParents) {
      if (parent.exitCode === null && parent.signalCode === null) {
        // Register the exit listener BEFORE kill so we don't miss the
        // event and deadlock.
        const exited = once(parent, "exit");
        try {
          parent.kill("SIGKILL");
        } catch {
          // ignore cleanup failures
        }
        await exited.catch(() => {});
      }
    }
    spawnedParents.clear();
  });

  const caseIt = process.platform === "win32" ? it.skip : it;

  caseIt.each([
    // Cover all parent teardown surfaces from FN-5893: normal exit, signal-driven exit,
    // and crash exit should all reap the supervised keepalive child within the guard window.
    ["clean-exit"],
    ["sigterm"],
    ["uncaught-exception"],
  ] satisfies [Scenario][]) ("reaps supervised child after parent %s", async (scenario) => {
    const { parent, childPid } = await spawnParent(scenario);
    spawnedParents.add(parent);

    if (scenario === "sigterm") {
      parent.kill("SIGTERM");
    }

    await once(parent, "exit");
    await waitForDead(childPid);

    expect(isAlive(childPid)).toBe(false);
  });
});

/*
FNXC:VerificationResourceBound 2026-09-10-12:13 (RUFU-212 Step 4):
Scope-termination proof at the REAL supervision seam. The risk of wrapping a verification
spawn in `systemd-run --user --scope` is turning the tracked child into an immortal grandchild
inside a lingering scope: the supervisor's negative-pgid kill (`process.kill(-pgid)`) must still
reach the whole payload tree. These cases run the real `superviseSpawn` and the real bound
wrapper module against a FAKE `systemd-run` placed on PATH (it records its argv, then `exec`s
the payload so pid/pgid semantics match real `--scope` behavior — no fork, no new session — and
the fake also answers the module's capability probe with exit 0 exactly like a real systemd
user manager would). The payload is `sleep 310 & echo $! > <pidfile>; sleep 311; wait`, so the
supervised pid and the recorded grandchild pid must BOTH die when the supervisor escalates
(maxLifetime SIGTERM→SIGKILL) or when the parent exits under SIGTERM (FN-5189 guard kill).
A wrapper that escapes the process group leaves both sleeps running and the test goes red.
*/
type ScopeScenario = "lifetime-timeout" | "abort-sigterm";

function buildScopeWrappedParentScript(scenario: ScopeScenario, pidfilePath: string): string {
  const payload = `sleep 310 & echo $! > ${JSON.stringify(pidfilePath)}; sleep 311; wait`;
  return `
    import { superviseSpawn } from "./packages/core/src/index.ts";
    import { applyVerificationResourceBound } from "./packages/engine/src/execution/verification-resource-bound.ts";
    const applied = await applyVerificationResourceBound({
      command: ${JSON.stringify(payload)},
      settings: { cpuQuotaPercent: 600, cpuIoWeight: 10, memoryMaxMb: 512 },
      lane: "tool",
    });
    if (applied.rung !== "scope") {
      process.stderr.write("RUNG_NOT_SCOPE=" + applied.rung + "\\n");
      process.exit(3);
    }
    const child = superviseSpawn(applied.command, [], {
      shell: true,
      stdio: "ignore",
      killGraceMs: 100,
      ${scenario === "lifetime-timeout" ? "maxLifetimeMs: 600," : ""}
    });
    await new Promise((resolve) => process.stdout.write(String(child.pid) + "\\n", resolve));
    ${scenario === "abort-sigterm" ? "process.on(\"SIGTERM\", () => process.exit(0));" : ""}
    await child.waitExit();
    process.exit(0);
  `;
}

async function makeFakeSystemdRun(): Promise<{ binDir: string; capturePath: string; tmpDir: string }> {
  const tmpDir = await mkdtemp(join(tmpdir(), "rufu212-scope-"));
  const binDir = join(tmpDir, "bin");
  await mkdir(binDir, { recursive: true });
  const capturePath = join(tmpDir, "capture.log");
  const script = [
    "#!/bin/sh",
    "# RUFU-212 fake systemd-run: record argv, then exec the payload under the SAME pid/pgid.",
    'printf \'%s\\n\' "$*" >> "$FAKE_SYSTEMD_RUN_CAPTURE"',
    "while [ $# -gt 0 ]; do",
    "  case \"$1\" in",
    "    --user|--scope) shift ;;",
    "    -p) shift 2 ;;",
    "    *) break ;;",
    "  esac",
    "done",
    'exec "$@"',
    "",
  ].join("\n");
  await writeFile(join(binDir, "systemd-run"), script, { mode: 0o755 });
  return { binDir, capturePath, tmpDir };
}

async function readPidfile(path: string, timeoutMs = 10_000): Promise<number> {
  const startedAt = Date.now();
  for (;;) {
    try {
      const pid = Number.parseInt((await readFile(path, "utf8")).trim(), 10);
      if (Number.isFinite(pid)) return pid;
    } catch {
      // Payload has not reached the pidfile write yet.
    }
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`Timed out waiting for wrapped grandchild pidfile ${path}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe("reliability interactions: RUFU-212 resource-bound scope termination", () => {
  const spawnedParents = new Set<ReturnType<typeof spawn>>();
  const trackedChildPids: number[] = [];
  let fixture: { binDir: string; capturePath: string; tmpDir: string } | undefined;

  afterEach(async () => {
    for (const parent of spawnedParents) {
      if (parent.exitCode === null && parent.signalCode === null) {
        const exited = once(parent, "exit");
        try {
          parent.kill("SIGKILL");
        } catch {
          // ignore cleanup failures
        }
        await exited.catch(() => {});
      }
    }
    spawnedParents.clear();
    // Best-effort group cleanup so a FAILED assertion here never leaves 310-second sleeps
    // running: the supervised child is a detached group leader, so -pid is a safe target
    // (never the vitest worker's own group).
    for (const pid of trackedChildPids) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        // group already gone
      }
    }
    trackedChildPids.length = 0;
    if (fixture) {
      await rm(fixture.tmpDir, { recursive: true, force: true }).catch(() => {});
      fixture = undefined;
    }
  });

  const scopeIt = process.platform === "win32" ? it.skip : it;

  async function spawnScopeWrappedParent(scenario: ScopeScenario): Promise<{
    parent: ReturnType<typeof spawn>;
    childPid: number;
    stderrText: () => string;
  }> {
    fixture = await makeFakeSystemdRun();
    const pidfilePath = join(fixture.tmpDir, "grandchild.pid");
    const script = buildScopeWrappedParentScript(scenario, pidfilePath);
    const parent = spawn(process.execPath, ["--import", "tsx/esm", "--input-type=module", "--eval", script], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        PATH: `${fixture.binDir}:${process.env.PATH ?? ""}`,
        FAKE_SYSTEMD_RUN_CAPTURE: fixture.capturePath,
      },
    });
    spawnedParents.add(parent);

    let stdout = "";
    let stderr = "";
    parent.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    const childPid = await new Promise<number>((resolvePromise, rejectPromise) => {
      const timeout = setTimeout(() => {
        rejectPromise(new Error(`Timed out waiting for wrapped child pid (${scenario}); stderr: ${stderr}`));
      }, 20_000);
      const onData = (chunk: Buffer | string) => {
        stdout += chunk.toString();
        const pid = Number.parseInt(stdout.trim().split(/\s+/)[0] ?? "", 10);
        if (!Number.isFinite(pid)) return;
        clearTimeout(timeout);
        parent.stdout?.off("data", onData);
        resolvePromise(pid);
      };
      parent.stdout?.on("data", onData);
      parent.once("error", (error) => {
        clearTimeout(timeout);
        rejectPromise(error);
      });
      parent.once("exit", (code, signal) => {
        if (!Number.isFinite(Number.parseInt(stdout.trim().split(/\s+/)[0] ?? "", 10))) {
          clearTimeout(timeout);
          rejectPromise(new Error(`Parent exited before printing wrapped child pid (code=${code} signal=${signal}); stderr: ${stderr}`));
        }
      });
    });
    trackedChildPids.push(childPid);

    return { parent, childPid, stderrText: () => stderr };
  }

  scopeIt("lifetime timeout through the scope wrapper kills supervised pid AND wrapped grandchild", async () => {
    const { parent, childPid, stderrText } = await spawnScopeWrappedParent("lifetime-timeout");
    const grandchildPid = await readPidfile(join(fixture!.tmpDir, "grandchild.pid"));

    await once(parent, "exit");
    expect(parent.exitCode).toBe(0);
    await waitForDead(childPid);
    await waitForDead(grandchildPid);

    const capture = await readFile(fixture!.capturePath, "utf8");
    // Capability probe ran through the wrapper (fake accepted the scope probe exactly like a
    // real systemd user manager would), and the REAL payload launched under the scope options.
    expect(capture).toContain("CPUQuota=100%");
    expect(capture).toContain("--scope");
    expect(capture).toContain("CPUQuota=600%");
    expect(capture).toContain("MemoryMax=512M");
    expect(capture).toContain("sleep 311");
    expect(isAlive(grandchildPid), `immortal wrapped grandchild survived the scope kill; stderr: ${stderrText()}`).toBe(false);
  }, 60_000);

  scopeIt("parent abort through the scope wrapper kills supervised pid AND wrapped grandchild", async () => {
    const { parent, childPid } = await spawnScopeWrappedParent("abort-sigterm");
    const grandchildPid = await readPidfile(join(fixture!.tmpDir, "grandchild.pid"));

    // The abort shape: SIGTERM the parent; its handler exits 0 and the FN-5189 registry
    // guard reaps the still-running wrapped child tree by process group.
    parent.kill("SIGTERM");
    await once(parent, "exit");
    await waitForDead(childPid);
    await waitForDead(grandchildPid);

    expect(isAlive(childPid)).toBe(false);
    expect(isAlive(grandchildPid)).toBe(false);
  }, 60_000);
});
