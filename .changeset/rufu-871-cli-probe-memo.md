---
"@runfusion/fusion": patch
---

summary: Dashboard no longer re-probes installed CLIs on every request; each presence probe is remembered for 60s.
category: performance
dev: `probeClaudeCli`, the runtime-provider CLI presence probes, and `detectFnBinary` are memoized per configured binary path with single-flight, mirroring `gh-cli.ts`'s TTL cache. Explicit invalidators (`invalidateClaudeCliProbeCache`, `invalidateRuntimeCliProbeCaches`, `resetFnBinaryDetectionCache`) are wired to the provider save routes and the fn-binary install route, so a settings change or a Test/Refresh still re-probes immediately.
