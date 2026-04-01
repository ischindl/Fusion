# Task: KB-662 - When dashboard becomes visible refresh data

**Created:** 2026-04-01
**Size:** S

## Review Level: 1 (Plan Only)

**Assessment:** Small, focused change adding visibilitychange listener to existing useTasks hook. Low blast radius, standard browser API pattern.
**Score:** 3/8 — Blast radius: 0, Pattern novelty: 1, Security: 0, Reversibility: 2

## Mission

Implement automatic data refresh when the dashboard tab becomes visible again after being hidden. When a user switches away from the dashboard tab and later returns, the task data should be refreshed to ensure the UI shows the current state. This uses the standard Page Visibility API (`document.visibilityState`).

## Dependencies

- **None**

## Context to Read First

- `packages/dashboard/app/hooks/useTasks.ts` — The main tasks hook that handles fetching and SSE updates
- `packages/dashboard/app/api.ts` — API functions including `fetchTasks()`

## File Scope

- `packages/dashboard/app/hooks/useTasks.ts` (modified)
- `packages/dashboard/app/hooks/__tests__/useTasks.test.ts` (new or modified)

## Steps

### Step 1: Add Visibility Change Listener

- [ ] Add `useEffect` hook in `useTasks.ts` to listen for `visibilitychange` events on `document`
- [ ] When `document.visibilityState` becomes `"visible"`, call `api.fetchTasks()` to refresh data
- [ ] Update local state via `setTasks()` with normalized results
- [ ] Debounce or throttle to prevent rapid refetching (minimum 1 second between refreshes)
- [ ] Clean up event listener on unmount

**Artifacts:**
- `packages/dashboard/app/hooks/useTasks.ts` (modified)

### Step 2: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Write unit test in `useTasks.test.ts` to verify:
  - Refetch occurs when visibility changes from "hidden" to "visible"
  - No refetch occurs when visibility changes to "hidden"
  - Debouncing works (multiple rapid visibility changes don't trigger multiple fetches)
- [ ] Run full test suite: `pnpm test`
- [ ] Fix all failures
- [ ] Build passes: `pnpm build`

### Step 3: Documentation & Delivery

- [ ] No documentation updates required (internal behavior change)
- [ ] Verify manual testing: open dashboard, switch to another tab, wait a few seconds, return — tasks should refresh

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] Dashboard refreshes data when tab becomes visible after being hidden
- [ ] Debouncing prevents excessive API calls

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-662): complete Step N — description`
- **Bug fixes:** `fix(KB-662): description`
- **Tests:** `test(KB-662): description`

## Do NOT

- Add settings or configuration options for this feature (always-on behavior)
- Modify the API server endpoints
- Change SSE or WebSocket behavior
- Add visual indicators or loading states for the refresh (silent background update)
- Use `window.focus` or `window.blur` events (use Page Visibility API only)
