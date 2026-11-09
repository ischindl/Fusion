/**
 * Out-of-line spill for oversized agent-log tool `detail`.
 *
 * FNXC:AgentLogDetailSpill 2026-11-06-00:46 (RUFU-340):
 * Before this module the storage layer destroyed tool payloads: `truncateAgentLogDetail` cut `detail` at
 * `AGENT_LOG_TOOL_DETAIL_LIMIT` code units and pasted the literal notice
 * `[tool output truncated to keep dashboard log views responsive]` into the persisted row — on the write
 * path AND on the read path — so the excess existed in no copy, and a coordinator's report lost whole
 * sections (measured on saneca SANE-435, where the only statement of a blocking A/B decision died that way
 * and the CEO had to rule on a reconstruction). A dashboard *render* concern had been applied to *storage*.
 *
 * The bound survives — a JSONL row must not grow with a payload, and one log write must not materialize a
 * multi-megabyte string — but it is now a storage bound with an escape hatch instead of a lossy cut:
 * the row keeps a bounded inline prefix of the redacted detail plus a pointer, and the complete bytes go to
 * ONE content-addressed file that the row addresses by their digest.
 *
 * Three properties every caller depends on:
 *
 * 1. EMIT EQUALS PERSISTED. Resolution runs synchronously at each durable sink's own entry point, BEFORE
 *    the row is buffered, appended, or emitted, so the frame a subscriber receives is the row on disk
 *    pointer included. Resolution inside `serializeEntry` was rejected: the append return value is built
 *    from the same rows the batch sink emits, so a serialize-side resolve would make the emitted frame
 *    carry the full body while disk held prefix+pointer — the same defect inverted. Async deferral was
 *    rejected for the same reason: `appendAgentLogImpl` emits `agent:log` before any flush.
 *
 * 2. READ EQUALS EMITTED. Only read surfaces resolve a pointer (`resolveAgentLogDetailForRead`). A spilled
 *    body is never a persisted field, so a resolution can never be written back and regrow the row. A
 *    missing or unreadable body returns the honest inline prefix — never a throw, never an invented body.
 *
 * 3. WHAT IS PERSISTED STAYS READABLE. A pointer belongs to exactly ONE producer directory and that
 *    directory's identity names the ONLY log that references the body:
 *    `<base>/agent-log-detail-spill/task/<taskId>/<digest>.txt` -> `.fusion/tasks/<taskId>/agent-log.jsonl`
 *    `<base>/agent-log-detail-spill/run/<agentId>/<runId>/<digest>.txt` -> `.fusion/agents/<agentId>-runlogs-<runId>.jsonl`
 *    Reclamation therefore resolves its referrer by path arithmetic and never has to scan a log tree; that
 *    per-sink ownership is also what makes its reference set complete, because a task-side pointer is never
 *    copied into a run-log row.
 *
 * Redaction is a durability-seam invariant, not a per-producer courtesy: this seam redacts its own input
 * once and derives the prefix, the body, the byte count and the digest from the REDACTED string, so no sink
 * can persist a credential it did not redact (`merger.ts` hands raw command output and raw error messages
 * straight to the store). `AgentLogger.writeEntry` keeps its own call, so the engine path redacts twice —
 * which is only safe because every rule in `secrets/redact-secrets.ts` maps its own `[REDACTED]` output back
 * to itself; `agent-log-detail-spill.test.ts` pins that per rule, because a non-idempotent rule would put a
 * file at a digest that names different bytes.
 *
 * Units: every inline bound in this area is declared in UTF-16 code units (`String.length`), matching its
 * name. Where a byte quantity is meant — the spill file and the recorded `bytes` — it is measured with
 * `Buffer.byteLength`. A diacritic-heavy payload therefore legitimately records `bytes > chars`.
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import type { AgentLogDetailSpill, AgentLogEntry } from "../types.js";
import { redactSecrets } from "../secrets/redact-secrets.js";
import { AGENT_LOG_FILENAME, AGENT_LOG_TOOL_DETAIL_LIMIT, AGENT_LOG_TOOL_TYPES, agentRunLogFileName } from "./agent-log-constants.js";
import { createLogger } from "../process/logger.js";

const log = createLogger("agent-log-detail-spill");

/** Directory name of the spill pool, directly under `.fusion/`. */
export const AGENT_LOG_DETAIL_SPILL_DIR = "agent-log-detail-spill";

/** Suffix of the unique in-flight publish file; reclamation reclaims aged leftovers. */
const PARTIAL_SUFFIX = ".partial";

/** The extension a published body carries so a spilled payload opens as text in any viewer. */
export const AGENT_LOG_SPILL_BODY_SUFFIX = ".txt";

/** Lowercase hex SHA-256 and nothing else — the stem of every published body file name. */
const SPILL_BODY_DIGEST_PATTERN = /^[0-9a-f]{64}$/;

/** File-name length of a lowercase hex SHA-256 digest. */
const SHA256_HEX_LENGTH = 64;

/** Pool layout segment for task-log producers. */
export const AGENT_LOG_SPILL_FAMILY_TASK = "task";

/** Pool layout segment for run-log producers. */
export const AGENT_LOG_SPILL_FAMILY_RUN = "run";

/** True for the entry types whose `detail` is tool payload and therefore bounded. */
export function isAgentLogToolDetailType(type: AgentLogEntry["type"]): boolean {
  return AGENT_LOG_TOOL_TYPES.has(type);
}

/** Producer directory for a task-log row: `<base>/agent-log-detail-spill/task/<taskId>`. */
export function agentLogTaskSpillDir(baseDir: string, taskId: string): string {
  return join(baseDir, AGENT_LOG_DETAIL_SPILL_DIR, AGENT_LOG_SPILL_FAMILY_TASK, taskId);
}

/** Producer directory for a run-log row: `<base>/agent-log-detail-spill/run/<agentId>/<runId>`. */
export function agentLogRunSpillDir(baseDir: string, agentId: string, runId: string): string {
  return join(baseDir, AGENT_LOG_DETAIL_SPILL_DIR, AGENT_LOG_SPILL_FAMILY_RUN, agentId, runId);
}

/** The task-side pool base a task directory already implies — no new accessor needed. */
export function agentLogSpillBaseFromTaskDir(taskDir: string): string {
  return dirname(dirname(taskDir));
}

/**
 * The run-side pool base an agents directory implies — the twin of {@link agentLogSpillBaseFromTaskDir}.
 *
 * FNXC:AgentLogDetailSpill 2026-11-06-00:46 (RUFU-340):
 * Decision 2's identity premise is load-bearing here: `AgentStore` builds `agentsDir = join(rootDir, "agents")`
 * from a `rootDir` that is the same directory `TaskStore.tasksDir` sits in (`.fusion/agents` beside
 * `.fusion/tasks`), so `dirname(agentsDir) === dirname(tasksDir)`. That identity is what makes ONE pool
 * reachable from both families of writer and lets reclaim resolve a run pointer's referrer by path arithmetic
 * instead of a reverse index. A run body's referrer is therefore never sought in the caller-supplied task
 * directory: a task directory is per-task while the run pool is per-store. The premise is asserted, not
 * assumed, in `agent-log-spill-carrier-census.test.ts`.
 */
export function agentLogSpillBaseFromAgentsDir(agentsDir: string): string {
  return dirname(agentsDir);
}

/**
 * The one task-side producer-directory derivation, composed so the buffering writer
 * (`appendAgentLogImpl`) and the sole append writer (`appendAgentLogEntriesSync`) cannot disagree about
 * where a task row's body lives — a disagreement would strand a body no log references.
 */
export function agentLogTaskProducerDir(taskDir: string, taskId: string): string {
  return agentLogTaskSpillDir(agentLogSpillBaseFromTaskDir(taskDir), taskId);
}

/** Lowercase hex SHA-256 of the exact bytes a spill body will hold. */
export function agentLogSpillDigest(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** True when `name` is a content-addressed spill body file name. */
export function isAgentLogSpillBodyFileName(name: string): boolean {
  if (!name.endsWith(AGENT_LOG_SPILL_BODY_SUFFIX)) return false;
  const stem = name.slice(0, -AGENT_LOG_SPILL_BODY_SUFFIX.length);
  return stem.length === SHA256_HEX_LENGTH && SPILL_BODY_DIGEST_PATTERN.test(stem);
}

/** True when `name` is an in-flight publish leftover (possibly aged). */
export function isAgentLogSpillPartialFileName(name: string): boolean {
  return name.endsWith(PARTIAL_SUFFIX);
}

/**
 * True when `value` is the lowercase hex SHA-256 a row records in `detailSpill.digest`.
 *
 * FNXC:AgentLogDetailSpill 2026-11-06-03:02 (RUFU-340):
 * Reclamation validates a row's digest with the SAME predicate that names a published body file, so the join
 * key it reads and the name it compares against cannot disagree about what a digest looks like.
 */
export function isAgentLogSpillDigest(value: unknown): value is string {
  return typeof value === "string" && SPILL_BODY_DIGEST_PATTERN.test(value);
}

/**
 * The digest a published body file name names, or null when the name is not a body file name.
 *
 * FNXC:AgentLogDetailSpill 2026-11-06-03:02 (RUFU-340):
 * Reclamation matches references by DIGEST and never by path string. The writer and the reclaimer are separate
 * processes that each derive the pool path from their own `rootDir` (engine/CLI pass `process.cwd()`, the
 * dashboard resolves a project path from settings), so when the two spell one real directory differently — a
 * symlinked project root, the macOS `/private/var` class this repo already had to realpath at both ends in
 * `dashboard/src/routes/system/register-git-github.ts` and in `core/src/agent-cwd-policy.ts` — `resolve()`
 * keeps the spellings apart, a path-keyed reference set reads EVERY body in the pool as unreferenced, and an
 * aged pass deletes evidence live rows still point at. A digest is content, is the file's own name, and spells
 * identically from every root, which is why it and not `body` is the join key.
 */
export function agentLogSpillDigestFromFileName(name: string): string | null {
  if (!isAgentLogSpillBodyFileName(name)) return null;
  return name.slice(0, -AGENT_LOG_SPILL_BODY_SUFFIX.length);
}

/**
 * True when a pool entry name can name exactly one producer identity (a task id, or one run level).
 *
 * FNXC:AgentLogDetailSpill 2026-11-06-01:44 (RUFU-340):
 * Reclamation resolves a producer's referrer by path arithmetic, so the directory name is the ONLY premise it
 * has for a filesystem path it will READ. A name carrying a separator or a pure-dot component (`..`) would
 * make that read land outside `tasks/` / `agents/`, which is the fail-closed case Decision 8 names: such a
 * directory is skipped whole, so none of its bodies is ever a deletion candidate either. Writers derive these
 * names from store ids and can produce no such name; the guard exists because reclaim must not need to trust
 * that premise to stay inside the pool.
 */
export function isAgentLogSpillIdentityName(name: string): boolean {
  if (name.length === 0 || name === "." || name === "..") return false;
  return !name.includes("/") && !name.includes("\\") && !name.includes("\0");
}

/**
 * Result of seam-side detail normalization: the pair a sink persists verbatim.
 *
 * FNXC:AgentLogDetailSpill 2026-11-06-00:46 (RUFU-340):
 * The seam NEVER mutates the entry handed to it. One `AgentLogger` flush fans one entry out to the task-log
 * sink and the run-log sink, and both hold the same object; each sink therefore derives its own pointer
 * under its own producer directory and returns a new row object, leaving the caller's entry holding its full
 * redacted detail for the next fan-out.
 */
export interface AgentLogDetailSpillPair {
  /** The value to persist as the row's `detail` (full payload, or the bounded inline prefix). */
  detail?: string;
  /** The pointer for that prefix, or undefined when nothing spilled. */
  spill?: AgentLogDetailSpill;
}

/**
 * Normalize one entry's `detail` for persistence into `producerDir`, writing the body when it overflows.
 *
 * Idempotent per producer directory: a row that already carries a pointer for THIS directory passes through
 * untouched, so a replay never re-cuts a prefix or rewrites a pointer. A pointer from ANOTHER directory is
 * replaced by this directory's own pair — a body must never be addressed across producers.
 *
 * @throws never: a failed publish degrades to the pre-spill inline behaviour and is logged, because losing
 * an overflow body is strictly better than losing the whole row.
 */
export function spillAgentLogDetail(
  input: { detail?: string | null; type: AgentLogEntry["type"]; detailSpill?: AgentLogDetailSpill },
  producerDir: string,
): AgentLogDetailSpillPair {
  const raw = input.detail;
  if (raw == null) return {};

  // Decision 6: only tool payload types are bounded. `text`/`status`/`thinking` pass through untouched.
  if (!isAgentLogToolDetailType(input.type)) {
    return input.detailSpill ? { detail: raw, spill: input.detailSpill } : { detail: raw };
  }

  // Already spilled for this sink (Decisions 4, 15): pass through on exact producer-directory identity,
  // which is also what makes that directory the complete reference set for reclamation. Never re-cut,
  // never re-hash, never rewrite — and never honour another directory's pointer.
  const existing = input.detailSpill;
  if (existing?.body && dirname(existing.body) === producerDir) {
    return { detail: raw, spill: existing };
  }
  if (existing?.body) {
    /*
     * FNXC:AgentLogDetailSpill 2026-11-06-00:46 (RUFU-340):
     * A pointer naming ANOTHER producer directory is never honoured: addressing a body across producers is
     * exactly what would let a task-log prune delete a body a run log still points at. Dropping it costs at
     * most the tail of a prefix-only replay, and no in-tree path produces one — the engine fan-out hands each
     * sink the entry with its FULL detail so every sink derives its own pair (pinned in
     * `agent-log-spill-carrier-census.test.ts`).
     */
    log.warn(`Ignoring an agent-log detail pointer from a foreign producer directory: ${dirname(existing.body)}`);
  }

  if (raw.length <= AGENT_LOG_TOOL_DETAIL_LIMIT) return { detail: raw };

  // Redact at the seam so the prefix, body, byte count, and digest all describe redacted bytes (Decision 3a).
  const redacted = redactSecrets(raw);
  if (redacted.length <= AGENT_LOG_TOOL_DETAIL_LIMIT) return { detail: redacted };

  const prefix = redacted.slice(0, AGENT_LOG_TOOL_DETAIL_LIMIT);
  const digest = agentLogSpillDigest(redacted);
  const bodyPath = join(producerDir, `${digest}${AGENT_LOG_SPILL_BODY_SUFFIX}`);

  if (existsSync(bodyPath)) {
    return { detail: prefix, spill: { body: bodyPath, digest, chars: redacted.length, bytes: Buffer.byteLength(redacted, "utf8") } };
  }

  try {
    mkdirSync(producerDir, { recursive: true });
    // Decision 3: a content-addressed name is a promise about bytes, so publish atomically. A torn file
    // left AT the digest name would be permanently mis-addressed and unreadable under the pass-through rule.
    const partialPath = join(producerDir, `${digest}.${process.pid}.${Math.random().toString(36).slice(2, 10)}${PARTIAL_SUFFIX}`);
    try {
      writeFileSync(partialPath, redacted, "utf8");
      if (existsSync(bodyPath)) {
        unlinkSync(partialPath);
      } else {
        renameSync(partialPath, bodyPath);
      }
    } catch (error) {
      // Never leave a half-written file at the digest name, and never leave the partial beside it either.
      try {
        if (existsSync(partialPath)) unlinkSync(partialPath);
      } catch {
        // best effort — reclamation sweeps aged `*.partial` leftovers
      }
      throw error;
    }
  } catch (error) {
    log.warn(`Failed to spill agent-log detail into ${producerDir}; persisting the inline prefix only`, error);
    return { detail: prefix };
  }

  return { detail: prefix, spill: { body: bodyPath, digest, chars: redacted.length, bytes: Buffer.byteLength(redacted, "utf8") } };
}

/**
 * Read-surface resolution: return the entry with its full spilled `detail`, or the entry unchanged.
 *
 * FNXC:AgentLogDetailSpill 2026-11-06-00:46 (RUFU-340):
 * The ONLY place a spill file may be read. The returned body is deliberately not accompanied by a persisted
 * field, so it can never be written back. A body that is missing or unreadable yields the inline prefix with
 * the pointer dropped — an honest short record beats a throw on a log read, and inventing bytes is worse
 * than either.
 */
export function resolveAgentLogDetailForRead<T extends { detail?: string; detailSpill?: AgentLogDetailSpill }>(entry: T): T {
  const spill = entry.detailSpill;
  if (!spill?.body || !entry.detail) return entry;
  let body: string;
  try {
    body = readFileSync(spill.body, "utf8");
  } catch (error) {
    log.warn(`Agent-log spill body unreadable (${spill.digest}); returning the inline prefix only`, error);
    const { detailSpill: _dropped, ...rest } = entry;
    return rest as T;
  }
  if (body.length === 0) return entry;
  const { detailSpill: _dropped, ...rest } = entry;
  return { ...rest, detail: body } as T;
}

/**
 * The ONE log that can reference a producer directory's bodies, derived from that directory's position.
 *
 * FNXC:AgentLogDetailSpill 2026-11-06-00:46 (RUFU-340):
 * Reclamation is allowed to delete a body only after it has read the log that points at it, so the referrer has
 * to be derivable without an index — and it is, because the producer directory's identity IS the referrer's
 * identity (`task/<taskId>` ↔ `tasks/<taskId>/agent-log.jsonl`; `run/<agentId>/<runId>` ↔
 * `agents/<agentId>-runlogs-<runId>.jsonl`). A referrer that cannot be read is therefore never treated as a
 * referrer that holds no pointers: the caller must skip the directory (see `pruneAgentLogFiles`).
 */
export function agentLogSpillReferrerLog(baseDir: string, producer: AgentLogSpillProducerDir): string | null {
  if (producer.family === "task" && producer.taskId) {
    return join(baseDir, "tasks", producer.taskId, AGENT_LOG_FILENAME);
  }
  if (producer.family === "run" && producer.agentId && producer.runId) {
    return join(baseDir, "agents", agentRunLogFileName(producer.agentId, producer.runId));
  }
  return null;
}

/**
 * Resolve every entry a read surface returns. Convenience over `resolveAgentLogDetailForRead` so a caller
 * cannot accidentally return a partially-resolved page.
 */
export function resolveAgentLogDetailsForRead<T extends { detail?: string; detailSpill?: AgentLogDetailSpill }>(entries: T[]): T[] {
  return entries.map((entry) => resolveAgentLogDetailForRead(entry));
}

/** The one pool root a `.fusion`-level base implies — the directory a reclaim pass walks. */
export function agentLogSpillPoolRoot(baseDir: string): string {
  return join(baseDir, AGENT_LOG_DETAIL_SPILL_DIR);
}

/** One producer directory in the pool, with the identity its position in the tree encodes. */
export interface AgentLogSpillProducerDir {
  /** Absolute path of the producer directory itself. */
  dir: string;
  family: "task" | "run";
  /** Set for the `task` family. */
  taskId?: string;
  /** Set for the `run` family. */
  agentId?: string;
  /** Set for the `run` family. */
  runId?: string;
  /** Directory mtime, the only cheap per-directory signal a bounded prefilter can use. */
  mtimeMs: number;
}

/**
 * Enumerate every producer directory in the pool: `task/<taskId>` and `run/<agentId>/<runId>`.
 *
 * FNXC:AgentLogDetailSpill 2026-11-06-00:46 (RUFU-340):
 * Reclaim is POOL-DRIVEN, so it enumerates directories and derives each one's referrer by path arithmetic — it
 * never iterates logs and never consults a reverse index. Both families are returned by ONE call, because the
 * requirement is that a pass must not delete a body whose referencing log it did not examine, and a pass that
 * walked only `task/` would exactly violate that against `run/`. An absent pool is not an error: it yields an
 * empty list, so the first run of this feature on an existing install (where the pool has never been created)
 * costs one `stat` and no directory.
 */
export function listAgentLogSpillProducerDirs(baseDir: string): AgentLogSpillProducerDir[] {
  const pool = agentLogSpillPoolRoot(baseDir);
  const found: AgentLogSpillProducerDir[] = [];
  const mtimeMs = (dir: string): number | null => {
    try {
      return statSync(dir).mtimeMs;
    } catch {
      return null;
    }
  };

  let taskFamily: string[];
  try {
    taskFamily = readdirSync(join(pool, AGENT_LOG_SPILL_FAMILY_TASK), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    taskFamily = [];
  }
  for (const taskId of taskFamily) {
    if (!isAgentLogSpillIdentityName(taskId)) {
      log.warn(`Skipping agent-log spill producer under task/${taskId}: its name cannot name one task identity`);
      continue;
    }
    const dir = join(pool, AGENT_LOG_SPILL_FAMILY_TASK, taskId);
    const stamp = mtimeMs(dir);
    if (stamp !== null) found.push({ dir, family: "task", taskId, mtimeMs: stamp });
  }

  let agents: string[];
  try {
    agents = readdirSync(join(pool, AGENT_LOG_SPILL_FAMILY_RUN), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    agents = [];
  }
  for (const agentId of agents) {
    if (!isAgentLogSpillIdentityName(agentId)) {
      log.warn(`Skipping agent-log spill producer under run/${agentId}: its name cannot name one agent identity`);
      continue;
    }
    let runs: string[];
    try {
      runs = readdirSync(join(pool, AGENT_LOG_SPILL_FAMILY_RUN, agentId), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      continue;
    }
    for (const runId of runs) {
      if (!isAgentLogSpillIdentityName(runId)) {
        log.warn(`Skipping agent-log spill producer under run/${agentId}/${runId}: its name cannot name one run identity`);
        continue;
      }
      const dir = join(pool, AGENT_LOG_SPILL_FAMILY_RUN, agentId, runId);
      const stamp = mtimeMs(dir);
      if (stamp !== null) found.push({ dir, family: "run", agentId, runId, mtimeMs: stamp });
    }
  }

  return found;
}
