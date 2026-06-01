---
"@runfusion/fusion": minor
---

Custom OpenAI-compatible providers now register with explicit conservative role compatibility: Fusion defaults `compat.supportsDeveloperRole` to `false` so reasoning-capable models emit the legacy `system` role instead of relying on provider URL auto-detection. Advanced users can opt in per provider with `supportsDeveloperRole: true` when their endpoint explicitly supports the `developer` role.
