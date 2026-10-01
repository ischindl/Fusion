---
"@runfusion/fusion": minor
---

summary: Post-merge CI gate now recognises OneDev and self-hosted GitLab as real pipeline reporters.
category: feature
dev: New `onedev`/`gitlab` providers in the post-merge evidence contract, derived from configured endpoint config (host[:port] match, never a hostname guess), with `none` still the only exemption. `postMergeEvidence` gained `baseUrl`/`tokenSecret` (secret reference only); GitLab reuses `gitlabInstanceUrl`/`gitlabApiBaseUrl`/`gitlabAuthToken`. The post-merge reviewer prompt is materialized per platform only for untampered built-in prompts, so an edited authored prompt is never rewritten. No CI API client is added. Settings/editor UI is RUFU-456.
