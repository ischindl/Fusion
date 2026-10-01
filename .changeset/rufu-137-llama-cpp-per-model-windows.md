---
"@runfusion/fusion": minor
---

summary: Local llama.cpp models now register their real context windows with the model picker and compaction gate.
category: feature
dev: @fusion/pi-llama-cpp extension reads /v1/models meta.n_ctx (per-slot) and /props from the running llama-server, with 128000/32000 fallbacks for servers that expose no window metadata; maxTokens is capped at half the resolved window so the compaction gate keeps a positive headroom.
