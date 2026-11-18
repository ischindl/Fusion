---
"@runfusion/fusion": minor
---

summary: Add an "Accepts images" switch so a custom-provider model with vision is no longer reported as text-only.
category: feature
dev: New optional per-model `supportsImages` boolean on settings `customProviders[].models[]` (Settings → Custom Providers and the add-provider form). When true the model registers with input `["text","image"]`; absent/false keeps `["text"]`, so existing provider registrations are unchanged. Auto-detection was measured and rejected: LiteLLM `/v1/models` returns no modality and `/model/info` answers `supports_vision: null`, so only the operator can declare it.
