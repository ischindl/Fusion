---
"@runfusion/fusion": patch
---

summary: Memory recall now verifies project ownership on every Stash read and reports what it excluded.
category: security
dev: A Stash account is shared by every Fusion project of one operator and its search route scopes by owner only, so recalled lines could come from a sibling project. Reads now verify each row's `metadata.discriminator` (or its `session_id`) against the asking project at one choke point in `memory-backend-stash.ts`, drop what is not attributable, count the drops as `all-own` / `dropped-foreign` / `dropped-unidentified`, emit `memory:stash-read-scope` (counts only, never recalled text) for a filtered read, and surface the counts as `stashReadScope` on the memory backend/test routes. No Stash scope parameter is sent — it is measurably inert.
