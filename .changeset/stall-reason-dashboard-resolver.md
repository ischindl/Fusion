---
"@runfusion/fusion": minor
---

summary: Stuck cards now name why they are not moving, as one consistent chip on the board card, list rows, and detail view.
category: feature
dev: New pure, browser-safe resolver `packages/dashboard/app/utils/stallReason.ts` (`resolveStallReason` + `stallReasonVisibleOnFace`) is the single authority for "why isn't this card moving?", replacing the per-surface inline copies. New `stall.*` catalog keys register the reason copy (English values in `en`, empty structure elsewhere awaiting translation) so every string reaches the app translator and can be localized. TaskCard, ListView (rows + mobile cards), the TaskDetailModal banner region, and the agent-health paused pill all consume it. Reused paused/queued badges stay byte-identical and resolve through each surface's own localized key (`tasks.*` on the card, `listView.*` on the list), so localization never de-localizes an existing label. `PAUSE_REASON_LABELS` maps engine pauseReason codes to human words; an unrecognized code keeps the old verbatim `Paused: <code>` fallback. A plain resting card still shows no chip. Forward-compat seam: the `mergeBlockerReason`/`completionBlockerReason` context strings are wired by no consumer today — when RUFU-174 lands its server-derived `task.stallReason` field, a follow-up maps its codes through this seam (do not build a second classifier).
