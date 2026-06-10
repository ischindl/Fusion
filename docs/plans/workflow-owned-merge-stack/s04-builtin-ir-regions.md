---
title: "S04: built-in merge retry recovery IR regions"
type: refactor
status: draft-stack-handoff
date: 2026-06-09
slice: S04
milestone: "Gate A"
origin: docs/plans/2026-06-09-003-refactor-workflow-owned-merge-full-migration-slices-plan.md
stack_base: feature/workflow-owned-merge-s03-generic-scheduler-claim
---

# S04: built-in merge retry recovery IR regions

## Stack Role

This draft PR reserves the S04 review slot in the workflow-owned merge,
retry, scheduling, and recovery migration stack. It is intentionally a handoff
artifact, not the completed implementation for this slice.

## Milestone

Gate A

## Depends On

S1 workflow work items and S2 merge request projection.

## Goal

Add explicit merge, retry, manual hold, branch-group, and recovery regions to built-in workflow IR.

## Expected File Scope

packages/core/src/builtin-*-workflow-ir.ts; packages/core/src/workflow-ir-types.ts; built-in workflow IR tests.

## Expected Tests

Built-in workflow validation for merge gates, retry nodes, manual holds, PR workflow routing, autoMerge false, and branch-group nodes.

## Exit Gate

Built-in IR is the source of truth for default merge/retry/recovery policy.

## Full Plan

See `docs/plans/2026-06-09-003-refactor-workflow-owned-merge-full-migration-slices-plan.md`.
