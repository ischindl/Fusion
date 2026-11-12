---
title: Prompt write read-back queries the task row
date: 2026-08-22
category: logic-errors
module: packages/engine/src/agent-tools.ts
problem_type: persistence_verification
symptoms: [prompt-write-false-failure, infinite-replanning]
applies_when: "A fail-closed mutation check compares a field stored outside the returned database row."
---

# Prompt write read-back queries the task row

## Symptom

Every `fn_task_prompt_write` call reported that the authoritative `PROMPT.md`
read-back could not be verified, even though the plan was immediately readable.
Planners correctly refuse to finish until the tool confirms persistence, so each
failed session was recovered as `needs-replan` and started another planning pass.

## Root cause

FN-094 added workspace repository-scope publication to the prompt-write path.
It retained the pre-write `getTask` needed for scope validation, then changed the
post-write check to inspect `updateTask`'s return value. That value is a
`project.tasks` row. `prompt` is filesystem-only: it is written to `PROMPT.md`
and only hydrated by `getTaskImpl`. The returned row therefore cannot prove the
write and has no `prompt` value to compare.

## Fix

After `updateTask` completes its single prompt-plus-scope mutation, read the
task again with `store.getTask(taskId)` and compare the hydrated prompt byte for
byte with the requested content. Missing, empty, changed, or unreadable
read-backs remain errors. Mirroring the verified plan to the project database
continues to be best-effort and occurs only afterwards.

## Rule

A mutation return value is not a read-back when the mutated field lives outside
that row. Repair fail-closed gates by correcting what they observe, never by
weakening their strictness. A false failure at a planning confirmation boundary
can amplify into an infinite replanning loop because the planner must treat an
unverified artifact as unsafe.

## Verification

- `packages/engine/src/__tests__/agent-document-tools.test.ts` covers exact,
  duplicate, workspace, missing, empty, altered, rejecting, and mirror-failure
  states.
- `packages/engine/src/__tests__/plan-prompt-write-surfaces.test.ts` covers
  triage/replanning, Plan Review, and reviewer-inline registration reachability.

## Byte-equality verification cannot see a model-side truncation (RUFU-534)

The read-back above proves one thing: the file on disk equals the string the
process was handed. It cannot prove that string is the whole specification, and
the two failure classes are disjoint. RUFU-519 measured it: a planner truncated
its own tool-call argument, so received payload and landed file were both 1 579 B
of a 57 814 B spec, the read-back saw a zero diff, and the write reported success
39.4 s later.

The verification layers are complementary, not redundant, and each catches what
the other cannot see:

- row read-back (`agent-tools.ts`) - the durable task row does not carry the
  prompt body, so the mutation return must not be trusted as evidence.
- landed-byte verification (`writePromptFileAtomic`, `verifyLanded`) - the rename
  landed bytes other than what it was handed (a partial or racing write).
- material-shrink guard (`assertNoAuthoritativePromptShrink`) - the bytes handed
  in are themselves materially smaller than the accepted spec, which is the only
  signal available when the truncation happened upstream of this process.

Do not collapse one into another: a change that removes the shrink guard "because
the write is already verified" reopens RUFU-519 exactly, and a change that removes
the row read-back reopens the original defect this file documents.
