import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AGENT_LOG_FILENAME, agentRunLogFileName } from "../agents/agent-log-constants.js";
import { agentLogSpillDigest, agentLogSpillReferrerLog, isAgentLogSpillIdentityName } from "../agents/agent-log-detail-spill.js";
import { pruneAgentLogFiles } from "../agents/agent-log-file-store.js";

/*
FNXC:AgentLogDetailSpill 2026-11-06-02:05 (RUFU-340):
One file owns two halves of the reclamation contract, because they are decided by the same pass:
(a) OWNERSHIP — a body is deleted only when the ONE log its producer directory names does not point at it, so a
    run-referenced body survives a task-only prune (PR10's loss), and (b) COST — the pass may not read a log it
    did not have to open, so a steady-state pass costs zero log reads. A test that proved only (a) would pass
    while the pool pass scanned every referrer on every prune.

FNXC:AgentLogDetailSpill 2026-11-06-01:44 (RUFU-340):
Cost is asserted as a COUNT OF LOG READS, never as wall clock — the precedent is the recording `node:fs` wrapper
in `agent-log-file-store.tail-window.test.ts`. Every primitive delegates to the real implementation, so only the
accounting is added, and the counter is armed per case so fixture writes and reads never enter the number.
*/
const reader = vi.hoisted(() => ({ armed: false, readFileSyncCalls: 0, readFileSyncPaths: [] as string[] }));

type FsModule = typeof import("node:fs");

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<FsModule>();
  return {
    ...actual,
    readFileSync: ((...args: unknown[]) => {
      if (reader.armed) {
        reader.readFileSyncCalls += 1;
        reader.readFileSyncPaths.push(String(args[0]));
      }
      return (actual.readFileSync as (...a: unknown[]) => unknown)(...args);
    }) as FsModule["readFileSync"],
  };
});

function measureReads<T>(run: () => T): { result: T; reads: number; paths: string[] } {
  reader.armed = true;
  reader.readFileSyncCalls = 0;
  reader.readFileSyncPaths = [];
  try {
    return { result: run(), reads: reader.readFileSyncCalls, paths: [...reader.readFileSyncPaths] };
  } finally {
    reader.armed = false;
  }
}

/*
FNXC:AgentLogDetailSpill 2026-11-06-00:46 (RUFU-340):
Reclaim is the half of this card that can destroy data, so every case below states which log the pass examined
and what that log said. The invariant under test is narrower than "delete orphans": a pass may delete a body ONLY
when it read the log that references it and that log did not name it. A pass that skipped a directory because it
is young, or that could not read a referrer, must leave every byte standing.
*/

const DAY_MS = 86_400_000;
const BODY = "rozhodnutie karty — casova peciatka, ktoru nesmieme stratit";
const RETENTION_DAYS = 7;

/*
FNXC:AgentLogDetailSpill 2026-11-06-03:02 (RUFU-340):
Code Review caught that these fixtures backdated only the PRODUCER DIRECTORY, which was exactly the premise the
reclaimer used to justify a deletion — so the pass deleted bodies whose own mtime was fresh and the suite pinned
that as correct. The deletion bound is per FILE, so a fixture that wants a body to be reclaimable has to age the
BODY. `ageFile` is that statement, and every fixture below that expects a deletion now says it.
*/
function ageFile(path: string): void {
  const aged = new Date(Date.now() - 30 * DAY_MS);
  utimesSync(path, aged, aged);
}

let baseDir = "";
let tasksDir = "";
let agentsDir = "";

function row(overrides: Record<string, unknown>): string {
  return JSON.stringify({ taskId: "RUFU-340", text: "bash", type: "tool_result", detail: "prefix", ...overrides });
}

function pointerFor(bodyPath: string, text = BODY): Record<string, unknown> {
  return { detailSpill: { body: bodyPath, digest: agentLogSpillDigest(text), chars: text.length, bytes: Buffer.byteLength(text, "utf8") } };
}

/** Writes a task log and returns the producer directory its pointers address. */
function taskProducer(taskId: string, lines: string[]): { logPath: string; dir: string; bodyPath: string } {
  const taskDir = join(tasksDir, taskId);
  mkdirSync(taskDir, { recursive: true });
  const dir = join(baseDir, "agent-log-detail-spill", "task", taskId);
  mkdirSync(dir, { recursive: true });
  const bodyPath = join(dir, `${agentLogSpillDigest(BODY)}.txt`);
  writeFileSync(bodyPath, BODY, "utf8");
  ageFile(bodyPath);
  const logPath = join(taskDir, AGENT_LOG_FILENAME);
  if (lines.length > 0) writeFileSync(logPath, lines.join("\n") + "\n", "utf8");
  // Directory mtimes are the prefilter's only signal, so the fixture owns them explicitly.
  utimesSync(dir, new Date(Date.now() - 30 * DAY_MS), new Date(Date.now() - 30 * DAY_MS));
  return { logPath, dir, bodyPath };
}

function runProducer(agentId: string, runId: string, lines: string[]): { logPath: string; dir: string; bodyPath: string } {
  mkdirSync(agentsDir, { recursive: true });
  const dir = join(baseDir, "agent-log-detail-spill", "run", agentId, runId);
  mkdirSync(dir, { recursive: true });
  const bodyPath = join(dir, `${agentLogSpillDigest(BODY)}.txt`);
  writeFileSync(bodyPath, BODY, "utf8");
  ageFile(bodyPath);
  const logPath = join(agentsDir, agentRunLogFileName(agentId, runId));
  if (lines.length > 0) writeFileSync(logPath, lines.join("\n") + "\n", "utf8");
  utimesSync(dir, new Date(Date.now() - 30 * DAY_MS), new Date(Date.now() - 30 * DAY_MS));
  return { logPath, dir, bodyPath };
}

const oldStamp = new Date(Date.now() - 30 * DAY_MS).toISOString();
const freshStamp = new Date().toISOString();

/** A second payload, so one producer directory can hold a referenced and an unreferenced body at once. */
const SECOND_BODY = "druha pristohlaska, ktoru ziadny riadok nevytvara";

/** Creates a producer directory (no referrer log) and returns the body path inside it. */
function spillBody(family: "task" | "run", identity: string[], aged = true): string {
  const dir = join(baseDir, "agent-log-detail-spill", family, ...identity);
  mkdirSync(dir, { recursive: true });
  const bodyPath = join(dir, `${agentLogSpillDigest(BODY)}.txt`);
  writeFileSync(bodyPath, BODY, "utf8");
  // A directory left alone is YOUNG (its mtime is the moment it was made), which is the prefilter's skip case.
  if (aged) {
    ageFile(bodyPath);
    utimesSync(dir, new Date(Date.now() - 30 * DAY_MS), new Date(Date.now() - 30 * DAY_MS));
  }
  return bodyPath;
}

/**
 * An aged run producer holding TWO bodies: its run log names exactly one of them, so the pass has to read the
 * log once and use that single read for both verdicts.
 */
function agedRunProducer(agentId: string, runId: string): { dir: string; logPath: string } {
  const dir = join(baseDir, "agent-log-detail-spill", "run", agentId, runId);
  mkdirSync(dir, { recursive: true });
  const kept = join(dir, `${agentLogSpillDigest(BODY)}.txt`);
  const orphan = join(dir, `${agentLogSpillDigest(SECOND_BODY)}.txt`);
  writeFileSync(kept, BODY, "utf8");
  writeFileSync(orphan, SECOND_BODY, "utf8");
  // Both bodies are aged: the verdict that keeps `kept` is the reference set, not its stamp, and the orphan is
  // only reclaimable because its OWN mtime is past the horizon.
  ageFile(kept);
  ageFile(orphan);
  const logPath = join(agentsDir, agentRunLogFileName(agentId, runId));
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(logPath, row({ timestamp: freshStamp, ...pointerFor(kept) }) + "\n", "utf8");
  utimesSync(dir, new Date(Date.now() - 30 * DAY_MS), new Date(Date.now() - 30 * DAY_MS));
  return { dir, logPath };
}

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), "rufu340-reclaim-"));
  tasksDir = join(baseDir, "tasks");
  agentsDir = join(baseDir, "agents");
  mkdirSync(tasksDir, { recursive: true });
});

afterEach(() => {
  rmSync(baseDir, { recursive: true, force: true });
});

describe("reclaiming spill bodies during a prune pass: ownership and read cost", () => {
  it("keeps a body a surviving row still points at and drops one whose pointing row aged out", () => {
    const kept = taskProducer("FN-KEEP", [row({ timestamp: freshStamp, ...pointerFor(join(baseDir, "agent-log-detail-spill", "task", "FN-KEEP", `${agentLogSpillDigest(BODY)}.txt`)) })]);
    const gone = taskProducer("FN-GONE", [row({ timestamp: oldStamp, ...pointerFor(join(baseDir, "agent-log-detail-spill", "task", "FN-GONE", `${agentLogSpillDigest(BODY)}.txt`)) })]);

    const result = pruneAgentLogFiles(tasksDir, RETENTION_DAYS);

    expect(result.prunedEntries).toBe(1);
    expect(existsSync(kept.bodyPath)).toBe(true);
    expect(existsSync(gone.bodyPath)).toBe(false);
    expect(result.spillBodiesDeleted).toBe(1);
    expect(result.spillBytesFreed).toBe(Buffer.byteLength(BODY, "utf8"));
  });

  it("deletes the body of a task whose whole log was pruned away, because a missing log references nothing", () => {
    const producer = taskProducer("FN-EMPTY", [row({ timestamp: oldStamp, ...pointerFor(join(baseDir, "agent-log-detail-spill", "task", "FN-EMPTY", `${agentLogSpillDigest(BODY)}.txt`)) })]);

    const result = pruneAgentLogFiles(tasksDir, RETENTION_DAYS);

    expect(result.prunedFiles).toBe(1);
    expect(existsSync(producer.logPath)).toBe(false);
    expect(existsSync(producer.bodyPath)).toBe(false);
    expect(result.spillDirsRemoved).toBe(1);
  });

  it("leaves a run-family body alone when the run log that references it survived a task-only prune", () => {
    const task = taskProducer("FN-TASK", [row({ timestamp: oldStamp, ...pointerFor(join(baseDir, "agent-log-detail-spill", "task", "FN-TASK", `${agentLogSpillDigest(BODY)}.txt`)) })]);
    const run = runProducer("agent-x", "run-1", [row({ timestamp: freshStamp, ...pointerFor(join(baseDir, "agent-log-detail-spill", "run", "agent-x", "run-1", `${agentLogSpillDigest(BODY)}.txt`)) })]);

    const result = pruneAgentLogFiles(tasksDir, RETENTION_DAYS);

    expect(existsSync(task.bodyPath)).toBe(false);
    expect(existsSync(run.bodyPath)).toBe(true);
    expect(result.spillDirsExamined).toBe(2);
  });

  it("deletes an unreferenced run body once its own run log is gone", () => {
    const run = runProducer("agent-y", "run-9", []);

    pruneAgentLogFiles(tasksDir, RETENTION_DAYS);

    expect(existsSync(run.logPath)).toBe(false);
    expect(existsSync(run.bodyPath)).toBe(false);
  });

  it("skips a producer directory younger than the retention window without reading anything", () => {
    const young = join(baseDir, "agent-log-detail-spill", "task", "FN-YOUNG");
    mkdirSync(young, { recursive: true });
    const bodyPath = join(young, `${agentLogSpillDigest(BODY)}.txt`);
    writeFileSync(bodyPath, BODY, "utf8");
    // No task log references it, and the directory is fresh: the bound, not the reference set, decides.
    expect(pruneAgentLogFiles(tasksDir, RETENTION_DAYS).spillDirsExamined).toBe(0);
    expect(existsSync(bodyPath)).toBe(true);
  });

  it("fails closed when the referrer exists but cannot be read", () => {
    const dir = join(baseDir, "agent-log-detail-spill", "task", "FN-BLOCKED");
    mkdirSync(dir, { recursive: true });
    const bodyPath = join(dir, `${agentLogSpillDigest(BODY)}.txt`);
    writeFileSync(bodyPath, BODY, "utf8");
    // A directory where the log file belongs: exists() says yes, readFileSync raises EISDIR.
    mkdirSync(join(tasksDir, "FN-BLOCKED", AGENT_LOG_FILENAME), { recursive: true });
    utimesSync(dir, new Date(Date.now() - 30 * DAY_MS), new Date(Date.now() - 30 * DAY_MS));

    const result = pruneAgentLogFiles(tasksDir, RETENTION_DAYS);

    expect(result.spillDirsExamined).toBe(1);
    expect(result.spillBodiesDeleted).toBe(0);
    expect(existsSync(bodyPath)).toBe(true);
  });

  it("honours scanTaskIds for the task family while still sweeping run producers", () => {
    const scanned = taskProducer("FN-SCANNED", [row({ timestamp: oldStamp, ...pointerFor(join(baseDir, "agent-log-detail-spill", "task", "FN-SCANNED", `${agentLogSpillDigest(BODY)}.txt`)) })]);
    const skipped = taskProducer("FN-OUTSIDE", [row({ timestamp: oldStamp, ...pointerFor(join(baseDir, "agent-log-detail-spill", "task", "FN-OUTSIDE", `${agentLogSpillDigest(BODY)}.txt`)) })]);
    const run = runProducer("agent-z", "run-2", []);

    pruneAgentLogFiles(tasksDir, RETENTION_DAYS, new Set(["FN-SCANNED"]));

    expect(existsSync(scanned.bodyPath)).toBe(false);
    // Its log was never re-read, so this pass never learned what still references that body.
    expect(existsSync(skipped.bodyPath)).toBe(true);
    expect(existsSync(run.bodyPath)).toBe(false);
  });

  it("collects an aged publish leftover but leaves one still inside the window", () => {
    const dir = join(baseDir, "agent-log-detail-spill", "task", "FN-PARTIAL");
    mkdirSync(dir, { recursive: true });
    const aged = join(dir, `${agentLogSpillDigest("stara")}.1234.abc.partial`);
    const fresh = join(dir, `${agentLogSpillDigest("novy")}.1234.def.partial`);
    writeFileSync(aged, "polovicna", "utf8");
    writeFileSync(fresh, "prave prebiehajuca", "utf8");
    utimesSync(aged, new Date(Date.now() - 30 * DAY_MS), new Date(Date.now() - 30 * DAY_MS));
    utimesSync(dir, new Date(Date.now() - 30 * DAY_MS), new Date(Date.now() - 30 * DAY_MS));

    pruneAgentLogFiles(tasksDir, RETENTION_DAYS);

    expect(existsSync(aged)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });

  it("leaves a pool that has never been created alone and reports nothing", () => {
    mkdirSync(join(tasksDir, "FN-NOPOOL"), { recursive: true });
    writeFileSync(join(tasksDir, "FN-NOPOOL", AGENT_LOG_FILENAME), row({ timestamp: oldStamp }) + "\n", "utf8");

    const result = pruneAgentLogFiles(tasksDir, RETENTION_DAYS);

    expect(result.spillDirsExamined).toBe(0);
    expect(result.spillBodiesDeleted).toBe(0);
    expect(existsSync(join(baseDir, "agent-log-detail-spill"))).toBe(false);
  });

  // ---------------------------------------------------------------- cost bound (counted reads, never timing)

  it("opens ZERO log files when every producer directory is younger than the retention window", () => {
    // No task directory exists at all, so every read the pass performs belongs to the reclaim sweep.
    const taskBody = spillBody("task", ["FN-FUTURE"], false);
    const runBody = spillBody("run", ["agent-fresh", "run-1"], false);

    const { result, reads } = measureReads(() => pruneAgentLogFiles(tasksDir, RETENTION_DAYS));

    // The prefilter is the only reason: nothing was read, therefore nothing could be proven unreferenced.
    expect(reads).toBe(0);
    expect(result.spillDirsExamined).toBe(0);
    expect(result.spillBodiesDeleted).toBe(0);
    expect(existsSync(taskBody)).toBe(true);
    expect(existsSync(runBody)).toBe(true);
  });

  it("reads at most one referrer log per aged producer directory, never one per body", () => {
    const first = agedRunProducer("agent-a", "run-1");
    const second = agedRunProducer("agent-b", "run-2");

    const { result, reads, paths } = measureReads(() => pruneAgentLogFiles(tasksDir, RETENTION_DAYS));

    // Two aged directories, four bodies (two per directory), exactly two reads: the bound is per directory.
    expect(reads).toBe(2);
    expect(paths.sort()).toEqual([first.logPath, second.logPath].sort());
    expect(result.spillDirsExamined).toBe(2);
    // Each directory keeps the body its own log names and loses the one it does not.
    expect(result.spillBodiesDeleted).toBe(2);
    expect(existsSync(join(first.dir, `${agentLogSpillDigest(BODY)}.txt`))).toBe(true);
    expect(existsSync(join(first.dir, `${agentLogSpillDigest(SECOND_BODY)}.txt`))).toBe(false);
    expect(existsSync(join(second.dir, `${agentLogSpillDigest(BODY)}.txt`))).toBe(true);
    expect(existsSync(join(second.dir, `${agentLogSpillDigest(SECOND_BODY)}.txt`))).toBe(false);
  });

  // ------------------------------------------------------- fail-closed on an unresolvable identity

  it("skips an aged producer whose name cannot name one identity, leaving its bytes standing", () => {
    // A backslash is a legal Linux file character and a path separator on Windows, so a producer carrying one
    // has no trustworthy single-segment identity: the pass must neither resolve it nor delete from it.
    const dir = join(baseDir, "agent-log-detail-spill", "task", "FN\u005cWILD");
    mkdirSync(dir, { recursive: true });
    const bodyPath = join(dir, `${agentLogSpillDigest(BODY)}.txt`);
    writeFileSync(bodyPath, BODY, "utf8");
    utimesSync(dir, new Date(Date.now() - 30 * DAY_MS), new Date(Date.now() - 30 * DAY_MS));

    const result = pruneAgentLogFiles(tasksDir, RETENTION_DAYS);

    // No identity, therefore no referrer, therefore no evidence — and no deletion, which is the point.
    expect(result.spillDirsExamined).toBe(0);
    expect(result.spillBodiesDeleted).toBe(0);
    expect(existsSync(bodyPath)).toBe(true);
  });

  it("never resolves a producer referrer outside the log families it owns", () => {
    // The predicate is what keeps `join(baseDir, "tasks", <name>)` inside the task tree.
    expect(isAgentLogSpillIdentityName("FN-1")).toBe(true);
    expect(isAgentLogSpillIdentityName("agent-5173bbf9")).toBe(true);
    expect(isAgentLogSpillIdentityName("..")).toBe(false);
    expect(isAgentLogSpillIdentityName(".")).toBe(false);
    expect(isAgentLogSpillIdentityName("")).toBe(false);
    expect(isAgentLogSpillIdentityName("a/b")).toBe(false);
    expect(isAgentLogSpillIdentityName("a\\b")).toBe(false);
    expect(isAgentLogSpillIdentityName("a\0b")).toBe(false);
    // A producer whose identity is unresolvable yields no referrer at all, so the pass cannot read anything.
    expect(agentLogSpillReferrerLog(baseDir, { dir: join(baseDir, "pool"), family: "task", mtimeMs: 0 })).toBeNull();
    expect(agentLogSpillReferrerLog(baseDir, { dir: join(baseDir, "pool"), family: "run", agentId: "a", mtimeMs: 0 })).toBeNull();
  });

  it("does not follow a symlinked producer directory out of the pool", () => {
    // The escaping shape reachable on a real filesystem: a pool entry that is a link, not a directory.
    const outside = mkdtempSync(join(tmpdir(), "rufu340-outside-"));
    try {
      const target = join(outside, "elsewhere");
      mkdirSync(target, { recursive: true });
      const bodyPath = join(target, `${agentLogSpillDigest(BODY)}.txt`);
      writeFileSync(bodyPath, BODY, "utf8");
      utimesSync(target, new Date(Date.now() - 30 * DAY_MS), new Date(Date.now() - 30 * DAY_MS));
      mkdirSync(join(baseDir, "agent-log-detail-spill", "task"), { recursive: true });
      symlinkSync(target, join(baseDir, "agent-log-detail-spill", "task", "FN-LINKED"));

      const result = pruneAgentLogFiles(tasksDir, RETENTION_DAYS);

      // A link is not a directory entry, so it is never enumerated, never resolved, and never deleted from.
      expect(result.spillDirsExamined).toBe(0);
      expect(result.spillBodiesDeleted).toBe(0);
      expect(existsSync(bodyPath)).toBe(true);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("leaves stray pool files that no producer level can name untouched", () => {
    // Bodies sitting at the wrong depth (a hand-placed file, or an older layout) address nothing; deleting them
    // would be a verdict the pass has no referrer to justify it with.
    const familyRoot = join(baseDir, "agent-log-detail-spill", "task");
    const agentRoot = join(baseDir, "agent-log-detail-spill", "run", "agent-orphan");
    mkdirSync(familyRoot, { recursive: true });
    mkdirSync(agentRoot, { recursive: true });
    const atFamilyRoot = join(familyRoot, `${agentLogSpillDigest(BODY)}.txt`);
    const atAgentLevel = join(agentRoot, `${agentLogSpillDigest(SECOND_BODY)}.txt`);
    writeFileSync(atFamilyRoot, BODY, "utf8");
    writeFileSync(atAgentLevel, SECOND_BODY, "utf8");
    utimesSync(familyRoot, new Date(Date.now() - 30 * DAY_MS), new Date(Date.now() - 30 * DAY_MS));
    utimesSync(agentRoot, new Date(Date.now() - 30 * DAY_MS), new Date(Date.now() - 30 * DAY_MS));

    const result = pruneAgentLogFiles(tasksDir, RETENTION_DAYS);

    expect(result.spillDirsExamined).toBe(0);
    expect(result.spillBodiesDeleted).toBe(0);
    expect(existsSync(atFamilyRoot)).toBe(true);
    expect(existsSync(atAgentLevel)).toBe(true);
  });
});

/*
FNXC:AgentLogDetailSpill 2026-11-06-03:02 (RUFU-340):
The two clauses Code Review proved the first cut of this pass violated. Both destroy evidence the same way — by
treating a premise that belongs to ONE PROCESS (a directory stamp, a path string) as if it identified a FILE — and
neither was visible to a fixture that only ever backdated a directory.
*/
describe("the per-file deletion bound and the digest-keyed reference set", () => {
  it("spares a young body published into a directory whose captured stamp is already aged", () => {
    /*
     * The cross-process shape this bound exists for: `listAgentLogSpillProducerDirs` captured this directory's mtime
     * as aged BEFORE the deletion loop, while a different process — the engine or pi-CLI appending into the same
     * pool the dashboard's maintenance pass is sweeping — was still spilling into it. A resumed task or a long-lived
     * run looks exactly like this: the row was written moments ago, so its body is young. Decision 11's protection
     * ("a body written for a row still in the buffer cannot be a candidate") is only real when the stamp that
     * licenses deletion is the file's own.
     */
    const dir = join(baseDir, "agent-log-detail-spill", "task", "FN-RESUMED");
    mkdirSync(dir, { recursive: true });
    const youngBody = join(dir, `${agentLogSpillDigest(BODY)}.txt`);
    writeFileSync(youngBody, BODY, "utf8");
    utimesSync(dir, new Date(Date.now() - 30 * DAY_MS), new Date(Date.now() - 30 * DAY_MS));
    // Its log names a DIFFERENT payload, so the reference set alone would condemn the young body.
    const taskDir = join(tasksDir, "FN-RESUMED");
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(
      join(taskDir, AGENT_LOG_FILENAME),
      row({ timestamp: freshStamp, ...pointerFor(join(dir, `${agentLogSpillDigest(SECOND_BODY)}.txt`), SECOND_BODY) }) + "\n",
      "utf8",
    );

    const result = pruneAgentLogFiles(tasksDir, RETENTION_DAYS);

    // The directory WAS examined — the per-file bound spared the body, the prefilter did not skip the work.
    expect(result.spillDirsExamined).toBe(1);
    expect(result.spillBodiesDeleted).toBe(0);
    expect(existsSync(youngBody)).toBe(true);
    expect(readFileSync(youngBody, "utf8")).toBe(BODY);
  });

  it("keeps a referenced body when the reclaiming process spells the pool root differently", () => {
    /*
     * The writer stored an absolute `detailSpill.body` under the real root, while this pass reclaims through a
     * symlink onto that same root (the macOS `/private/var` class this repo already had to realpath at both ends in
     * `register-git-github.ts` and `agent-cwd-policy.ts`). A reference set keyed on `resolve()`d paths kept the two
     * spellings apart, so EVERY body in the pool read as unreferenced and an aged pass unlinked live evidence. A
     * digest is content, so it survives any spelling of the root.
     */
    const aliasRoot = mkdtempSync(join(tmpdir(), "rufu340-alias-"));
    const alias = join(aliasRoot, "project");
    try {
      symlinkSync(baseDir, alias);
      const producer = taskProducer("FN-ALIASED", [
        row({ timestamp: freshStamp, ...pointerFor(join(baseDir, "agent-log-detail-spill", "task", "FN-ALIASED", `${agentLogSpillDigest(BODY)}.txt`)) }),
      ]);

      const result = pruneAgentLogFiles(join(alias, "tasks"), RETENTION_DAYS);

      expect(result.spillBodiesDeleted).toBe(0);
      expect(existsSync(producer.bodyPath)).toBe(true);
      // And it still resolves: the surviving bytes hash back to the digest its row recorded.
      expect(agentLogSpillDigest(readFileSync(producer.bodyPath, "utf8"))).toBe(agentLogSpillDigest(BODY));
    } finally {
      rmSync(alias, { force: true });
      rmSync(aliasRoot, { recursive: true, force: true });
    }
  });
});
