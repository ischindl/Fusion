/*
FNXC:CrossProjectHandoff 2026-09-09-04:31 (RUFU-203):
Cross-project task transfer: a COPY with cross-references, never a physical row move.
`project.tasks` is keyed `(project_id, id)` — the project id is the RLS partition key, not an
attribute, so a row cannot leave its partition and stay itself, and the card's visible identity
comes from the TARGET project's own `taskPrefix` (STAS-042 cannot exist as an id inside Fusion).
The transfer therefore creates a NEW card through the TARGET project's own `createTask` (which
routes it into that workflow's intake column and applies that project's default workflow), copies
title/description/attachments, and stamps bidirectional pointers through the already-persisted
`sourceMetadata` JSONB carrier (see HANDOFF_FROM_METADATA_KEY / TRANSFERRED_TO_METADATA_KEY in
@fusion/core — no new `tasks` column). Dependencies are flattened into the copied description
(no cross-project dependency edges exist) and the source PROMPT.md rides along as a fenced
informational appendix — the target project's own planner writes the live spec.

Idempotency rides the existing per-project partial-unique `proposalClaimId`:
`handoff:<sourceProject>:<sourceTask>:<targetProject>` — a double-click or retry replays onto the
canonical target row (createTask's claim check calls `onProposalClaimConflict`) and the source's
`transferredTo` list is deduped per target project at write time, so no orphan row and no
double-listed pointer can form.

FNXC:CrossProjectHandoff 2026-09-09-04:31 (RUFU-203):
Refusal-over-best-effort is the security boundary. `getOrCreateProjectStore` boots a store for ANY
id, so the LOCAL project registry (`CentralCore.listProjects()` — exactly what GET /api/projects
returns) is checked BEFORE any store resolution; an unregistered or cross-node target is refused
with the pinned reason below and a `task:cross-project-handoff-failed` audit row, because silently
creating a card in a store this install cannot open is worse than a clean 409.
*/
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  CentralCore,
  emitBoundedRunAudit,
  HANDOFF_FROM_METADATA_KEY,
  TRANSFERRED_TO_METADATA_KEY,
  type RegisteredProject,
  type Task,
  type TaskHandoffPointer,
  type TaskStore,
} from "@fusion/core";
import { generateSyntheticRunId } from "@fusion/engine";

/** The refusal sentence for any target project the local registry cannot resolve. Pinned by tests. */
export const CROSS_NODE_REFUSAL = "cross-node targets are not supported in v1";

/** Success audit event (outcome `created` | `deduplicated`). Documented in docs/run-audit.md. */
export const HANDOFF_AUDIT_EVENT = "task:cross-project-handoff";
/** Failure audit event with a fixed `reason` enum. Documented in docs/run-audit.md. */
export const HANDOFF_AUDIT_FAILED_EVENT = "task:cross-project-handoff-failed";

/** Why a handoff failed. Fixed enum — never free-text. */
export type HandoffFailureReason = "target-unresolvable" | "attachment-copy-failed" | "store-write-failed";

/**
 * What the operator wants their card to look like afterwards.
 * `keep-transferred` (default) stamps the `transferredTo` badge pointer on the source;
 * `keep-unchanged` copies to the target but leaves the source card untouched.
 */
export type TaskTransferDisposition = "keep-transferred" | "keep-unchanged";

const TRANSFER_DISPOSITIONS: readonly TaskTransferDisposition[] = ["keep-transferred", "keep-unchanged"];

export function isTaskTransferDisposition(value: unknown): value is TaskTransferDisposition {
  return typeof value === "string" && (TRANSFER_DISPOSITIONS as readonly string[]).includes(value);
}

/** Structured 409 reason for a target the local registry cannot resolve. Pinned by tests. */
export const TARGET_UNRESOLVABLE_REASON = "target-unresolvable";

export interface TaskTransferResponse {
  targetTaskId: string;
  targetProjectId: string;
  targetProjectName: string;
  targetColumn: string;
  /** True when the proposal claim already existed and the canonical target row was replayed. */
  deduped: boolean;
  /** Attachments whose bytes were written into the target store. */
  copiedAttachmentCount: number;
  /** Attachments skipped (unreadable/oversized); a gap, surfaced — never a silent drop. */
  skippedAttachmentCount: number;
}

export interface TaskHandoffStatusEntry {
  projectId: string;
  projectName: string;
  taskId: string;
  transferredAt: string;
  /** False when the pointer's project/store/card cannot be resolved right now. */
  targetAvailable: boolean;
  /** Present only when the pointer resolved to a live card. */
  column?: string;
  status?: string;
  /** Present only when resolution failed; the card keeps a named reason instead of disappearing. */
  error?: string;
}

/** Stable per-(source card, target project) idempotency key stored in the TARGET partition. */
export function handoffProposalClaimId(
  sourceProjectId: string,
  sourceTaskId: string,
  targetProjectId: string,
): string {
  return `handoff:${sourceProjectId}:${sourceTaskId}:${targetProjectId}`;
}

function asHandoffPointer(value: unknown): TaskHandoffPointer | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const rec = value as Record<string, unknown>;
  if (typeof rec.projectId !== "string" || rec.projectId.length === 0) return null;
  if (typeof rec.taskId !== "string" || rec.taskId.length === 0) return null;
  return {
    projectId: rec.projectId,
    projectName: typeof rec.projectName === "string" && rec.projectName.length > 0 ? rec.projectName : rec.projectId,
    taskId: rec.taskId,
    transferredAt: typeof rec.transferredAt === "string" ? rec.transferredAt : "",
  };
}

/** Defensive read of the source card's `transferredTo` pointer array. */
export function parseTransferredTo(sourceMetadata: Record<string, unknown> | undefined | null): TaskHandoffPointer[] {
  const raw = sourceMetadata?.[TRANSFERRED_TO_METADATA_KEY];
  if (!Array.isArray(raw)) return [];
  return raw.map(asHandoffPointer).filter((p): p is TaskHandoffPointer => p !== null);
}

/** Defensive read of the target card's `handoffFrom` pointer record. */
export function parseHandoffFrom(sourceMetadata: Record<string, unknown> | undefined | null): TaskHandoffPointer | null {
  return asHandoffPointer(sourceMetadata?.[HANDOFF_FROM_METADATA_KEY]);
}

/**
 * Shared CentralCore acquisition matching the register-project-routes pattern: reuse the injected
 * instance when the server owns one, otherwise construct/init/close a scoped one. The local
 * registry read doubles as the transfer privilege guard.
 */
export async function withCentralRegistry<T>(
  options: { centralCore?: CentralCore } | undefined,
  run: (central: CentralCore) => Promise<T>,
  onError?: (error: unknown) => T | Promise<T>,
): Promise<T> {
  const sharedCentral = options?.centralCore;
  const shouldClose = !sharedCentral;
  const central = sharedCentral ?? new CentralCore();
  try {
    if (!sharedCentral || (typeof central.isInitialized === "function" && !central.isInitialized())) {
      await central.init();
    }
    return await run(central);
  } catch (error) {
    if (onError) return await onError(error);
    throw error;
  } finally {
    if (shouldClose) {
      try {
        await central.close();
      } catch {
        // A scoped registry never outlives the request either way.
      }
    }
  }
}

/*
FNXC:CrossProjectHandoff 2026-09-09-04:31 (RUFU-203):
Audit metadata is ids/counts/outcomes ONLY — never titles, descriptions, spec text, or file
bytes. Success rows carry `outcome` created|deduplicated; failure rows carry the fixed `reason`
enum. Both events are emitted on the SOURCE store through the bounded best-effort seam so
telemetry can never become a transfer lifecycle dependency (FN-9175 convention).
*/
interface HandoffAuditIds {
  sourceProjectId: string;
  sourceTaskId: string;
  targetProjectId: string;
  targetTaskId?: string;
}

function emitHandoffEvent(
  sourceStore: TaskStore,
  mutationType: string,
  ids: HandoffAuditIds,
  metadata: Record<string, unknown>,
): void {
  void emitBoundedRunAudit(sourceStore, {
    taskId: ids.sourceTaskId,
    agentId: "dashboard-api",
    runId: generateSyntheticRunId("cross-project-handoff", ids.sourceTaskId),
    domain: "database",
    mutationType,
    target: ids.sourceTaskId,
    metadata: {
      sourceProjectId: ids.sourceProjectId,
      sourceTaskId: ids.sourceTaskId,
      targetProjectId: ids.targetProjectId,
      ...(ids.targetTaskId ? { targetTaskId: ids.targetTaskId } : {}),
      ...metadata,
    },
  });
}

export function emitHandoffAudit(
  sourceStore: TaskStore,
  ids: HandoffAuditIds,
  metadata: Record<string, unknown>,
): void {
  emitHandoffEvent(sourceStore, HANDOFF_AUDIT_EVENT, ids, metadata);
}

export function emitHandoffFailureAudit(
  sourceStore: TaskStore,
  ids: HandoffAuditIds,
  reason: HandoffFailureReason,
  extra: Record<string, unknown> = {},
): void {
  emitHandoffEvent(sourceStore, HANDOFF_AUDIT_FAILED_EVENT, ids, { outcome: "failed", reason, ...extra });
}

/**
 * Build the copied description: the description verbatim, then the flattened dependency line
 * (cross-project dependency edges cannot exist, so they become informational text), then the
 * source PROMPT.md as a fenced appendix. The target's planner owns the live spec; this is
 * context, not a contract the target store enforces.
 */
export function buildTransferredDescription(input: {
  description: string;
  dependencies: string[];
  promptSpec?: string | null;
}): string {
  const blocks: string[] = [];
  const base = input.description?.trim() ?? "";
  if (base) blocks.push(base);
  if (input.dependencies.length > 0) {
    blocks.push(`Dependencies at transfer time (informational): ${input.dependencies.join(", ")}`);
  }
  const spec = input.promptSpec?.trim();
  if (spec) {
    blocks.push(`## Transferred spec\n\n\`\`\`markdown\n${spec}\n\`\`\``);
  }
  return blocks.join("\n\n");
}

/** Read the source card's PROMPT.md spec, or null when the card has none (ENOENT is normal). */
async function readSourcePromptSpec(sourceStore: TaskStore, taskId: string): Promise<string | null> {
  try {
    return await readFile(join(sourceStore.taskDir(taskId), "PROMPT.md"), "utf8");
  } catch {
    return null;
  }
}

export interface TaskTransferDeps {
  sourceStore: TaskStore;
  targetStore: TaskStore;
  sourceProjectId: string;
  sourceProjectName: string;
  targetProjectId: string;
  targetProjectName: string;
  warn: (message: string) => void;
}

/**
 * Executes the copy-with-cross-reference transfer. The target create goes through the target
 * store's OWN `createTask` (never a direct row write), so the card lands in the target workflow's
 * intake column with the target's default workflow and `taskPrefix`-minted id. Attachment bytes
 * flow file-by-file through `addAttachment`, so the target store owns its own copies.
 * Disposition `keep-unchanged` performs the copy but writes no `transferredTo` pointer — the
 * source card stays exactly as it was.
 */
export async function transferTaskToProject(
  deps: TaskTransferDeps,
  sourceTask: Task,
  opts: { disposition?: TaskTransferDisposition } = {},
): Promise<TaskTransferResponse> {
  const disposition = opts.disposition ?? "keep-transferred";
  const now = new Date().toISOString();
  const claimId = handoffProposalClaimId(deps.sourceProjectId, sourceTask.id, deps.targetProjectId);
  const auditIds = {
    sourceProjectId: deps.sourceProjectId,
    sourceTaskId: sourceTask.id,
    targetProjectId: deps.targetProjectId,
  };

  const promptSpec = await readSourcePromptSpec(deps.sourceStore, sourceTask.id);
  const description = buildTransferredDescription({
    description: sourceTask.description,
    dependencies: sourceTask.dependencies ?? [],
    promptSpec,
  });

  let deduped = false;
  let targetTask;
  try {
    targetTask = await deps.targetStore.createTask(
      {
        title: sourceTask.title,
        description,
        proposalClaimId: claimId,
        source: {
          sourceType: "cross_project_handoff",
          sourceParentTaskId: sourceTask.id,
          sourceMetadata: {
            [HANDOFF_FROM_METADATA_KEY]: {
              projectId: deps.sourceProjectId,
              projectName: deps.sourceProjectName,
              taskId: sourceTask.id,
              transferredAt: now,
            },
          },
        },
      },
      {
        onProposalClaimConflict: () => {
          deduped = true;
        },
      },
    );
  } catch (err) {
    emitHandoffFailureAudit(deps.sourceStore, auditIds, "store-write-failed", {
      errorName: err instanceof Error ? err.name : "unknown",
    });
    throw err;
  }

  // Attachments copy best-effort file-by-file: the card itself transferred, so one oversized or
  // unreadable attachment must not fail the whole operation — the gap is counted, audited, and
  // reported in the response, never silent.
  let copiedAttachmentCount = 0;
  let skippedAttachmentCount = 0;
  for (const attachment of sourceTask.attachments ?? []) {
    try {
      const { path, mimeType } = await deps.sourceStore.getAttachment(sourceTask.id, attachment.filename);
      const buffer = await readFile(path);
      await deps.targetStore.addAttachment(
        targetTask.id,
        attachment.originalName || attachment.filename,
        buffer,
        mimeType,
      );
      copiedAttachmentCount += 1;
    } catch (err) {
      skippedAttachmentCount += 1;
      deps.warn(
        `handoff attachment copy skipped (${deps.sourceProjectId}:${sourceTask.id}/${attachment.filename} → ${deps.targetProjectId}:${targetTask.id}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  if (skippedAttachmentCount > 0) {
    emitHandoffFailureAudit(deps.sourceStore, { ...auditIds, targetTaskId: targetTask.id }, "attachment-copy-failed", {
      attachmentCount: copiedAttachmentCount,
      skippedAttachmentCount,
    });
  }

  // Source-side pointer (default disposition only), deduped per target project so a retry never
  // double-lists the badge. A failed stamp is a half-transfer: fail loudly — the target card's
  // claim makes the retry replay onto the same card and re-stamp cleanly.
  if (disposition === "keep-transferred") {
    const existingPointers = parseTransferredTo(sourceTask.sourceMetadata);
    if (!existingPointers.some((p) => p.projectId === deps.targetProjectId)) {
      try {
        await deps.sourceStore.updateTask(sourceTask.id, {
          sourceMetadataPatch: {
            [TRANSFERRED_TO_METADATA_KEY]: [
              ...existingPointers,
              {
                projectId: deps.targetProjectId,
                projectName: deps.targetProjectName,
                taskId: targetTask.id,
                transferredAt: now,
              },
            ],
          },
        });
      } catch (err) {
        emitHandoffFailureAudit(deps.sourceStore, { ...auditIds, targetTaskId: targetTask.id }, "store-write-failed", {
          errorName: err instanceof Error ? err.name : "unknown",
        });
        throw err;
      }
    }
  }

  // Best-effort visibility on the source card's history; the audit row is the durable record.
  try {
    await deps.sourceStore.logEntry(
      sourceTask.id,
      `Transferred to ${deps.targetProjectName}`,
      `${deps.targetProjectId}:${targetTask.id}`,
    );
  } catch (err) {
    deps.warn(`handoff log entry skipped for ${sourceTask.id}: ${err instanceof Error ? err.message : String(err)}`);
  }

  emitHandoffAudit(deps.sourceStore, { ...auditIds, targetTaskId: targetTask.id }, {
    outcome: deduped ? "deduplicated" : "created",
    attachmentCount: copiedAttachmentCount,
    skippedAttachmentCount,
  });

  return {
    targetTaskId: targetTask.id,
    targetProjectId: deps.targetProjectId,
    targetProjectName: deps.targetProjectName,
    targetColumn: targetTask.column,
    deduped,
    copiedAttachmentCount,
    skippedAttachmentCount,
  };
}

export interface HandoffStatusContext {
  /** The LOCAL registry listing — the same privilege guard the transfer create enforces. */
  localProjects: Array<Pick<RegisteredProject, "id" | "name">>;
  /** One store resolution per referenced project per request (memoized below). */
  resolveStore: (projectId: string) => Promise<TaskStore>;
}

/**
 * Read-only resolution of a source card's `transferredTo` pointers to live target status. An
 * unresolvable pointer is returned WITH `targetAvailable:false` and a named error reason rather
 * than dropped, so the badge tells the operator why the target went dark (registry removal,
 * cross-node pointer, deleted card) instead of silently shrinking.
 */
export async function resolveHandoffStatuses(
  sourceTask: Task,
  ctx: HandoffStatusContext,
): Promise<TaskHandoffStatusEntry[]> {
  const pointers = parseTransferredTo(sourceTask.sourceMetadata);
  if (pointers.length === 0) return [];

  const storeByProject = new Map<string, TaskStore>();
  const entries: TaskHandoffStatusEntry[] = [];
  for (const pointer of pointers) {
    // `base` holds the pointer identity only; every push below states `targetAvailable` explicitly,
    // so the shared shape is the entry minus that one required field.
    const base: Omit<TaskHandoffStatusEntry, "targetAvailable"> = {
      projectId: pointer.projectId,
      projectName: pointer.projectName,
      taskId: pointer.taskId,
      transferredAt: pointer.transferredAt,
    };
    if (!ctx.localProjects.some((project) => project.id === pointer.projectId)) {
      entries.push({ ...base, targetAvailable: false, error: CROSS_NODE_REFUSAL });
      continue;
    }
    try {
      let store = storeByProject.get(pointer.projectId);
      if (!store) {
        store = await ctx.resolveStore(pointer.projectId);
        storeByProject.set(pointer.projectId, store);
      }
      const target = await store.getTask(pointer.taskId);
      if (!target) {
        entries.push({
          ...base,
          targetAvailable: false,
          error: `task ${pointer.taskId} not found in project ${pointer.projectId}`,
        });
        continue;
      }
      entries.push({ ...base, targetAvailable: true, column: target.column, status: target.status });
    } catch (err) {
      entries.push({
        ...base,
        targetAvailable: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return entries;
}
