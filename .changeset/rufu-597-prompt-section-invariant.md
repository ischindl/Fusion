---
"@runfusion/fusion": patch
---

summary: Prompt memory sections can no longer render another card's or persona's text as agent memory.
category: fix
dev: `buildRequestVolatileContext` now enforces the section-source invariant — every composed prompt block opens with its own `##` heading (headingless producer input gets the slot's declared fallback heading inserted; bytes are never moved), so `## Agent Memory` spans end at the declared source boundary even under `compactPromptMemory`'s end-of-string span extension. Guard: `packages/engine/src/execution/prompt-layers.ts`; tests: `prompt-section-source-invariant.test.ts`.
