---
"@runfusion/fusion": patch
---

summary: The WIP-slot stall explanation and the settings "Scan now" button now render in all seven languages.
category: fix
dev: Fills the eight empty `stall.wip-admission-throttled.facts.*` leaves in zh-CN/zh-TW/ko (a parity-gate blind spot: empty
  secondary values fall back to English silently), adds `settings.merge.scanNow` behind the previously hardcoded button label,
  and excludes e2e fixtures from i18n lint by the `-fixture.tsx` suffix — `app/test/boardViewReturnFixture.tsx` was renamed to
  `board-view-return-fixture.tsx` so no ignore entry had to name a dashboard path.
