---
"@runfusion/fusion": minor
---

summary: Review-lane bypass now covers pre-merge gates that never ran, and the menu item now activates.
category: feature
dev: New `Task.reviewBypass` capability field is hydrated on every read path (detail, slim board list, modified-since, search) by `deriveReviewBypassTarget` — the same derivation `TaskStore.bypassFailedPreMergeReviewStep` applies to itself. The dashboard Actions-menu item now renders from that field (the local `status === "failed"` predicate was deleted, ending the drift where paused cards were offered a refusal and unrun-gate cards were hidden while the POST route succeeded), with kind-branched copy: `taskDetail.bypassReview.{btnUnrun,promptMessageUnrun,successUnrun}` for the never-ran shape. Separately, FN-7720's item shipped with `tone: "note"`, which renders a non-interactive `<span role="note">` and short-circuits `selectAction`, so the bypass could never fire on any host; it is now the actionable `default` tone. `btnUnrun` is added to the i18next `preservePatterns` list because its call site uses an unbound `TFunction<"app">` (same reason `btn` is listed) and extraction otherwise prunes it into the `common` namespace where the runtime cannot see it.
