---
"@runfusion/fusion": patch
---

summary: Blocked-task notice text no longer spills over the card; it clamps on the card face and reads in full in list/detail.
category: fix
dev: The clamp mechanism moved off the shared `.external-block-notice__reason` rule onto a `--card`-scoped rule, so `--list` and `--detail` paint the whole obstacle report again; `--card` and `.card.external-blocked` gained token-derived `max-height` ceilings (no px literals). Geometry is now measured, not text-asserted, by a new `dashboard-browser-touch` spec (`external-block-card-geometry-browser.test.ts`), which asserts its own screenshots exist so a run that writes no evidence cannot report a pass. Code review P0 follow-up: the ceiling's two identity inputs are bounded in the same derivation — one `--blocked-card-header-rows` property rules both the header badge group's clip and the ceiling term that budgets it, and the card title clamps to the two lines the ceiling spends — so no header/title combination can push the notice below the card's border box again. Standing it up exposed that `workflow-ir-resolver.ts` read `process.env` at module scope and killed every browser fixture page at load; the read is now the repo's browser-safe guarded shape (Node behavior unchanged).
