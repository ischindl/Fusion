---
"@runfusion/fusion": minor
---

summary: Add an opt-in LLM diff-review verification step for task verification.
category: feature
dev: New project setting `verificationLlmReview` ("off" default | "advisory" | "blocking"). When not "off", an AI reviews the task diff for correctness/regressions as an additional step after the test/build commands in both the merger (`runDeterministicVerification`) and executor verification gates. Advisory logs findings but never fails; blocking fails on a passed:false high-severity verdict; any LLM/infra error degrades to a non-blocking advisory-unavailable result. Reuses createFnAgent/promptWithFallback (no new AI SDK dep). Default-off path is byte-identical to prior behavior. Implemented in `packages/engine/src/llm-review-verification.ts`.
