---
"@runfusion/fusion": patch
---

Extend internal `SandboxBackend` abstraction to cover the spawn-based verification runner (`runVerificationCommand` / `execWithProcessGroup`) via a new `runStreaming` method on the backend. Native passthrough only — no behavior change. Foundation for FN-4637/FN-4638 to wrap the verification path the same way they wrap `runConfiguredCommand`.
