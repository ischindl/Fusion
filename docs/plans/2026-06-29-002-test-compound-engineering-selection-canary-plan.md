---
title: "Compound Engineering Task-Selection Canary - Plan"
date: 2026-06-29
type: test
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
---

# Compound Engineering Task-Selection Canary - Plan

## Goal Capsule

| Field | Value |
|---|---|
| Objective | Add a narrow regression canary proving that a task created with the Compound engineering workflow selected persists `workflowId: "builtin:compound-engineering"` instead of silently falling back to default Coding. |
| Authority | Fusion task FN-7219, titled "Add a Compound Engineering task-selection canary", and the existing workflow-selection contract in `docs/plans/2026-06-29-001-feat-stepwise-final-review-workflow-plan.md`. |
| Execution profile | Small test-focused code change in the workflow task-creation boundary, with production code changes only if the canary exposes a real defect. |
| Stop conditions | Do not redesign the Compound Engineering workflow, plugin installation, or task creation UX. Do not change fallback behavior unless the canary proves selection intent is still being lost. |
| Tail ownership | Implementation should add the canary first, fix only real failures it exposes, and run focused route/store verification. |

---

## Product Contract

### Summary

Fusion should never turn an explicit Compound engineering task selection into a default Coding task without telling the operator. This task adds a canary around that contract so future changes to task creation, workflow defaults, or plugin gating cannot regress it unnoticed.

### Problem Frame

The broader workflow-selection plan already identifies Compound engineering as a plugin-gated built-in that must either create/select `builtin:compound-engineering` when its required plugin is available or fail closed with a clear plugin requirement when unavailable. Because `builtin:coding` is the default fallback, a missing or dropped workflow ID can look like a successful task creation while routing execution through the wrong workflow. A small canary gives this high-risk boundary a cheap, targeted signal.

### Requirements

- R1. The canary must exercise task creation with explicit `workflowId: "builtin:compound-engineering"` through a production task-creation boundary rather than only asserting registry metadata.
- R2. When `fusion-plugin-compound-engineering` is registered/enabled in the test store, the created task must record a `task_workflow_selection` row with `workflowId: "builtin:compound-engineering"`.
- R3. When the required plugin is unavailable, explicit Compound engineering task creation must fail with a 4xx response that names the selected workflow or required plugin and must not create a task.
- R4. The canary must prove the created task does not resolve to `builtin:coding` after explicit Compound engineering selection.
- R5. Production fixes are in scope only when the new canary fails against current behavior; unrelated cleanup and workflow redesign are out of scope.

### Acceptance Examples

- AE1. Given the Compound Engineering plugin is registered in the project plugin store, when `POST /api/tasks` receives `workflowId: "builtin:compound-engineering"`, then the response is created and `store.getTaskWorkflowSelection(taskId)?.workflowId` is `builtin:compound-engineering`.
- AE2. Given the Compound Engineering plugin is not registered or enabled, when `POST /api/tasks` receives `workflowId: "builtin:compound-engineering"`, then the response is a client error and the total task count is unchanged.
- AE3. Given a task was created through the available-plugin path, when the task's effective workflow is inspected through the same store/route seam used by board workflow grouping, then it is not classified as `builtin:coding`.

### Scope Boundaries

- In scope: route/store-level canary coverage for explicit Compound engineering task creation, plugin-available behavior, plugin-unavailable behavior, and default-fallback prevention.
- In scope: minimal production fix if the canary demonstrates that task creation still loses or suppresses the selected workflow ID.
- Out of scope: adding new Compound Engineering workflow nodes, changing CE skill prompts, changing plugin discovery/install UX, or broad dashboard workflow-picker redesign.
- Out of scope: full-suite validation; focused tests plus the normal merge gate are sufficient for this canary.

### Surface Enumeration

- **Create boundary:** `POST /api/tasks` in `packages/dashboard/src/routes/register-task-workflow-routes.ts` because it is the shared API path for dashboard-created tasks.
- **Store boundary:** `TaskStore.createTask` and `TaskStore.getTaskWorkflowSelection` because they own materializing explicit workflow selection rows.
- **Plugin states:** `fusion-plugin-compound-engineering` registered/enabled and unavailable.
- **Fallback state:** `builtin:coding` as the default workflow/fallback must not mask explicit CE selection.

---

## Planning Contract

### Key Technical Decisions

- KTD-1. Put the canary at the route/store seam.
  The route test exercises request validation, plugin-gated workflow selection, store materialization, and task creation together without needing brittle UI automation.

- KTD-2. Register the plugin in the real test plugin store for the positive path.
  Using the store's plugin registration path keeps the canary aligned with how plugin-gated built-ins become selectable in production instead of mocking the gate away.

- KTD-3. Assert both persistence and non-fallback.
  Checking only the HTTP status can miss a silent fallback to `builtin:coding`; the canary must inspect `task_workflow_selection` and, where practical, the resolved workflow lane/effective workflow signal.

- KTD-4. Keep production changes reactive.
  This task is a canary task. If the canary is already green, implementation should land the targeted test coverage without changing runtime behavior.

### Existing Patterns To Follow

- `packages/dashboard/src/routes/__tests__/task-create-workflow-route.test.ts` for route-level task creation tests with a real `TaskStore` and plugin-store setup.
- `packages/core/src/builtin-workflows.ts` for `builtin:compound-engineering` plugin-gating metadata and required plugin ID.
- `packages/dashboard/src/routes/board-workflows.ts` and `packages/dashboard/src/routes/__tests__/board-workflows-route.test.ts` if the implementer adds an effective board-lane non-fallback assertion.
- `docs/plans/2026-06-29-001-feat-stepwise-final-review-workflow-plan.md` for the broader workflow-selection requirements this canary protects.

### Assumptions

- The current task is intentionally narrow: it adds a canary for Compound engineering workflow selection, not a full implementation of the broader stepwise/final-review workflow plan.
- The route/store seam is sufficient for this canary because UI-level selection tests are already broader and more expensive; add UI coverage only if the route canary passes while manual evidence still shows UI selection loss.

---

## Implementation Units

### U1. Add the Compound engineering positive-path canary

- **Goal:** Prove that task creation with the CE plugin available persists explicit Compound engineering workflow selection.
- **Requirements:** R1, R2, R4, AE1, AE3
- **Dependencies:** None
- **Files:**
  - Modify `packages/dashboard/src/routes/__tests__/task-create-workflow-route.test.ts`
- **Approach:** Extend the existing `POST /tasks workflowId` route suite or add a focused case in that suite. Initialize the real `TaskStore`, register `fusion-plugin-compound-engineering` through `store.getPluginStore().registerPlugin`, create a task with `workflowId: "builtin:compound-engineering"`, and assert the stored workflow selection row names `builtin:compound-engineering`. Add a non-fallback assertion through the route/store seam if an existing helper exposes effective workflow resolution without broad setup.
- **FNXC comment requirement:** If adding a comment in test code, prefix it with `FNXC:WorkflowSelection` and explain that explicit CE workflow intent must persist because silent fallback to Coding hides operator-selected workflow execution.
- **Patterns to follow:** The real-store setup and `post` helper in `packages/dashboard/src/routes/__tests__/task-create-workflow-route.test.ts`.
- **Test Scenarios:**
  - Happy path: registered CE plugin plus `workflowId: "builtin:compound-engineering"` returns 201 and records `task_workflow_selection.workflowId` as `builtin:compound-engineering`.
  - Integration: created task inspected through store selection APIs remains associated with CE and not the default Coding fallback.
- **Verification:** The focused route test demonstrates explicit CE workflow selection persists when the required plugin is available.

### U2. Add the Compound engineering unavailable-plugin canary

- **Goal:** Prove that unavailable CE workflow selection fails closed instead of creating a default Coding task.
- **Requirements:** R1, R3, R4, AE2
- **Dependencies:** None
- **Files:**
  - Modify `packages/dashboard/src/routes/__tests__/task-create-workflow-route.test.ts`
- **Approach:** Add or tighten a negative test in the same route suite. Capture the task count before the request, submit `workflowId: "builtin:compound-engineering"` without registering the required plugin, assert a 4xx response, assert the error text names either `builtin:compound-engineering` or `fusion-plugin-compound-engineering`, and assert the task count is unchanged.
- **Patterns to follow:** Existing fragment/unknown-workflow tests in `packages/dashboard/src/routes/__tests__/task-create-workflow-route.test.ts` that verify no task row is created on client errors.
- **Test Scenarios:**
  - Error path: missing CE plugin returns a client error and no task is created.
  - Error message: response identifies the CE workflow or required plugin so the operator can distinguish gating from generic task creation failure.
- **Verification:** The focused route test proves a missing plugin cannot silently produce a default Coding task.

### U3. Fix only failures exposed by the canary

- **Goal:** Keep this task scoped to real defects uncovered by U1/U2.
- **Requirements:** R5
- **Dependencies:** U1, U2
- **Files:**
  - Modify `packages/dashboard/src/routes/register-task-workflow-routes.ts` only if create-route validation or plugin-gated rejection is defective.
  - Modify `packages/core/src/store.ts` only if `TaskStore.createTask` drops explicit CE workflow selection after the route passes it through.
  - Modify `packages/core/src/builtin-workflows.ts` only if required-plugin metadata for `builtin:compound-engineering` is missing or incorrect.
- **Approach:** Run the canary after adding it. If it fails, trace the smallest boundary where explicit CE selection is lost: request validation, plugin-gated availability, store selection materialization, or default workflow resolution. Patch that boundary only. Preserve the distinction between `workflowId: undefined`, `workflowId: null`, and explicit string selection.
- **FNXC comment requirement:** Any production fix must include an updated `FNXC:WorkflowSelection` or `FNXC:WorkflowCreation` comment at the fixed boundary explaining the CE plugin-gated no-fallback requirement.
- **Patterns to follow:** Existing workflow-selection comments in `packages/core/src/store.ts` and client-error mapping in `packages/dashboard/src/routes/register-task-workflow-routes.ts`.
- **Test Scenarios:**
  - Only the failing U1/U2 scenario needs additional assertions unless the fix touches a shared boundary.
  - If the store is changed, add/extend core coverage for explicit built-in workflow selection plus optional-step defaults.
- **Verification:** The canary fails before the fix and passes after the fix, or implementation documents that no production fix was needed because the canary passed immediately.

---

## Verification Contract

| Scope | Command | Proves |
|---|---|---|
| CE task-selection canary | `pnpm --filter @fusion/dashboard exec vitest run src/routes/__tests__/task-create-workflow-route.test.ts --silent=passed-only --reporter=dot` | Explicit CE workflow selection persists when the plugin is available and fails closed when unavailable. |
| Store selection fallback, only if store code changes | `pnpm --filter @fusion/core exec vitest run src/__tests__/builtin-workflows.test.ts --silent=passed-only --reporter=dot` | Explicit built-in workflow selection remains distinct from default fallback behavior. |
| Type safety, only if route/store/core code changes | `pnpm --filter @fusion/dashboard typecheck` or the narrow package typecheck for the changed package | Route/store changes typecheck without relying on the full suite. |

Do not run `pnpm test:full`, `pnpm verify:workspace`, or broad repeated test loops for this canary.

---

## Definition of Done

- A focused canary covers `workflowId: "builtin:compound-engineering"` task creation with the CE plugin available.
- A focused canary covers unavailable CE plugin behavior and proves no task is created on the gated failure path.
- The canary asserts explicit CE selection does not resolve or persist as default Coding.
- Any production change is limited to a real defect exposed by the canary and includes an FNXC comment where requirements changed or were clarified.
- No changeset is added unless implementation changes published `@runfusion/fusion` behavior beyond test coverage.
- Focused verification in the Verification Contract passes.
