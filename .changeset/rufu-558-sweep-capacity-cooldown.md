---
"@runfusion/fusion": patch
---

summary: A card waiting for a free lane slot waits its cooldown instead of re-trying every pass.
category: fix
dev: The hold→WIP release sweep now paces a refusal it recorded itself. The class is the held reason the sweep reported on its previous pass (one-wide allowlist: `move-rejected-or-no-slot`, the only arm whose re-derivation costs readiness probes plus a worktree-slot reservation plus a move), and the clock is the card's own `wipAdmissionStall` episode `lastAt`, advanced only when that record is refreshed, so one refused card costs at most 4 release attempts per hour at the 15-minute floor instead of ~240. Keying on the episode's gate code was measured inert - labels sharpen upward only, so 60 of 138 refusals in the motivating window carried no code on a card already labelled `downstream-full`. The live lane sample stays ahead of the skip, so a slot that frees still releases the waiting card the same pass with no wake; `downstream-full`, `column-capacity`, operator promote/release and `awaiting-planning` / `awaiting-approval` are never paced, and the review/executor lane twin deferral is unchanged. No new state, floor, badge, error, pause, or lane move; a restart costs the one fail-open re-probe the sweep already had.
