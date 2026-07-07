---
"@runfusion/fusion": patch
---

summary: Planning Mode "needs input" now shows a yellow nav badge instead of a top banner.
category: fix
dev: Excludes planning `awaiting_input` sessions from SessionNotificationBanner and adds a `status-dot--pending` dot to the Planning nav destination (LeftSidebarNav + MobileNavBar More item/tab), driven by a new `planningNeedsInput` flag.
